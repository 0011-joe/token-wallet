/**
 * 预算告警端到端（测试库）：造 UsageDaily → dispatchBudgetAlerts → AlertEvent。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const describeDb = describe.skipIf(!process.env.DATABASE_URL);

vi.mock("@/lib/email/send", () => ({
  sendAlertEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

import { db } from "@/lib/db";
import { dispatchBudgetAlerts } from "@/lib/alerts/budget-dispatch";
import { sendAlertEmail } from "@/lib/email/send";

const EMAIL = `bd-e2e-${Date.now()}@test.local`;
const USER_ID = `bd-e2e-${Date.now()}`;

describeDb("dispatchBudgetAlerts 端到端", () => {
  beforeAll(async () => {
    await db.user.create({ data: { id: USER_ID, email: EMAIL } });
    await db.budget.create({
      data: {
        userId: USER_ID,
        amount: "100",
        currency: "CNY",
        period: "month",
        scope: "global",
        warnPct: 80,
        criticalPct: 100,
        runwayAlertDays: null,
      },
    });
    // 本月 3 天完整消耗 40 → 40% < 80，不触发
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const day = (d: number) => new Date(Date.UTC(y, m, d));
    await db.usageDaily.createMany({
      data: [
        {
          userId: USER_ID,
          provider: "deepseek",
          model: "m",
          date: day(1),
          source: "csv_official",
          cost: "10",
          costComplete: true,
          currency: "CNY",
          inputTokens: BigInt(1000),
        },
        {
          userId: USER_ID,
          provider: "deepseek",
          model: "m",
          date: day(2),
          source: "csv_official",
          cost: "15",
          costComplete: true,
          currency: "CNY",
          inputTokens: BigInt(1000),
        },
        {
          userId: USER_ID,
          provider: "deepseek",
          model: "m",
          date: day(3),
          source: "csv_official",
          cost: "15",
          costComplete: true,
          currency: "CNY",
          inputTokens: BigInt(1000),
        },
      ],
    });
  });

  afterAll(async () => {
    await db.alertEvent.deleteMany({ where: { userId: USER_ID } });
    await db.usageDaily.deleteMany({ where: { userId: USER_ID } });
    await db.budget.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
  });

  beforeEach(() => {
    vi.mocked(sendAlertEmail).mockClear();
  });

  it("消耗 40% 不触发", async () => {
    const r = await dispatchBudgetAlerts(USER_ID);
    expect(r.evaluated).toBeGreaterThanOrEqual(1);
    expect(r.emitted).toBe(0);
    const events = await db.alertEvent.count({
      where: { userId: USER_ID, type: { startsWith: "BUDGET" } },
    });
    expect(events).toBe(0);
  });

  it("推高消耗到 ≥80% → BUDGET_WARN 事件 + 发信", async () => {
    // 再加 50 → 总 90%（≥80，<100）
    await db.usageDaily.updateMany({
      where: { userId: USER_ID, source: "csv_official" },
      data: { cost: "50", costComplete: true },
    });
    // 上面 updateMany 无法用 Decimal 字符串，改为删重建
    await db.usageDaily.deleteMany({ where: { userId: USER_ID } });
    const now = new Date();
    await db.usageDaily.create({
      data: {
        userId: USER_ID,
        provider: "deepseek",
        model: "m",
        date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 5)),
        source: "csv_official",
        cost: "90",
        costComplete: true,
        currency: "CNY",
        inputTokens: BigInt(1),
      },
    });

    const r = await dispatchBudgetAlerts(USER_ID);
    expect(r.emitted).toBeGreaterThanOrEqual(1);

    const warn = await db.alertEvent.findFirst({
      where: { userId: USER_ID, type: "BUDGET_WARN" },
      orderBy: { createdAt: "desc" },
    });
    expect(warn).not.toBeNull();
    expect(warn?.message).toContain("[budget#");
    expect(sendAlertEmail).toHaveBeenCalled();
  });

  it("24h 内重复 dispatch 不重复发事件", async () => {
    const before = await db.alertEvent.count({
      where: { userId: USER_ID, type: "BUDGET_WARN" },
    });
    const r = await dispatchBudgetAlerts(USER_ID);
    expect(r.emitted).toBe(0);
    const after = await db.alertEvent.count({
      where: { userId: USER_ID, type: "BUDGET_WARN" },
    });
    expect(after).toBe(before);
  });
});
