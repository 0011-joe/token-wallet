/**
 * 预算校验 + 月度对账纯函数。
 */
import { describe, expect, it } from "vitest";

import { validateBudgetInput } from "@/lib/billing/budget";
import { reconcileMonth } from "@/lib/billing/reconcile";

describe("validateBudgetInput", () => {
  it("合法预算通过", () => {
    expect(
      validateBudgetInput({
        amount: "20",
        currency: "CNY",
        period: "month",
        scope: "global",
        warnPct: 80,
        criticalPct: 100,
      })
    ).toBeNull();
  });

  it("warnPct >= criticalPct → 拒绝", () => {
    expect(
      validateBudgetInput({
        amount: "20",
        currency: "CNY",
        period: "month",
        scope: "global",
        warnPct: 100,
        criticalPct: 80,
      })
    ).toContain("warnPct");
  });

  it("amount 非正 → 拒绝", () => {
    expect(
      validateBudgetInput({
        amount: "0",
        currency: "CNY",
        period: "month",
        scope: "global",
        warnPct: 80,
        criticalPct: 100,
      })
    ).toContain("amount");
  });

  it("scope=provider 必须带 provider", () => {
    expect(
      validateBudgetInput({
        amount: "1",
        currency: "CNY",
        period: "month",
        scope: "provider",
        warnPct: 80,
        criticalPct: 100,
      })
    ).toContain("provider");
  });
});

describe("reconcileMonth", () => {
  it("三侧数字与误差", () => {
    const r = reconcileMonth({
      currency: "CNY",
      modelUsageCost: 10,
      usageDailyCost: 10,
      balanceDeltaCost: 9.5,
      usageDailyComplete: true,
    });
    expect(r.absDiff).toBeCloseTo(0, 9);
    expect(r.relDiffPct).toBeCloseTo(0, 6);
    expect(r.usable).toBe(true);
  });

  it("误差过大时 usable=false", () => {
    const r = reconcileMonth({
      currency: "CNY",
      modelUsageCost: 10,
      usageDailyCost: 8,
      balanceDeltaCost: null,
      usageDailyComplete: false,
    });
    expect(r.usable).toBe(false);
    expect(r.note).toContain("估算");
  });
});
