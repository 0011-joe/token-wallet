/**
 * 前端 API 契约类型 —— 与后端 app/api/** 的响应结构一一对应。
 * 只做类型声明，不改后端；字段以后端实现为准（见各 route.ts 注释）。
 */

/** 单条 Key 的对外视图（/api/keys、/api/dashboard.key 共用） */
export interface ApiKeySummary {
  id: string;
  label: string;
  last4: string;
  isActive: boolean;
  failCount: number;
  /** OK | INVALID | RATE_LIMITED | ERROR（见 lib/keys/repo.ts） */
  lastStatus: string | null;
  /** ISO 时间字符串 */
  createdAt: string;
}

export interface KeysResponse {
  keys: ApiKeySummary[];
}

/** 单币种余额快照视图（/api/dashboard.balance.byCurrency 单项） */
export interface BalanceView {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
  isAvailable: boolean;
  fetchedAt: string;
}

/** 今日 / 本月消耗（估算口径） */
export interface TodayMonthCost {
  cost: number;
  /** snapshot=有快照基准；no-snapshot=快照不足（<2 个），cost 恒为 0 */
  from: "snapshot" | "no-snapshot";
  currency: string;
}

/** 趋势单日数据（UTC） */
export interface TrendDay {
  /** YYYY-MM-DD */
  date: string;
  cost: number;
  /** 该日存在快照缺口（数据恢复日），UI 画出断点 / 插值样式 */
  hasGap: boolean;
}

export interface DashboardData {
  key: ApiKeySummary;
  /** 主卡币种（CNY 优先）的最新快照；无任何快照时为 null */
  balance: (BalanceView & { stale: boolean; byCurrency: BalanceView[] }) | null;
  today: TodayMonthCost;
  month: TodayMonthCost;
  trend: { range: number; days: TrendDay[] };
  /** 恒为 true：所有消耗均为快照差值估算，UI 必须标注 */
  isEstimate: true;
  generatedAt: string;
}

export type BalanceInfo = NonNullable<DashboardData["balance"]>;

/** 后端错误响应（/api/dashboard 为 { ok:false, error }，其余为 { error }） */
export interface ApiErrorBody {
  ok?: false;
  error: string;
}

/** /api/usage/models —— type 取值全集（不得增删，见 lib/usage/csv-parse.ts） */
export type UsageType =
  | "input_cache_hit_tokens"
  | "input_cache_miss_tokens"
  | "output_tokens"
  | "request_count";

export interface ModelUsageTypeRow {
  type: UsageType;
  /** token 数或请求次数 */
  amount: number;
  cost: number;
}

export interface ModelUsageRow {
  model: string;
  totalTokens: number;
  totalCost: number;
  /** 占当月总费用百分比（2 位小数） */
  sharePct: number;
  byType: ModelUsageTypeRow[];
}

export interface ModelsResponse {
  /** YYYY-MM */
  month: string;
  models: ModelUsageRow[];
  totalCost: number;
  totalTokens: number;
  /** cost 文件未接入，恒为 null */
  currency: string | null;
}

/** POST /api/usage/import 成功响应 */
export interface ImportUsageResponse {
  month: string;
  rows: number;
  models: number;
}
