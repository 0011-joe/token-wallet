/**
 * 用量 API / 估算拉取调度（T5.x）。
 *
 * 契约与 lib/providers/kimi-usage.ts 对齐（并行 agent 共用）：
 *   UsageRow / UsagePullResult / pull*Usage(ctx)
 *
 * 职责：
 * 1. 按 provider 动态加载 usage 模块（文件尚未落地时返回 not-ready，不炸编译）；
 * 2. 把 UsageRow[] 转成入库用的 ParsedUsageRow[]（按月分组，复用 upsertUsageImport）；
 * 3. 金额纪律：cost 一律经 lib/money 规范化后入库（Decimal 字符串）。
 *
 * 与 CSV 导入的关系：
 * - 共用 UsageImport / ModelUsage 表与幂等键 [userId, provider, month]；
 * - 同月先 CSV 再 pull（或反过来）都会覆盖当月，不翻倍；
 * - fileName 固定为 `api-pull`，便于与 CSV 文件名区分。
 */
import type { ProviderId } from "@/lib/providers/types";
import { toMoney } from "@/lib/money";
import type { ParsedUsageRow, UsageType } from "./csv-parse";

// ── 对外契约（与 kimi-usage.ts 结构兼容；volc/deepseek 落地时对齐） ──

/** 拉取结果单行：date=YYYY-MM-DD；model/token 可缺省（快照差值口径不可知） */
export interface UsageRow {
  date: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 消耗金额，Decimal 字符串（lib/money） */
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

/** 余额快照点（供 derived 估算；字段与 BalanceSnapshot 对齐） */
export interface PullSnapshotPoint {
  fetchedAt: Date | string;
  available: string | number;
  currency?: string;
}

/**
 * 传给各平台 pull*Usage 的上下文。
 * - kimi-usage 只消费 snapshots（官方无用量 API，见该文件头注释）；
 * - volc/deepseek 若实现 api 路径可消费 secret/region。
 */
export interface PullUsageCtx {
  secret?: { key?: string; ak?: string; sk?: string };
  region?: string | null;
  snapshots?: PullSnapshotPoint[];
}

export type PullUsageFn = (ctx?: PullUsageCtx) => Promise<UsagePullResult>;

type ProviderUsageModule = Record<string, unknown>;

/** 模块未就绪（文件尚未存在 / 导出缺失） */
export type PullNotReady = { ok: false; notReady: true; provider: ProviderId };

export type PullDispatchResult =
  | { ok: true; result: UsagePullResult }
  | PullNotReady
  | { ok: false; notReady: false; reason: string; message: string };

// ── 动态加载 ──

/** 相对 lib/usage/ 的模块路径；变量形式避免打包器/TS 对不存在文件做静态解析 */
const MODULE_SPECIFIERS: Record<ProviderId, string> = {
  kimi: "../providers/kimi-usage",
  volcengine: "../providers/volcengine/usage",
  deepseek: "../providers/deepseek-usage",
};

/** 各平台约定的导出函数名（按优先级探测） */
const PULL_FN_NAMES: Record<ProviderId, string[]> = {
  kimi: ["pullKimiUsage", "pullUsage"],
  volcengine: ["pullVolcUsage", "pullUsage"],
  deepseek: ["pullDeepseekUsage", "pullDeepseek", "pullUsage"],
};

/** 测试可注入的模块解析器；null 时走默认动态 import */
export type UsageModuleResolver = (
  provider: ProviderId
) => Promise<ProviderUsageModule | null>;

let testResolver: UsageModuleResolver | null = null;

/** 仅测试使用：注入/清除模块解析器 */
export function setUsageModuleResolver(resolver: UsageModuleResolver | null): void {
  testResolver = resolver;
}

async function defaultLoadModule(
  provider: ProviderId
): Promise<ProviderUsageModule | null> {
  const specifier = MODULE_SPECIFIERS[provider];
  if (!specifier) return null;
  try {
    // 变量 specifier：模块可能尚未落地，import 失败由 catch 容错
    const mod: unknown = await import(/* @vite-ignore */ specifier);
    return mod as ProviderUsageModule;
  } catch {
    return null;
  }
}

function pickPullFn(
  mod: ProviderUsageModule,
  provider: ProviderId
): PullUsageFn | null {
  for (const name of PULL_FN_NAMES[provider]) {
    const fn = mod[name];
    if (typeof fn === "function") return fn as PullUsageFn;
  }
  return null;
}

/**
 * 按 provider 调用 pull*Usage。
 * - 模块/函数未就绪 → { ok:false, notReady:true }（路由映射 501）
 * - 平台返回 ok:false → 原样透出 reason/message
 */
export async function dispatchUsagePull(
  provider: ProviderId,
  ctx: PullUsageCtx
): Promise<PullDispatchResult> {
  const load = testResolver ?? defaultLoadModule;
  let mod: ProviderUsageModule | null;
  try {
    mod = await load(provider);
  } catch {
    mod = null;
  }
  if (!mod) {
    return { ok: false, notReady: true, provider };
  }
  const fn = pickPullFn(mod, provider);
  if (!fn) {
    return { ok: false, notReady: true, provider };
  }
  try {
    const result = await fn(ctx);
    if (!result || typeof result !== "object" || !("ok" in result)) {
      return {
        ok: false,
        notReady: false,
        reason: "INVALID_RESULT",
        message: "平台用量拉取返回了非法结果",
      };
    }
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "平台用量拉取失败";
    return { ok: false, notReady: false, reason: "PULL_THREW", message };
  }
}

// ── UsageRow → ParsedUsageRow（入库形状） ──

/** 无模型名时的占位（快照差值口径不可知模型粒度） */
export const PULL_UNKNOWN_MODEL = "（快照估算）";

const MONTH_RE = /^\d{4}-\d{2}$/;

function monthOf(date: string): string | null {
  const m = date.trim().slice(0, 7);
  return MONTH_RE.test(m) ? m : null;
}

function toNonNegInt(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * 把拉取行按 UTC 月分组，转成 CSV 入库同构的 ParsedUsageRow。
 *
 * 映射规则：
 * - promptTokens  → input_cache_miss_tokens（快照/API 通常无缓存细分，统一记未命中）
 * - completionTokens → output_tokens
 * - 仅有 cost、无 token → 单行 output_tokens / amount=0，费用仍落库
 * - 费用按 token 数比例拆到两行；unitPrice = cost/amount（amount>0 时）
 */
export function groupPullRowsByMonth(
  rows: UsageRow[]
): Map<string, ParsedUsageRow[]> {
  const byMonth = new Map<string, ParsedUsageRow[]>();

  for (const row of rows) {
    const month = monthOf(row.date ?? "");
    if (!month) continue;

    const model = (row.model ?? "").trim() || PULL_UNKNOWN_MODEL;
    const prompt = toNonNegInt(row.promptTokens);
    const completion = toNonNegInt(row.completionTokens);
    const totalTokens = prompt + completion;

    // cost 经 toMoney 规范化，再转 number 交给 ParsedUsageRow（import-store 会再 toMoney 入库）
    let cost = 0;
    try {
      cost = Number(toMoney(row.cost));
    } catch {
      cost = 0;
    }
    if (!Number.isFinite(cost) || cost < 0) cost = 0;

    let list = byMonth.get(month);
    if (!list) {
      list = [];
      byMonth.set(month, list);
    }

    if (totalTokens === 0) {
      list.push({
        model,
        apiKeyRef: null,
        type: "output_tokens",
        unitPrice: null,
        amount: 0,
        cost,
      });
      continue;
    }

    if (prompt > 0) {
      const c = (cost * prompt) / totalTokens;
      list.push({
        model,
        apiKeyRef: null,
        type: "input_cache_miss_tokens" satisfies UsageType,
        unitPrice: c > 0 ? c / prompt : null,
        amount: prompt,
        cost: c,
      });
    }
    if (completion > 0) {
      const c = (cost * completion) / totalTokens;
      list.push({
        model,
        apiKeyRef: null,
        type: "output_tokens" satisfies UsageType,
        unitPrice: c > 0 ? c / completion : null,
        amount: completion,
        cost: c,
      });
    }
  }

  return byMonth;
}

/** pull 入库的 fileName 标记（与 CSV 文件名区分） */
export const PULL_FILE_NAME = "api-pull";

/** 选「最新」月份作为响应主月（YYYY-MM 字典序即时间序） */
export function latestMonth(months: string[]): string | null {
  if (months.length === 0) return null;
  return [...months].sort().at(-1) ?? null;
}
