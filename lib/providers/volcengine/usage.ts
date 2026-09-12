/**
 * 豆包（火山引擎）用量拉取（与 Kimi agent 契约同形）。
 *
 * 模式策略（红线：不编造 Action/Version/字段）：
 * - derived（默认）：基于 BalanceSnapshot 差值估算，复用 lib/billing/snapshot-delta
 *   的 deltaCost/dailyAggregate 口径（净额=max(0,prev.available-next.available)）。
 *   note 明确标注「估算」；无模型/token 明细。
 * - api：Action=ListBill&Version=2022-01-01 已由 tests/volc-sigv4.test.ts 官方向量
 *   确认（POST + JSON body BillPeriod/Limit），与余额同一 SigV4 签名路径（service=billing,
 *   region=cn-beijing）。**响应中账单行字段未在本仓库代码/官方向量确认**，故成功响应
 *   不臆造解析：返回 mode=unsupported 并附说明，待只读账单权限联调后再补全字段映射。
 * - unsupported：无快照可推 / api 无法映射时，message 指向账号级只读账单权限与 CSV 导入。
 *
 * 只读 IAM：仅接受费用中心只读子用户 AK/SK（与 adapter 相同约束，主账号/ARK Key 已在
 * 表单与接口层拒绝）；测试一律 fixture mock fetch，不直连生产。
 */
import { toMoney } from "@/lib/money";
import {
  dailyAggregate,
  DEFAULT_MAX_GAP_MS,
  type TimedSnapshotPoint,
} from "@/lib/billing/snapshot-delta";
import type { SecretPayload } from "../types";
import {
  classifyVolcError,
  DEFAULT_TIMEOUT_MS,
  VOLC_HOST,
  VOLC_REGION,
  VOLC_SERVICE,
} from "./adapter";
import { signVolcRequest } from "./sigv4";

/** 用量行：date=YYYY-MM-DD（UTC）；cost 为 Decimal 字符串（lib/money 纪律） */
export interface UsageRow {
  date: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost: string;
}

export type UsagePullResult =
  | {
      ok: true;
      mode: "api" | "derived" | "unsupported";
      rows: UsageRow[];
      currency: "CNY";
      note?: string;
    }
  | { ok: false; reason: string; message: string };

export interface PullVolcUsageInput {
  /** derived：已落库的余额快照点（调用方负责只传 ok=true 的点） */
  snapshots?: TimedSnapshotPoint[];
  /** derived：快照缺口阈值，默认 2h */
  maxGapMs?: number;
  /** api：费用中心只读 IAM AK/SK */
  secret?: SecretPayload;
  /** api：账单周期 YYYY-MM（ListBill 官方向量请求体字段） */
  billPeriod?: string;
  /** api：单页条数上限，官方向量示例为 10；默认 100 */
  limit?: number;
  /** 优先模式，默认 derived（不因传入 secret 静默改走 api） */
  prefer?: "derived" | "api";
  /** 测试注入 baseUrl（默认 https://billing.volcengineapi.com） */
  baseUrl?: string;
  timeoutMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function utcDateTime(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 无可用数据时的统一引导文案（不臆造端点，指向只读权限 + CSV） */
function unsupportedResult(note: string): UsagePullResult {
  return {
    ok: true,
    mode: "unsupported",
    rows: [],
    currency: "CNY",
    note,
  };
}

/**
 * derived：余额快照差值 → 按 UTC 日聚合的估算用量行。
 * 公式口径见 lib/billing/snapshot-delta.ts 文件头；无模型/token 明细。
 */
export function deriveUsageFromSnapshots(
  snapshots: TimedSnapshotPoint[],
  maxGapMs: number = DEFAULT_MAX_GAP_MS
): UsagePullResult {
  const cny = snapshots.filter((p) => p.currency === "CNY");
  if (cny.length === 0) {
    return unsupportedResult(
      "无 CNY 余额快照，无法差值估算；请先完成余额快照采集，或改用 CSV 导入 / 账号级只读账单权限。"
    );
  }
  const aggregates = dailyAggregate(cny, maxGapMs);
  if (aggregates.length === 0) {
    return unsupportedResult(
      "余额快照不足以按日聚合；请先完成余额快照采集，或改用 CSV 导入 / 账号级只读账单权限。"
    );
  }
  const hasGap = aggregates.some((a) => a.hasGap);
  const rows: UsageRow[] = aggregates.map((a) => ({
    date: a.date,
    cost: a.cost,
  }));
  const gapNote = hasGap ? "；存在快照缺口日（hasGap），当日数值可能偏低" : "";
  return {
    ok: true,
    mode: "derived",
    rows,
    currency: "CNY",
    note: `估算：由余额快照差值推算（无模型/token 明细）；充值/赠金到账不计为消耗，同日「消耗+充值」仅得净额${gapNote}`,
  };
}

interface VolcApiBody {
  ResponseMetadata?: {
    Error?: { Code?: string; Message?: string };
  };
  Result?: unknown;
}

/**
 * api：ListBill 请求（Action/Version/body 字段均来自官方向量，见 volc-sigv4.test.ts 向量 2）。
 * 响应账单行字段未确认 → 成功时返回 unsupported，不臆造行；错误时按 adapter 同口径分类。
 */
async function pullViaListBill(
  input: PullVolcUsageInput
): Promise<UsagePullResult> {
  const ak = input.secret?.ak;
  const sk = input.secret?.sk;
  if (typeof ak !== "string" || ak === "" || typeof sk !== "string" || sk === "") {
    return { ok: false, reason: "INVALID", message: "缺少 AccessKeyId / SecretAccessKey" };
  }
  const billPeriod = input.billPeriod;
  if (typeof billPeriod !== "string" || !/^\d{4}-\d{2}$/.test(billPeriod)) {
    return { ok: false, reason: "INVALID", message: "billPeriod 需为 YYYY-MM（ListBill 官方向量字段）" };
  }
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, reason: "INVALID", message: "limit 需为正整数" };
  }

