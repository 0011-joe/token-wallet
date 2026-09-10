/**
 * 告警判定与频控：纯函数（无副作用、不触库、不读环境变量）。
 *
 * 规则（PRD §6.5 / DEV-GUIDE §12；v2 适配 Credential 模型）：
 * - LOW_BALANCE：最新成功快照可用余额 < 阈值（Decimal 字符串比较，阈值非负由设置 API 保证；
 *   多币种只评估「主币种」——CNY 优先，无 CNY 取最近一次快照币种，分币种不混算）；
 * - UNAVAILABLE：最新快照 is_available=false 且上一笔成功快照并非 false（true→false 翻转
 *   立即触发 critical，AC5-2）；首次即 false（无 prev）也触发；
 * - CREDENTIAL_FAILED（统一 v1 的 KEY_FAILED）：连续失败 failCount >= N 且最近状态
 *   为失败态（INVALID / FORBIDDEN_SCOPE / RATE_LIMITED / ERROR）；
 * - 频控（AC5-3）：同类（type）同凭证最近一次预警在 24h 窗口内不重复；dedupKey =
 *   `${type}:${credentialId}`（业务唯一，不含时间；DB 唯一约束已废弃，由时间窗判断兜底）。
 *
 * 告警内容只含平台、脱敏标识（hint）、类型、数值，绝无明文凭证（AC5.3）。
 */
import { moneyCmp, moneyIsPositive, type Money } from "@/lib/money";
import type { ProviderId } from "@/lib/providers/types";

export const ALERT_TYPES = [
  "LOW_BALANCE",
  "ARREARS",
  "UNAVAILABLE",
  "CREDENTIAL_FAILED",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** 频控窗口：24h（AC5-3）。 */
export const FREQUENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 低余额默认阈值（PRD Q3 建议值 20，schema 默认一致）——规范 6 位 Decimal 字符串 */
export const DEFAULT_LOW_BALANCE_THRESHOLD = "20.000000000";
/** 连续失败默认次数 N（PRD Q3 建议值 3，schema 默认一致）。 */
export const DEFAULT_FAIL_THRESHOLD_N = 3;

/** Key 失败态集合（与 runner 的 lastStatus 取值对齐）。 */
const FAILURE_STATUSES = new Set(["INVALID", "FORBIDDEN_SCOPE", "RATE_LIMITED", "ERROR"]);

export interface AlertCandidate {
  type: AlertType;
  credentialId: string;
  message: string;
  dedupKey: string;
  severity: "warning" | "critical";
}

export interface AlertKeyView {
  id: string;
  provider: ProviderId;
  hint: string;
  failCount: number;
  lastStatus: string | null;
}

export interface AlertSnapshotView {
  available: Money;
  isAvailable: boolean;
  currency: string;
  /** 归一化构成（用于欠费判定：Kimi cash<0 / 火山 ArrearsBalance>0） */
  breakdown?: Record<string, string | undefined>;
}

function maskedHint(hint: string): string {
  return hint.includes("****") ? hint : `****${hint.slice(-4)}`;
}

/** 同类同凭证是否处于 24h 频控窗口内（lastAlert.type 不同不构成频控）。 */
function isSuppressed(
  type: AlertType,
  lastAlert: { type: AlertType; createdAt: Date } | null | undefined
): boolean {
  if (!lastAlert || lastAlert.type !== type) return false;
  return Date.now() - lastAlert.createdAt.getTime() < FREQUENCY_WINDOW_MS;
}

export function evaluateAlerts(params: {
  settings: { lowBalanceThreshold: Money; failThresholdN: number };
  key: AlertKeyView;
  latestSnapshot: AlertSnapshotView | null;
  // 上一次成功快照（同主币种），判定 is_available 翻转；null 表示首次/无历史
  prevSnapshot: { isAvailable: boolean } | null;
  // 最近一次同类预警（频控窗口判定），由调用方按 (type, credentialId) 查询后传入
  lastAlert?: { type: AlertType; createdAt: Date } | null;
}): AlertCandidate[] {
  const { settings, key, latestSnapshot, prevSnapshot, lastAlert } = params;
  const candidates: AlertCandidate[] = [];

  // ── LOW_BALANCE（AC5-1）：跌破阈值（严格小于，Decimal 比较） ──
  if (!isSuppressed("LOW_BALANCE", lastAlert)) {
    if (latestSnapshot !== null && moneyCmp(latestSnapshot.available, settings.lowBalanceThreshold) < 0) {
      candidates.push({
        type: "LOW_BALANCE",
        credentialId: key.id,
        message: `${key.provider} 凭证 ${maskedHint(key.hint)} 余额 ${latestSnapshot.available}${latestSnapshot.currency}，已低于预警阈值 ${settings.lowBalanceThreshold}${latestSnapshot.currency}，请及时充值`,
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
        credentialId: key.id,
        message: `${key.provider} 凭证 ${maskedHint(key.hint)} 判定为不可用（is_available=false），请登录平台检查账户状态`,
        dedupKey: `UNAVAILABLE:${key.id}`,
        severity: "critical",
      });
    }
  }

  // ── ARREARS（欠费：Kimi cash<0 / 火山 ArrearsBalance>0，AC5.1）──
  if (!isSuppressed("ARREARS", lastAlert)) {
    const arrears = latestSnapshot?.breakdown?.arrears;
    if (arrears !== undefined && moneyIsPositive(arrears)) {
      candidates.push({
        type: "ARREARS",
        credentialId: key.id,
        message: `${key.provider} 凭证 ${maskedHint(key.hint)} 存在欠费 ${arrears}${latestSnapshot?.currency ?? ""}，请尽快充值`,
        dedupKey: `ARREARS:${key.id}`,
        severity: "critical",
      });
    }
  }

  // ── CREDENTIAL_FAILED（统一 v1 的 KEY_FAILED）：连续失败达 N 且最近状态为失败态 ──
  if (!isSuppressed("CREDENTIAL_FAILED", lastAlert)) {
    if (
      key.failCount >= settings.failThresholdN &&
      key.lastStatus !== null &&
      FAILURE_STATUSES.has(key.lastStatus)
    ) {
      candidates.push({
        type: "CREDENTIAL_FAILED",
        credentialId: key.id,
        message: `${key.provider} 凭证 ${maskedHint(key.hint)} 连续失败 ${key.failCount} 次（最近状态 ${key.lastStatus}），请检查该凭证是否已失效或已在官方侧删除`,
        dedupKey: `CREDENTIAL_FAILED:${key.id}`,
        severity: "warning",
      });
    }
  }

  return candidates;
}
