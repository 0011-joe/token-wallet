/**
 * Kimi（Moonshot）用量拉取适配（usage 管线契约）。
 *
 * 红线结论（与 README 能力矩阵、kimiAdapter.usageMode=csv_import 一致）：
 * - Moonshot 模型 Key 仅公开余额端点 GET /v1/users/me/balance（见 lib/providers/kimi.ts）；
 *   **不存在**可对模型 Key 调用的「用量明细」官方 API。本模块禁止臆造任何端点。
 * - 仓库 samples/ 仅有 DeepSeek 官方 CSV，无 Kimi 官方导出样本，故不自造 Kimi CSV 列名。
 *
 * 因此 pullKimiUsage 只提供两种路径：
 *   A) derived —— 调用方传入 BalanceSnapshot 序列时，复用 lib/billing/snapshot-delta
 *      的净消耗口径 deltaCost = max(0, prev.available - next.available)，按 UTC 日聚合。
 *      结果**必须**标「估算」，不得等同官方账单（红线）。
 *   C) unsupported —— 无足够快照（<2 条）时返回结构化 not_supported，rows 为空，
 *      note 说明原因；不伪造数字、不假装有 API。
 *
 * 未来若官方开放模型 Key 用量明细 API 或提供 Kimi 控制台 CSV 样本，
 * 在此扩展 mode='api' / 'csv'，不得在开放前写入虚构字段。
 *
 * 金额纪律：cost 一律经 lib/money 的 Decimal 字符串（18,9），领域层禁止 float。
 */
import { dailyAggregate, type TimedSnapshotPoint } from "@/lib/billing/snapshot-delta";
import { toMoney, type Money } from "@/lib/money";
import { KIMI_HOSTS } from "./kimi";

/** 与 usage 管线约定的行结构 */
export interface UsageRow {
  /** YYYY-MM-DD（UTC） */
  date: string;
  /** 模型名；快照差值口径无模型粒度，恒缺省 */
  model?: string;
  /** prompt token 数；快照差值口径不可知，恒缺省 */
  promptTokens?: number;
  /** completion token 数；快照差值口径不可知，恒缺省 */
  completionTokens?: number;
  /** 消耗金额，Decimal 字符串（lib/money 规范，如 "1.230000000"） */
  cost: string;
}

export type UsagePullMode = "api" | "derived" | "csv" | "unsupported";

export type UsagePullResult =
  | {
      ok: true;
      mode: UsagePullMode;
      rows: UsageRow[];
      currency: string;
      note?: string;
    }
  | { ok: false; reason: string; message: string };

/** 供 pullKimiUsage 消费的快照点（字段与 BalanceSnapshot 对齐，amount 允许 number/Decimal 字符串） */
export interface KimiUsageSnapshot {
  fetchedAt: Date | string;
  /** 可用余额（BalanceSnapshot.available） */
  available: string | number;
  /** 币种，缺省 CNY（Kimi 国内站恒为 CNY） */
  currency?: string;
}

export interface PullKimiUsageCtx {
  /**
   * 余额快照序列。提供且有效点数 ≥2 时走 derived 估算；
   * 否则返回 mode='unsupported'。
   */
  snapshots?: KimiUsageSnapshot[];
  /**
   * 预留：若未来接入官方用量 API / CSV，此处再扩字段。
   * 当前刻意不暴露 apiKey，避免调用方误以为存在 API 拉取路径。
   */
}

/** Kimi 国内站默认币种 */
export const KIMI_USAGE_CURRENCY = "CNY";

/**
 * 声明：官方未公开模型 Key 可调用的用量明细 API。
 * 供 UI / 管线展示，禁止把 derived 结果写成官方账单。
 */
export const KIMI_USAGE_API_SUPPORTED = false as const;

