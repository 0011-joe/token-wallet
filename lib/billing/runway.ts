/**
 * runway（D12 / 红线 18：分币种、样本不足不外推、充值日识别）。
 */
import { moneyCmp, toMoney, type Money } from "@/lib/money";

export type Runway =
  | {
      basis: "ok";
      currency: string;
      days: number;
      medianDailyCost: Money;
      p25Days: number;
      p75Days: number;
      sampleDays: number;
      rechargeDays: number;
    }
  | {
      basis: "estimate";
      currency: string;
      days: number;
      sampleDays: number;
      note: string;
    }
  | {
      basis: "insufficient";
      currency: string;
      sampleDays: number;
      reason: "NO_COST_DATA" | "TOO_FEW_DAYS" | "NO_BALANCE" | "CURRENCY_MISMATCH";
    };

export interface RunwayDay {
  /** YYYY-MM-DD */
  date: string;
  cost: Money | string | null;
  costComplete: boolean;
  source: string;
}

export interface RunwayBalancePoint {
  fetchedAt: Date | string;
  currency: string;
  available: Money | string;
}

function dayKey(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  );
  return sorted[idx]!;
}

/**
 * @param currency 目标币种（必须与余额币种一致）
 * @param available 最新可用余额
 * @param days 日用量（含 derived 时 caller 可只传官方/实测）
 * @param balances 余额序列（识别充值日：available 相对前一点上升）
 */
export function computeRunway(args: {
  currency: string;
  available: Money | string;
  days: RunwayDay[];
  balances?: RunwayBalancePoint[];
  /** 是否允许 derived_estimate 进入 estimate 档 */
  allowEstimate?: boolean;
}): Runway {
  const currency = args.currency.trim().toUpperCase();
  if (!currency) {
    return { basis: "insufficient", currency: "", sampleDays: 0, reason: "CURRENCY_MISMATCH" };
  }

  let available: Money;
  try {
    available = toMoney(args.available);
  } catch {
    return { basis: "insufficient", currency, sampleDays: 0, reason: "NO_BALANCE" };
  }
  if (moneyCmp(available, "0") <= 0) {
    return { basis: "insufficient", currency, sampleDays: 0, reason: "NO_BALANCE" };
  }

  // 充值日：余额相对前一点上升的日期
  const recharge = new Set<string>();
  const bals = [...(args.balances ?? [])].sort((a, b) => {
    const ta = new Date(a.fetchedAt).getTime();
    const tb = new Date(b.fetchedAt).getTime();
    return ta - tb;
  });
  for (let i = 1; i < bals.length; i++) {
    const prev = bals[i - 1]!;
    const cur = bals[i]!;
    if (prev.currency.toUpperCase() !== currency || cur.currency.toUpperCase() !== currency) continue;
    try {
      if (moneyCmp(toMoney(cur.available), toMoney(prev.available)) > 0) {
        recharge.add(dayKey(cur.fetchedAt));
      }
    } catch {
      // ignore invalid balance points
    }
  }

  const completeCosts: number[] = [];
  const estimateCosts: number[] = [];
  let sawEstimate = false;

  for (const d of args.days) {
    if (recharge.has(d.date)) continue;
    const costNum = d.cost == null ? null : Number(toMoney(d.cost));
    if (costNum == null || !Number.isFinite(costNum)) continue;
    if (d.source === "derived_estimate") {
      sawEstimate = true;
      if (args.allowEstimate !== false) estimateCosts.push(Math.max(0, costNum));
      continue;
    }
    if (!d.costComplete || costNum <= 0) continue;
    completeCosts.push(costNum);
  }

  // 优先官方/实测；不足 3 天时若有官方样本则直接 insufficient（不拿估算凑数）
  let pool: number[];
  let isEstimate = false;
  if (completeCosts.length >= 3) {
    pool = completeCosts;
  } else if (completeCosts.length > 0) {
    return {
      basis: "insufficient",
      currency,
      sampleDays: completeCosts.length,
      reason: "TOO_FEW_DAYS",
    };
  } else if (estimateCosts.length >= 3) {
    pool = estimateCosts;
    isEstimate = true;
  } else {
    return {
      basis: "insufficient",
      currency,
      sampleDays: estimateCosts.length,
      reason: estimateCosts.length === 0 ? "NO_COST_DATA" : "TOO_FEW_DAYS",
    };
  }
  const sampleDays = pool.length;

  const sorted = [...pool].sort((a, b) => a - b);
  const med = median(sorted);
  if (med <= 0) {
    return { basis: "insufficient", currency, sampleDays, reason: "NO_COST_DATA" };
  }

  const availNum = Number(available);
  const days = Math.floor(availNum / med);
  const p25 = percentile(sorted, 25);
  const p75 = percentile(sorted, 75);
  const p25Days = p25 > 0 ? Math.floor(availNum / p25) : days;
  const p75Days = p75 > 0 ? Math.floor(availNum / p75) : days;

  if (isEstimate || (sawEstimate && completeCosts.length < 3)) {
    return {
      basis: "estimate",
      currency,
      days,
      sampleDays,
      note: "含余额差值估算日，仅作参考；建议导入官方 CSV 或开启采集器",
    };
  }

  return {
    basis: "ok",
    currency,
    days,
    medianDailyCost: toMoney(med),
    p25Days: Math.min(p25Days, days),
    p75Days: Math.max(p75Days, days),
    sampleDays,
    rechargeDays: recharge.size,
  };
}

export const RUNWAY_COPY =
  "按最近 N 天速度估算，非承诺用完日期";
