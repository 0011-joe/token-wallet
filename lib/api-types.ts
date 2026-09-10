/**
 * 前端 API 契约类型 —— 与后端 app/api/** 的响应结构一一对应（v2：多 Provider + Decimal 字符串）。
 * 只做类型声明，不改后端；字段以后端实现为准。
 */

export type ProviderId = "deepseek" | "kimi" | "volcengine";
export type CredentialKind = "bearer" | "aksk";

/** 单条凭证的对外视图（/api/credentials、/api/dashboard.credential 共用） */
export interface CredentialSummary {
  id: string;
  provider: ProviderId;
  kind: CredentialKind;
  region: string | null;
  label: string;
  /** 脱敏标识：last4 / AK 前缀+尾4 */
  hint: string;
  isActive: boolean;
  failCount: number;
  /** OK | INVALID | FORBIDDEN_SCOPE | RATE_LIMITED | ERROR */
  lastStatus: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
}

export interface CredentialsResponse {
  credentials: CredentialSummary[];
}

export interface CreateCredentialResponse {
  credential: CredentialSummary;
  firstBalance: {
    mode: "native";
    isAvailable: boolean;
    balances: Array<{
      currency: string;
      available: string;
      breakdown: Record<string, string | undefined>;
    }>;
  };
}

/** 单币种余额快照视图（金额全部 Decimal 字符串） */
export interface BalanceView {
  currency: string;
  available: string;
  breakdown: Record<string, string | undefined>;
  isAvailable: boolean;
  fetchedAt: string;
}

export interface TodayMonthCost {
  /** Decimal 字符串（估算口径） */
  cost: string;
  /** snapshot=有快照基准；no-snapshot=快照不足（<2 个），cost 恒为 0 */
  from: "snapshot" | "no-snapshot";
  currency: string;
}

export interface TrendDay {
  date: string;
  cost: string;
  hasGap: boolean;
}

export interface DashboardData {
  credential: CredentialSummary;
  balance: (BalanceView & { stale: boolean; byCurrency: BalanceView[] }) | null;
  today: TodayMonthCost;
  month: TodayMonthCost;
  trend: { range: number; days: TrendDay[] };
  isEstimate: true;
  generatedAt: string;
}

export type BalanceInfo = NonNullable<DashboardData["balance"]>;

export interface ApiErrorBody {
  ok?: false;
  error: string;
}

export type UsageType =
  | "input_cache_hit_tokens"
  | "input_cache_miss_tokens"
  | "output_tokens"
  | "request_count";

export interface ModelUsageTypeRow {
  type: UsageType;
  amount: number;
  cost: string;
}

export interface ModelUsageRow {
  model: string;
  totalTokens: number;
  totalCost: string;
  sharePct: number;
  byType: ModelUsageTypeRow[];
}

export interface ModelsResponse {
  month: string;
  models: ModelUsageRow[];
  totalCost: string;
  totalTokens: number;
  currency: string | null;
}

export interface ImportUsageResponse {
  month: string;
  rows: number;
  models: number;
}

export interface AlertSettings {
  /** Decimal 字符串 */
  lowBalanceThreshold: string;
  failThresholdN: number;
  emailEnabled: boolean;
  inappEnabled: boolean;
}

export interface AlertEventView {
  id: string;
  type: string;
  provider: ProviderId;
  credentialId: string | null;
  message: string;
  severity: "critical" | "warning";
  createdAt: string;
}

export interface AlertsResponse {
  events: AlertEventView[];
  settings: AlertSettings;
}

export interface RefreshResponse {
  ok: boolean;
  snapshots: number;
  latest: {
    currency: string;
    available: string;
    isAvailable: boolean;
    fetchedAt: string;
  } | null;
}

export interface OverviewCurrency {
  currency: string;
  totalAvailable: string;
  credentialCount: number;
  latestFetchedAt: string | null;
}

export interface OverviewPlatform {
  provider: ProviderId;
  credentialCount: number;
  failedCount: number;
  staleCount: number;
  byCurrency: Array<{ currency: string; available: string; credentialCount: number }>;
  latestFetchedAt: string | null;
}

export interface DashboardOverview {
  overview: { currencies: OverviewCurrency[]; platforms: OverviewPlatform[]; generatedAt: string };
  isEstimate: true;
}
