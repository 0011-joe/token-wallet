/**
 * 预算/runway 告警测试。
 */
import { describe, expect, it } from "vitest";

import { budgetWindowRange, evaluateBudgetAlerts } from "@/lib/alerts/budget-evaluate";

describe("evaluateBudgetAlerts", () => {
  const budget = {
    id: "b1",
    amount: "100.000000000",
    currency: "CNY",
    warnPct: 80,
    criticalPct: 100,
    runwayAlertDays: 3,
  };

  it("低于 warn 无告警", () => {
    const r = evaluateBudgetAlerts({ budget, spent: "50" });
    expect(r).toHaveLength(0);
  });

  it("达到 warn → BUDGET_WARN warning", () => {
    const r = evaluateBudgetAlerts({ budget, spent: "85" });
    expect(r).toHaveLength(1);
    expect(r[0]?.type).toBe("BUDGET_WARN");
    expect(r[0]?.severity).toBe("warning");
    expect(r[0]?.dedupKey).toBe("BUDGET_WARN:b1");
  });

  it("达到 critical → BUDGET_BREACH critical（不再同时发 WARN）", () => {
    const r = evaluateBudgetAlerts({ budget, spent: "100" });
    expect(r).toHaveLength(1);
    expect(r[0]?.type).toBe("BUDGET_BREACH");
    expect(r[0]?.severity).toBe("critical");
  });

  it("runway 过短 → RUNWAY_SHORT，文案含估算", () => {
    const r = evaluateBudgetAlerts({
      budget,
      spent: "10",
      runwayDays: 2,
    });
    expect(r.some((c) => c.type === "RUNWAY_SHORT")).toBe(true);
    const hit = r.find((c) => c.type === "RUNWAY_SHORT");
    expect(hit?.message).toContain("估算");
  });

  it("24h 频控：同 type lastAlert 窗口内不重复", () => {
    const r = evaluateBudgetAlerts({
      budget,
      spent: "90",
      lastAlert: { type: "BUDGET_WARN", createdAt: new Date() },
    });
    expect(r.some((c) => c.type === "BUDGET_WARN")).toBe(false);
  });
});

describe("budgetWindowRange", () => {
  it("month 窗口为当月 UTC", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const r = budgetWindowRange({ period: "month", now });
    expect(r.gte.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(r.lt.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("day 窗口为当日 UTC", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const r = budgetWindowRange({ period: "day", now });
    expect(r.gte.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(r.lt.toISOString().slice(0, 10)).toBe("2026-09-16");
  });
});