/** 模式说明常量（note 可拼接，测试可断言） */
export const KIMI_USAGE_ESTIMATE_PREFIX = "估算";
export const KIMI_USAGE_NOT_SUPPORTED_MESSAGE =
  "Moonshot 模型 Key 未公开用量明细 API，且当前无足够余额快照可供差值估算；" +
  "请在 platform.moonshot.cn 控制台查看官方账单，或先接入快照后再试。";

function isFiniteDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/** 归一化入参快照 → TimedSnapshotPoint；过滤非法点 */
function toTimedPoints(snapshots: KimiUsageSnapshot[]): TimedSnapshotPoint[] {
  const points: TimedSnapshotPoint[] = [];
  for (const s of snapshots) {
    const fetchedAt = s.fetchedAt instanceof Date ? s.fetchedAt : new Date(s.fetchedAt);
    if (!isFiniteDate(fetchedAt)) continue;
    let available: Money;
    try {
      available = toMoney(s.available);
    } catch {
      continue; // 非法金额跳过，不中断整体
    }
    points.push({
      currency: typeof s.currency === "string" && s.currency !== "" ? s.currency : KIMI_USAGE_CURRENCY,
      available,
      fetchedAt,
    });
  }
  return points;
}

/** 取出现次数最多的币种（Kimi 实际恒为 CNY；防御多币种入参） */
function dominantCurrency(points: TimedSnapshotPoint[]): string {
  const counts = new Map<string, number>();
  for (const p of points) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
  let best = KIMI_USAGE_CURRENCY;
  let bestN = -1;
  for (const [cur, n] of counts) {
    if (n > bestN) {
      best = cur;
      bestN = n;
    }
  }
  return best;
}

/**
 * 拉取 Kimi 用量。
 *
 * - snapshots 有效点 ≥2 → mode='derived'，rows 为按 UTC 日聚合的估算消耗；
 *   note 恒含「估算」字样，有缺口时追加缺口提示。
 * - 其他 → mode='unsupported'，rows=[]，note 为结构化说明（ok:true，非错误）。
 * - 不发起任何 HTTP 请求，不臆造 API。
 */
export async function pullKimiUsage(ctx: PullKimiUsageCtx = {}): Promise<UsagePullResult> {
  const raw = ctx.snapshots ?? [];
  const points = toTimedPoints(raw);

  if (points.length < 2) {
    return {
      ok: true,
      mode: "unsupported",
      rows: [],
      currency: KIMI_USAGE_CURRENCY,
      note:
        points.length === 0
          ? KIMI_USAGE_NOT_SUPPORTED_MESSAGE
          : `仅有 ${points.length} 条有效余额快照，无法差值估算（至少需要 2 条）。` +
            KIMI_USAGE_NOT_SUPPORTED_MESSAGE,
    };
  }

  const currency = dominantCurrency(points);
  // 复用既有差值引擎：净消耗 max(0, prev.available - next.available)，按 UTC 日聚合
  const aggregates = dailyAggregate(points);

  const rows: UsageRow[] = aggregates.map((d) => ({
    date: d.date,
    // 模型 / token 粒度在快照差值口径下不可知，明确缺省而非编造
    cost: d.cost,
  }));

  const hasGap = aggregates.some((d) => d.hasGap);
  const note =
    `${KIMI_USAGE_ESTIMATE_PREFIX}：基于余额快照差值（max(0, prev.available - next.available)）按日聚合，` +
    `非官方账单；请以 Moonshot 控制台为准。` +
    (hasGap ? "（部分日期存在快照缺口，该日数据可能不完整。）" : "");

  return { ok: true, mode: "derived", rows, currency, note };
}

/** 供测试与文档：当前仅支持 derived / unsupported，api 恒不可用 */
export const KIMI_USAGE_SUPPORTED_MODES: readonly UsagePullMode[] = ["derived", "unsupported"] as const;

/** 再导出 host 常量，方便管线按 region 拼展示链接（不发起请求） */
export { KIMI_HOSTS };