  // 与官方向量一致的 body 键序：Limit 在前、BillPeriod 在后（签名按原文哈希）
  const payload = JSON.stringify({ Limit: limit, BillPeriod: billPeriod });

  const host = (input.baseUrl ?? `https://${VOLC_HOST}`)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const signed = signVolcRequest({
    method: "POST",
    host,
    query: { Action: "ListBill", Version: "2022-01-01" },
    payload,
    service: VOLC_SERVICE,
    region: VOLC_REGION,
    ak,
    sk,
    dateTime: utcDateTime(),
  });

  // Content-Type 不参与签名（官方向量 2 的 SignedHeaders 仅 host;x-date）
  const headers: Record<string, string> = {
    ...signed.headers,
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(signed.url, {
      method: "POST",
      headers,
      body: payload,
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "ERROR",
      message: err instanceof Error ? err.name : "网络错误",
    };
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return { ok: false, reason: "ERROR", message: "响应不是合法 JSON" };
  }
  if (!isRecord(body)) {
    return { ok: false, reason: "ERROR", message: "响应结构不符合预期" };
  }
  const resp = body as VolcApiBody;
  const err = resp.ResponseMetadata?.Error;
  if (err) {
    const classified = classifyVolcError(err.Code, err.Message);
    return { ok: false, reason: classified.reason, message: classified.message };
  }
  if (resp.Result === undefined) {
    return { ok: false, reason: "ERROR", message: "Result 字段缺失" };
  }

  // 红线：账单行字段未在本仓库确认，不臆造解析。请求已走通 + Result 存在时，
  // 明确降级为 unsupported，由上层引导 CSV 导入或等待字段联调。
  return unsupportedResult(
    "ListBill 请求已走通（Action=ListBill&Version=2022-01-01，SigV4 与余额同路径），" +
      "但响应账单行字段未在本仓库确认，暂不解析为用量行；" +
      "请使用余额差值估算（prefer=derived）或 CSV 导入。" +
      "若需 api 模式落行，需账号级只读账单权限联调确认字段映射。"
  );
}

/**
 * 火山用量拉取统一入口。
 * - prefer=derived（默认）：有 CNY 快照则估算，否则 unsupported；
 * - prefer=api：需 secret + billPeriod；签名调用 ListBill；成功但字段未确认 → unsupported。
 * 网络/业务错误以 ok:false 表达，不抛未捕获异常（与 adapter 一致）。
 */
export async function pullVolcUsage(input: PullVolcUsageInput = {}): Promise<UsagePullResult> {
  const prefer = input.prefer ?? "derived";
  if (prefer === "api") {
    return pullViaListBill(input);
  }
  return deriveUsageFromSnapshots(input.snapshots ?? [], input.maxGapMs);
}

/** 便捷：从 Prisma BalanceSnapshot 行构造 TimedSnapshotPoint（available 走 toMoney 边界） */
export function snapshotToPoint(row: {
  currency: string;
  available: unknown;
  fetchedAt: Date;
  breakdown?: unknown;
}): TimedSnapshotPoint {
  const breakdown =
    isRecord(row.breakdown) ? (row.breakdown as Record<string, string | undefined>) : undefined;
  return {
    currency: row.currency,
    available: toMoney(row.available),
    ...(breakdown ? { breakdown } : {}),
    fetchedAt: row.fetchedAt,
  };
}
