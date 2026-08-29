/**
 * M6（T6.1）预警判定与频控：纯函数（无副作用、不触库、不读环境变量）。
 *
 * 规则（PRD §6.5 FR-5 / 计划 §7.7 规格卡 E）：
 * - LOW_BALANCE：最新成功快照总余额 < 用户低余额阈值（阈值由设置 API 保证非负；
 *   多币种只对「主币种」评估——主币种口径与 dashboard 一致：CNY 优先，无 CNY 取最近
 *   一次快照的币种；分币种不混算、不换算，见路由侧取数逻辑）。
 * - UNAVAILABLE：最新快照 is_available=false 且上一次成功快照并非 false（true→false
 *   翻转立即触发，高级别 critical，AC5-2）；首次即 false（无 prev）也触发——
 *   第一次拿到「不可用」就应立刻告知用户（无历史可对照，不等待）。
 *   持续 false 不重复触发（prev=false 时 no-op），避免每次 cron 都告警。
 * - KEY_FAILED：连续失败 failCount >= failThresholdN 且最近状态为失败态
 *   （INVALID / RATE_LIMITED / ERROR）→ 提醒检查 Key。
 * - 频控（AC5-3）：同类（type）同 Key 的最近一次预警在 24h 窗口内 → 不生成；
 *   窗口过后恢复。dedupKey = `${type}:${apiKeyId}`（固定、不含时间：同窗口内唯一，
 *   @@unique([dedupKey, createdAt]) 兜底并发同刻写入；时间戳由调用方写库时生成）。
 *   lastAlert 语义：调用方传入「最近一次同类预警」；type 不同则不构成频控。
 */

export const ALERT_TYPES = ["LOW_BALANCE", "UNAVAILABLE", "KEY_FAILED"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** 频控窗口：24h（AC5-3）。 */
export const FREQUENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 低余额默认阈值（PRD Q3 建议值 20，schemas 默认一致）。 */
export const DEFAULT_LOW_BALANCE_THRESHOLD = 20;
/** 连续失败默认次数 N（PRD Q3 建议值 3，schema 默认一致）。 */
export const DEFAULT_FAIL_THRESHOLD_N = 3;

/** Key 失败态集合（与 M3 cron 的 FAILURE_STATUS 对齐的字符串值）。 */
const FAILURE_STATUSES = new Set(["INVALID", "RATE_LIMITED", "ERROR"]);

export interface AlertCandidate {
  type: AlertType;
  apiKeyId: string;
  message: string;
  dedupKey: string;
  severity: "warning" | "critical";
}

function maskLast4(last4: string): string {
  return `sk-****${last4}`;
}

/** 同类同 Key 是否处于 24h 频控窗口内（lastAlert.type 不同不构成频控）。 */
function isSuppressed(
  type: AlertType,
  lastAlert: { type: AlertType; createdAt: Date } | null | undefined
): boolean {
  if (!lastAlert || lastAlert.type !== type) return false;
  return Date.now() - lastAlert.createdAt.getTime() < FREQUENCY_WINDOW_MS;
}

export function evaluateAlerts(params: {
  settings: { lowBalanceThreshold: number; failThresholdN: number };
  key: { id: string; last4: string; failCount: number; lastStatus: string | null };
  latestSnapshot: { totalBalance: number; isAvailable: boolean; currency: string } | null;
  // 上一次成功快照（同主币种），判定 is_available 翻转；null 表示首次/无历史
  prevSnapshot: { isAvailable: boolean } | null;
  // 最近一次同类预警（频控窗口判定），由调用方按 (type, apiKeyId) 查询后传入
  lastAlert?: { type: AlertType; createdAt: Date } | null;
}): AlertCandidate[] {
  const { settings, key, latestSnapshot, prevSnapshot, lastAlert } = params;
  const candidates: AlertCandidate[] = [];

  // ── LOW_BALANCE（AC5-1）：跌破阈值（严格小于） ──
  if (!isSuppressed("LOW_BALANCE", lastAlert)) {
    if (
      latestSnapshot !== null &&
      latestSnapshot.totalBalance < settings.lowBalanceThreshold
    ) {
      candidates.push({
        type: "LOW_BALANCE",
        apiKeyId: key.id,
        message: `Key ${maskLast4(key.last4)} 余额 ${latestSnapshot.totalBalance}${latestSnapshot.currency}，已低于预警阈值 ${settings.lowBalanceThreshold}${latestSnapshot.currency}，请及时充值`,
        dedupKey: `LOW_BALANCE:${key.id}`,
        severity: "warning",
      });
    }
  }

  // ── UNAVAILABLE（AC5-2）：翻转才触发（true→false），首见 false 也触发 ──
  if (!isSuppressed("UNAVAILABLE", lastAlert)) {
    if (
      latestSnapshot !== null &&
      latestSnapshot.isAvailable === false &&
      prevSnapshot?.isAvailable !== false
    ) {
      candidates.push({
        type: "UNAVAILABLE",
        apiKeyId: key.id,
        message: `Key ${maskLast4(key.last4)} 判定为不可用（is_available=false），请登录 DeepSeek 检查账户状态`,
        dedupKey: `UNAVAILABLE:${key.id}`,
        severity: "critical",
      });
    }
  }

  // ── KEY_FAILED（AC5-2）：连续失败达 N 且最近状态为失败态 ──
  if (!isSuppressed("KEY_FAILED", lastAlert)) {
    if (
      key.failCount >= settings.failThresholdN &&
      key.lastStatus !== null &&
      FAILURE_STATUSES.has(key.lastStatus)
    ) {
      candidates.push({
        type: "KEY_FAILED",
        apiKeyId: key.id,
        message: `Key ${maskLast4(key.last4)} 连续失败 ${key.failCount} 次（最近状态 ${key.lastStatus}），请检查该 Key 是否已失效或已在官方侧删除`,
        dedupKey: `KEY_FAILED:${key.id}`,
        severity: "warning",
      });
    }
  }

  return candidates;
}
