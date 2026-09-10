/**
 * T4.1 跨平台总览聚合单测（AC3.1/3.2/3.3）。
 * 覆盖：分币种不混算、平台卡、stale/failed 计数、故障不显示成 0。
 */
import { describe, expect, it } from "vitest";
import {
  aggregateOverview,
  STALE_AFTER_MS,
  type OverviewCredential,
  type OverviewSnapshot,
} from "../lib/dashboard/overview";

const NOW = new Date("2026-09-10T04:00:00Z");
const recent = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h 前，未 stale
const stale = new Date(NOW.getTime() - STALE_AFTER_MS - 1000); // 超时

function cred(id: string, provider: OverviewCredential["provider"], extra: Partial<OverviewCredential> = {}): OverviewCredential {
  return {
    id,
    provider,
    hint: id.slice(-4),
    label: id,
    isActive: true,
    lastStatus: null,
    failCount: 0,
    lastSuccessAt: recent,
    ...extra,
  };
}

function snap(currency: string, available: string, fetchedAt: Date): OverviewSnapshot {
  return { currency, available, isAvailable: true, fetchedAt };
}

describe("aggregateOverview", () => {
  it("分币种合计不混算（CNY 与 USD 各自独立，AC3.2）", () => {
    const result = aggregateOverview(
      [
        cred("ds1", "deepseek"),
        cred("ds2", "deepseek"),
        cred("km1", "kimi"),
      ],
      new Map([
        ["ds1", [snap("CNY", "100.000000000", recent), snap("USD", "10.000000000", recent)]],
        ["ds2", [snap("CNY", "50.000000000", recent)]],
        ["km1", [snap("CNY", "30.000000000", recent)]],
      ]),
      NOW
    );
    const cny = result.currencies.find((c) => c.currency === "CNY");
    const usd = result.currencies.find((c) => c.currency === "USD");
    expect(cny?.totalAvailable).toBe("180.000000000");
    expect(cny?.credentialCount).toBe(3);
    expect(usd?.totalAvailable).toBe("10.000000000");
    expect(usd?.credentialCount).toBe(1);
  });

  it("平台卡：每平台凭证数、币种汇总、failed/stale 计数", () => {
    const result = aggregateOverview(
      [
        cred("ds1", "deepseek"),
        cred("km1", "kimi", { lastStatus: "INVALID", failCount: 1 }),
        cred("vol1", "volcengine", { lastSuccessAt: stale }),
      ],
      new Map([
        ["ds1", [snap("CNY", "100.000000000", recent)]],
        ["km1", [snap("CNY", "30.000000000", recent)]],
        ["vol1", [snap("CNY", "20.000000000", stale)]],
      ]),
      NOW
    );
    const kimi = result.platforms.find((p) => p.provider === "kimi");
    expect(kimi?.credentialCount).toBe(1);
    expect(kimi?.failedCount).toBe(1);
    const vol = result.platforms.find((p) => p.provider === "volcengine");
    expect(vol?.staleCount).toBe(1);
    expect(vol?.byCurrency[0].available).toBe("20.000000000");
  });

  it("故障凭证无任何成功快照 → 不贡献余额、不计为 0（AC3.3）", () => {
    const result = aggregateOverview(
      [cred("broken", "deepseek", { lastStatus: "ERROR", failCount: 2 })],
      new Map([["broken", []]]),
      NOW
    );
    expect(result.currencies).toHaveLength(0); // 无数据不伪造 0
    const ds = result.platforms.find((p) => p.provider === "deepseek");
    expect(ds?.failedCount).toBe(1);
    expect(ds?.staleCount).toBe(1);
  });

  it("同一凭证多币种：各币种分别计入对应分组", () => {
    const result = aggregateOverview(
      [cred("multi", "deepseek")],
      new Map([["multi", [snap("CNY", "1.000000000", recent), snap("USD", "2.000000000", recent)]]]),
      NOW
    );
    expect(result.currencies.map((c) => c.currency).sort()).toEqual(["CNY", "USD"]);
  });

  it("停用凭证不参与聚合", () => {
    const result = aggregateOverview(
      [cred("off", "deepseek", { isActive: false })],
      new Map([["off", [snap("CNY", "9.000000000", recent)]]]),
      NOW
    );
    expect(result.currencies).toHaveLength(0);
  });
});
