/**
 * T5.5 快照保留策略单测：>180 天明细按天降采样（每天保留最早一条，其余删除）。
 */
import { describe, expect, it } from "vitest";
import { retentionCandidates, type SnapshotCandidate } from "../lib/snapshot/retention";

const NOW = new Date("2026-09-10T00:00:00Z");
const day = (offsetDays: number, hour: number): SnapshotCandidate => ({
  id: `d${offsetDays}h${hour}`,
  fetchedAt: new Date(NOW.getTime() - offsetDays * 86400_000 + hour * 3600_000),
});

describe("retentionCandidates", () => {
  it("180 天内快照不删除", () => {
    const drops = retentionCandidates([day(10, 0), day(179, 23)], NOW);
    expect(drops.size).toBe(0);
  });

  it("超 180 天：同一天保留最早一条，其余删除", () => {
    const old = day(200, 0); // 保留（最早）
    const old2 = day(200, 6);
    const old3 = day(200, 12);
    const drops = retentionCandidates([old, old2, old3, day(10, 0)], NOW);
    expect(drops).toEqual(new Set(["d200h6", "d200h12"]));
  });

  it("不同天各保留最早一条", () => {
    const a1 = day(200, 1);
    const a2 = day(200, 5);
    const b1 = day(201, 0);
    const b2 = day(201, 8);
    const drops = retentionCandidates([a2, a1, b2, b1], NOW);
    expect(drops).toEqual(new Set(["d200h5", "d201h8"]));
  });

  it("自定义阈值天数", () => {
    const drops = retentionCandidates([day(31, 0), day(31, 6)], NOW, 30);
    expect(drops).toEqual(new Set(["d31h6"]));
  });

  it("空输入 → 空集", () => {
    expect(retentionCandidates([], NOW).size).toBe(0);
  });
});
