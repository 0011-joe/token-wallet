/**
 * 看板聚合端点（v2 过渡版：单凭证视角，字段已 Decimal 化；M4 扩展为跨平台总览）。
 *
 * GET /api/dashboard?credentialId=xxx&range=7|30|90（range 默认 30）
 *
 * 口径（PRD §4.2 / §6.3，DEV-GUIDE 红线）：
 * - 所有消耗均为**估算**（快照差值口径），响应恒带 isEstimate: true，UI 必须标注；
 * - 金额全部 Decimal 字符串（红线 #1）；
 * - 时区一律 UTC：today=UTC 当日 00:00 之后、month=UTC 当月 1 日后（M4 展示层切北京时间）；
 * - 多币种：主卡币种 CNY 优先（无 CNY 时取最近一条快照的币种）；分币种不混算；
 * - 缺口：trend 中以 hasGap 标记；无快照的天 cost=0、hasGap=false（不伪造数据）；
 * - 失败快照不写库；新鲜度用 stale 表达（最近成功快照距今 > 90 分钟）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import {
  DEFAULT_MAX_GAP_MS,
  cumulativeCostFrom,
  dailyAggregate,
  type TimedSnapshotPoint,
} from "@/lib/billing/snapshot-delta";
import { toMoney } from "@/lib/money";
import { aggregateOverview, type OverviewSnapshot } from "@/lib/dashboard/overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RANGES = [7, 30, 90] as const;
/** 快照周期 1h × 1.5 = 90 分钟，超过判定为「当前获取失败」的陈旧展示。 */
const STALE_AFTER_MS = 90 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveMaxGapMs(): number {
  const raw = process.env.SNAPSHOT_GAP_MAX_MS;
  if (!raw) return DEFAULT_MAX_GAP_MS;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_GAP_MS;
}

