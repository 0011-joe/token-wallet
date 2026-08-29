/**
 * T3.2 单测（规格卡 C）：差值消耗公式必测四例 + 按天聚合/累计推荐用例。
 * 纯函数测试，不触库；期望值严格，与 AC3-1/AC3-2 对齐。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_GAP_MS,
  cumulativeCostFrom,
  dailyAggregate,
  deltaCost,
  type SnapshotPoint,
  type TimedSnapshotPoint,
} from "../lib/billing/snapshot-delta";

const p = (
  currency: string,
  totalBalance: number,
  grantedBalance = 0,
  toppedUpBalance = 0
): SnapshotPoint => ({ currency, totalBalance, grantedBalance, toppedUpBalance });

const t = (iso: string): Date => new Date(iso);

const pts = (...args: Array<[string, number, number, number, string]>): TimedSnapshotPoint[] =>
  args.map(([currency, total, granted, toppedUp, fetchedAt]) => ({
    ...p(currency, total, granted, toppedUp),
    fetchedAt: t(fetchedAt),
  }));

describe("deltaCost（规格卡 C 公式）", () => {
  it("纯消费：total 100→90，其余不变 → 10", () => {
    expect(deltaCost(p("CNY", 100), p("CNY", 90))).toBe(10);
  });

  it("充值当天：total 90→100，toppedUp 90→100 → 0（不被误计为收入）", () => {
    expect(deltaCost(p("CNY", 90, 0, 90), p("CNY", 100, 0, 100))).toBe(0);
  });

  it("消费+赠金：total 100→95，granted 0→5 → 5（净额：赠金到账 5 抵消部分消耗）", () => {
    expect(deltaCost(p("CNY", 100, 0), p("CNY", 95, 5))).toBe(5);
  });

  it("跨币种：CNY→USD → null（分开统计，不强行换算）", () => {
    expect(deltaCost(p("CNY", 100, 0, 0), p("USD", 90, 0, 0))).toBeNull();
  });

  it("余额回充/调整（无充值字段变化）→ clamp 至 0，不计负消耗", () => {
    expect(deltaCost(p("CNY", 90, 0, 0), p("CNY", 100, 0, 0))).toBe(0);
  });

  it("消费+充值混合：total 100→95，toppedUp 0→10 → 5（官方恒等口径：充值到账使 total 上升，只按净额计）", () => {
    expect(deltaCost(p("CNY", 100, 0, 0), p("CNY", 95, 0, 10))).toBe(5);
  });
});

describe("cumulativeCostFrom（今日/本月累计）", () => {
  it("只累计起点 >= fromMs 的段：今日从当天第一个快照起算（跨日段归前一日起算）", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T23:00:00Z"],
      ["CNY", 97, 0, 0, "2026-08-28T23:30:00Z"],
      ["CNY", 95, 0, 0, "2026-08-29T00:30:00Z"], // 跨日段（23:30→00:30）归 08-28
      ["CNY", 90, 0, 0, "2026-08-29T01:30:00Z"]
    );
    const dayStart = new Date("2026-08-29T00:00:00Z").getTime();
    expect(cumulativeCostFrom(points, dayStart)).toBe(5); // 只算 08-29 内的段
  });

  it("AC3-1：无充值无赠金时等于当日首末快照总余额之差（逐段累加可对消）", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T05:00:00Z"],
      ["CNY", 95, 0, 0, "2026-08-28T09:00:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T11:00:00Z"]
    );
    expect(
      cumulativeCostFrom(points, new Date("2026-08-28T00:00:00Z").getTime())
    ).toBe(10); // 首末差 100-90=10；逐段 5+5=10
  });

  it("fromMs 之后无快照 → 0", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T11:00:00Z"]
    );
    expect(cumulativeCostFrom(points, new Date("2026-09-01T00:00:00Z").getTime())).toBe(0);
  });

  it("多币种：跨币种段跳过，各币种独立累计", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["USD", 100, 0, 0, "2026-08-28T10:01:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T10:02:00Z"],
      ["USD", 95, 0, 0, "2026-08-28T10:03:00Z"]
    );
    expect(
      cumulativeCostFrom(points, new Date("2026-08-28T00:00:00Z").getTime())
    ).toBe(15); // CNY 10 + USD 5
  });
});

describe("dailyAggregate（按天聚合）", () => {
  it("同日两快照：cost 累加、hasGap=false", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T11:00:00Z"]
    );
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 10, hasGap: false },
    ]);
  });

  it("段内间隔 > maxGapMs：该日 hasGap=true，cost 照常累加", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T13:00:00Z"] // 3h > 2h 缺口
    );
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 10, hasGap: true },
    ]);
  });

  it("间隔恰好等于 maxGapMs 不算缺口（严格大于才标记）", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T12:00:00Z"] // 恰 2h
    );
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 10, hasGap: false },
    ]);
  });

  it("跨日缺口：缺口日跳过、数据恢复日 hasGap=true，段成本归并到起点日", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["CNY", 90, 0, 0, "2026-08-30T10:00:00Z"] // 48h 缺口
    );
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 10, hasGap: false }, // 段归起点日
      { date: "2026-08-30", cost: 0, hasGap: true }, // 缺口日 08-29 无快照，跳过
    ]);
  });

  it("跨午夜段归并到起点日；无快照的天不产出（无数据不伪造）", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T23:00:00Z"],
      ["CNY", 97, 0, 0, "2026-08-28T23:30:00Z"],
      ["CNY", 95, 0, 0, "2026-08-29T00:30:00Z"], // 跨日段归 08-28；与 23:30 间隔 1h 无缺口
      ["CNY", 90, 0, 0, "2026-08-29T01:30:00Z"]
    );
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 5, hasGap: false },
      { date: "2026-08-29", cost: 5, hasGap: false },
    ]);
  });

  it("多币种分流：跨币种段不参与 cost 也不参与缺口判定", () => {
    const points = pts(
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["USD", 100, 0, 0, "2026-08-28T10:01:00Z"],
      ["CNY", 90, 0, 0, "2026-08-28T10:02:00Z"],
      ["USD", 95, 0, 0, "2026-08-28T10:03:00Z"]
    );
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 15, hasGap: false },
    ]);
  });

  it("输入乱序也能正确聚合（内部先排序），且不修改入参", () => {
    const points = pts(
      ["CNY", 90, 0, 0, "2026-08-28T12:00:00Z"],
      ["CNY", 100, 0, 0, "2026-08-28T10:00:00Z"],
      ["CNY", 95, 0, 0, "2026-08-28T11:00:00Z"]
    );
    const before = JSON.stringify(points);
    expect(dailyAggregate(points, DEFAULT_MAX_GAP_MS)).toEqual([
      { date: "2026-08-28", cost: 10, hasGap: false },
    ]);
    expect(JSON.stringify(points)).toBe(before);
  });

  it("空输入 → 空数组", () => {
    expect(dailyAggregate([], DEFAULT_MAX_GAP_MS)).toEqual([]);
  });
});
