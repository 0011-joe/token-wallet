/**
 * Kimi（Moonshot）adapter（T2.1 / AC2.3，v2.0 仅国内站）。
 *
 * - GET {host}/v1/users/me/balance，Bearer 模型 Key；默认 10s 超时；
 * - 业务成功判定：HTTP 200 且 code === 0 && status === true（红线 #5，不能只看 HTTP 200）；
 * - 金额是 JSON number，边界立即转 Decimal 字符串（toMoney，无 float 精度丢失）；
 * - 归一：available=available_balance；breakdown={cash, voucher}；
 *   cash_balance<0 → arrears=|cash|（欠费独立表达）；isAvailable = available_balance > 0；
 * - host 由 region 常量表决定：cn → api.moonshot.cn，intl → api.moonshot.ai（v2.1 预留）；
 * - 限频 3 次/分钟（rateLimitPerMin=3，供 runner 令牌桶使用）；
 * - 401 → INVALID；429 → RATE_LIMITED；其他非 2xx → ERROR；2xx 但 code≠0/status≠true → ERROR。
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

/** 国内/国际站 host 常量表（决策 D2：region 扩展位；v2.0 UI 只开放 cn） */
export const KIMI_HOSTS: Record<string, string> = {
  cn: "https://api.moonshot.cn",
  intl: "https://api.moonshot.ai",
};

const DEFAULT_REGION = "cn";
const DEFAULT_TIMEOUT_MS = 10_000;

interface KimiRawData {
  available_balance: number;
  voucher_balance: number;
  cash_balance: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 解析并归一（adapter 边界一次性转 Decimal 字符串） */
function normalize(raw: KimiRawData): NormalizedBalance {
  const available = toMoney(raw.available_balance);
  const voucher = toMoney(raw.voucher_balance);
  const cash = toMoney(raw.cash_balance);
  // 红线：cash<0 = 欠费，arrears 取绝对值；不为负则不出现 arrears 键
  const arrears = raw.cash_balance < 0 ? toMoney(Math.abs(raw.cash_balance)) : undefined;
  return {
    mode: "native",
    isAvailable: raw.available_balance > 0,
    balances: [
      {
        currency: "CNY",
        available,
        breakdown: {
          cash,
          voucher,
          ...(arrears !== undefined ? { arrears } : {}),
        },
        raw: { ...raw },
      },
    ],
  };
}

function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "网络错误";
}

async function fetchKimiBalance(
  apiKey: string,
  opts: { baseUrl?: string; timeoutMs?: number }
): Promise<ProviderResult<NormalizedBalance>> {
  const baseUrl = (opts.baseUrl ?? KIMI_HOSTS[DEFAULT_REGION]).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/users/me/balance`, {
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

  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return { ok: false, reason: "ERROR", statusCode: res.status, message: "响应不是合法 JSON" };
  }
  if (!isRecord(body)) {
    return { ok: false, reason: "ERROR", statusCode: res.status, message: "响应结构不符合预期" };
  }
  // 红线 #5：业务成功 = code === 0 && status === true
  if (body.code !== 0 || body.status !== true) {
    return {
      ok: false,
      reason: "ERROR",
      statusCode: res.status,
      message: `业务失败（code=${String(body.code)} status=${String(body.status)}）`,
    };
  }
  const data = body.data;
  if (!isRecord(data)) {
    return { ok: false, reason: "ERROR", statusCode: res.status, message: "data 字段缺失" };
  }
  const { available_balance, voucher_balance, cash_balance } = data;
  if (
    typeof available_balance !== "number" ||
    typeof voucher_balance !== "number" ||
    typeof cash_balance !== "number"
  ) {
    return { ok: false, reason: "ERROR", statusCode: res.status, message: "余额字段类型不符" };
  }
  return {
    ok: true,
    data: normalize({ available_balance, voucher_balance, cash_balance }),
  };
}

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  credentialKind: "bearer",
  balanceMode: "native",
  usageMode: "csv_import",
  rateLimitPerMin: 3,

  async testCredential(secret, opts): Promise<TestResult> {
    if (typeof secret.key !== "string" || secret.key === "") {
      return { ok: false, reason: "INVALID", message: "缺少 API Key" };
    }
    const region = opts?.region ?? DEFAULT_REGION;
    const baseUrl = KIMI_HOSTS[region] ?? KIMI_HOSTS[DEFAULT_REGION];
    const result = await fetchKimiBalance(secret.key, { baseUrl });
    if (!result.ok) {
      return { ok: false, reason: result.reason, statusCode: result.statusCode, message: result.message };
    }
    return { ok: true, balance: result.data };
  },

  async fetchBalance(ctx: FetchCtx): Promise<ProviderResult<NormalizedBalance>> {
    if (typeof ctx.secret.key !== "string" || ctx.secret.key === "") {
      return { ok: false, reason: "INVALID", message: "缺少 API Key" };
    }
    const region = ctx.region ?? DEFAULT_REGION;
    const baseUrl = ctx.baseUrl ?? KIMI_HOSTS[region] ?? KIMI_HOSTS[DEFAULT_REGION];
    return fetchKimiBalance(ctx.secret.key, { baseUrl, timeoutMs: ctx.timeoutMs });
  },
};

registerProvider(kimiAdapter);
