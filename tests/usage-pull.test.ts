/**
 * 用量拉取管线单测：
 * 1. UsageRow → ParsedUsageRow 按月分组与费用拆分（纯函数，无 DB）
 * 2. dispatchUsagePull 动态模块容错 / 函数探测 / 异常包装（注入 resolver）
 * 3. POST /api/usage/pull 路由：鉴权、参数、501 not ready、unsupported、derived 入库覆盖
 *
 * 与 CSV 导入关系：同月 pull 覆盖 UsageImport（幂等键 userId+provider+month），不翻倍。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/auth", () => ({ authOptions: {} }));

import { getServerSession } from "next-auth";
import { POST } from "../app/api/usage/pull/route";
import { db } from "../lib/db";
import {
  PULL_FILE_NAME,
  PULL_UNKNOWN_MODEL,
  dispatchUsagePull,
  groupPullRowsByMonth,
  latestMonth,
  setUsageModuleResolver,
  type UsagePullResult,
  type UsageRow,
} from "../lib/usage/provider-pull";

const describeDb = describe.skipIf(!process.env.DATABASE_URL);

const mockSession = vi.mocked(getServerSession);
function session(email: string | null): Session {
  return { user: { email }, expires: "2099-01-01T00:00:00.000Z" } as Session;
}

// ── 1. 纯函数：按月分组 ──

describe("groupPullRowsByMonth", () => {
  it("按 date 前缀分月；无 model 用占位；仅有 cost 时 amount=0", () => {
    const rows: UsageRow[] = [
      { date: "2026-01-15", cost: "1.500000000" },
      { date: "2026-01-31", cost: "0.500000000" },
      { date: "2026-02-01", model: "moonshot-v1", cost: "2.000000000" },
    ];
    const map = groupPullRowsByMonth(rows);
    expect([...map.keys()].sort()).toEqual(["2026-01", "2026-02"]);

    const jan = map.get("2026-01")!;
    expect(jan).toHaveLength(2);
    expect(jan[0].model).toBe(PULL_UNKNOWN_MODEL);
    expect(jan[0].type).toBe("output_tokens");
    expect(jan[0].amount).toBe(0);
    expect(jan[0].apiKeyRef).toBeNull();
    // cost 规范为 Decimal 数值（toMoney → Number）
    expect(jan[0].cost).toBeCloseTo(1.5, 9);
    expect(jan[1].cost).toBeCloseTo(0.5, 9);

    expect(map.get("2026-02")![0].model).toBe("moonshot-v1");
  });

  it("prompt/completion 按 token 比例拆费用，unitPrice = cost/amount", () => {
    const rows: UsageRow[] = [
      {
        date: "2026-03-10",
        model: "m1",
        promptTokens: 100,
        completionTokens: 300,
        cost: "4.000000000",
      },
    ];
    const list = groupPullRowsByMonth(rows).get("2026-03")!;
    expect(list).toHaveLength(2);

    const input = list.find((r) => r.type === "input_cache_miss_tokens")!;
    const output = list.find((r) => r.type === "output_tokens")!;
    expect(input.amount).toBe(100);
    expect(output.amount).toBe(300);
    expect(input.cost).toBeCloseTo(1.0, 9);
    expect(output.cost).toBeCloseTo(3.0, 9);
    expect(input.unitPrice).toBeCloseTo(0.01, 9);
    expect(output.unitPrice).toBeCloseTo(0.01, 9);
  });

  it("非法 date / 负 token / 非法 cost 不炸，跳过或归零", () => {
    const rows: UsageRow[] = [
      { date: "not-a-date", cost: "1" },
      { date: "2026-04-01", promptTokens: -5, completionTokens: Number.NaN, cost: "oops" },
    ];
    const map = groupPullRowsByMonth(rows);
    expect(map.has("2026-04")).toBe(true);
    const list = map.get("2026-04")!;
    expect(list[0].amount).toBe(0);
    expect(list[0].cost).toBe(0);
    // 非法 date 不产生月份
    expect([...map.keys()]).toEqual(["2026-04"]);
  });

  it("latestMonth 取字典序最大（即时间最新）", () => {
    expect(latestMonth(["2026-01", "2026-03", "2026-02"])).toBe("2026-03");
    expect(latestMonth([])).toBeNull();
  });
});

// ── 2. dispatchUsagePull（注入 resolver，不碰真实动态 import） ──

describe("dispatchUsagePull", () => {
  afterEach(() => {
    setUsageModuleResolver(null);
  });

  it("模块未就绪 → notReady", async () => {
    setUsageModuleResolver(async () => null);
    const r = await dispatchUsagePull("volcengine", {});
    expect(r).toEqual({ ok: false, notReady: true, provider: "volcengine" });
  });

  it("模块存在但无 pull 导出 → notReady", async () => {
    setUsageModuleResolver(async () => ({ somethingElse: 1 }));
    const r = await dispatchUsagePull("kimi", {});
    expect(r).toMatchObject({ ok: false, notReady: true });
  });

  it("resolver 抛错 → notReady（容错）", async () => {
    setUsageModuleResolver(async () => {
      throw new Error("module missing");
    });
    const r = await dispatchUsagePull("kimi", {});
    expect(r).toMatchObject({ ok: false, notReady: true });
  });

  it("命中 pullKimiUsage 并透传结果", async () => {
    const result: UsagePullResult = {
      ok: true,
      mode: "unsupported",
      rows: [],
      currency: "CNY",
      note: "no api",
    };
    setUsageModuleResolver(async () => ({
      pullKimiUsage: vi.fn(async () => result),
    }));
    const r = await dispatchUsagePull("kimi", { snapshots: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual(result);
  });

  it("pull 抛错 → 包装为 PULL_THREW", async () => {
    setUsageModuleResolver(async () => ({
      pullVolcUsage: vi.fn(async () => {
        throw new Error("upstream boom");
      }),
    }));
    const r = await dispatchUsagePull("volcengine", {});
    expect(r).toMatchObject({
      ok: false,
      notReady: false,
      reason: "PULL_THREW",
      message: "upstream boom",
    });
  });
});

// ── 3. 路由 ──

describe("POST /api/usage/pull 鉴权与参数（无 DB）", () => {
  afterEach(() => {
    setUsageModuleResolver(null);
    mockSession.mockReset();
  });

  it("未登录 → 401", async () => {
    mockSession.mockResolvedValue(null);
    const res = await POST(
      new Request("http://x/api/usage/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "kimi" }),
      })
    );
    expect(res.status).toBe(401);
  });
});

// ── 路由集成（需测试库） ──

const EMAIL = `unit-pull-${Date.now()}@test.local`;
const USER_ID = `unit-pull-${Date.now()}`;
const MONTH = "2099-08";

describeDb("POST /api/usage/pull 集成", () => {
  beforeAll(async () => {
    await db.user.create({ data: { id: USER_ID, email: EMAIL } });
  });

  afterAll(async () => {
    setUsageModuleResolver(null);
    await db.usageImport.deleteMany({ where: { userId: USER_ID } });
    await db.credential.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
  });

  afterEach(() => {
    setUsageModuleResolver(null);
    mockSession.mockReset();
  });

  function pullReq(body: unknown): Request {
    return new Request("http://x/api/usage/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("非法 provider / 非 JSON → 400", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const badProvider = await POST(pullReq({ provider: "nope" }));
    expect(badProvider.status).toBe(400);

    const badJson = await POST(
      new Request("http://x/api/usage/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(badJson.status).toBe(400);
  });

  it("无该平台凭证 → 400", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const res = await POST(pullReq({ provider: "kimi" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("凭证");
  });

  it("模块未就绪 → 501 provider usage not ready", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    // 建一条假凭证（不校验密文，因为 501 发生在 pull 阶段之前仍会读快照/解密；
    // 解密失败不影响 dispatch；此处用占位密文保证 findFirst 命中）
    const cred = await db.credential.create({
      data: {
        userId: USER_ID,
        provider: "volcengine",
        kind: "aksk",
        label: "pull-test",
        secretCipher: Buffer.from([1, 2, 3]),
        iv: Buffer.from([1, 2, 3]),
        authTag: Buffer.from([1, 2, 3]),
        hint: "AKLT-test-0001",
      },
    });
    setUsageModuleResolver(async () => null);

    const res = await POST(pullReq({ provider: "volcengine", credentialId: cred.id }));
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("provider usage not ready");
    expect(body.message).toContain("CSV");

    await db.credential.delete({ where: { id: cred.id } });
  });

  it("mode=unsupported → 200 + note，不入库", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const cred = await db.credential.create({
      data: {
        userId: USER_ID,
        provider: "kimi",
        kind: "bearer",
        label: "pull-kimi",
        secretCipher: Buffer.from([1]),
        iv: Buffer.from([1]),
        authTag: Buffer.from([1]),
        hint: "sk-****0001",
      },
    });
    setUsageModuleResolver(async () => ({
      pullKimiUsage: async () => ({
        ok: true as const,
        mode: "unsupported" as const,
        rows: [],
        currency: "CNY",
        note: "快照不足，无法估算",
      }),
    }));

    const res = await POST(pullReq({ provider: "kimi", credentialId: cred.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      note: string;
      rows: number;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("unsupported");
    expect(body.note).toContain("快照不足");
    expect(body.rows).toBe(0);

    const imp = await db.usageImport.findUnique({
      where: {
        userId_provider_month: { userId: USER_ID, provider: "kimi", month: MONTH },
      },
    });
    expect(imp).toBeNull();

    await db.credential.delete({ where: { id: cred.id } });
  });

  it("mode=derived → 入库并覆盖同月（幂等）；fileName=api-pull", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const cred = await db.credential.create({
      data: {
        userId: USER_ID,
        provider: "kimi",
        kind: "bearer",
        label: "pull-derived",
        secretCipher: Buffer.from([1]),
        iv: Buffer.from([1]),
        authTag: Buffer.from([1]),
        hint: "sk-****0002",
      },
    });

    const derivedResult: UsagePullResult = {
      ok: true,
      mode: "derived",
      rows: [
        { date: `${MONTH}-01`, cost: "1.000000000" },
        { date: `${MONTH}-02`, model: "kimi-est", cost: "2.000000000" },
        // 跨月：应写入另一条 UsageImport
        { date: "2099-09-01", cost: "0.250000000" },
      ],
      currency: "CNY",
      note: "估算：基于余额快照差值",
    };
    setUsageModuleResolver(async () => ({
      pullKimiUsage: async () => derivedResult,
    }));

    const res = await POST(pullReq({ provider: "kimi", credentialId: cred.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      month: string;
      months: string[];
      rows: number;
      models: number;
      currency: string;
      note?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("derived");
    expect(body.month).toBe("2099-09");
    expect(body.months).toEqual(["2099-08", "2099-09"]);
    expect(body.currency).toBe("CNY");
    expect(body.note).toContain("估算");
    expect(body.rows).toBe(3);
    expect(body.models).toBe(2);

    const aug = await db.usageImport.findUniqueOrThrow({
      where: {
        userId_provider_month: { userId: USER_ID, provider: "kimi", month: MONTH },
      },
      include: { rows: true },
    });
    expect(aug.fileName).toBe(PULL_FILE_NAME);
    expect(aug.currency).toBe("CNY");
    expect(aug.rows).toHaveLength(2);
    const augCost = aug.rows.reduce((s, r) => s + Number(r.cost.toString()), 0);
    expect(augCost).toBeCloseTo(3.0, 6);

    // 同月再拉一次：覆盖不翻倍
    const res2 = await POST(pullReq({ provider: "kimi", credentialId: cred.id }));
    expect(res2.status).toBe(200);
    const aug2 = await db.usageImport.findUniqueOrThrow({
      where: {
        userId_provider_month: { userId: USER_ID, provider: "kimi", month: MONTH },
      },
      include: { rows: true },
    });
    expect(aug2.id).toBe(aug.id);
    expect(aug2.rows).toHaveLength(2);

    await db.credential.delete({ where: { id: cred.id } });
  });

  it("ok:false → 422", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const cred = await db.credential.create({
      data: {
        userId: USER_ID,
        provider: "kimi",
        kind: "bearer",
        label: "pull-fail",
        secretCipher: Buffer.from([1]),
        iv: Buffer.from([1]),
        authTag: Buffer.from([1]),
        hint: "sk-****0003",
      },
    });
    setUsageModuleResolver(async () => ({
      pullKimiUsage: async () => ({
        ok: false as const,
        reason: "RATE_LIMITED",
        message: "官方接口限流",
      }),
    }));

    const res = await POST(pullReq({ provider: "kimi", credentialId: cred.id }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("限流");

    await db.credential.delete({ where: { id: cred.id } });
  });
});
