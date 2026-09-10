/**
 * M5 / T5.3 models 路由集成自测：mock next-auth 会话，走真实入库后调用 GET，
 * 验证分模型聚合、占比、排序与空态（AC4-1 / AC4-4）。
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/auth", () => ({ authOptions: {} }));

import { getServerSession } from "next-auth";
import { GET } from "../app/api/usage/models/route";
import { db } from "../lib/db";
import { parseUsageCsv } from "../lib/usage/csv-parse";
import { upsertUsageImport } from "../lib/usage/import-store";

// 无 DATABASE_URL 时显式跳过（开源 fork 未配置 DB secret 的 CI 场景）；本地/配置后全跑
const describeDb = describe.skipIf(!process.env.DATABASE_URL);

const AMOUNT_CSV = path.join(
  process.cwd(),
  "samples",
  "amount-2026-07-31_2026-08-28.csv"
);
const OFFICIAL_MODEL = "deepseek-v4-flash-vision-exp";

const EMAIL = `unit-models-${Date.now()}@test.local`;
const USER_ID = `unit-models-${Date.now()}`;
const MONTH = "2099-03";
const EMPTY_MONTH = "2099-04";

const mockSession = vi.mocked(getServerSession);
function session(email: string | null): Session {
  return { user: { email }, expires: "2099-01-01T00:00:00.000Z" } as Session;
}

beforeAll(async () => {
  await db.user.create({ data: { id: USER_ID, email: EMAIL } });
  const parsed = parseUsageCsv(fs.readFileSync(AMOUNT_CSV, "utf8"));
  await db.$transaction((tx) =>
    upsertUsageImport(tx, USER_ID, "deepseek", MONTH, "amount.csv", parsed.rows, "CNY")
  );
  // 追加一个只有一行的小模型，验证排序与占比
  await db.$transaction((tx) =>
    upsertUsageImport(tx, USER_ID, "deepseek", EMPTY_MONTH, "empty.csv", [])
  );
  await db.modelUsage.create({
    data: {
      provider: "deepseek",
      model: "second-model-for-sort",
      type: "output_tokens",
      unitPrice: "0.000005000", // 四舍五入到 6 位（0.0000045 → 0.000005）
      amount: 1000,
      cost: "0.005000000", // 0.000005 × 1000
      importId: (
        await db.usageImport.findUniqueOrThrow({
          where: { userId_provider_month: { userId: USER_ID, provider: "deepseek", month: MONTH } },
        })
      ).id,
    },
  });
});

afterAll(async () => {
  await db.usageImport.deleteMany({ where: { userId: USER_ID } });
  await db.user.deleteMany({ where: { email: EMAIL } });
  await db.$disconnect();
});

describeDb("GET /api/usage/models", () => {
  it("未登录 → 401", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/usage/models?month=2099-03&provider=deepseek"));
    expect(res.status).toBe(401);
  });

  it("month 缺失或非法 → 400", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    expect((await GET(new Request("http://x/api/usage/models?provider=deepseek"))).status).toBe(400);
    expect(
      (await GET(new Request("http://x/api/usage/models?month=2026-8&provider=deepseek"))).status
    ).toBe(400);
  });

  it("未导入月份 → 空态 { models: [], currency: null }（AC4-4）", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const res = await GET(
      new Request(`http://x/api/usage/models?month=${EMPTY_MONTH}&provider=deepseek`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      month: EMPTY_MONTH,
      models: [],
      totalCost: "0.000000000",
      totalTokens: 0,
      currency: null,
    });
  });

  it("有数据：聚合合计与 CSV 一致、占比正确、按 cost 降序（AC4-1）", async () => {
    mockSession.mockResolvedValue(session(EMAIL));
    const res = await GET(
      new Request(`http://x/api/usage/models?month=${MONTH}&provider=deepseek`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.month).toBe(MONTH);
    expect(body.currency).toBe("CNY"); // Q4：cost 文件币种已入库
    // 全月 = 官方样本 2.8196908（9 位精度完整保留）+ 追加小模型 0.005
    expect(body.totalCost).toBe("2.824690800");
    // token 合计 = cache_hit 14368512 + cache_miss 653480 + output 217360 + 追加 1000（不含 request_count）
    expect(body.totalTokens).toBe(14368512 + 653480 + 217360 + 1000);

    expect(body.models).toHaveLength(2);
    // 排序：大模型在前；两个占比之和应为 100
    const [top, second] = body.models;
    expect(top.model).toBe(OFFICIAL_MODEL);
    expect(second.model).toBe("second-model-for-sort");
        expect(top.totalCost).toBe("2.819690800"); // 官方样本合计（9 位精度完整保留，第二模型另计）
    expect(second.totalCost).toBe("0.005000000");
    const shareSum = top.sharePct + second.sharePct;
    expect(top.sharePct).toBe(99.82); // 2.8196908 / 2.8246908 * 100
    expect(second.sharePct).toBe(0.18); // 0.005 / 2.8246908 * 100
    expect(shareSum).toBeCloseTo(100, 1);

    // byType：官方 7 行 = type×单价 7 档，各自保留；request_count 行 cost=0
    expect(top.byType).toHaveLength(7);
    const rc = top.byType.find((e: { type: string }) => e.type === "request_count");
    expect(rc.amount).toBe(302);
    expect(rc.cost).toBe("0.000000000");
    const hitRows = top.byType.filter(
      (e: { type: string }) => e.type === "input_cache_hit_tokens"
    );
    expect(hitRows.reduce((s: number, e: { amount: number }) => s + e.amount, 0)).toBe(14368512);
    expect(top.totalTokens).toBe(15239352);
  });
});
