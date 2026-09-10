/**
 * 快照差值消耗引擎（T4.3 / 规格卡 B）——v2 Decimal 化，口径与 v1 实测校正一致。
 *
 * 公式口径说明（重要，与 PRD §4.2 原始公式的差异）：
 * 官方 /user/balance 的 balance_infos 恒有 total = granted + topped_up（2026-08-29 实测），
 * 消耗发生时 total 与 topped_up/granted 同步减少。PRD 原始公式
 * 「-(Δtotal) + Δtopped_up + Δgranted」在这些字段语义下两两抵消、恒为 0（v1 代码注释实测校正）。
 * 故 deltaCost 采用实测口径：net = max(0, prev.available - next.available)。
 * 充值/赠金到账使 available 上升，天然不会被误计为消耗；同日「消耗+充值」混合段只能得到
 * 净额，属既有已知误差，UI 维持「估算」标注（红线 #9）。
 *
 * 金额纪律（红线 #1）：全部 Decimal 字符串（lib/money）运算，领域层禁止 float。
 * 时区：一律 UTC；缺口：hasGap 标记（不线性插值），插值由 UI 层完成。
 */
import { moneyAdd, moneyCmp, moneyIsPositive, moneySub, toMoney, type Money } from "@/lib/money";

export interface SnapshotPoint {
  currency: string;
  available: Money;
  breakdown?: Record<string, string | undefined>;
}

export interface TimedSnapshotPoint extends SnapshotPoint {
  fetchedAt: Date;
}

export interface DayAggregate {
  /** YYYY-MM-DD（UTC） */
  date: string;
  /** 当日「段起点在该日」的各段 deltaCost 之和；无段可归的天为 0 */
  cost: Money;
  /**
   * true 表示该日存在快照缺口：当天某相邻快照间隔 > maxGapMs，
   * 或该日第一条快照与之前最后一条同币种快照间隔 > maxGapMs（数据恢复日）。
   * UI 在此画断点/浅色虚线。
   */
  hasGap: boolean;
}

/** 缺口判定阈值默认值：2 倍快照周期（SNAPSHOT_CRON 默认 1 小时 → 2 小时）；可通过 SNAPSHOT_GAP_MAX_MS 覆盖。 */
export const DEFAULT_MAX_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * 相邻两期快照的消费消耗；返回 null 表示无法判定（跨币种，不强行换算）。
 * 实测口径：净消耗 = max(0, prev.available - next.available)（见文件头注释）。
 */
export function deltaCost(prev: SnapshotPoint, next: SnapshotPoint): Money | null {
  if (prev.currency !== next.currency) return null;
  const cost = moneySub(prev.available, next.available);
  return moneyIsPositive(cost) ? cost : toMoney("0");
}

/** UTC 日键：YYYY-MM-DD。 */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 提取同币种相邻快照对（按 fetchedAt 升序）。各币种是平行数据流：
 * 跨币种相邻快照不对齐、不参与差值也不参与缺口判定。不修改入参（内部复制后排序）。
 */
function sameCurrencyPairs(points: TimedSnapshotPoint[]): Array<{ prev: TimedSnapshotPoint; next: TimedSnapshotPoint }> {
  const sorted = [...points].sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());
  const lastByCurrency = new Map<string, TimedSnapshotPoint>();
  const pairs: Array<{ prev: TimedSnapshotPoint; next: TimedSnapshotPoint }> = [];
  for (const p of sorted) {
    const prev = lastByCurrency.get(p.currency);
    if (prev) pairs.push({ prev, next: p });
    lastByCurrency.set(p.currency, p);
  }
  return pairs;
}

/**
 * 从 fromMs（含，毫秒时间戳）起累计消耗：所有「段起点 >= fromMs」的同币种相邻段 deltaCost 之和。
 * 段归并规则：一段消耗归并到段的起点快照；今日消耗 = UTC 当日 00:00 之后所有段的累计。
 */
export function cumulativeCostFrom(points: TimedSnapshotPoint[], fromMs: number): Money {
  let total: Money = toMoney("0");
  for (const { prev, next } of sameCurrencyPairs(points)) {
    if (prev.fetchedAt.getTime() < fromMs) continue;
    const d = deltaCost(prev, next);
    if (d !== null) total = moneyAdd(total, d);
  }
  return total;
}

/**
 * 按 UTC 日聚合 Δcost（驱动趋势图）。
 * - 只返回**有快照**的天；无快照的天由调用方补 cost=0、hasGap=false（无数据不伪造）；
 * - cost：当日「段起点在该日」的各段 deltaCost 之和；跨日段归并到起点日；
 * - hasGap：当天存在段内间隔 > maxGapMs，或数据恢复日（该日第一条快照与
 *   之前最后一条同币种快照间隔 > maxGapMs）；
 * - 结果按日期升序（YYYY-MM-DD 字符串序即时间序）。
 */
export function dailyAggregate(
  points: TimedSnapshotPoint[],
  maxGapMs: number = DEFAULT_MAX_GAP_MS
): DayAggregate[] {
  const costByDay = new Map<string, Money>();
  const gapByDay = new Map<string, boolean>();
  const dayWithSnapshot = new Set<string>();

  for (const p of points) dayWithSnapshot.add(utcDayKey(p.fetchedAt));

  for (const { prev, next } of sameCurrencyPairs(points)) {
    const cost = deltaCost(prev, next);
    if (cost !== null) {
      const day = utcDayKey(prev.fetchedAt);
      costByDay.set(day, moneyAdd(costByDay.get(day) ?? toMoney("0"), cost));
    }
    const gapMs = next.fetchedAt.getTime() - prev.fetchedAt.getTime();
    if (gapMs > maxGapMs) {
      gapByDay.set(utcDayKey(next.fetchedAt), true);
    }
  }

  return [...dayWithSnapshot].sort().map((date) => ({
    date,
    cost: costByDay.get(date) ?? toMoney("0"),
    hasGap: gapByDay.get(date) ?? false,
  }));
}

/** 比较两期快照可用余额（供测试与调用方使用）：a>b → 1 等 */
export function compareAvailable(a: Money, b: Money): number {
  return moneyCmp(a, b);
}
