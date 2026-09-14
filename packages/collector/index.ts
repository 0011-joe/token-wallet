/**
 * token-wallet 鏈湴閲囬泦鍣ㄩ鏋讹紙M10 MVP锛屽悓浠撳簱 packages 璇箟锛夈€? * 鍙笂鎶ユ棩鑱氬悎浜旀《 + requests锛涗笉涓婁紶浼氳瘽/prompt銆? * 鐢ㄦ硶锛歯ode packages/collector/collect.js锛堟垨 tsx锛夐厤缃?env 鍚庡畾鏃惰皟鐢?ingest銆? */
export interface CollectorDayRow {
  provider: string;
  model: string;
  date: string;
  inputTokens: string;
  outputTokens: string;
  cacheHitTokens: string;
  cacheMissTokens: string;
  reasoningTokens: string;
  requests: number;
}

export interface CollectorConfig {
  baseUrl: string;
  ingestKey: string;
  tz?: string;
}

export { foldUsageSamples, createMemoryQueue, localDateKey } from "@/lib/collector/folds";
export type { UsageEventSample, DayAcc } from "@/lib/collector/folds";

export async function pushUsageDays(
  config: CollectorConfig,
  days: CollectorDayRow[]
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/usage/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.ingestKey}`,
      "Content-Type": "application/json",
      "x-tw-nonce": `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    },
    body: JSON.stringify({
      source: "host_measured",
      tz: config.tz ?? "Asia/Shanghai",
      days,
    }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

