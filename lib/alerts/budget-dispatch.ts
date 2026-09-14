/**
 * 预算/runway 告警派发（由 cron 调用；写 AlertEvent + 邮件，24h 频控）。
 */
import { db } from "@/lib/db";
import { toMoney } from "@/lib/money";
import { computeRunway, type RunwayDay } from "@/lib/billing/runway";
import {
  budgetWindowRange,
  evaluateBudgetAlerts,
} from "@/lib/alerts/budget-evaluate";
import { renderAlertEmail } from "@/lib/email/templates";
import { sendAlertEmail } from "@/lib/email/send";

/** AlertEvent.type 允许的新类型（Prisma 字符串列） */
const BUDGET_TYPES = new Set<string>([
  "BUDGET_WARN",
  "BUDGET_BREACH",
  "RUNWAY_SHORT",
]);

export interface BudgetDispatchResult {
  evaluated: number;
  emitted: number;
}

export async function dispatchBudgetAlerts(
  userId: string
): Promise<BudgetDispatchResult> {
  const budgets = await db.budget.findMany({
    where: { userId, isActive: true },
  });
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) return { evaluated: 0, emitted: 0 };

  const settings = await db.alertSetting.findUnique({ where: { userId } });
  const emailEnabled = settings?.emailEnabled ?? true;
  const inappEnabled = settings?.inappEnabled ?? true;

  let evaluated = 0;
  let emitted = 0;

  for (const b of budgets) {
    evaluated += 1;
    const range = budgetWindowRange({
      period: b.period as "day" | "month" | "custom",
      windowStart: b.windowStart,
      windowEnd: b.windowEnd,
    });

    const rows = await db.usageDaily.findMany({
      where: {
        userId,
        currency: b.currency,
        costComplete: true,
        date: { gte: range.gte, lt: range.lt },
        ...(b.provider ? { provider: b.provider } : {}),
      },
      select: { cost: true, date: true, source: true },
    });
    const spent = rows.reduce((s, r) => s + Number((r.cost ?? 0).toString()), 0);

    // runway（粗算：30 天窗口）
    const since = new Date(Date.now() - 30 * 86400_000);
    const daily = await db.usageDaily.findMany({
      where: {
        userId,
        currency: b.currency,
        date: { gte: since },
        ...(b.provider ? { provider: b.provider } : {}),
      },
      select: {
        date: true,
        cost: true,
        costComplete: true,
        source: true,
      },
    });
    const snaps = await db.balanceSnapshot.findMany({
      where: {
        ok: true,
        currency: b.currency,
        credential: { userId, ...(b.provider ? { provider: b.provider as never } : {}) },
      },
      orderBy: { fetchedAt: "desc" },
      take: 1,
      select: { available: true },
    });
    let runwayDays: number | null = null;
    if (snaps[0]) {
      const runway = computeRunway({
        currency: b.currency,
        available: toMoney(snaps[0].available),
        days: daily.map(
          (d): RunwayDay => ({
            date: d.date.toISOString().slice(0, 10),
            cost: d.cost == null ? null : toMoney(d.cost),
            costComplete: d.costComplete,
            source: d.source,
          })
        ),
        allowEstimate: true,
      });
      if (runway.basis === "ok" || runway.basis === "estimate") {
        runwayDays = runway.days;
      }
    }

    // lastAlert：预算类事件按 budgetId 前缀查询最近一次
    const lastEvents = await db.alertEvent.findMany({
      where: {
        userId,
        type: { in: [...BUDGET_TYPES] },
        message: { contains: `#${b.id}` },
      },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { type: true, createdAt: true },
    });
    const lastByType = new Map(
      lastEvents.map((e) => [e.type, { type: e.type, createdAt: e.createdAt }])
    );

    const candidates = evaluateBudgetAlerts({
      budget: {
        id: b.id,
        amount: toMoney(b.amount),
        currency: b.currency,
        warnPct: b.warnPct,
        criticalPct: b.criticalPct,
        runwayAlertDays: b.runwayAlertDays,
        provider: b.provider,
      },
      spent: toMoney(spent),
      runwayDays,
    });

    for (const c of candidates) {
      const last = lastByType.get(c.type);
      const suppressed =
        last &&
        last.type === c.type &&
        Date.now() - last.createdAt.getTime() < 24 * 60 * 60 * 1000;
      // evaluateBudgetAlerts 已做同参频控；DB 再兜一层（多实例）
      if (suppressed) continue;

      const message = `${c.message} [budget#${b.id}]`;
      if (inappEnabled) {
        try {
          await db.alertEvent.create({
            data: {
              userId,
              provider: (b.provider as never) ?? "deepseek",
              credentialId: null,
              type: c.type,
              message,
              dedupKey: c.dedupKey,
            },
          });
        } catch (err) {
          if ((err as { code?: string }).code !== "P2002") throw err;
          continue;
        }
      }
      emitted += 1;
      if (emailEnabled) {
        const { subject, html } = renderAlertEmail({
          type: c.type as never,
          last4: b.currency,
          message,
          severity: c.severity,
        });
        await sendAlertEmail({ to: user.email, subject, html });
      }
    }
  }

  return { evaluated, emitted };
}
