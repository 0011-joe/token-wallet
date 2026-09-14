/**
 * token-wallet 本地采集器骨架（M10 MVP，同仓库 packages 语义）。
 * 只上报日聚合五桶 + requests；不上传会话/prompt。
 * 用法：node packages/collector/collect.js（或 tsx）配置 env 后定时调用 ingest。
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
