/**
 * 计价引擎纯函数测试（v2.1-alpha M9）。
 * 不依赖数据库与网络。
 */
import { describe, expect, it } from "vitest";

import { computeCost } from "@/lib/pricing/cost";
import { priceAt, type PriceRow } from "@/lib/pricing/price";
import {
  currentWindow,
  localMinuteAndWeekday,
  windowMultiplierAt,
  type PriceWindowRow,
} from "@/lib/pricing/window";

/** DeepSeek 参考：空闲基价 0.5，高峰 ×2（种子以官方抓取为准，此处仅测试引擎） */
const prices: PriceRow[] = [
  {
    provider: "deepseek",
    model: "deepseek-chat",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    currency: "CNY",
    input: "0.500000000",
    output: "2.000000000",
    cacheHit: "0.100000000",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    checkedAt: new Date("2026-09-14T00:00:00Z"),
  },
  {
    provider: "deepseek",
    model: "deepseek-chat",
    effectiveFrom: new Date("2026-06-01T00:00:00Z"),
    currency: "CNY",
    input: "0.600000000",
    output: "2.400000000",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    checkedAt: new Date("2026-09-14T00:00:00Z"),
  },
  {
    provider: "deepseek",
    model: "deepseek-chat",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    currency: "USD",
    input: "0.070000000",
    output: "0.280000000",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    checkedAt: new Date("2026-09-14T00:00:00Z"),
  },
];

/** UTC 周一–周五 01:00–04:00 与 06:00–10:00，×2 */
const windows: PriceWindowRow[] = [
  {
    provider: "deepseek",
    label: "peak",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    weekdayMask: 0b0011111, // Mon–Fri
    startMinute: 60,
    endMinute: 240,
    tz: "UTC",
    multiplier: "2.000",
  },
  {
    provider: "deepseek",
    label: "peak",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    weekdayMask: 0b0011111,
    startMinute: 360,
    endMinute: 600,
    tz: "UTC",
    multiplier: "2.000",
  },
];

describe("priceAt", () => {
  it("按事件时间取最近 effectiveFrom ≤ at，且币种过滤", () => {
    // 2026-05 仍用旧价 0.5
    expect(
      priceAt(
        "deepseek",
        "deepseek-chat",
        new Date("2026-05-01T00:00:00Z"),
        "CNY",
        prices
      )?.input
    ).toBe("0.500000000");
    // 2026-07 用新价 0.6
    expect(
      priceAt(
        "deepseek",
        "deepseek-chat",
        new Date("2026-07-01T00:00:00Z"),
        "CNY",
        prices
      )?.input
    ).toBe("0.600000000");
    // USD 独立
    expect(
      priceAt(
        "deepseek",
        "deepseek-chat",
        new Date("2026-07-01T00:00:00Z"),
        "USD",
        prices
      )?.input
    ).toBe("0.070000000");
  });

  it("无匹配币种/模型 → null", () => {
    expect(
      priceAt("deepseek", "unknown", new Date("2026-07-01T00:00:00Z"), "CNY", prices)
    ).toBeNull();
    expect(
      priceAt("kimi", "deepseek-chat", new Date("2026-07-01T00:00:00Z"), "CNY", prices)
    ).toBeNull();
  });
});

describe("windowMultiplierAt", () => {
  // 2026-09-15 是周二
  it("高峰窗口内 ×2，窗口外 ×1，边界半开", () => {
    const peak = new Date("2026-09-15T02:00:00Z"); // 02:00 UTC 周二
    expect(windowMultiplierAt("deepseek", peak, windows)).toBe("2.000000000");

    const before = new Date("2026-09-15T01:00:00Z");
    expect(windowMultiplierAt("deepseek", before, windows)).toBe("2.000000000");

    const end = new Date("2026-09-15T04:00:00Z");
    expect(windowMultiplierAt("deepseek", end, windows)).toBe("1.000000000");

    const valley = new Date("2026-09-15T05:00:00Z");
    expect(windowMultiplierAt("deepseek", valley, windows)).toBe("1.000000000");
  });

  it("周六不命中工作日高峰", () => {
    // 2026-09-19 周六 02:00
    const sat = new Date("2026-09-19T02:00:00Z");
    expect(windowMultiplierAt("deepseek", sat, windows)).toBe("1.000000000");
  });

  it("无窗口 provider 恒 1", () => {
    expect(
      windowMultiplierAt("kimi", new Date("2026-09-15T02:00:00Z"), windows)
    ).toBe("1.000000000");
  });

  it("窗口 effectiveFrom 在事件之后不生效", () => {
    const futureWindows = windows.map((w) => ({
      ...w,
      effectiveFrom: new Date("2027-01-01T00:00:00Z"),
    }));
    expect(
      windowMultiplierAt("deepseek", new Date("2026-09-15T02:00:00Z"), futureWindows)
    ).toBe("1.000000000");
  });
});

