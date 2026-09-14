/**
 * GET /api/billing/reconcile?month=YYYY-MM&provider=deepseek
 * 月度对账：ModelUsage vs UsageDaily vs 余额差（可选）。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { reconcileMonth } from "@/lib/billing/reconcile";
import {
  sumModelUsageMonthCost,
  sumUsageDailyMonthCost,
} from "@/lib/usage/daily-dual-write";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const url = new URL(request.url);
  const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  const provider = url.searchParams.get("provider") ?? "deepseek";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month 须为 YYYY-MM" }, { status: 400 });
  }

  const mu = await sumModelUsageMonthCost(db, user.id, provider, month);
  const ud = await sumUsageDailyMonthCost(db, user.id, provider, month);
  const importRow = await db.usageImport.findUnique({
    where: {
      userId_provider_month: { userId: user.id, provider: provider as never, month },
    },
    select: { currency: true },
  });
  const dailyComplete = await db.usageDaily.count({
    where: {
      userId: user.id,
      provider,
      source: "csv_official",
      costComplete: false,
    },
  });

  const result = reconcileMonth({
    currency: importRow?.currency ?? "CNY",
    modelUsageCost: mu,
    usageDailyCost: ud,
    balanceDeltaCost: null,
    usageDailyComplete: dailyComplete === 0,
  });

  return NextResponse.json({ month, provider, ...result });
}
