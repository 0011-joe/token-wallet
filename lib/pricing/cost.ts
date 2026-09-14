/**
 * 费用计算（D6 / D6b / 红线 19：缺价不输出部分金额）。
 * cost = Σ(tokens / 1e6 × unit × windowMultiplier)，全程 bigint 定点，禁 float。
 * 注意：tsconfig target=ES2017，禁用 0n 字面量，一律 BigInt(x)。
 */
import { DECIMAL_SCALE, toMoney, type Money } from "@/lib/money";
import { priceAt, type PriceRow } from "./price";
import { windowMultiplierAt, type PriceWindowRow } from "./window";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const DENOM = BigInt(10) ** BigInt(15); // 1e6 × 1e9

export interface TokenBuckets {
  inputTokens: string | number | bigint;
  outputTokens: string | number | bigint;
  cacheHitTokens: string | number | bigint;
  cacheMissTokens: string | number | bigint;
  reasoningTokens: string | number | bigint;
}

export type CostFailureReason =
  | "NO_PRICE"
  | "NO_CURRENCY"
  | "MISSING_UNIT_PRICE";

export type ComputeCostResult =
  | { cost: Money; currency: string; costComplete: true; note?: string }
  | { cost: null; currency: null; costComplete: false; reason: CostFailureReason };

function toTokenBig(v: string | number | bigint): bigint {
  if (typeof v === "bigint") return v < ZERO ? ZERO : v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return ZERO;
    return BigInt(Math.floor(v));
  }
  const s = v.trim();
  if (!/^\d+$/.test(s)) return ZERO;
  return BigInt(s);
}

/** Decimal 字符串 → 10^9 定点 bigint */
function microOf(value: string): bigint {
  const m = toMoney(value);
  const neg = m.startsWith("-");
  const body = neg ? m.slice(1) : m;
  const [i, f = ""] = body.split(".");
  const frac = (f + "000000000").slice(0, DECIMAL_SCALE);
  const raw = BigInt(i + frac);
  return neg ? -raw : raw;
}

function microToString(micro: bigint): Money {
  const neg = micro < ZERO;
  const abs = neg ? -micro : micro;
  const scale = BigInt(10) ** BigInt(DECIMAL_SCALE);
  const intPart = abs / scale;
  const fracPart = abs % scale;
  const frac = fracPart.toString().padStart(DECIMAL_SCALE, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

/** tokens × unitPer1M × multiplier → micro cost */
function lineCostMicro(
  tokens: bigint,
  unitMicro: bigint,
  multMicro: bigint
): bigint {
  if (tokens === ZERO) return ZERO;
  const prod = tokens * unitMicro * multMicro;
  const q = prod / DENOM;
  const r = prod % DENOM;
  const neg = q < ZERO || r < ZERO;
  const absQ = q < ZERO ? -q : q;
  const absR = r < ZERO ? -r : r;
  const rounded = absR * TWO >= DENOM ? absQ + ONE : absQ;
  return neg ? -rounded : rounded;
}

export function computeCost(args: {
  provider: string;
  model: string;
  at: Date;
  currency: string;
  buckets: TokenBuckets;
  prices: PriceRow[];
  windows: PriceWindowRow[];
}): ComputeCostResult {
  const currency = args.currency?.trim().toUpperCase() ?? "";
  if (!currency) {
    return { cost: null, currency: null, costComplete: false, reason: "NO_CURRENCY" };
  }

  const price = priceAt(args.provider, args.model, args.at, currency, args.prices);
  if (!price) {
    return { cost: null, currency: null, costComplete: false, reason: "NO_PRICE" };
  }

  const mult = windowMultiplierAt(args.provider, args.at, args.windows);
  const multMicro = microOf(mult);

  const input = toTokenBig(args.buckets.inputTokens);
  const output = toTokenBig(args.buckets.outputTokens);
  const cacheHit = toTokenBig(args.buckets.cacheHitTokens);
  const cacheMiss = toTokenBig(args.buckets.cacheMissTokens);
  const reasoning = toTokenBig(args.buckets.reasoningTokens);

  const notes: string[] = [];
  const cacheMissUnit = price.cacheMiss ?? price.input;
  const reasoningUnit = price.reasoning ?? price.output;
  if (price.cacheMiss == null && cacheMiss > ZERO) notes.push("cacheMiss 回退 input");
  if (price.reasoning == null && reasoning > ZERO) notes.push("reasoning 回退 output");

  const units: Array<{ tokens: bigint; unit: string | null | undefined }> = [
    { tokens: input, unit: price.input },
    { tokens: output, unit: price.output },
    { tokens: cacheHit, unit: price.cacheHit },
    { tokens: cacheMiss, unit: cacheMissUnit },
    { tokens: reasoning, unit: reasoningUnit },
  ];

  for (const u of units) {
    if (u.tokens > ZERO && (u.unit == null || u.unit === "")) {
      return {
        cost: null,
        currency: null,
        costComplete: false,
        reason: "MISSING_UNIT_PRICE",
      };
    }
  }

  let total = ZERO;
  for (const u of units) {
    if (u.tokens === ZERO) continue;
    total += lineCostMicro(u.tokens, microOf(String(u.unit)), multMicro);
  }

  return {
    cost: microToString(total),
    currency: price.currency.trim().toUpperCase(),
    costComplete: true,
    ...(notes.length ? { note: notes.join("；") } : {}),
  };
}