describe("computeCost", () => {
  const buckets = {
    inputTokens: "1000000", // 1M
    outputTokens: "0",
    cacheHitTokens: "0",
    cacheMissTokens: "0",
    reasoningTokens: "0",
  };

  it("空闲：1M input × 0.5 = 0.5 CNY（调价前）", () => {
    const r = computeCost({
      provider: "deepseek",
      model: "deepseek-chat",
      at: new Date("2026-05-15T05:00:00Z"),
      currency: "CNY",
      buckets,
      prices,
      windows,
    });
    expect(r.costComplete).toBe(true);
    if (!r.costComplete) return;
    expect(r.cost).toBe("0.500000000");
    expect(r.currency).toBe("CNY");
  });

  it("高峰：同一 token × 2 = 1.0（调价前基价）", () => {
    const r = computeCost({
      provider: "deepseek",
      model: "deepseek-chat",
      at: new Date("2026-05-12T02:00:00Z"),
      currency: "CNY",
      buckets,
      prices,
      windows,
    });
    expect(r.costComplete).toBe(true);
    if (!r.costComplete) return;
    expect(r.cost).toBe("1.000000000");
  });

  it("历史价：2026-05 与 2026-07 同 token 费用不同（D6）", () => {
    const may = computeCost({
      provider: "deepseek",
      model: "deepseek-chat",
      at: new Date("2026-05-15T05:00:00Z"),
      currency: "CNY",
      buckets,
      prices,
      windows,
    });
    const jul = computeCost({
      provider: "deepseek",
      model: "deepseek-chat",
      at: new Date("2026-07-15T05:00:00Z"),
      currency: "CNY",
      buckets,
      prices,
      windows,
    });
    if (!may.costComplete || !jul.costComplete) throw new Error("should complete");
    expect(may.cost).toBe("0.500000000");
    expect(jul.cost).toBe("0.600000000");
  });

  it("cacheHit 非零但缺价 → MISSING_UNIT_PRICE 且 cost null", () => {
    const noHit: PriceRow[] = [
      {
        ...prices[0]!,
        cacheHit: null,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    const r = computeCost({
      provider: "deepseek",
      model: "deepseek-chat",
      at: new Date("2026-09-15T05:00:00Z"),
      currency: "CNY",
      buckets: { ...buckets, cacheHitTokens: "10" },
      prices: noHit,
      windows,
    });
    expect(r).toMatchObject({
      costComplete: false,
      reason: "MISSING_UNIT_PRICE",
      cost: null,
    });
  });

  it("无价 → NO_PRICE", () => {
    const r = computeCost({
      provider: "volcengine",
      model: "doubao",
      at: new Date("2026-09-15T05:00:00Z"),
      currency: "CNY",
      buckets,
      prices,
      windows,
    });
    expect(r).toMatchObject({ costComplete: false, reason: "NO_PRICE" });
  });

  it("cacheMiss 缺省回退 input，costComplete=true 并 note", () => {
    const r = computeCost({
      provider: "deepseek",
      model: "deepseek-chat",
      at: new Date("2026-05-15T05:00:00Z"),
      currency: "CNY",
      buckets: {
        inputTokens: "0",
        outputTokens: "0",
        cacheHitTokens: "0",
        cacheMissTokens: "1000000",
        reasoningTokens: "0",
      },
      prices,
      windows,
    });
    expect(r.costComplete).toBe(true);
    if (!r.costComplete) return;
    expect(r.cost).toBe("0.500000000");
    expect(r.note).toContain("cacheMiss");
  });
});

describe("localMinuteAndWeekday", () => {
  it("UTC 与 Asia/Shanghai 差 8 小时", () => {
    const at = new Date("2026-09-15T01:30:00Z");
    const utc = localMinuteAndWeekday(at, "UTC");
    const sh = localMinuteAndWeekday(at, "Asia/Shanghai");
    expect(utc.minuteOfDay).toBe(90);
    expect(sh.minuteOfDay).toBe(9 * 60 + 30);
  });
});

describe("currentWindow", () => {
  it("高峰内 label=peak 且给出 nextChangeAt", () => {
    const info = currentWindow(
      "deepseek",
      new Date("2026-09-15T02:00:00Z"),
      windows
    );
    expect(info.label).toBe("peak");
    expect(info.multiplier).toBe("2.000000000");
    expect(info.nextChangeAt).not.toBeNull();
  });
});
