/**
 * 快照领域逻辑（DEV-GUIDE §11 核心；M5 补并发限流编排）。
 * cron 与手动「立即刷新」共用同一函数：差异仅在调用方（批量编排 vs 单凭证鉴权触发）。
 *
 * 纪律：
 * - 失败不写伪余额：只更新 lastStatus/failCount，绝不写 ok 快照（红线 #3）；
 * - 单凭证异常不向上抛出（返回值表达），失败隔离（AC2.5）；
 * - 明文仅在发起平台请求瞬间存在于内存；日志只含脱敏信息。
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToPayload } from "@/lib/crypto/keyvault";
import type { CredentialRecord } from "@/lib/credentials/service";
import type { FailReason, ProviderAdapter } from "@/lib/providers/types";

export interface CredentialWithSecret {
  id: string;
  provider: CredentialRecord["provider"];
  region: string | null;
  iv: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
}

export interface RefreshOneResult {
  credentialId: string;
  ok: boolean;
  /** 成功：写入的快照条数；失败：0 */
  snapshots: number;
  reason?: FailReason | "DECRYPT_FAILED";
  /** 脱敏错误说明（不含任何明文/密钥） */
  message?: string;
}

/** 失败归类 → 凭证 lastStatus（与 FailReason 一致，解密失败归 ERROR） */
export function failureToStatus(reason: FailReason | "DECRYPT_FAILED"): string {
  if (reason === "DECRYPT_FAILED") return "ERROR";
  return reason;
}

/** 将归一化余额落库为快照（每币种一条）；返回写入条数。供 refresh 与「提交即首余额」共用。 */
export async function writeSnapshots(
  credentialId: string,
  provider: ProviderAdapter["id"],
  data: import("@/lib/providers/types").NormalizedBalance,
  fetchedAt: Date = new Date()
): Promise<number> {
  const writes = data.balances.map((info) =>
    db.balanceSnapshot.create({
      data: {
        credentialId,
        provider,
        mode: "native",
        fetchedAt,
        currency: info.currency,
        available: info.available,
        breakdown: info.breakdown as Prisma.InputJsonValue,
        ...(info.raw !== null && info.raw !== undefined
          ? { raw: info.raw as Prisma.InputJsonValue }
          : {}),
        isAvailable: data.isAvailable,
        ok: true,
        stale: false,
      },
    })
  );
  await db.$transaction(writes);
  return writes.length;
}

export async function refreshCredential(
  cred: CredentialWithSecret,
  adapter: ProviderAdapter
): Promise<RefreshOneResult> {
  const base: RefreshOneResult = { credentialId: cred.id, ok: false, snapshots: 0 };

  // 1) 解密（失败 → ERROR 状态，不写快照）
  let payload;
  try {
    payload = decryptToPayload({
      iv: Buffer.from(cred.iv),
      authTag: Buffer.from(cred.authTag),
      ciphertext: Buffer.from(cred.ciphertext),
    });
  } catch (err) {
    await markFailure(cred.id, "ERROR");
    return {
      ...base,
      reason: "DECRYPT_FAILED",
      message: `decrypt failed (${err instanceof Error ? err.name : "unknown"})`,
    };
  }

  // 2) 调用平台余额接口（错误以返回值表达）
  const result = await adapter.fetchBalance({
    secret: payload,
    region: cred.region ?? undefined,
  });

  // 3) 失败：仅更新状态位，不写快照
  if (!result.ok) {
    await markFailure(cred.id, result.reason);
    return {
      ...base,
      reason: result.reason,
      message: result.message ?? `fetch failed (${result.reason})`,
    };
  }

  // 4) 成功：写快照 + 复位状态
  const now = new Date();
  const written = await writeSnapshots(cred.id, adapter.id, result.data, now);
  await db.credential.update({
    where: { id: cred.id },
    data: { lastStatus: "OK", failCount: 0, lastSuccessAt: now },
  });
  return { credentialId: cred.id, ok: true, snapshots: written };
}

async function markFailure(credentialId: string, status: string): Promise<void> {
  await db.credential
    .update({
      where: { id: credentialId },
      data: { lastStatus: status, failCount: { increment: 1 } },
    })
    .catch(() => {}); // DB 完全不可用时不抛出（留给下个周期）
}
