/**
 * DSH session/event → UsageEventSample 适配。
 * 与 v1 lib/index.js 的 assistant/message usage 五桶对齐。
 * 红线 16：不提取 sessionId/title/prompt，只取 token 计数与 provider/model。
 */

export interface DshSessionLike {
  id?: string;
  provider?: string;
  model?: string;
}

export interface DshAssistantEvent {
  type?: string;
  data?: {
    turn?: number | string;
    usage?: {
      inputTokens?: number | string;
      outputTokens?: number | string;
      cacheReadTokens?: number | string;
      cacheWriteTokens?: number | string;
      reasoningTokens?: number | string;
    };
    message?: {
      source?: {
        model?: string;
        provider?: string;
      };
    };
    provider?: string;
  };
}

import type { UsageEventSample } from "@/lib/collector/folds";

/**
 * 从 DSH assistant/message 事件提取一条 usage 样本；不相关事件返回 null。
 * @param defaultProvider 宿主当前默认 provider（事件未带时兜底）
 */
export function sampleFromDshEvent(
  event: DshAssistantEvent | null | undefined,
  defaultProvider: string,
  at: string | (() => string)
): UsageEventSample | null {
  if (!event || event.type !== "assistant/message") return null;
  const d = event.data;
  if (!d || typeof d !== "object") return null;
  const usage = d.usage;
  if (!usage || typeof usage !== "object") return null;

  const model = d.message?.source?.model ?? "";
  if (!model) return null;

  const provider =
    d.message?.source?.provider ?? d.provider ?? defaultProvider;
  if (!provider) return null;

  const stamp = typeof at === "function" ? at() : at;

  return {
    at: stamp,
    provider,
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    // DSH 的 cacheReadTokens = 缓存命中；cache miss ≈ input - cacheRead（不重复计）
    cacheHitTokens: usage.cacheReadTokens ?? 0,
    cacheMissTokens: cacheMissOf(
      usage.inputTokens,
      usage.cacheReadTokens
    ),
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

/** cacheMiss = max(0, input - cacheRead)；input 含命中部分的常见口径 */
function cacheMissOf(
  input: number | string | undefined,
  cacheRead: number | string | undefined
): number {
  const i = Number(input) || 0;
  const c = Number(cacheRead) || 0;
  return Math.max(0, i - c);
}
