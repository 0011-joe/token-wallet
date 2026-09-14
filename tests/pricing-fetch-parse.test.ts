/**
 * 定价页解析单测（fixture 文本，不打真网）。
 */
import { describe, expect, it } from "vitest";

import { parseDeepSeekPricesFromText } from "@/lib/pricing/fetch-parse";

const EN = `
MODELdeepseek-flashdeepseek-v4-pro
PRICING(3)
1M INPUT TOKENS(CACHE HIT)
OFF-PEAK$0.003$0.022
PEAK$0.006$0.044
1M INPUT TOKENS(CACHE MISS)
OFF-PEAK$0.15$0.66
PEAK$0.3$1.32
1M OUTPUT TOKENS
OFF-PEAK$0.6$1.98
PEAK$1.2$3.96
Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC
`;

const ZH = `
价格(3)
百万tokens
输入（缓存命中）空闲时段0.02元高峰时段0.04元0.15元0.30元
输入（缓存未命中）空闲时段1元高峰时段2元4.5元9.0元
输出空闲时段4元高峰时段8元13.5元27.0元
`;

describe("parseDeepSeekPricesFromText", () => {
  it("从 fixture 提取 off-peak 价与窗口", () => {
    const p = parseDeepSeekPricesFromText(EN, ZH, "2026-09-14T00:00:00.000Z");
    const prices = p.prices as Array<{
      model: string;
      currency: string;
      input: string;
      output: string;
      cacheHit: string;
    }>;
    const flashUsd = prices.find(
      (x) => x.model === "deepseek-flash" && x.currency === "USD"
    );
    expect(flashUsd?.input).toBe("0.150000000");
    expect(flashUsd?.output).toBe("0.600000000");
    expect(flashUsd?.cacheHit).toBe("0.003000000");
  });

  it("结构变化时抛错", () => {
    expect(() =>
      parseDeepSeekPricesFromText("no anchors", "no", "2026-09-14T00:00:00.000Z")
    ).toThrow();
  });
});
