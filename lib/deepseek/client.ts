/**
 * DeepSeek 官方余额接口封装（规格卡 B / T2.1）。
 *
 * - GET {baseUrl}/user/balance，Authorization: Bearer <apiKey>，默认 10s 超时（AbortController）
 * - 401/403 → { ok:false, reason:"INVALID" }；429 → { ok:false, reason:"RATE_LIMITED" }
 *   且 message 携带 Retry-After 头（若有）；其他非 2xx → ERROR
 * - 网络错误 / 超时 → ERROR；本模块不抛未捕获异常（错误都以返回值表达）
 * - 安全：apiKey 只进入请求头，绝不进入日志或返回对象
 */
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface BalanceInfo {
  currency: string; // "CNY" | "USD"
  totalBalance: string; // 官方返回是字符串，如 "6.32"
  grantedBalance: string;
  toppedUpBalance: string;
}

export type BalanceResult =
  | { ok: true; isAvailable: boolean; balanceInfos: BalanceInfo[] }
  | {
      ok: false;
      reason: "INVALID" | "RATE_LIMITED" | "ERROR";
      statusCode?: number;
      message?: string;
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 校验并转换官方 200 响应体；结构不符返回 null（调用方归为 ERROR）。 */
function parseBalanceBody(data: unknown): BalanceResult | null {
  if (
    !isRecord(data) ||
    typeof data.is_available !== "boolean" ||
    !Array.isArray(data.balance_infos)
  ) {
    return null;
  }
  const balanceInfos: BalanceInfo[] = [];
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
    balanceInfos.push({
      currency,
      totalBalance: total_balance,
      grantedBalance: granted_balance,
      toppedUpBalance: topped_up_balance,
    });
  }
  return { ok: true, isAvailable: data.is_available, balanceInfos };
}

function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "网络错误";
}

export async function fetchBalance(
  apiKey: string,
  opts?: { baseUrl?: string; timeoutMs?: number }
): Promise<BalanceResult> {
  const baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/user/balance`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    // 网络错误或超时（AbortError）统一归为 ERROR，不抛出
    return { ok: false, reason: "ERROR", message: networkErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "INVALID", statusCode: res.status };
  }
  if (res.status === 429) {
    return {
      ok: false,
      reason: "RATE_LIMITED",
      statusCode: res.status,
      message: res.headers.get("retry-after") ?? undefined,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: "ERROR", statusCode: res.status };
  }

  // 2xx：读取并解析响应体（读取失败同样归为 ERROR，不抛异常）
  try {
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: "ERROR",
        statusCode: res.status,
        message: "响应不是合法 JSON",
      };
    }
    return (
      parseBalanceBody(data) ?? {
        ok: false,
        reason: "ERROR",
        statusCode: res.status,
        message: "响应结构不符合预期",
      }
    );
  } catch {
    return {
      ok: false,
      reason: "ERROR",
      statusCode: res.status,
      message: "响应读取失败",
    };
  }
}
