/**
 * GET /api/billing/runway —— 分币种 runway（从 BalanceSnapshot + UsageDaily 计算）。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { computeRunway, type RunwayDay } from "@/lib/billing/runway";
import { toMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOOKBACK_DAYS = 30;

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);
  const snaps = await db.balanceSnapshot.findMany({
    where: { ok: true, credential: { userId: user.id } },
    orderBy: { fetchedAt: "desc" },
    take: 200,
    select: { currency: true, available: true, fetchedAt: true },
  });

  // 每币种最新可用余额
  const latestByCur = new Map<
    string,
    { available: string; fetchedAt: Date; points: Array<{ fetchedAt: Date; currency: string; available: string }> }
  >();
  for (const s of [...snaps].reverse()) {
    const cur = s.currency.toUpperCase();
    const avail = toMoney(s.available);
    const bucket = latestByCur.get(cur) ?? {
      available: avail,
      fetchedAt: s.fetchedAt,
      points: [],
    };
    bucket.points.push({
      fetchedAt: s.fetchedAt,
      currency: cur,
      available: avail,
    });
    // 反序写入后最后一个是最新
    bucket.available = avail;
    bucket.fetchedAt = s.fetchedAt;
    latestByCur.set(cur, bucket);
  }

  const daily = await db.usageDaily.findMany({
    where: { userId: user.id, date: { gte: since } },
    select: {
      date: true,
      currency: true,
      cost: true,
      costComplete: true,
      source: true,
    },
  });

  const results = [] as Array<Record<string, unknown>>;
  for (const [cur, info] of latestByCur) {
    const days: RunwayDay[] = daily
      .filter((d) => !d.currency || d.currency.toUpperCase() === cur)
      .map((d) => ({
        date: d.date.toISOString().slice(0, 10),
        cost: d.cost == null ? null : toMoney(d.cost),
        costComplete: d.costComplete,
        source: d.source,
      }));
    const runway = computeRunway({
      currency: cur,
      available: info.available,
      days,
      balances: info.points,
      allowEstimate: true,
    });
    results.push({ currency: cur, runway });
  }

  return NextResponse.json({
    asOf: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    runways: results,
  });
}
