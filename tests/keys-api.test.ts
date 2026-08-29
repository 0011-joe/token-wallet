/**
 * T2.1/T2.2/T2.3 Key 管理业务逻辑单测（service 层；route 为薄调用层）。
 * 不连真实网络与数据库：checkKey 与 repo 均为注入的内存实现。
 * 覆盖：格式校验、实测结果决定入库/拒绝、重复 last4 检测、启停/改名/删除归属校验。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptKey } from "../lib/crypto/key-vault";
import {
  DEFAULT_KEY_LABEL,
  addKey,
  deleteKey,
  deriveLast4,
  listKeys,
  updateKey,
  validateKeyFormat,
  type ApiKeyRecord,
  type CreateKeyInput,
  type KeysRepo,
} from "../lib/keys/service";
import type { BalanceResult } from "../lib/deepseek/client";

const ENCRYPTION_KEY = "a".repeat(64);
const VALID_KEY = "sk-aBcDefGhIjKlMnOpQrStUvWxYz012345D8d7"; // last4 = "D8d7"

beforeAll(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

interface StoredRow extends ApiKeyRecord {
  userId: string;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function toRecord(row: StoredRow): ApiKeyRecord {
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

/** 内存版 KeysRepo：记录密文字段用于断言加密正确性，但返回给业务层的 record 不含密文。 */
function memoryRepo(seed: Array<{ userId: string; last4: string }> = []) {
  const rows: StoredRow[] = seed.map((s, i) => ({
    id: `seed-${i}-${s.last4}`,
    userId: s.userId,
    label: "测试",
    last4: s.last4,
    isActive: true,
    failCount: 0,
    lastStatus: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ciphertext: Buffer.from([1]),
    iv: Buffer.from([2]),
    authTag: Buffer.from([3]),
  }));
  const repo: KeysRepo = {
    async findByLast4(userId, last4) {
      const row = rows.find((r) => r.userId === userId && r.last4 === last4);
      return row ? toRecord(row) : null;
    },
    async create(userId, input: CreateKeyInput) {
      const row: StoredRow = {
        id: `created-${rows.length}`,
        userId,
        label: input.label,
        last4: input.last4,
        isActive: input.isActive,
        failCount: 0,
        lastStatus: null,
        createdAt: new Date(),
        ciphertext: input.ciphertext,
        iv: input.iv,
        authTag: input.authTag,
      };
      rows.push(row);
      return toRecord(row);
    },
    async listByUser(userId) {
      return rows.filter((r) => r.userId === userId).map(toRecord);
    },
    async getById(userId, id) {
      const row = rows.find((r) => r.id === id && r.userId === userId);
      return row ? toRecord(row) : null;
    },
    async updateById(userId, id, data) {
      const row = rows.find((r) => r.id === id && r.userId === userId);
      if (!row) return null;
      if (data.isActive !== undefined) row.isActive = data.isActive;
      if (data.label !== undefined) row.label = data.label;
      return toRecord(row);
    },
    async deleteById(userId, id) {
      const idx = rows.findIndex((r) => r.id === id && r.userId === userId);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      return true;
    },
  };
  return { repo, rows };
}

const okCheck = (): Promise<BalanceResult> =>
  Promise.resolve({
    ok: true,
    isAvailable: true,
    balanceInfos: [
      {
        currency: "CNY",
        totalBalance: "6.32",
        grantedBalance: "0.00",
        toppedUpBalance: "6.32",
      },
    ],
  });

describe("validateKeyFormat（AC1-2 后端兜底）", () => {
  it("合法格式通过", () => {
    expect(validateKeyFormat("sk-12345678")).toBeNull();
    expect(validateKeyFormat("sk-AbCdEfGh9_-0")).toBeNull();
    expect(validateKeyFormat(`sk-${"X".repeat(35)}`)).toBeNull();
  });

  it("非法格式全部拒绝并给出可读原因", () => {
    expect(validateKeyFormat("")).toMatch(/缺少/);
    expect(validateKeyFormat("sk-1234567")).toMatch(/格式/); // 只有 7 位
    expect(validateKeyFormat("SK-12345678")).toMatch(/格式/); // 大写前缀
    expect(validateKeyFormat("sk-1234567!")).toMatch(/格式/); // 非法字符
    expect(validateKeyFormat("12345678")).toMatch(/格式/); // 无 sk- 前缀
    expect(validateKeyFormat("sk-12345678-extra-token")).toBeNull(); // 长串合法
  });
});

describe("deriveLast4", () => {
  it("取明文后 4 位", () => {
    expect(deriveLast4("sk-abcdefghij1234D8d7")).toBe("D8d7");
    expect(deriveLast4("sk-12345678")).toBe("5678");
  });
});

