/**
 * Provider 适配器统一接口（DEV-GUIDE §8 / PRD §9.2，AC2.1 预埋）。
 *
 * - 新增 Provider 只加 adapter 文件 + registry 注册，不改 cron / 仪表盘 / 告警主流程；
 * - 金额纪律：adapter 边界一次性转 Decimal 字符串（lib/money），领域层禁止 number/float；
 * - 错误以返回值表达，不抛未捕获异常（FailReason 映射凭证 lastStatus）。
 */
import type { Money } from "@/lib/money";

export type ProviderId = "deepseek" | "kimi" | "volcengine";
export type CredentialKind = "bearer" | "aksk";
export type BalanceMode = "native" | "derived" | "manual";
export type UsageMode = "csv_import" | "api_pull" | "both";

/** 凭证明文负载（与 lib/crypto/keyvault 信封一致） */
export interface SecretPayload {
  key?: string;
  ak?: string;
  sk?: string;
}

/** 归一化余额：每条币种一条；available 恒为 Decimal 字符串 */
export interface NormalizedBalanceInfo {
  currency: string;
  available: Money;
  breakdown: Record<string, string | undefined>;
  raw: unknown;
}

export interface NormalizedBalance {
  mode: "native";
  isAvailable: boolean;
  balances: NormalizedBalanceInfo[];
}

export type FailReason = "INVALID" | "FORBIDDEN_SCOPE" | "RATE_LIMITED" | "ERROR";

export type ProviderResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FailReason; statusCode?: number; message?: string };

export interface FetchCtx {
  secret: SecretPayload;
  region?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** 录入连通性测试结果：失败给出可操作原因（AC1.2）；成功附首份余额（AC1.3） */
export type TestResult =
  | { ok: true; balance: NormalizedBalance }
  | { ok: false; reason: FailReason; statusCode?: number; message?: string };

export interface ProviderAdapter {
  id: ProviderId;
  credentialKind: CredentialKind;
  balanceMode: "native";
  usageMode: UsageMode;
  /** Kimi = 3（限频令牌桶依据）；未声明 = 不额外限频 */
  rateLimitPerMin?: number;
  testCredential(secret: SecretPayload, opts?: { region?: string }): Promise<TestResult>;
  fetchBalance(ctx: FetchCtx): Promise<ProviderResult<NormalizedBalance>>;
}
