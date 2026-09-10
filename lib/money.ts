/**
 * token-wallet 金额工具（T0.2，DEV-GUIDE 红线 #1 / 规格卡 B）
 *
 * 领域层金额一律为「定点 Decimal 字符串」：
 *   - 规范格式恒为 6 位小数（对应数据库 Decimal(18,9)），如 "49.588940000"；
 *   - 所有运算走 bigint 定点（微元 ×10^6），禁止 float/number 参与金额运算；
 *   - number 输入（如 Kimi JSON number）先经 toString() 取最短十进制表示，
 *     再按字符串解析，避免二进制浮点误差；Prisma Decimal 对象走 toString()。
 *
 * 展示层格式化（formatMoney 等）也在本文件统一入口；v1 的 parseFloat 路径
 * 由后续里程碑（M4）逐处删除。
 */

/**
 * 定点小数位：与数据库 Decimal(18,9) 对齐。
 * 修正记录（原为 6）：DeepSeek 官方用量 CSV 单价可达 8 位小数（如 0.00000005），
 * Decimal(18,6) 会把单价四舍五入归零、档位合并，违反 AC4-1「与 CSV 合计一致、误差为 0」。
 * 故精度统一提升到 9 位小数（保留余量），余额展示仍格式化为 2 位。
 */
export const DECIMAL_SCALE = 9;

const SCALE_BIG = BigInt(10) ** BigInt(DECIMAL_SCALE);

/** 领域层金额类型：规范 6 位小数的定点字符串（如 "49.588940000"） */
export type Money = string;

class MoneyParseError extends Error {
  constructor(value: unknown) {
    super(`无法将 ${JSON.stringify(String(value))} 解析为 Decimal(18,9) 金额`);
    this.name = "MoneyParseError";
  }
}

/** 解析纯数字字符串（可含前导 -/+）为 [neg, intPart, fracPart]；失败抛错 */
function splitNumberString(raw: string): { neg: boolean; int: string; frac: string } {
  let s = raw.trim();
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s === "") throw new MoneyParseError(raw);
  const dot = s.indexOf(".");
  const int = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  if (int === "" && frac === "") throw new MoneyParseError(raw);
  if (!/^\d+$/.test(int) || (frac !== "" && !/^\d+$/.test(frac))) {
    throw new MoneyParseError(raw);
  }
  return { neg, int, frac };
}

/** 数字字符串（整数/小数/科学计数法）→ 微元 bigint（四舍五入到 6 位小数） */
function strToMicro(s: string): bigint {
  const str = s.trim();
  if (/[eE]/.test(str)) {
    const idx = str.search(/[eE]/);
    const mant = str.slice(0, idx);
    const exp = Number.parseInt(str.slice(idx + 1), 10);
    if (!Number.isFinite(exp)) throw new MoneyParseError(s);
    const { neg, int, frac } = splitNumberString(mant);
    const digits = (int + frac).replace(/^0+/, "") || "0";
    // value = ±digits × 10^(exp - frac.length)
    return scaleDigitsToMicro(digits, exp - frac.length, neg);
  }
  const { neg, int, frac } = splitNumberString(str);
  const intDigits = int.replace(/^0+/, "") || "0";
  return scaleDigitsToMicro(intDigits + frac, -frac.length, neg);
}

/** digits(十进制串) × 10^shift → 微元 bigint；不足 6 位小数右补零，超出四舍五入 */
function scaleDigitsToMicro(digits: string, shift: number, neg: boolean): bigint {
  // 目标小数位 = 6 ⇒ 需要的总指数 = -6，即 digits × 10^(shift+6)
  const scale = shift + DECIMAL_SCALE;
  let val: bigint;
  if (scale >= 0) {
    val = BigInt(digits) * BigInt(10) ** BigInt(scale);
  } else {
    const cut = -scale;
    const power = BigInt(10) ** BigInt(cut);
    const q = BigInt(digits) / power;
    const r = BigInt(digits) % power;
    // 四舍五入（half-up）：余数 ≥ 一半则进位
    val = r * BigInt(2) >= power ? q + BigInt(1) : q;
  }
  return neg ? -val : val;
}

