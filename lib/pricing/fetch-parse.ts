/**
 * DeepSeek 定价页文本解析（供 pricing-fetch 脚本与单测共用）。
 * 结构变化必须抛错，禁止猜测（D8/R9）。
 */

export const DEEPSEEK_PRICING_EN = "https://api-docs.deepseek.com/quick_start/pricing";
export const DEEPSEEK_PRICING_ZH = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";

export function parseDeepSeekPricesFromText(
  enText: string,
  zhText: string,
  checkedAt: string
): Record<string, unknown> {
  const must = ["deepseek-flash", "deepseek-v4-pro", "off-peak", "peak"];
  const lowerEn = enText.toLowerCase();
  for (const m of must) {
    if (!lowerEn.includes(m)) {
      throw new Error(`英文定价页缺少关键片段「${m}」，解析中止（结构可能已变）`);
    }
  }
  if (!zhText.includes("空闲时段") || !zhText.includes("高峰时段")) {
    throw new Error("中文定价页缺少「空闲时段/高峰时段」，解析中止");
  }

  function grabAfter(text: string, anchor: string, count: number): number[] {
    const i = text.indexOf(anchor);
    if (i < 0) throw new Error(`未找到锚点 ${anchor}`);
    const slice = text.slice(i, i + 400);
    const nums = [...slice.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map((m) =>
      Number(m[1])
    );
    if (nums.length < count) {
      throw new Error(`锚点 ${anchor} 后数字不足（${nums.length} < ${count}）`);
    }
    return nums.slice(0, count);
  }

  const hit = grabAfter(enText, "1M INPUT TOKENS(CACHE HIT)", 4);
  const miss = grabAfter(enText, "1M INPUT TOKENS(CACHE MISS)", 4);
  const out = grabAfter(enText, "1M OUTPUT TOKENS", 4);

  const zhHit = [...zhText.matchAll(/([0-9]+(?:\.[0-9]+)?)元/g)].map((m) =>
    Number(m[1])
  );
  if (zhHit.length < 12) {
    throw new Error(`中文价数字不足（${zhHit.length} < 12）`);
  }

  const asOf = checkedAt.slice(0, 10);
  return {
    asOf,
    sourceUrl: DEEPSEEK_PRICING_EN,
    sourceUrlZh: DEEPSEEK_PRICING_ZH,
    checkedAt,
    note: "自动抓取候选；空闲价=高峰×50%；应用前须人工审阅（D8）",
    peakWindowUtc: {
      weekdayMask: 31,
      windows: [
        { startMinute: 60, endMinute: 240 },
        { startMinute: 360, endMinute: 600 },
      ],
      tz: "UTC",
      multiplier: "2.000",
    },
    prices: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        currency: "USD",
        input: miss[0]!.toFixed(9),
        output: out[0]!.toFixed(9),
        cacheHit: hit[0]!.toFixed(9),
        sourceUrl: DEEPSEEK_PRICING_EN,
        checkedAt,
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        currency: "USD",
        input: miss[2]!.toFixed(9),
        output: out[2]!.toFixed(9),
        cacheHit: hit[2]!.toFixed(9),
        sourceUrl: DEEPSEEK_PRICING_EN,
        checkedAt,
      },
      {
        provider: "deepseek",
        model: "deepseek-flash",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        currency: "CNY",
        input: String(zhHit[4]),
        output: String(zhHit[8]),
        cacheHit: String(zhHit[0]),
        sourceUrl: DEEPSEEK_PRICING_ZH,
        checkedAt,
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        currency: "CNY",
        input: String(zhHit[6]),
        output: String(zhHit[10]),
        cacheHit: String(zhHit[2]),
        sourceUrl: DEEPSEEK_PRICING_ZH,
        checkedAt,
      },
    ],
  };
}
