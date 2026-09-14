/**
 * 预算/runway 告警判定（纯函数，可单测）。
 * 消耗来源应为 UsageDaily.cost（计价引擎），不用余额差值。
 */
import { moneyCmp, moneyIsPositive, toMoney, type Money } from "@/lib/money";

export type BudgetAlertType = "BUDGET_WARN" | "BUDGET_BREACH" | "RUNWAY_SHORT";

export interface BudgetAlertCandidate {
  type: BudgetAlertType;
  budgetId: string;
  message: string;
  dedupKey: string;
  severity: "warning" | "critical";
}

export interface BudgetView {
  id: string;
  amount: Money | string;
  currency: string;
  warnPct: number;
  criticalPct: number;
  runwayAlertDays: number | null;
  provider?: string | null;
}

export function evaluateBudgetAlerts(params: {
  budget: BudgetView;
  /** 周期内已消耗（同币种） */
  spent: Money | string;
  runwayDays?: number | null;
  lastAlert?: { type: string; createdAt: Date } | null;
  windowMs?: number;
}): BudgetAlertCandidate[] {
  const windowMs = params.windowMs ?? 24 * 60 * 60 * 1000;
  const out: BudgetAlertCandidate[] = [];
  const b = params.budget;
  const amount = toMoney(b.amount);
  const spent = toMoney(params.spent);
  const spentNum = Number(spent);
  const amountNum = Number(amount);
  if (amountNum <= 0) return out;

  const pct = (spentNum / amountNum) * 100;
  const cur = b.currency.toUpperCase();
  const scope = b.provider ? ` (${b.provider})` : "";

  function suppressed(type: BudgetAlertType): boolean {
    const last = params.lastAlert;
    if (!last || last.type !== type) return false;
    return Date.now() - last.createdAt.getTime() < windowMs;
  }

  if (!suppressed("BUDGET_BREACH") && pct >= b.criticalPct) {
    out.push({
      type: "BUDGET_BREACH",
      budgetId: b.id,
      message: `预算${scope} 已用 ${pct.toFixed(1)}%（${spent}${cur} / ${amount}${cur}），达到或超过 ${b.criticalPct}%`,
      dedupKey: `BUDGET_BREACH:${b.id}`,
      severity: "critical",
    });
  } else if (!suppressed("BUDGET_WARN") && pct >= b.warnPct) {
    out.push({
      type: "BUDGET_WARN",
      budgetId: b.id,
      message: `预算${scope} 已用 ${pct.toFixed(1)}%（${spent}${cur} / ${amount}${cur}），超过 ${b.warnPct}% 预警线`,
      dedupKey: `BUDGET_WARN:${b.id}`,
      severity: "warning",
    });
  }

  const runwayDays = params.runwayDays;
  if (
    b.runwayAlertDays != null &&
    runwayDays != null &&
    runwayDays < b.runwayAlertDays &&
    !suppressed("RUNWAY_SHORT")
  ) {
    out.push({
      type: "RUNWAY_SHORT",
      budgetId: b.id,
      message: `按最近消耗速度估算，余额约还能用 ${runwayDays} 天（低于 ${b.runwayAlertDays} 天）。该数字为估算，非承诺用完日期。`,
      dedupKey: `RUNWAY_SHORT:${b.id}`,
      severity: "warning",
    });
  }

  return out;
}

/** 周期窗口（UTC）：day/month/custom */
export function budgetWindowRange(opts: {
  period: "day" | "month" | "custom";
  windowStart?: Date | string | null;
  windowEnd?: Date | string | null;
  now?: Date;
}): { gte: Date; lt: Date } {
  const now = opts.now ?? new Date();
  if (opts.period === "day") {
    const gte = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const lt = new Date(gte.getTime() + 86400_000);
    return { gte, lt };
  }
  if (opts.period === "month") {
    const gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { gte, lt };
  }
  const gte = opts.windowStart ? new Date(opts.windowStart) : now;
  const lt = opts.windowEnd ? new Date(opts.windowEnd) : now;
  return { gte, lt };
}

export function budgetPctOf(spent: Money | string, amount: Money | string): number {
  const a = Number(toMoney(amount));
  if (a <= 0) return 0;
  return (Number(toMoney(spent)) / a) * 100;
}

export function isOverBudget(spent: Money | string, amount: Money | string): boolean {
  return moneyCmp(toMoney(spent), toMoney(amount)) >= 0 && moneyIsPositive(toMoney(spent));
}
