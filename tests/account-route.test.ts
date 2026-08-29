/**
 * M7/T7.2 账户接口集成自测（AC6-2 / 导出红线）。
 * mock next-auth 会话（与 tests/usage-models-route.test.ts 同法），走真实 DB。
 *
 * 覆盖：
 * - 未登录 401；confirm 非 true（缺失/错误值/非法 JSON）→ 400；
 * - confirm=true → 204：user/apiKey/snapshot/alertSetting/alertEvent/usageImport 全部删除，
 *   且全局 isActive=true 的 Key 集合不再包含已删 Key（AC6-2「不再被定时任务调用」的数据面证据）；
 * - 导出：200 + Content-Disposition attachment；JSON 只含元信息，
 *   绝无 ciphertext/iv/authTag，响应原文既不含密文 base64 也不含明文 Key。
 *
 * 用户以唯一 id 创建，afterAll 清理（AlertEvent/UsageImport 无级联，先手动删再删用户）。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/auth", () => ({ authOptions: {} }));

import { getServerSession } from "next-auth";
import { DELETE } from "../app/api/account/route";
import { GET as exportGET } from "../app/api/account/export/route";
import { db } from "../lib/db";
import { encryptKey } from "../lib/crypto/key-vault";

const RUN = Date.now();
const EMAIL = `unit-account-${RUN}@test.local`;
const USER_ID = `unit-account-${RUN}`;
/** 测试假 Key：明文仅用于灌库时加密；断言导出不出现它 */
const PLAINTEXT_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789A1B2";
const LAST4 = PLAINTEXT_KEY.slice(-4);
const MONTH = "2099-07";

const mockSession = vi.mocked(getServerSession);
function session(email: string): Session {
  return { user: { email }, expires: "2099-01-01T00:00:00.000Z" } as Session;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

/** 每次测试前先清残留（先删无 relation 的表，再删用户），再重建用户。 */
beforeEach(async () => {
  await db.alertEvent.deleteMany({ where: { userId: USER_ID } });
  await db.usageImport.deleteMany({ where: { userId: USER_ID } });
  await db.user.deleteMany({ where: { email: EMAIL } });
  await db.user.create({ data: { id: USER_ID, email: EMAIL } });
});

/** 灌入：1 个 Key + 1 条快照 + 1 个月份导入 + 预警设置 + 1 条预警事件。 */
async function seedAccount() {
  const enc = encryptKey(PLAINTEXT_KEY);
  const key = await db.apiKey.create({
    data: {
      userId: USER_ID,
      label: "测试Key",
      ciphertext: new Uint8Array(enc.ciphertext),
      iv: new Uint8Array(enc.iv),
      authTag: new Uint8Array(enc.authTag),
      last4: LAST4,
      isActive: true,
    },
  });
  await db.balanceSnapshot.create({
    data: {
      apiKeyId: key.id,
      fetchedAt: new Date(),
      currency: "CNY",
      totalBalance: 100,
      grantedBalance: 0,
      toppedUpBalance: 100,
      isAvailable: true,
      ok: true,
    },
  });
  await db.usageImport.create({
    data: { userId: USER_ID, month: MONTH, fileName: "amount.csv" },
  });
  await db.alertSetting.create({ data: { userId: USER_ID } });
  await db.alertEvent.create({
    data: {
      userId: USER_ID,
      apiKeyId: key.id,
      type: "LOW_BALANCE",
      message: "余额低于阈值",
      dedupKey: `unit-account-${RUN}-dedup`,
    },
  });
  return { key, enc };
}

function deleteRequest(body: unknown): Request {
  return new Request("http://x/api/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("DELETE /api/account（AC6-2）", () => {
  it("未登录 → 401", async () => {
    mockSession.mockResolvedValue(null);
    const res = await DELETE(deleteRequest({ confirm: true }));
    expect(res.status).toBe(401);
  });

  it("confirm 缺失 / 非 true / 非法 JSON → 400", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    expect((await DELETE(deleteRequest({}))).status).toBe(400);
    expect((await DELETE(deleteRequest({ confirm: "yes" }))).status).toBe(400);
    expect((await DELETE(deleteRequest({ confirm: 1 }))).status).toBe(400);
    expect((await DELETE(deleteRequest("not-json"))).status).toBe(400);
  });

  it("confirm=true → 204，用户与全部关联数据删除，active Key 集合不再含该 Key", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const { key } = await seedAccount();

    const res = await DELETE(deleteRequest({ confirm: true }));
    expect(res.status).toBe(204);

    expect(await db.user.findUnique({ where: { id: USER_ID } })).toBeNull();
    expect(await db.apiKey.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await db.balanceSnapshot.count({ where: { apiKeyId: key.id } })).toBe(0);
    expect(await db.alertSetting.count({ where: { userId: USER_ID } })).toBe(0);
    // AlertEvent / UsageImport 无 User relation、无自动级联：必须被 deleteAccount 手动删
    expect(await db.alertEvent.count({ where: { userId: USER_ID } })).toBe(0);
    expect(await db.usageImport.count({ where: { userId: USER_ID } })).toBe(0);
    // 数据面证据（AC6-2「不再被定时任务调用」）：cron 遍历的 isActive=true 集合已无本用户 Key
    const activeKeys = await db.apiKey.findMany({ where: { isActive: true } });
    expect(activeKeys.some((k) => k.id === key.id)).toBe(false);
  });

  it("用户已不存在（并发注销竞态）→ 405 之外的确定性错误：会话查询不到用户 → 401", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    await db.user.delete({ where: { id: USER_ID } });
    // currentUser 以 email 回查不到 → 未登录语义
    const res = await DELETE(deleteRequest({ confirm: true }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/account/export", () => {
  it("导出：附件下载、元信息齐全、无密文/无明文 Key（红线）", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const { enc } = await seedAccount();

    const res = await exportGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const raw = await res.text();
    // 响应原文级红线：不得出现密文 base64 与明文 Key
    expect(raw).not.toContain(Buffer.from(enc.ciphertext).toString("base64"));
    expect(raw).not.toContain(PLAINTEXT_KEY);

    const body = JSON.parse(raw);
    expect(body.user.email).toBe(EMAIL);
    expect(body.exports?.[0]).toBeUndefined(); // 惰性断言：不存在 export 类字段（防未来误加）
    expect(body.keys).toHaveLength(1);
    const k = body.keys[0];
    expect(k).toMatchObject({ label: "测试Key", last4: LAST4, isActive: true });
    expect(k).not.toHaveProperty("ciphertext");
    expect(k).not.toHaveProperty("iv");
    expect(k).not.toHaveProperty("authTag");
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]).not.toHaveProperty("apiKeyId");
    expect(body.snapshots[0]).toHaveProperty("currency");
    expect(body.usageImports.map((i: { month: string }) => i.month)).toContain(MONTH);
    expect(body.alertSetting).not.toBeNull();
  });

  it("未登录 → 401", async () => {
    mockSession.mockResolvedValue(null);
    const res = await exportGET();
    expect(res.status).toBe(401);
  });
});

afterAll(async () => {
  // 与 beforeEach 同序清理：AlertEvent/UsageImport 无级联需先手动删
  await db.alertEvent.deleteMany({ where: { userId: USER_ID } });
  await db.usageImport.deleteMany({ where: { userId: USER_ID } });
  await db.user.deleteMany({ where: { email: EMAIL } });
  delete process.env.ENCRYPTION_KEY;
  await db.$disconnect();
});
