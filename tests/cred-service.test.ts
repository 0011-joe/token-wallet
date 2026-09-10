/**
 * M1 凭证管理业务逻辑单测（service 层；route 为薄调用层）。
 * 不连真实网络与数据库：testFn 与 repo 均为注入的内存实现。
 * 覆盖：格式校验（bearer/aksk）、实测结果决定入库/拒绝（含 FORBIDDEN_SCOPE）、
 * 重复检测（[userId, provider, hint]）、启停/改名/删除归属校验、密文双格式。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptToPayload } from "../lib/crypto/keyvault";
import {
  DEFAULT_CREDENTIAL_LABEL,
  addCredential,
  deleteCredential,
  deriveHint,
  listCredentials,
  updateCredential,
  validateCredentialInput,
  type CredentialRecord,
  type CreateCredentialInput,
  type CredentialsRepo,
  type TestCredentialFn,
} from "../lib/credentials/service";

const ENCRYPTION_KEY = "a".repeat(64);
const VALID_KEY = "sk-aBcDefGhIjKlMnOpQrStUvWxYz012345D8d7"; // last4 = "D8d7"

beforeAll(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

interface StoredRow extends CredentialRecord {
  userId: string;
  secretCipher: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function toRecord(row: StoredRow): CredentialRecord {
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

function memoryRepo(seed: Array<{ userId: string; hint: string; provider?: CredentialRecord["provider"] }> = []) {
  const rows: StoredRow[] = seed.map((s, i) => ({
    id: `seed-${i}-${s.hint}`,
    userId: s.userId,
    provider: s.provider ?? "deepseek",
    kind: "bearer",
    region: null,
    label: "测试",
    hint: s.hint,
    meta: null,
    isActive: true,
    failCount: 0,
    lastStatus: null,
    lastSuccessAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    secretCipher: Buffer.from([1]),
    iv: Buffer.from([2]),
    authTag: Buffer.from([3]),
  }));
  const repo: CredentialsRepo = {
    async findByProviderAndHint(userId, provider, hint) {
      const row = rows.find((r) => r.userId === userId && r.provider === provider && r.hint === hint);
      return row ? toRecord(row) : null;
    },
    async create(userId, input: CreateCredentialInput) {
      const row: StoredRow = {
        id: `created-${rows.length}`,
        userId,
        provider: input.provider,
        kind: input.kind,
        region: input.region,
        label: input.label,
        hint: input.hint,
        meta: null,
        isActive: input.isActive,
        failCount: 0,
        lastStatus: null,
        lastSuccessAt: null,
        createdAt: new Date(),
        secretCipher: input.secretCipher,
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

const okTest: TestCredentialFn = () =>
  Promise.resolve({
    ok: true,
    balance: {
      mode: "native",
      isAvailable: true,
      balances: [
        {
          currency: "CNY",
          available: "6.320000000",
          breakdown: { cash: "6.320000000", granted: "0.000000000" },
          raw: {},
        },
      ],
    },
  });

describe("validateCredentialInput（AC1.2 后端兜底）", () => {
  it("bearer 合法格式通过", () => {
    expect(validateCredentialInput({ provider: "deepseek", kind: "bearer", secret: { key: "sk-12345678" } })).toBeNull();
    expect(validateCredentialInput({ provider: "kimi", kind: "bearer", secret: { key: "sk-AbCdEfGh9_-0" } })).toBeNull();
  });

  it("bearer 非法格式拒绝并给出可读原因", () => {
    expect(validateCredentialInput({ provider: "deepseek", kind: "bearer", secret: {} })).toMatch(/缺少/);
    expect(validateCredentialInput({ provider: "deepseek", kind: "bearer", secret: { key: "sk-1234567" } })).toMatch(/格式/);
    expect(validateCredentialInput({ provider: "deepseek", kind: "bearer", secret: { key: "SK-12345678" } })).toMatch(/格式/);
  });

  it("aksk：只允许 volcengine；AK 必须 AKLT 开头（拒绝 ARK 推理 Key 等）", () => {
    expect(
      validateCredentialInput({ provider: "deepseek", kind: "aksk", secret: { ak: "AKLTx", sk: "s" } })
    ).toMatch(/不支持/);
    expect(
      validateCredentialInput({ provider: "volcengine", kind: "aksk", secret: { ak: "AKLT12345678901234", sk: "secret" } })
    ).toBeNull();
    expect(
      validateCredentialInput({ provider: "volcengine", kind: "aksk", secret: { ak: "AKLT12345678", sk: "secret" } })
    ).toBeNull();
    expect(
      validateCredentialInput({ provider: "volcengine", kind: "aksk", secret: { ak: "uuid-like-ark-key", sk: "secret" } })
    ).toMatch(/格式/);
    expect(
      validateCredentialInput({ provider: "volcengine", kind: "aksk", secret: { ak: "AKLT1234567890" } })
    ).toMatch(/缺少 Secret/);
  });
});

describe("deriveHint（脱敏标识）", () => {
  it("bearer → 后 4 位", () => {
    expect(deriveHint("bearer", { key: "sk-abcdefghij1234D8d7" })).toBe("D8d7");
  });
  it("aksk → AK 前缀 + 尾 4 位，SK 不参与", () => {
    expect(deriveHint("aksk", { ak: "AKLT1234567890abcd", sk: "supersecret" })).toBe("AKLT****abcd");
  });
});

describe("addCredential", () => {
  it("格式不合法 → 400，不调实测、不创建记录", async () => {
    const { repo, rows } = memoryRepo();
    const testFn = vi.fn();
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: "sk-123" },
      testFn,
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(testFn).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("实测 INVALID → 422 可操作原因，不创建任何记录（AC1-2/1.3）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: VALID_KEY },
      testFn: () => Promise.resolve({ ok: false, reason: "INVALID", statusCode: 401 }),
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (!result.ok) expect(result.error).toMatch(/无效/);
    expect(rows).toHaveLength(0);
  });

  it("实测 FORBIDDEN_SCOPE → 422 提示只读 IAM 子用户", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "volcengine",
      kind: "aksk",
      secret: { ak: "AKLT12345678901234", sk: "secret" },
      testFn: () => Promise.resolve({ ok: false, reason: "FORBIDDEN_SCOPE", statusCode: 200 }),
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (!result.ok) expect(result.error).toMatch(/只读/);
    expect(rows).toHaveLength(0);
  });

  it("实测 RATE_LIMITED → 429，不创建记录（允许重试）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: VALID_KEY },
      testFn: () => Promise.resolve({ ok: false, reason: "RATE_LIMITED", statusCode: 429, message: "60" }),
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(rows).toHaveLength(0);
  });

  it("实测 ERROR → 502，不创建记录（允许重试）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: VALID_KEY },
      testFn: () => Promise.resolve({ ok: false, reason: "ERROR", statusCode: 500 }),
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(rows).toHaveLength(0);
  });

  it("同 userId 同 provider 同 hint → 409，不重复创建（AC1 去重）", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", hint: "D8d7" }]);
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: VALID_KEY },
      testFn: okTest,
      repo,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(rows).toHaveLength(1);
  });

  it("同 hint 不同 provider 不冲突", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", hint: "D8d7", provider: "deepseek" }]);
    const result = await addCredential({
      userId: "u1",
      provider: "kimi",
      kind: "bearer",
      secret: { key: VALID_KEY },
      testFn: okTest,
      repo,
    });
    expect(result.ok).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("有效且不重复：信封密文落库、hint 正确、响应不含明文（AC1.4）", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: VALID_KEY },
      testFn: okTest,
      repo,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.hint).toBe("D8d7");
    expect(result.record.label).toBe(DEFAULT_CREDENTIAL_LABEL);
    expect(result.record.isActive).toBe(true);
    expect(JSON.stringify(result.record)).not.toContain(VALID_KEY);
    const stored = rows[0];
    const payload = decryptToPayload({ iv: stored.iv, authTag: stored.authTag, ciphertext: stored.secretCipher });
    expect(payload).toEqual({ key: VALID_KEY });
    expect(result.test.balance.balances[0].available).toBe("6.320000000");
  });

  it("aksk 凭证：ak+sk 双字段信封往返", async () => {
    const { repo, rows } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "volcengine",
      kind: "aksk",
      secret: { ak: "AKLT1234567890abcd", sk: "super-secret-sk" },
      testFn: okTest,
      repo,
    });
    expect(result.ok).toBe(true);
    const stored = rows[0];
    const payload = decryptToPayload({ iv: stored.iv, authTag: stored.authTag, ciphertext: stored.secretCipher });
    expect(payload).toEqual({ ak: "AKLT1234567890abcd", sk: "super-secret-sk" });
    expect(JSON.stringify(result)).not.toContain("super-secret-sk");
  });

  it("自定义 label 生效（trim）", async () => {
    const { repo } = memoryRepo();
    const result = await addCredential({
      userId: "u1",
      provider: "deepseek",
      kind: "bearer",
      secret: { key: VALID_KEY },
      label: " 正式环境 ",
      testFn: okTest,
      repo,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.label).toBe("正式环境");
  });
});

describe("listCredentials / updateCredential / deleteCredential", () => {
  it("listCredentials 只返回当前用户", async () => {
    const { repo } = memoryRepo([
      { userId: "u1", hint: "aaaa" },
      { userId: "u2", hint: "bbbb" },
    ]);
    const list = await listCredentials("u1", repo);
    expect(list).toHaveLength(1);
    expect(list[0].hint).toBe("aaaa");
  });

  it("updateCredential：非本用户 → 404；本用户可启停改名", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", hint: "abcd" }]);
    const denied = await updateCredential({ userId: "u2", id: rows[0].id, isActive: false, repo });
    expect(denied).toMatchObject({ ok: false, status: 404 });
    const ok = await updateCredential({ userId: "u1", id: rows[0].id, isActive: false, label: "正式环境", repo });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.record.isActive).toBe(false);
      expect(ok.record.label).toBe("正式环境");
    }
  });

  it("deleteCredential：存在且属本用户 → 删除；否则 404 不删", async () => {
    const { repo, rows } = memoryRepo([{ userId: "u1", hint: "abcd" }]);
    const denied = await deleteCredential({ userId: "u9", id: rows[0].id, repo });
    expect(denied).toMatchObject({ ok: false, status: 404 });
    expect(rows).toHaveLength(1);
    const ok = await deleteCredential({ userId: "u1", id: rows[0].id, repo });
    expect(ok).toEqual({ ok: true });
    expect(rows).toHaveLength(0);
  });
});
