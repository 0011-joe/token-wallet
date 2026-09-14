/**
 * DSH 宿主 usage 事件 → 日聚合（红线 16：只发聚合，不发会话/prompt）。
 * 事件形状对齐 v1 lib/index.js 的 assistant/message usage 五桶。
 */

export interface UsageEventSample {
  /** ISO 时间戳（事件完成时刻） */
  at: string;
  provider: string;
  model: string;
  /** 五桶 token（数字或数字串） */
  inputTokens?: number | string;
  outputTokens?: number | string;
  cacheHitTokens?: number | string;
  cacheMissTokens?: number | string;
  reasoningTokens?: number | string;
}

export interface DayAcc {
  provider: string;
  model: string;
  /** YYYY-MM-DD（按 tz 归属日） */
  date: string;
  inputTokens: string;
  outputTokens: string;
  cacheHitTokens: string;
  cacheMissTokens: string;
  reasoningTokens: string;
  requests: number;
}

function toBig(v: number | string | undefined): bigint {
  if (v === undefined || v === "") return BigInt(0);
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return BigInt(0);
    return BigInt(Math.floor(v));
  }
  const s = v.trim();
  if (!/^\d+$/.test(s)) return BigInt(0);
  return BigInt(s);
}

/** 按 tz 将 ISO 时刻映射为日历日 YYYY-MM-DD */
export function localDateKey(iso: string, tz = "Asia/Shanghai"): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // en-CA → YYYY-MM-DD
}

/**
 * 折叠 usage 样本为日聚合行。
 * 禁止保留 sessionId/title/prompt（本函数入参也不接收这些字段）。
 */
export function foldUsageSamples(
  samples: UsageEventSample[],
  tz = "Asia/Shanghai"
): DayAcc[] {
  const map = new Map<string, DayAcc>();
  for (const s of samples) {
    if (!s.provider || !s.model || !s.at) continue;
    const date = localDateKey(s.at, tz);
    const key = `${date}|${s.provider}|${s.model}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        provider: s.provider,
        model: s.model,
        date,
        inputTokens: "0",
        outputTokens: "0",
        cacheHitTokens: "0",
        cacheMissTokens: "0",
        reasoningTokens: "0",
        requests: 0,
      };
      map.set(key, acc);
    }
    const add = (cur: string, v: number | string | undefined) =>
      (BigInt(cur) + toBig(v)).toString();
    acc.inputTokens = add(acc.inputTokens, s.inputTokens);
    acc.outputTokens = add(acc.outputTokens, s.outputTokens);
    acc.cacheHitTokens = add(acc.cacheHitTokens, s.cacheHitTokens);
    acc.cacheMissTokens = add(acc.cacheMissTokens, s.cacheMissTokens);
    acc.reasoningTokens = add(acc.reasoningTokens, s.reasoningTokens);
    acc.requests += 1;
  }
  return [...map.values()].sort((a, b) =>
    a.date === b.date
      ? a.model.localeCompare(b.model)
      : a.date.localeCompare(b.date)
  );
}

/** 本地队列：简单文件/内存持久化钩子（由宿主注入存储） */
export interface CollectorQueue {
  enqueue(rows: DayAcc[]): void;
  drain(): DayAcc[];
}

export function createMemoryQueue(): CollectorQueue {
  let pending: DayAcc[] = [];
  return {
    enqueue(rows) {
      // 同 key 合并
      const map = new Map(pending.map((r) => [`${r.date}|${r.provider}|${r.model}`, r]));
      for (const r of rows) {
        const k = `${r.date}|${r.provider}|${r.model}`;
        const prev = map.get(k);
        if (!prev) {
          map.set(k, { ...r });
          continue;
        }
        map.set(k, {
          ...prev,
          inputTokens: (BigInt(prev.inputTokens) + BigInt(r.inputTokens)).toString(),
          outputTokens: (BigInt(prev.outputTokens) + BigInt(r.outputTokens)).toString(),
          cacheHitTokens: (BigInt(prev.cacheHitTokens) + BigInt(r.cacheHitTokens)).toString(),
          cacheMissTokens: (BigInt(prev.cacheMissTokens) + BigInt(r.cacheMissTokens)).toString(),
          reasoningTokens: (BigInt(prev.reasoningTokens) + BigInt(r.reasoningTokens)).toString(),
          requests: prev.requests + r.requests,
        });
      }
      pending = [...map.values()];
    },
    drain() {
      const out = pending;
      pending = [];
      return out;
    },
  };
}
