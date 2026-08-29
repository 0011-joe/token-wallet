/** 金额 / 时间格式化工具（前端展示专用，纯函数无副作用）。 */

const CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };

const moneyFmt = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const intFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

/** 带币种的金额：¥6.32 / $1.20；未知币种回退 "USD 1.20" 前缀 */
export function formatMoney(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${moneyFmt.format(amount)}`;
}

/** 无币种金额（分模型费用等，后端 currency 恒为 null）：仅数值，2 位小数 */
export function formatAmount(amount: number): string {
  return moneyFmt.format(amount);
}

/** 整数（Token 数 / 请求次数）：1,234,567 */
export function formatNumber(amount: number): string {
  return intFmt.format(amount);
}

/** 图表 Y 轴刻度缩写：1000 → "1.0k"，小数保留 1 位 */
export function formatAxisMoney(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 相对时间："刚刚" / "x 分钟前" / "x 小时前" / "x 天前" */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 无相对时间的日期时间：2026/8/28 16:41 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

/** 当前 UTC 月份 "YYYY-MM"（与后端 CSV start_time_iso 的 UTC 口径一致） */
export function currentMonthUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
