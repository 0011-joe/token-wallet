/**
 * KeysRepo 的 Prisma 实现（T2.1/T2.2/T2.3）。
 * 所有查询都以 (id, userId) 联合条件限定，确保只能操作当前用户自己的 Key。
 * 写入返回的 ApiKeyRecord 只含对外字段（id/label/last4/isActive/failCount/lastStatus/createdAt），
 * 密文（ciphertext/iv/authTag）不离开仓储层。
 */
import { db } from "@/lib/db";
import {
  DuplicateLast4Error,
  type ApiKeyRecord,
  type CreateKeyInput,
  type KeysRepo,
} from "./service";

type ApiKeyRow = {
  id: string;
  label: string;
  last4: string;
  isActive: boolean;
  failCount: number;
  lastStatus: string | null;
  createdAt: Date;
};

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    last4: row.last4,
    isActive: row.isActive,
    failCount: row.failCount,
    lastStatus: row.lastStatus,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

export const keysRepo: KeysRepo = {
  async findByLast4(userId, last4) {
    const row = await db.apiKey.findFirst({ where: { userId, last4 } });
    return row ? toRecord(row) : null;
  },

  async create(userId, input: CreateKeyInput) {
    try {
      const row = await db.apiKey.create({
        data: {
          userId,
          label: input.label,
          ciphertext: new Uint8Array(input.ciphertext),
          iv: new Uint8Array(input.iv),
          authTag: new Uint8Array(input.authTag),
          last4: input.last4,
          isActive: input.isActive,
        },
      });
      return toRecord(row);
    } catch (err) {
      // 并发场景下唯一约束兜底（service 侧已做 findByLast4 预检）
      if (isUniqueViolation(err)) throw new DuplicateLast4Error();
      throw err;
    }
  },

  async listByUser(userId) {
    const rows = await db.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  },

  async getById(userId, id) {
    const row = await db.apiKey.findFirst({ where: { id, userId } });
    return row ? toRecord(row) : null;
  },

  async updateById(userId, id, data) {
    const updated = await db.apiKey.updateMany({ where: { id, userId }, data });
    if (updated.count === 0) return null;
    const row = await db.apiKey.findUniqueOrThrow({ where: { id } });
    return toRecord(row);
  },

  async deleteById(userId, id) {
    const deleted = await db.apiKey.deleteMany({ where: { id, userId } });
    return deleted.count > 0;
  },
};
