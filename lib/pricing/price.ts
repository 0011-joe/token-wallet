/**
 * 历史价匹配（D6：按事件时间 + 币种）。
 */

export interface PriceRow {
  provider: string;
  model: string;
  effectiveFrom: Date;
  currency: string;
  /** 每 1M token，Decimal 字符串 */
  input: string;
  output: string;
  cacheHit?: string | null;
  cacheMiss?: string | null;
  reasoning?: string | null;
  sourceUrl?: string;
  checkedAt?: Date;
  note?: string | null;
}

/**
 * 取 currency 相同且 effectiveFrom ≤ at 的最近一行。
 * 解析不出唯一行 → null（禁止随机取一行）。
 */
export function priceAt(
  provider: string,
  model: string,
  at: Date,
  currency: string,
  prices: PriceRow[]
): PriceRow | null {
  const cur = currency.trim().toUpperCase();
  const matched = prices
    .filter(
      (p) =>
        p.provider === provider &&
        p.model === model &&
        p.currency.trim().toUpperCase() === cur &&
        p.effectiveFrom.getTime() <= at.getTime()
    )
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return matched[0] ?? null;
}