function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** breakdown 为 Prisma JsonValue；按统一槽位取值（缺项 undefined，前端隐藏） */
function breakdownOf(raw: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["cash", "granted", "voucher", "creditLimit", "frozen", "arrears"]) {
      const v = obj[key];
      if (typeof v === "string") out[key] = v;
      else if (typeof v === "number") out[key] = toMoney(v);
    }
  }
  return out;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const user = await db.user.findUnique({ where: { email: session.user.email } });
  if (!user) {
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const credentialId = params.get("credentialId");

  // ── 总览模式（FR-3 / AC3.1-3.3）：无 credentialId → 跨平台分币种聚合 ──
  if (!credentialId) {
    const allCredentials = await db.credential.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    const snapshots = await db.balanceSnapshot.findMany({
      where: { credentialId: { in: allCredentials.map((c) => c.id) }, ok: true },
      orderBy: { fetchedAt: "asc" },
      select: { credentialId: true, currency: true, available: true, isAvailable: true, fetchedAt: true },
    });
    const byCredential = new Map<string, OverviewSnapshot[]>();
    for (const s of snapshots) {
      const list = byCredential.get(s.credentialId) ?? [];
      list.push({
        currency: s.currency,
        available: s.available.toString(),
        isAvailable: s.isAvailable,
        fetchedAt: s.fetchedAt,
      });
      byCredential.set(s.credentialId, list);
    }
    const overview = aggregateOverview(
      allCredentials.map((c) => ({
        id: c.id,
        provider: c.provider,
        hint: c.hint,
        label: c.label,
        isActive: c.isActive,
        lastStatus: c.lastStatus,
        failCount: c.failCount,
        lastSuccessAt: c.lastSuccessAt,
      })),
      byCredential
    );
    return NextResponse.json(
      { overview, isEstimate: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (credentialId === "") {
    return NextResponse.json({ ok: false, error: "缺少 credentialId 参数" }, { status: 400 });
  }

  let range = 30;
  const rawRange = params.get("range");
  if (rawRange !== null && rawRange !== "") {
    range = Number(rawRange);
    if (!Number.isInteger(range) || !(RANGES as readonly number[]).includes(range)) {
      return NextResponse.json({ ok: false, error: "range 仅支持 7 | 30 | 90" }, { status: 400 });
    }
  }

  const credential = await db.credential.findUnique({ where: { id: credentialId } });
  // 归属校验失败统一 404：不向他人泄露凭证是否存在
  if (!credential || credential.userId !== user.id) {
    return NextResponse.json({ ok: false, error: "凭证不存在" }, { status: 404 });
  }

  const snapshots = await db.balanceSnapshot.findMany({
    where: { credentialId: credential.id, ok: true },
    orderBy: { fetchedAt: "asc" },
  });

  const now = new Date();
  const nowMs = now.getTime();

  // ── balance 主卡：每币种取最近一条 ok=true；主卡币种 CNY 优先 ──
  const latestByCurrency = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) latestByCurrency.set(s.currency, s);

  const latest = snapshots[snapshots.length - 1];
  const displayCurrency = latestByCurrency.has("CNY")
    ? "CNY"
    : latest?.currency ?? "CNY";

  const displayed = latestByCurrency.get(displayCurrency) ?? null;
  const balance = displayed
    ? {
        currency: displayed.currency,
        available: displayed.available.toString(),
        breakdown: breakdownOf(displayed.breakdown),
        isAvailable: displayed.isAvailable,
        fetchedAt: displayed.fetchedAt.toISOString(),
        stale: nowMs - displayed.fetchedAt.getTime() > STALE_AFTER_MS,
        byCurrency: [...latestByCurrency.values()]
          .sort(
            (a, b) =>
              a.fetchedAt.getTime() - b.fetchedAt.getTime() ||
              a.currency.localeCompare(b.currency)
          )
          .map((s) => ({
            currency: s.currency,
            available: s.available.toString(),
            breakdown: breakdownOf(s.breakdown),
            isAvailable: s.isAvailable,
            fetchedAt: s.fetchedAt.toISOString(),
          })),
      }
    : null;

  // ── today / month：主卡币种升序快照逐段 deltaCost 累计（从窗口起点起算） ──
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const displayPoints: TimedSnapshotPoint[] = snapshots
    .filter((s) => s.currency === displayCurrency)
    .map((s) => ({
      currency: s.currency,
      available: s.available.toString(),
      fetchedAt: s.fetchedAt,
    }));

  const todayCount = displayPoints.filter((p) => p.fetchedAt >= todayStart).length;
  const monthCount = displayPoints.filter((p) => p.fetchedAt >= monthStart).length;
  const today = {
    cost: todayCount >= 2 ? cumulativeCostFrom(displayPoints, todayStart.getTime()) : toMoney("0"),
    from: (todayCount >= 2 ? "snapshot" : "no-snapshot") as "snapshot" | "no-snapshot",
    currency: displayCurrency,
  };
  const month = {
    cost: monthCount >= 2 ? cumulativeCostFrom(displayPoints, monthStart.getTime()) : toMoney("0"),
    from: (monthCount >= 2 ? "snapshot" : "no-snapshot") as "snapshot" | "no-snapshot",
    currency: displayCurrency,
  };

  // ── trend：range 天逐日 {date, cost, hasGap}；无快照的天补 0/false（不伪造） ──
  const aggByDate = new Map(
    dailyAggregate(displayPoints, resolveMaxGapMs()).map((d) => [d.date, d])
  );
  const days: { date: string; cost: string; hasGap: boolean }[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const date = utcDayString(new Date(todayStart.getTime() - i * DAY_MS));
    const agg = aggByDate.get(date);
    days.push(agg ? { date, cost: agg.cost, hasGap: agg.hasGap } : { date, cost: "0.000000000", hasGap: false });
  }

  return NextResponse.json(
    {
      credential: {
        id: credential.id,
        provider: credential.provider,
        kind: credential.kind,
        region: credential.region,
        label: credential.label,
        hint: credential.hint,
        isActive: credential.isActive,
        lastStatus: credential.lastStatus,
        failCount: credential.failCount,
        lastSuccessAt: credential.lastSuccessAt?.toISOString() ?? null,
      },
      balance,
      today,
      month,
      trend: { range, days },
      isEstimate: true,
      generatedAt: now.toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
