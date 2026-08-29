/**
 * T3.3 看板聚合端点：余额卡 + 今日/本月消耗 + 趋势（7/30/90 天）。
 *
 * GET /api/dashboard?keyId=xxx&range=7|30|90（range 默认 30）
 *
 * 口径（PRD §4.2 / §6.3）：
 * - 所有消耗均为**估算**（快照差值口径），响应恒带 isEstimate: true，UI 必须标注；
 * - 时区一律 UTC：today=UTC 当日 00:00 之后、month=UTC 当月 1 日后；
 * - 段归并：一段消耗归并到段的起点快照（today 从当天第一个快照起算，AC3-1 逐段可对消）；
 * - 多币种：主卡币种 CNY 优先（无 CNY 时取最近一条快照的币种）；today/month/trend 均
 *   按主卡币种单独统计（分币种不混算、不换算），byCurrency 提供各币种最新快照；
 * - 缺口：trend 中以 hasGap 标记（AC3-3）；缺口区间内无快照的天 cost=0、hasGap=false
 *   （无数据不伪造，UI 自行处理空数据）；数据恢复日 hasGap=true 由 UI 画断点/浅色虚线，
 *   线性插值在 UI 层完成（前端负责）；
 * - 快照缺口判定阈值：默认 2 倍快照周期（SNAPSHOT_CRON 默认 1h → 2h），
 *   可用 SNAPSHOT_GAP_MAX_MS（毫秒）覆盖；
 * - 失败快照不写库（cron 取舍，见 app/api/cron/snapshot/route.ts），本端点只取 ok=true；
 *   数据新鲜度用 stale 表达（最近成功快照距今 > 90 分钟 = 快照周期 1h × 1.5）。
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
  const keyId = params.get("keyId");
  if (!keyId) {
    return NextResponse.json({ ok: false, error: "缺少 keyId 参数" }, { status: 400 });
  }

  let range = 30;
  const rawRange = params.get("range");
  if (rawRange !== null && rawRange !== "") {
    range = Number(rawRange);
    if (!Number.isInteger(range) || !(RANGES as readonly number[]).includes(range)) {
      return NextResponse.json(
        { ok: false, error: "range 仅支持 7 | 30 | 90" },
        { status: 400 }
      );
    }
  }

  const key = await db.apiKey.findUnique({ where: { id: keyId } });
  // 归属校验失败统一 404：不向他人泄露 key 是否存在
  if (!key || key.userId !== user.id) {
    return NextResponse.json({ ok: false, error: "Key 不存在" }, { status: 404 });
  }

  const snapshots = await db.balanceSnapshot.findMany({
    where: { apiKeyId: key.id, ok: true },
    orderBy: { fetchedAt: "asc" },
  });

  const now = new Date();
  const nowMs = now.getTime();

  // ── balance 主卡：每币种取最近一条 ok=true；主卡币种 CNY 优先 ──
  const latestByCurrency = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) latestByCurrency.set(s.currency, s); // fetchedAt 升序，最后写入即最新

  const latest = snapshots[snapshots.length - 1];
  const displayCurrency = latestByCurrency.has("CNY")
    ? "CNY"
    : latest?.currency ?? "CNY"; // 无任何快照时兜底 CNY（不影响响应，balance 为 null）

  const displayed = latestByCurrency.get(displayCurrency) ?? null;
  const balance = displayed
    ? {
        currency: displayed.currency,
        total: displayed.totalBalance,
        granted: displayed.grantedBalance,
        toppedUp: displayed.toppedUpBalance,
        isAvailable: displayed.isAvailable,
        fetchedAt: displayed.fetchedAt.toISOString(),
        // 以主卡展示快照的时效为准：展示的是哪个值，就标哪个值的时效
        stale: nowMs - displayed.fetchedAt.getTime() > STALE_AFTER_MS,
        byCurrency: [...latestByCurrency.values()]
          .sort(
            (a, b) =>
              a.fetchedAt.getTime() - b.fetchedAt.getTime() ||
              a.currency.localeCompare(b.currency)
          )
          .map((s) => ({
            currency: s.currency,
            total: s.totalBalance,
            granted: s.grantedBalance,
            toppedUp: s.toppedUpBalance,
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
      totalBalance: s.totalBalance,
      grantedBalance: s.grantedBalance,
      toppedUpBalance: s.toppedUpBalance,
      fetchedAt: s.fetchedAt,
    }));

  const todayCount = displayPoints.filter((p) => p.fetchedAt >= todayStart).length;
  const monthCount = displayPoints.filter((p) => p.fetchedAt >= monthStart).length;
  const today = {
    cost: todayCount >= 2 ? cumulativeCostFrom(displayPoints, todayStart.getTime()) : 0,
    from: (todayCount >= 2 ? "snapshot" : "no-snapshot") as "snapshot" | "no-snapshot",
    currency: displayCurrency,
  };
  const month = {
    cost: monthCount >= 2 ? cumulativeCostFrom(displayPoints, monthStart.getTime()) : 0,
    from: (monthCount >= 2 ? "snapshot" : "no-snapshot") as "snapshot" | "no-snapshot",
    currency: displayCurrency,
  };

  // ── trend：range 天逐日 {date, cost, hasGap}；无快照的天补 0/false（不伪造） ──
  const aggByDate = new Map(
    dailyAggregate(displayPoints, resolveMaxGapMs()).map((d) => [d.date, d])
  );
  const days: { date: string; cost: number; hasGap: boolean }[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const date = utcDayString(new Date(todayStart.getTime() - i * DAY_MS));
    const agg = aggByDate.get(date);
    days.push(agg ?? { date, cost: 0, hasGap: false });
  }

  return NextResponse.json(
    {
      key: {
        id: key.id,
        label: key.label,
        last4: key.last4,
        isActive: key.isActive,
        lastStatus: key.lastStatus,
        failCount: key.failCount,
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
