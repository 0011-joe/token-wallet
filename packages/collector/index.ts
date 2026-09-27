/**
 * token-wallet 本地采集器（M10 MVP，同仓库 packages 语义）。
 * 只上报日聚合五桶 + requests；不上传会话/prompt。
 *
 * 宿主接法（见 lib/collector/runtime.ts）：
 *   const rt = createCollectorRuntime({ flush: (d) => pushUsageDays(cfg, d) });
 *   host.on('session/event', (_, ev) => {
 *     const s = sampleFromDshEvent(ev, defaultProvider, new Date().toISOString());
 *     if (s) rt.onUsageSample(s);
 *   });
 */
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

export {
  foldUsageSamples,
  createMemoryQueue,
  localDateKey,
} from "@/lib/collector/folds";
export type { UsageEventSample, DayAcc } from "@/lib/collector/folds";
export { sampleFromDshEvent } from "@/lib/collector/dsh-adapter";
export type { DshAssistantEvent } from "@/lib/collector/dsh-adapter";
export { createCollectorRuntime, selfCheckHost } from "@/lib/collector/runtime";
export type { CollectorRuntime, CollectorRuntimeConfig } from "@/lib/collector/runtime";

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
