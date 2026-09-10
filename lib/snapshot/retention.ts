/**
 * 快照保留策略（T5.5 / FR-7，P1）：超过 180 天的明细按天降采样，
 * 每天仅保留最早一条成功快照，其余标记删除（避免无限膨胀）。
 * 纯函数，无副作用，便于单测。
 */
export interface SnapshotCandidate {
  id: string;
  fetchedAt: Date;
}

export const DEFAULT_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 计算待删除快照 id 集合：
 * - 仅处理 fetchedAt 早于 cutoff（now - thresholdDays 天）的快照；
 * - 同一 UTC 日内保留最早一条，其余删除。
 */
export function retentionCandidates(
  snapshots: SnapshotCandidate[],
  now: Date = new Date(),
  thresholdDays: number = DEFAULT_RETENTION_DAYS
): Set<string> {
  const cutoff = new Date(now.getTime() - thresholdDays * DAY_MS);
  const old = snapshots.filter((s) => s.fetchedAt.getTime() < cutoff.getTime());
  const keepByDay = new Map<string, string>(); // dayKey -> 最早快照 id
  const drop = new Set<string>();

  for (const s of [...old].sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())) {
    const day = utcDayKey(s.fetchedAt);
    if (!keepByDay.has(day)) {
      keepByDay.set(day, s.id); // 最早一条保留
    } else {
      drop.add(s.id);
    }
  }
  return drop;
}
