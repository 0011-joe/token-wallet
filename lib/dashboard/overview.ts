/**
 * 跨平台总览聚合（T4.1 / AC3.1-3.3）：纯函数，无副作用，便于单测。
 *
 * 纪律：
 * - 分币种合计，CNY 与 USD 不混算、不换算（红线 #6 / AC3.2）；
 * - 每凭证每币种只取最新一条成功快照参与汇总；
 * - 平台故障仅体现在 failed/stale 计数与「数据截至 xx:xx」，不把失败显示成 0（红线 #4 / AC3.3）；
 * - 金额全程 Decimal 字符串（lib/money）。
 */
import { moneyAdd, toMoney, type Money } from "@/lib/money";
import type { ProviderId } from "@/lib/providers/types";

export interface OverviewCredential {
  id: string;
  provider: ProviderId;
  hint: string;
  label: string;
  isActive: boolean;
  lastStatus: string | null;
  failCount: number;
  lastSuccessAt: Date | null;
}

export interface OverviewSnapshot {
  currency: string;
  available: Money;
  isAvailable: boolean;
  fetchedAt: Date;
}

export interface CurrencyTotal {
  currency: string;
  /** 该币种所有凭证最新可用余额之和（Decimal 字符串） */
  totalAvailable: Money;
  /** 贡献该币种的凭证数 */
  credentialCount: number;
  /** 最近一次成功快照时间（ISO） */
  latestFetchedAt: string | null;
}

export interface PlatformCard {
  provider: ProviderId;
  credentialCount: number;
  /** 有拉取异常（lastStatus 非 OK）的凭证数 */
  failedCount: number;
  /** 最近成功快照超时的凭证数 */
  staleCount: number;
  /** 每币种最新可用余额（该平台内所有凭证汇总，不跨币种） */
  byCurrency: Array<{ currency: string; available: Money; credentialCount: number }>;
  latestFetchedAt: string | null;
}

export interface Overview {
  currencies: CurrencyTotal[];
  platforms: PlatformCard[];
  generatedAt: string;
}

/** 快照距今超过该毫秒数视为 stale（与单凭证看板一致：快照周期 1h × 1.5） */
export const STALE_AFTER_MS = 90 * 60 * 1000;

const FAILURE_STATUSES = new Set(["INVALID", "FORBIDDEN_SCOPE", "RATE_LIMITED", "ERROR"]);

/**
 * 聚合总览：输入凭证列表 + 每个凭证的全部成功快照（按 fetchedAt 升序）。
 * 输出分币种合计与平台卡（AC3.1/3.2/3.3）。
 */
export function aggregateOverview(
  credentials: OverviewCredential[],
  snapshotsByCredential: Map<string, OverviewSnapshot[]>,
  now: Date = new Date()
): Overview {
  const activeCredentials = credentials.filter((c) => c.isActive);

  // ── 每凭证每币种取最新成功快照 ──
  const latestByCredential = new Map<string, Map<string, OverviewSnapshot>>();
  for (const cred of activeCredentials) {
    const snaps = snapshotsByCredential.get(cred.id) ?? [];
    const latest = new Map<string, OverviewSnapshot>();
    for (const s of snaps) latest.set(s.currency, s); // 升序，最后写入即最新
    latestByCredential.set(cred.id, latest);
  }

  // ── 分币种合计 ──
  const currencyMap = new Map<
    string,
    { total: Money; credentialCount: number; latestFetchedAt: number | null }
  >();
  for (const cred of activeCredentials) {
    const latest = latestByCredential.get(cred.id) ?? new Map();
    for (const [currency, snap] of latest) {
      const agg = currencyMap.get(currency) ?? {
        total: toMoney("0"),
        credentialCount: 0,
        latestFetchedAt: null as number | null,
      };
      agg.total = moneyAdd(agg.total, snap.available);
      agg.credentialCount += 1;
      const ts = snap.fetchedAt.getTime();
      if (agg.latestFetchedAt === null || ts > agg.latestFetchedAt) agg.latestFetchedAt = ts;
      currencyMap.set(currency, agg);
    }
  }
  const currencies: CurrencyTotal[] = [...currencyMap.entries()]
    .map(([currency, a]) => ({
      currency,
      totalAvailable: a.total,
      credentialCount: a.credentialCount,
      latestFetchedAt: a.latestFetchedAt === null ? null : new Date(a.latestFetchedAt).toISOString(),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  // ── 平台卡 ──
  const providerMap = new Map<ProviderId, {
    credentialCount: number;
    failedCount: number;
    staleCount: number;
    byCurrency: Map<string, { available: Money; credentialCount: number }>;
    latestFetchedAt: number | null;
  }>();
  for (const cred of activeCredentials) {
    const agg = providerMap.get(cred.provider) ?? {
      credentialCount: 0,
      failedCount: 0,
      staleCount: 0,
      byCurrency: new Map(),
      latestFetchedAt: null as number | null,
    };
    agg.credentialCount += 1;
    if (cred.lastStatus !== null && FAILURE_STATUSES.has(cred.lastStatus)) {
      agg.failedCount += 1;
    }
    const latest = latestByCredential.get(cred.id) ?? new Map();
    if (latest.size === 0) {
      agg.staleCount += 1; // 无任何成功快照 → 视为陈旧/无数据
    }
    for (const [currency, snap] of latest) {
      const c = agg.byCurrency.get(currency) ?? { available: toMoney("0"), credentialCount: 0 };
      c.available = moneyAdd(c.available, snap.available);
      c.credentialCount += 1;
      agg.byCurrency.set(currency, c);
      const ts = snap.fetchedAt.getTime();
      if (now.getTime() - ts > STALE_AFTER_MS) agg.staleCount += 1;
      if (agg.latestFetchedAt === null || ts > agg.latestFetchedAt) agg.latestFetchedAt = ts;
    }
    providerMap.set(cred.provider, agg);
  }

  const platforms: PlatformCard[] = [...providerMap.entries()]
    .map(([provider, a]) => ({
      provider,
      credentialCount: a.credentialCount,
      failedCount: a.failedCount,
      staleCount: a.staleCount,
      byCurrency: [...a.byCurrency.entries()]
        .map(([currency, c]) => ({ currency, available: c.available, credentialCount: c.credentialCount }))
        .sort((x, y) => x.currency.localeCompare(y.currency)),
      latestFetchedAt: a.latestFetchedAt === null ? null : new Date(a.latestFetchedAt).toISOString(),
    }))
    .sort((x, y) => x.provider.localeCompare(y.provider));

  return { currencies, platforms, generatedAt: now.toISOString() };
}
