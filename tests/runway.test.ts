/**
 * runway 纯函数测试（分币种、样本不足、充值日、estimate 档）。
 */
import { describe, expect, it } from "vitest";

import { computeRunway } from "@/lib/billing/runway";

function day(date: string, cost: string, source = "csv_official", costComplete = true) {
  return { date, cost, costComplete, source };
}

describe("computeRunway", () => {
  it("样本不足 → insufficient", () => {
    const r = computeRunway({
      currency: "CNY",
      available: "100",
      days: [day("2026-09-01", "1"), day("2026-09-02", "1")],
    });
    expect(r.basis).toBe("insufficient");
    if (r.basis === "insufficient") expect(r.reason).toBe("TOO_FEW_DAYS");
  });

  it("充足官方日 → ok，days=floor(available/median)", () => {
    const r = computeRunway({
      currency: "CNY",
      available: "30.000000000",
      days: [
        day("2026-09-01", "1"),
        day("2026-09-02", "1"),
        day("2026-09-03", "1"),
      ],
    });
    expect(r.basis).toBe("ok");
    if (r.basis !== "ok") return;
    expect(r.days).toBe(30);
    expect(r.sampleDays).toBe(3);
    expect(r.medianDailyCost).toBe("1.000000000");
  });

  it("余额 ≤0 → insufficient NO_BALANCE", () => {
    const r = computeRunway({
      currency: "CNY",
      available: "0",
      days: [day("a", "1"), day("b", "1"), day("c", "1")],
    });
    expect(r.basis).toBe("insufficient");
    if (r.basis === "insufficient") expect(r.reason).toBe("NO_BALANCE");
  });

  it("充值日不进 median", () => {
    const r = computeRunway({
      currency: "CNY",
      available: "100",
      days: [
        day("2026-09-01", "1"),
        day("2026-09-02", "50"), // 充值日，应剔除
        day("2026-09-03", "1"),
        day("2026-09-04", "1"),
      ],
      balances: [
        { fetchedAt: "2026-09-01T12:00:00Z", currency: "CNY", available: "10" },
        { fetchedAt: "2026-09-02T12:00:00Z", currency: "CNY", available: "60" }, // 充值
        { fetchedAt: "2026-09-03T12:00:00Z", currency: "CNY", available: "59" },
        { fetchedAt: "2026-09-04T12:00:00Z", currency: "CNY", available: "58" },
      ],
    });
    expect(r.basis).toBe("ok");
    if (r.basis !== "ok") return;
    expect(r.medianDailyCost).toBe("1.000000000");
    expect(r.rechargeDays).toBeGreaterThanOrEqual(1);
  });

  it("仅估算日 → estimate 档", () => {
    const r = computeRunway({
      currency: "CNY",
      available: "100",
      days: [
        day("2026-09-01", "1", "derived_estimate"),
        day("2026-09-02", "1", "derived_estimate"),
        day("2026-09-03", "1", "derived_estimate"),
      ],
      allowEstimate: true,
    });
    expect(r.basis).toBe("estimate");
    if (r.basis === "estimate") {
      expect(r.days).toBe(100);
      expect(r.note).toContain("估算");
    }
  });

  it("币种无法匹配余额时仍按入参 currency 计算（caller 负责过滤）", () => {
    const r = computeRunway({
      currency: "USD",
      available: "10",
      days: [day("2026-09-01", "1"), day("2026-09-02", "1"), day("2026-09-03", "1")],
    });
    expect(r.currency).toBe("USD");
  });
});
