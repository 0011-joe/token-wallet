/**
 * 月度对账（G10）：ModelUsage vs UsageDaily vs 余额差值。
 */
import { moneyAbs, moneyCmp, moneySub, toMoney, type Money } from "@/lib/money";

export interface ReconcileInput {
  currency: string;
  modelUsageCost: number | string;
  usageDailyCost: number | string;
  balanceDeltaCost?: number | string | null;
  usageDailyComplete?: boolean;
}

export interface ReconcileResult {
  currency: string;
  modelUsageCost: Money;
  usageDailyCost: Money;
  balanceDeltaCost: Money | null;
  absDiff: Money;
  relDiffPct: number;
  usable: boolean;
  note: string;
}

export function reconcileMonth(input: ReconcileInput): ReconcileResult {
  const currency = input.currency.trim().toUpperCase();
  const mu = toMoney(input.modelUsageCost);
  const ud = toMoney(input.usageDailyCost);
  const bd = input.balanceDeltaCost == null ? null : toMoney(input.balanceDeltaCost);

  const absDiff = moneyAbs(moneySub(mu, ud));
  const base = Math.max(Number(mu), Number(ud), 1e-9);
  const relDiffPct = (Number(absDiff) / base) * 100;

  const complete = input.usageDailyComplete !== false;
  const usable = complete && moneyCmp(absDiff, "0.000000001") < 0;

  let note: string;
  if (!complete) {
    note = "UsageDaily 含估算或不完整费用，对账仅供参考";
  } else if (usable) {
    note = "两表月合计一致";
  } else {
    note = "两表月合计存在差异，请检查导入与双写";
  }
  if (bd != null) {
    note += "；余额差值仅作估算对照";
  }

  return {
    currency,
    modelUsageCost: mu,
    usageDailyCost: ud,
    balanceDeltaCost: bd,
    absDiff,
    relDiffPct,
    usable,
    note,
  };
}
