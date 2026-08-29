/**
 * DeepBalance 快照差值消耗引擎（T3.2，规格卡 C）
 *
 * 纯函数、无副作用、按币种分开，公式与 PRD §4.2「余额快照与差值推算口径」完全一致。
 * 时区约定：一律 UTC（`toISOString` 即 UTC；项目为个人工具，UTC 口径见 PRD 关键事实）。
 *
 * 已知误差与边界（PRD §4.2）：
 * - 快照间隔内的消耗归并到相邻时点；本实现将一段消耗归并到段的**起点**快照所在日；
 * - 拉取失败造成的缺口：聚合函数**只做 hasGap 标记**（不线性插值），缺口区间内的
 *   无快照日直接跳过（cost=0），由 UI 层在 hasGap=true 的数据恢复日画断点/浅色虚线，
 *   插值逻辑在 UI 层完成（前端负责，见 PRD「缺口…以浅色/断点标注」）；
 * - 接入前无历史：无快照的天不伪造数据（调用方补 cost=0、hasGap=false）；
 * - 多币种分别统计、不强行换算（跨币种相邻段 deltaCost 为 null，直接跳过）。
 */

export interface SnapshotPoint {
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
}

export interface TimedSnapshotPoint extends SnapshotPoint {
  fetchedAt: Date;
}

export interface DayAggregate {
  /** YYYY-MM-DD（UTC） */
  date: string;
  /** 当日「段起点在该日」的各段 deltaCost 之和；无段可归的天为 0 */
  cost: number;
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
 *
 * 口径修正说明（对 PRD §4.2 / 规格卡 C 公式的偏离，2026-08-29 实测校正）：
 * 官方 /user/balance 的 balance_infos 恒有 total = granted + topped_up（探针与
 * 真实用户数据均验证），消耗发生时 total 与 topped_up 同步减少。PRD 原公式
 * 「-(Δtotal) + Δtopped_up + Δgranted」在这些字段下两两抵消，导致消耗恒为 0。
 * 修正口径：净消耗 = max(0, prev.total - next.total)（官方剩余额度模型下，
 * 充值/赠金到账会使 total 上升，天然不会被误计为消耗；同日"消耗+充值"混合段
 * 只能得到净额，属既有已知误差，UI 维持「估算」标注）。
 */
export function deltaCost(prev: SnapshotPoint, next: SnapshotPoint): number | null {
  if (prev.currency !== next.currency) return null;
  const cost = prev.totalBalance - next.totalBalance;
  return cost > 0 ? cost : 0;
}

/** UTC 日键：YYYY-MM-DD。 */
function utcDayKey(d: Date): string {
  // toISOString 恒为 UTC（ISO 8601），取前 10 位即 UTC 日期
  return d.toISOString().slice(0, 10);
}

/**
 * 提取同币种相邻快照对（按 fetchedAt 升序）。各币种是平行数据流：
 * 跨币种相邻快照不对齐、不参与差值也不参与缺口判定。
 * 不修改入参（内部复制后排序）。
 */
function sameCurrencyPairs(
  points: TimedSnapshotPoint[]
): Array<{ prev: TimedSnapshotPoint; next: TimedSnapshotPoint }> {
  const sorted = [...points].sort(
    (a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime()
  );
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
 *
 * 段归并规则：一段消耗归并到段的起点快照（PRD「归并到相邻时点」）。
 * 由此，今日消耗 = UTC 当日 00:00 之后所有段的累计（即从当天第一个快照起算）：
 * 当无充值、无赠金变化时，逐段累加线性对消，恰等于当日首末快照 totalBalance 之差（AC3-1）。
 * 注意：deltaCost 对每段单独 clamp（Δcost<=0 视为无消耗，PRD），因此有充值/赠金调整时
 * 逐段累加与「首末整体套公式」略有差异——逐段更贴近真实消费，且充值段的负值不会冲减消耗。
 * 跨币种段（null）直接跳过。
 */
export function cumulativeCostFrom(points: TimedSnapshotPoint[], fromMs: number): number {
  let total = 0;
  for (const { prev, next } of sameCurrencyPairs(points)) {
    if (prev.fetchedAt.getTime() < fromMs) continue;
    total += deltaCost(prev, next) ?? 0;
  }
  return total;
}

/**
 * 按 UTC 日聚合 Δcost（驱动趋势图）。
 *
 * - 只返回**有快照**的天；无快照的天由调用方补 cost=0、hasGap=false（无数据不伪造，
 *   UI 自行处理空数据，见 dashboard route）；
 * - cost：当日「段起点在该日」的各段 deltaCost 之和；跨日段归并到起点日；
 * - hasGap：当天存在段内间隔 > maxGapMs，或数据恢复日（该日第一条快照与
 *   之前最后一条同币种快照间隔 > maxGapMs）。缺口区间内的无快照日不出现在
 *   结果中（跳过），UI 用恢复日的 hasGap=true 画断点/浅色虚线；
 * - 结果按日期升序（YYYY-MM-DD 字符串序即时间序）。
 */
export function dailyAggregate(
  points: TimedSnapshotPoint[],
  maxGapMs: number = DEFAULT_MAX_GAP_MS
): DayAggregate[] {
  const costByDay = new Map<string, number>();
  const gapByDay = new Map<string, boolean>();
  const dayWithSnapshot = new Set<string>();

  for (const p of points) dayWithSnapshot.add(utcDayKey(p.fetchedAt));

  for (const { prev, next } of sameCurrencyPairs(points)) {
    const cost = deltaCost(prev, next);
    if (cost !== null) {
      const day = utcDayKey(prev.fetchedAt);
      costByDay.set(day, (costByDay.get(day) ?? 0) + cost);
    }
    const gapMs = next.fetchedAt.getTime() - prev.fetchedAt.getTime();
    if (gapMs > maxGapMs) {
      gapByDay.set(utcDayKey(next.fetchedAt), true);
    }
  }

  return [...dayWithSnapshot].sort().map((date) => ({
    date,
    cost: costByDay.get(date) ?? 0,
    hasGap: gapByDay.get(date) ?? false,
  }));
}
