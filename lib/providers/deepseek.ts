/**
 * DeepSeek adapter（T1.2，由 v1 lib/deepseek/client.ts 平移，行为不变）。
 *
 * - GET api.deepseek.com/user/balance，Bearer 模型 Key；默认 10s 超时；
 * - 401/403 → INVALID；429 → RATE_LIMITED（带 Retry-After）；其他非 2xx/网络 → ERROR；
 * - 金额边界一次性转 Decimal 字符串（红线 #1）：官方金额是字符串，经 toMoney 规范为 6 位；
 * - 归一：available=total_balance；breakdown={cash: topped_up_balance, granted: granted_balance}；
 *   raw 留存脱敏后的原始响应（余额响应本身不含凭证，可完整留存）；
 * - 安全：apiKey 只进入请求头，绝不进入日志、错误信息或返回对象。
 */
import { toMoney } from "@/lib/money";
import { registerProvider } from "./registry";
import type {
  FetchCtx,
  NormalizedBalance,
  ProviderAdapter,
  ProviderResult,
  TestResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 10_000;

interface RawBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

type RawResult =
  | { ok: true; isAvailable: boolean; balanceInfos: RawBalanceInfo[] }
  | { ok: false; reason: "INVALID" | "RATE_LIMITED" | "ERROR"; statusCode?: number; message?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseBalanceBody(data: unknown): RawResult | null {
  if (
    !isRecord(data) ||
    typeof data.is_available !== "boolean" ||
    !Array.isArray(data.balance_infos)
  ) {
    return null;
  }
  const balanceInfos: RawBalanceInfo[] = [];
  for (const item of data.balance_infos) {
    if (!isRecord(item)) return null;
    const { currency, total_balance, granted_balance, topped_up_balance } = item;
    if (
      typeof currency !== "string" ||
      typeof total_balance !== "string" ||
      typeof granted_balance !== "string" ||
      typeof topped_up_balance !== "string"
    ) {
      return null;
    }
    balanceInfos.push({ currency, totalBalance: total_balance, grantedBalance: granted_balance, toppedUpBalance: topped_up_balance });
  }
  return { ok: true, isAvailable: data.is_available, balanceInfos };
}

function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "网络错误";
}

/** 官方响应 → 归一化余额（adapter 边界一次性转 Decimal 字符串） */
function normalize(raw: Extract<RawResult, { ok: true }>): NormalizedBalance {
  return {
    mode: "native",
    isAvailable: raw.isAvailable,
    balances: raw.balanceInfos.map((info) => ({
      currency: info.currency,
      available: toMoney(info.totalBalance),
      breakdown: {
        cash: toMoney(info.toppedUpBalance),
        granted: toMoney(info.grantedBalance),
      },
      raw: {
        currency: info.currency,
        total_balance: info.totalBalance,
        granted_balance: info.grantedBalance,
        topped_up_balance: info.toppedUpBalance,
      },
    })),
  };
}

/** 实际 HTTP 调用（与 v1 fetchBalance 一致，错误全部以返回值表达） */
async function fetchBalance(apiKey: string, opts?: { baseUrl?: string; timeoutMs?: number }): Promise<RawResult> {
  const baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/user/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, reason: "ERROR", message: networkErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "INVALID", statusCode: res.status };
  }
  if (res.status === 429) {
    return { ok: false, reason: "RATE_LIMITED", statusCode: res.status, message: res.headers.get("retry-after") ?? undefined };
  }
  if (!res.ok) {
    return { ok: false, reason: "ERROR", statusCode: res.status };
  }

  try {
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: "ERROR", statusCode: res.status, message: "响应不是合法 JSON" };
    }
    return parseBalanceBody(data) ?? { ok: false, reason: "ERROR", statusCode: res.status, message: "响应结构不符合预期" };
  } catch {
    return { ok: false, reason: "ERROR", statusCode: res.status, message: "响应读取失败" };
  }
}

export const deepseekAdapter: ProviderAdapter = {
  id: "deepseek",
  credentialKind: "bearer",
  balanceMode: "native",
  usageMode: "csv_import",

  async testCredential(secret): Promise<TestResult> {
    if (typeof secret.key !== "string" || secret.key === "") {
      return { ok: false, reason: "INVALID", message: "缺少 API Key" };
    }
    const result = await fetchBalance(secret.key);
    if (!result.ok) {
      return { ok: false, reason: result.reason, statusCode: result.statusCode, message: result.message };
    }
    return { ok: true, balance: normalize(result) };
  },

  async fetchBalance(ctx: FetchCtx): Promise<ProviderResult<NormalizedBalance>> {
    if (typeof ctx.secret.key !== "string" || ctx.secret.key === "") {
      return { ok: false, reason: "INVALID", message: "缺少 API Key" };
    }
    const result = await fetchBalance(ctx.secret.key, { baseUrl: ctx.baseUrl, timeoutMs: ctx.timeoutMs });
    if (!result.ok) {
      return { ok: false, reason: result.reason, statusCode: result.statusCode, message: result.message };
    }
    return { ok: true, data: normalize(result) };
  },
};

registerProvider(deepseekAdapter);