describe("addKey", () => {
  it("格式不合法 → 400，不调实测、不创建记录", async () => {
    const { repo, rows } = memoryRepo();
    const checkKey = vi.fn();
    const result = await addKey({
      userId: "u1",
      apiKey: "sk-123",
      label: "测试",
      checkKey,
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(checkKey).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("实测 INVALID → 422「Key 无效或已失效」，不创建任何记录（AC1-3）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addKey({
      userId: "u1",
      apiKey: VALID_KEY,
      checkKey: () =>
        Promise.resolve({
          ok: false,
          reason: "INVALID",
          statusCode: 401,
        } satisfies BalanceResult),
      repo,
    });
    expect(result).toEqual({ ok: false, status: 422, error: "Key 无效或已失效" });
    expect(rows).toHaveLength(0);
  });

  it("实测 RATE_LIMITED → 429，不创建记录（允许重试）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addKey({
      userId: "u1",
      apiKey: VALID_KEY,
      checkKey: () =>
        Promise.resolve({
          ok: false,
          reason: "RATE_LIMITED",
          statusCode: 429,
          message: "60",
        } satisfies BalanceResult),
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 429 });
    if (!result.ok) expect(result.error).toContain("429");
    expect(rows).toHaveLength(0);
  });

  it("实测 ERROR → 502，不创建记录（允许重试）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addKey({
      userId: "u1",
      apiKey: VALID_KEY,
      checkKey: () =>
        Promise.resolve({
          ok: false,
          reason: "ERROR",
          statusCode: 500,
        } satisfies BalanceResult),
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(rows).toHaveLength(0);
  });

  it("同 userId 下 last4 相同 → 409「该 Key 已绑定」，不重复创建（AC1-4）", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", last4: "D8d7" }]);
    const result = await addKey({
      userId: "u1",
      apiKey: VALID_KEY,
      checkKey: okCheck,
      repo,
    });
    expect(result).toEqual({ ok: false, status: 409, error: "该 Key 已绑定" });
    expect(rows).toHaveLength(1); // 没有新增
  });

  it("同 last4 不同 userId 不冲突（多用户各自独立）", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", last4: "D8d7" }]);
    const result = await addKey({
      userId: "u2",
      apiKey: VALID_KEY,
      checkKey: okCheck,
      repo,
    });
    expect(result.ok).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("有效且不重复：加密入库存 last4、默认标签、isActive，响应不含明文", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addKey({
      userId: "u1",
      apiKey: VALID_KEY,
      checkKey: okCheck,
      repo,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.last4).toBe("D8d7");
    expect(result.record.label).toBe(DEFAULT_KEY_LABEL);
    expect(result.record.isActive).toBe(true);
    // 对外 record 序列化绝不出现明文
    expect(JSON.stringify(result.record)).not.toContain(VALID_KEY);
    // 落库的是密文且可逆
    const stored = rows[0];
    expect(stored.ciphertext).toBeDefined();
    expect(
      decryptKey({ iv: stored.iv, authTag: stored.authTag, ciphertext: stored.ciphertext })
    ).toBe(VALID_KEY);
  });

  it("自定义 label 生效", async () => {
    const { repo } = memoryRepo();
    const result = await addKey({
      userId: "u1",
      apiKey: VALID_KEY,
      label: " 正式环境 ",
      checkKey: okCheck,
      repo,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.label).toBe("正式环境");
  });
});

describe("updateKey（启停/改名，T2.3）", () => {
  it("不存在或非本用户 → 404", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", last4: "abcd" }]);
    const result = await updateKey({
      userId: "u2",
      id: rows[0].id,
      isActive: false,
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("本用户可启停与改名", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", last4: "abcd" }]);
    const result = await updateKey({
      userId: "u1",
      id: rows[0].id,
      isActive: false,
      label: "正式环境",
      repo,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.isActive).toBe(false);
      expect(result.record.label).toBe("正式环境");
    }
  });
});

describe("deleteKey（T2.3，快照由 Cascade 连带删除）", () => {
  it("删除存在且属本用户的 Key", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", last4: "abcd" }]);
    const result = await deleteKey({ userId: "u1", id: rows[0].id, repo });
    expect(result).toEqual({ ok: true });
    expect(rows).toHaveLength(0);
  });

  it("非本用户的 Key → 404 且不删除", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", last4: "abcd" }]);
    const result = await deleteKey({ userId: "u9", id: rows[0].id, repo });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(rows).toHaveLength(1);
  });

  it("不存在的 id → 404", async () => {
    const { repo } = memoryRepo();
    const result = await deleteKey({ userId: "u1", id: "nope", repo });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});

describe("listKeys（T2.2）", () => {
  it("只返回当前用户的 Key，字段不含密文", async () => {
    const { repo } = memoryRepo([
      { userId: "u1", last4: "aaaa" },
      { userId: "u2", last4: "bbbb" },
    ]);
    const keys = await listKeys("u1", repo);
    expect(keys).toHaveLength(1);
    expect(keys[0].last4).toBe("aaaa");
    expect(JSON.stringify(keys)).not.toContain("ciphertext");
  });
});
