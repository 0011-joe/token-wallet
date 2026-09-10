/**
 * CredentialsRepo 的 Prisma 实现（M1）。
 * 所有查询都以 (id, userId) 联合条件限定，确保只能操作当前用户自己的凭证；
 * 对外只暴露 CredentialRecord（不含密文字段）；密文经 getSecretBlobById 单独取出
 * （仅供 cron/refresh 解密使用，绝不进入响应）。
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { ProviderId } from "@/lib/providers/types";
import {
  DuplicateCredentialError,
  type CredentialRecord,
  type CreateCredentialInput,
  type CredentialsRepo,
} from "./service";

type CredentialRow = {
  id: string;
  provider: ProviderId;
  kind: "bearer" | "aksk";
  region: string | null;
  label: string;
  hint: string;
  meta: Prisma.JsonValue | null;
  isActive: boolean;
  failCount: number;
  lastStatus: string | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
};

function toRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    region: row.region,
    label: row.label,
    hint: row.hint,
    meta: row.meta,
    isActive: row.isActive,
    failCount: row.failCount,
    lastStatus: row.lastStatus,
    lastSuccessAt: row.lastSuccessAt,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

export const credentialsRepo: CredentialsRepo = {
  async findByProviderAndHint(userId, provider, hint) {
    const row = await db.credential.findFirst({ where: { userId, provider, hint } });
    return row ? toRecord(row) : null;
  },

  async create(userId, input: CreateCredentialInput) {
    try {
      const row = await db.credential.create({
        data: {
          userId,
          provider: input.provider,
          kind: input.kind,
          region: input.region,
          label: input.label,
          secretCipher: new Uint8Array(input.secretCipher),
          iv: new Uint8Array(input.iv),
          authTag: new Uint8Array(input.authTag),
          hint: input.hint,
          ...(input.meta !== null ? { meta: input.meta } : {}),
          keyVersion: input.keyVersion,
          isActive: input.isActive,
        },
      });
      return toRecord(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCredentialError();
      throw err;
    }
  },

  async listByUser(userId) {
    const rows = await db.credential.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  },

  async getById(userId, id) {
    const row = await db.credential.findFirst({ where: { id, userId } });
    return row ? toRecord(row) : null;
  },

  async updateById(userId, id, data) {
    const updated = await db.credential.updateMany({ where: { id, userId }, data });
    if (updated.count === 0) return null;
    const row = await db.credential.findUniqueOrThrow({ where: { id } });
    return toRecord(row);
  },

  async deleteById(userId, id) {
    const deleted = await db.credential.deleteMany({ where: { id, userId } });
    return deleted.count > 0;
  },
};

/** cron/refresh 专用：取密文字段（不进入任何对外响应）。 */
export interface CredentialSecretBlob {
  iv: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
}

export async function getSecretBlobById(userId: string, id: string): Promise<CredentialSecretBlob | null> {
  const row = await db.credential.findFirst({
    where: { id, userId },
    select: { iv: true, authTag: true, secretCipher: true },
  });
  if (!row) return null;
  return { iv: row.iv, authTag: row.authTag, ciphertext: row.secretCipher };
}

/** cron 专用：全部启用凭证（含密文 + userId），供快照遍历解密与告警派发。 */
export async function listActiveCredentialsWithSecret(): Promise<
  Array<CredentialRecord & CredentialSecretBlob & { userId: string }>
> {
  const rows = await db.credential.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    ...toRecord(row),
    userId: row.userId,
    iv: row.iv,
    authTag: row.authTag,
    ciphertext: row.secretCipher,
  }));
}
