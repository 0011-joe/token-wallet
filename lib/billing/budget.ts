/**
 * 预算输入校验（FR-10）。
 */
export interface BudgetInput {
  amount: string;
  currency: string;
  period: "day" | "month" | "custom";
  scope: "global" | "provider" | "modelPattern";
  provider?: string | null;
  modelPattern?: string | null;
  windowStart?: string | Date | null;
  windowEnd?: string | Date | null;
  warnPct: number;
  criticalPct: number;
  runwayAlertDays?: number | null;
}

export function validateBudgetInput(input: BudgetInput): string | null {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "amount 必须为正数";
  }
  const cur = input.currency?.trim().toUpperCase();
  if (!cur) return "currency 必填";
  if (!Number.isInteger(input.warnPct) || input.warnPct < 0 || input.warnPct > 100) {
    return "warnPct 须为 0–100 整数";
  }
  if (
    !Number.isInteger(input.criticalPct) ||
    input.criticalPct < 0 ||
    input.criticalPct > 200
  ) {
    return "criticalPct 须为 0–200 整数";
  }
  if (input.warnPct >= input.criticalPct) {
    return "warnPct 必须小于 criticalPct";
  }
  if (input.scope === "provider" && !input.provider?.trim()) {
    return "scope=provider 时必须填写 provider";
  }
  if (input.scope === "modelPattern" && !input.modelPattern?.trim()) {
    return "scope=modelPattern 时必须填写 modelPattern";
  }
  if (input.period === "custom") {
    if (!input.windowStart || !input.windowEnd) {
      return "period=custom 时必须填写 windowStart/windowEnd";
    }
    const s = new Date(input.windowStart).getTime();
    const e = new Date(input.windowEnd).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) {
      return "windowStart 必须早于 windowEnd";
    }
  }
  if (
    input.runwayAlertDays != null &&
    (!Number.isInteger(input.runwayAlertDays) || input.runwayAlertDays < 0)
  ) {
    return "runwayAlertDays 须为非负整数或空";
  }
  return null;
}
