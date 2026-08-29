import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptKey } from "@/lib/crypto/key-vault";
import { fetchBalance } from "@/lib/deepseek/client";
import { getCurrentUser } from "@/lib/auth/current-user";

/**
 * 立即刷新余额（手动触发）：复刻 cron 的单 Key 快照逻辑——
 * 实时调用官方 /user/balance，成功则写入一条新快照（ok=true、每币种一条）
 * 并重置 lastStatus/failCount；失败仅更新状态，不写快照（AC2-3 语义）。
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const { id } = await params;
  const key = await db.apiKey.findUnique({ where: { id } });
  if (!key || key.userId !== user.id) {
    return NextResponse.json({ ok: false, error: "Key 不存在" }, { status: 404 });
  }
  if (!key.isActive) {
    return NextResponse.json({ ok: false, error: "该 Key 已停用" }, { status: 400 });
  }

  let plain: string;
  try {
    plain = decryptKey({
      iv: Buffer.from(key.iv),
      authTag: Buffer.from(key.authTag),
      ciphertext: Buffer.from(key.ciphertext),
    });
  } catch {
    await db.apiKey.update({
      where: { id: key.id },
      data: { lastStatus: "ERROR", failCount: { increment: 1 } },
    });
    return NextResponse.json(
      { ok: false, error: "Key 解密失败（密钥配置异常）" },
      { status: 500 }
    );
  }

  const result = await fetchBalance(plain);
  if (!result.ok) {
    const status =
      result.reason === "INVALID" ? "INVALID"
      : result.reason === "RATE_LIMITED" ? "RATE_LIMITED"
      : "ERROR";
    await db.apiKey.update({
      where: { id: key.id },
      data: { lastStatus: status, failCount: { increment: 1 } },
    });
    const msg =
      result.reason === "INVALID"
        ? "Key 无效或已失效"
        : result.reason === "RATE_LIMITED"
          ? "官方接口限流，请稍后重试"
          : "官方接口请求失败，请稍后重试";
    return NextResponse.json(
      { ok: false, error: msg, reason: result.reason },
      { status: result.reason === "INVALID" ? 422 : 502 }
    );
  }

  const now = new Date();
  await db.$transaction([
    ...result.balanceInfos.map((b) =>
      db.balanceSnapshot.create({
        data: {
          apiKeyId: key.id,
          fetchedAt: now,
          currency: b.currency,
          totalBalance: Number(b.totalBalance),
          grantedBalance: Number(b.grantedBalance),
          toppedUpBalance: Number(b.toppedUpBalance),
          isAvailable: result.isAvailable,
          ok: true,
        },
      })
    ),
    db.apiKey.update({
      where: { id: key.id },
      data: { lastStatus: "OK", failCount: 0 },
    }),
  ]);

  const primary =
    result.balanceInfos.find((b) => b.currency === "CNY") ?? result.balanceInfos[0];
  return NextResponse.json({
    ok: true,
    isAvailable: result.isAvailable,
    balance: {
      currency: primary?.currency ?? null,
      total: Number(primary?.totalBalance ?? 0),
      granted: Number(primary?.grantedBalance ?? 0),
      toppedUp: Number(primary?.toppedUpBalance ?? 0),
    },
    fetchedAt: now.toISOString(),
  });
}