/** 规范化：微元 bigint → 恒 6 位小数的字符串（如 -1500000n → "-1.500000000"） */
function microToCanonical(micro: bigint): string {
  const neg = micro < BigInt(0);
  const abs = neg ? -micro : micro;
  const intPart = abs / SCALE_BIG;
  const fracPart = abs % SCALE_BIG;
  const frac = fracPart.toString().padStart(DECIMAL_SCALE, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

/**
 * 任意金额输入 → 规范 Decimal 字符串（6 位小数）。
 * 接受：number（JSON number）、string、Prisma Decimal（有 toString 的对象）。
 * 不可解析时抛错（快速失败，禁止静默降级）。
 */
export function toMoney(value: unknown): Money {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyParseError(value);
    return microToCanonical(strToMicro(value.toString()));
  }
  if (typeof value === "string") {
    return microToCanonical(strToMicro(value));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    // Prisma Decimal / Decimal.js 等：优先 toString
    return microToCanonical(strToMicro(String((value as { toString(): string }).toString())));
  }
  throw new MoneyParseError(value);
}

/** 两个规范金额相加 */
export function moneyAdd(a: Money, b: Money): Money {
  return microToCanonical(strToMicro(a) + strToMicro(b));
}

/** a - b */
export function moneySub(a: Money, b: Money): Money {
  return microToCanonical(strToMicro(a) - strToMicro(b));
}

/** 金额 × 标量（标量最多 6 位小数；结果四舍五入到 6 位） */
export function moneyMul(a: Money, scalar: Money): Money {
  const m = strToMicro(a) * strToMicro(scalar);
  // m 现在小数位为 12 位，回缩到 6 位（四舍五入 half-up）
  const q = m / SCALE_BIG;
  const r = m % SCALE_BIG;
  const absR = r < BigInt(0) ? -r : r;
  // 对负数的四舍五入按绝对值进位后恢复符号
  const rounded =
    absR * BigInt(2) >= SCALE_BIG ? q + (m < BigInt(0) ? -BigInt(1) : BigInt(1)) : q;
  return microToCanonical(rounded);
}

/** 金额 ÷ 标量（half-up 到 6 位小数）；标量为 0 抛错 */
export function moneyDiv(a: Money, scalar: Money): Money {
  const divisor = strToMicro(scalar);
  if (divisor === BigInt(0)) throw new Error("moneyDiv 除数为 0");
  const dividend = strToMicro(a) * SCALE_BIG; // 升 6 位再整除，余数四舍五入
  const negative = dividend < BigInt(0) !== divisor < BigInt(0);
  const absD = dividend < BigInt(0) ? -dividend : dividend;
  const absS = divisor < BigInt(0) ? -divisor : divisor;
  const q = absD / absS;
  const r = absD % absS;
  const rounded = r * BigInt(2) >= absS ? q + BigInt(1) : q; // half-up
  return microToCanonical(negative ? -rounded : rounded);
}

/** 金额 → 浮点数（仅限比例/百分比等非金额派生计算，如 sharePct；禁止用于金额运算与存储） */
export function moneyToNumber(a: Money): number {
  const m = strToMicro(a);
  return Number(m) / Number(SCALE_BIG);
}

/** 比较：a<b → -1；a===b → 0；a>b → 1 */
export function moneyCmp(a: Money, b: Money): number {
  const d = strToMicro(a) - strToMicro(b);
  return d < BigInt(0) ? -1 : d > BigInt(0) ? 1 : 0;
}

export function moneyIsZero(a: Money): boolean {
  return strToMicro(a) === BigInt(0);
}

export function moneyIsNegative(a: Money): boolean {
  return strToMicro(a) < BigInt(0);
}

export function moneyIsPositive(a: Money): boolean {
  return strToMicro(a) > BigInt(0);
}

/** 绝对值 */
export function moneyAbs(a: Money): Money {
  const m = strToMicro(a);
  return microToCanonical(m < BigInt(0) ? -m : m);
}

/** 取反 */
export function moneyNeg(a: Money): Money {
  return microToCanonical(-strToMicro(a));
}

// ── 展示层格式化（唯一入口） ──

const CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };

const moneyFmt = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const intFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

/** 微元 → 2 位小数展示数字（half-up），供 Intl 格式化 */
function toDisplayNumber(a: Money): number {
  let m = strToMicro(a);
  const negative = m < BigInt(0);
  if (negative) m = -m; // 负数按绝对值四舍五入，再恢复符号（half-up 定义）
  const hundred = BigInt(100);
  const q = m / SCALE_BIG; // 整数部分
  const rem = m % SCALE_BIG; // 剩余 6 位小数
  const r2 = rem % (SCALE_BIG / hundred); // 第 3~6 位小数
  const rounded2 = rem / (SCALE_BIG / hundred); // 前 2 位小数
  const carry = r2 * BigInt(2) >= SCALE_BIG / hundred ? BigInt(1) : BigInt(0);
  const cents = rounded2 + carry; // [0, 100]，=100 时自然进位到整数部分
  const abs = Number(q) + Number(cents) / 100;
  return negative ? -abs : abs;
}

/** 带币种金额展示：¥6.32 / $1.20；未知币种回退 "USD 1.20" 前缀 */
export function formatMoney(amount: Money | string, currency: string): string {
  const canonical = typeof amount === "string" ? amount : toMoney(amount);
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${moneyFmt.format(toDisplayNumber(canonical))}`;
}

/** 无币种金额（2 位小数） */
export function formatAmount(amount: Money | string): string {
  const canonical = typeof amount === "string" ? amount : toMoney(amount);
  return moneyFmt.format(toDisplayNumber(canonical));
}

/** 整数（Token 数 / 请求次数）：1,234,567 */
export function formatNumber(n: number): string {
  return intFmt.format(n);
}

/** 图表 Y 轴刻度缩写：1000 → "1.0k"，小数保留 1 位 */
export function formatAxisMoney(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
