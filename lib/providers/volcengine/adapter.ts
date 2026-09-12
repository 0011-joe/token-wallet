/**
 * 豆包（火山引擎）adapter（T3.2 / AC2.2，native 余额）。
 *
 * - 凭证：账号级 AK/SK + 火山签名 V4（lib/providers/volcengine/sigv4），
 *   仅接受费用中心只读 IAM 子用户（决策 D1；主账号/ARK Key 在表单与接口层已拒绝）；
 * - 端点：GET https://billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01
 *   （service=billing, region=cn-beijing；host 以官方费用中心文档为准）；
 * - 归一（红线 #6 币种不混算，固定 CNY）：
 *   available=AvailableBalance（官方值，不自行重算覆盖）；
 *   breakdown={cash: CashBalance, creditLimit: CreditLimit, frozen: FreezeAmount, arrears: ArrearsBalance}；
 *   isAvailable = AvailableBalance>0 && ArrearsBalance<=0；
 * - 错误分类：SignatureDoesNotMatch/100010 → INVALID；AccessDenied/100013 → FORBIDDEN_SCOPE；
 *   InvalidTimestamp/100006 及其他业务/网络错误 → ERROR。
 */
import { moneyCmp, toMoney } from "@/lib/money";
import { signVolcRequest } from "./sigv4";
import { registerProvider } from "../registry";
import type {
  FetchCtx,
  NormalizedBalance,
  ProviderAdapter,
  ProviderResult,
  TestResult,
} from "../types";

/** 费用中心 OpenAPI 端点常量（usage.ts 复用，勿在此处改余额路径） */
export const VOLC_HOST = "billing.volcengineapi.com";
export const VOLC_SERVICE = "billing";
export const VOLC_REGION = "cn-beijing";
export const DEFAULT_TIMEOUT_MS = 10_000;

interface VolcBalanceResult {
  AccountID?: number | string;
  AvailableBalance?: string;
  CashBalance?: string;
  CreditLimit?: string;
  FreezeAmount?: string;
  ArrearsBalance?: string;
}

interface VolcResponse {
  ResponseMetadata?: {
    Error?: { Code?: string; Message?: string };
  };
  Result?: VolcBalanceResult;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 官方错误码 → 统一错误模型（AC2.2：签名错/权限不足可区分）；usage.ts 复用 */
export function classifyVolcError(code: string | undefined, message: string | undefined) {
  if (code === "SignatureDoesNotMatch" || code === "100010") {
    return { reason: "INVALID" as const, message: message ?? "签名不匹配（检查 AK/SK 与时钟）" };
  }
  if (code === "AccessDenied" || code === "100013") {
    return {
      reason: "FORBIDDEN_SCOPE" as const,
      // 可操作引导恒附带（AC1.2：权限不足与签名错可区分且给出补救）
      message: `${message ?? "无 billing 权限"}（请使用费用中心只读 IAM 子用户，推荐绑定 BillingCenterReadOnlyAccess）`,
    };
  }
  return { reason: "ERROR" as const, message: `${code ?? "未知错误"}${message ? `: ${message}` : ""}` };
}

function normalize(result: VolcBalanceResult): NormalizedBalance {
  const available = toMoney(result.AvailableBalance ?? "0");
  const cash = result.CashBalance !== undefined ? toMoney(result.CashBalance) : undefined;
  const creditLimit = result.CreditLimit !== undefined ? toMoney(result.CreditLimit) : undefined;
  const frozen = result.FreezeAmount !== undefined ? toMoney(result.FreezeAmount) : undefined;
  const arrears = result.ArrearsBalance !== undefined ? toMoney(result.ArrearsBalance) : undefined;
  // isAvailable = AvailableBalance>0 且 ArrearsBalance<=0（红线/PRD §4.3）
  const isAvailable =
    moneyCmp(available, "0.000000000") > 0 &&
    (arrears === undefined || moneyCmp(arrears, "0.000000000") <= 0);
  return {
    mode: "native",
    isAvailable,
    balances: [
      {
        currency: "CNY",
        available,
        breakdown: {
          ...(cash !== undefined ? { cash } : {}),
          ...(creditLimit !== undefined ? { creditLimit } : {}),
          ...(frozen !== undefined ? { frozen } : {}),
          ...(arrears !== undefined ? { arrears } : {}),
        },
        raw: { ...result },
      },
    ],
  };
}

function utcDateTime(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function fetchVolcBalance(
  ak: string,
  sk: string,
  opts: { baseUrl?: string; timeoutMs?: number }
): Promise<ProviderResult<NormalizedBalance>> {
  const host = (opts.baseUrl ?? `https://${VOLC_HOST}`).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dateTime = utcDateTime();

  const signed = signVolcRequest({
    method: "GET",
    host,
    query: { Action: "QueryBalanceAcct", Version: "2022-01-01" },
    service: VOLC_SERVICE,
    region: VOLC_REGION,
    ak,
    sk,
    dateTime,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(signed.url, {
      method: "GET",
      headers: signed.headers,
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, reason: "ERROR", message: err instanceof Error ? err.name : "网络错误" };
  } finally {
    clearTimeout(timer);
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
  const resp = body as VolcResponse;
  const err = resp.ResponseMetadata?.Error;
  if (err) {
    const classified = classifyVolcError(err.Code, err.Message);
    return { ok: false, reason: classified.reason, statusCode: res.status, message: classified.message };
  }
  if (!resp.Result || !isRecord(resp.Result)) {
    return { ok: false, reason: "ERROR", statusCode: res.status, message: "Result 字段缺失" };
  }
  return { ok: true, data: normalize(resp.Result as VolcBalanceResult) };
}

export const volcengineAdapter: ProviderAdapter = {
  id: "volcengine",
  credentialKind: "aksk",
  balanceMode: "native",
  usageMode: "csv_import",

  async testCredential(secret): Promise<TestResult> {
    if (typeof secret.ak !== "string" || secret.ak === "" || typeof secret.sk !== "string" || secret.sk === "") {
      return { ok: false, reason: "INVALID", message: "缺少 AccessKeyId / SecretAccessKey" };
    }
    if (!/^AKLT/.test(secret.ak)) {
      return { ok: false, reason: "INVALID", message: "AccessKeyId 需以 AKLT 开头（费用中心只读 IAM 子用户）" };
    }
    const result = await fetchVolcBalance(secret.ak, secret.sk, {});
    if (!result.ok) {
      return { ok: false, reason: result.reason, statusCode: result.statusCode, message: result.message };
    }
    return { ok: true, balance: result.data };
  },

  async fetchBalance(ctx: FetchCtx): Promise<ProviderResult<NormalizedBalance>> {
    if (typeof ctx.secret.ak !== "string" || ctx.secret.ak === "" || typeof ctx.secret.sk !== "string" || ctx.secret.sk === "") {
      return { ok: false, reason: "INVALID", message: "缺少 AccessKeyId / SecretAccessKey" };
    }
    return fetchVolcBalance(ctx.secret.ak, ctx.secret.sk, { baseUrl: ctx.baseUrl, timeoutMs: ctx.timeoutMs });
  },
};

registerProvider(volcengineAdapter);
