/**
 * 采集器运行时：接 DSH 事件 → fold → 队列 → 定时 push ingest。
 * 宿主以依赖注入方式挂接（ctx.on('session/event')），本模块不做任何网络嗅探。
 */
import {
  createMemoryQueue,
  foldUsageSamples,
  type CollectorQueue,
  type DayAcc,
  type UsageEventSample,
} from "./folds";

export interface CollectorRuntimeConfig {
  /** 上报函数（由 packages/collector pushUsageDays 或测试注入） */
  flush: (days: DayAcc[]) => Promise<{ ok: boolean; status: number; body: unknown }>;
  /** flush 间隔 ms，默认 5 分钟 */
  flushIntervalMs?: number;
  /** 每次最多上报条数，默认 500 */
  maxBatch?: number;
  /** 禁用自动 flush（仅手动 flushQueue） */
  autoFlush?: boolean;
  onFlushResult?: (r: { ok: boolean; status: number; queued: number }) => void;
  onError?: (err: unknown) => void;
}

export interface CollectorRuntime {
  /** 宿主 event 回调入口 */
  onUsageSample(sample: UsageEventSample): void;
  /** 手动冲刷（出队 → flush；失败入队重试） */
  flushQueue(): Promise<{ ok: boolean; status: number; queued: number }>;
  /** 当前积压条数 */
  pending(): number;
  stop(): void;
  /** 启动自动 flush 定时器（autoFlush 默认 true 时由 create 启动） */
  start(): void;
}

export function createCollectorRuntime(cfg: CollectorRuntimeConfig): CollectorRuntime {
  const queue: CollectorQueue = createMemoryQueue();
  const maxBatch = cfg.maxBatch ?? 500;
  const interval = cfg.flushIntervalMs ?? 5 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  /** 进程内样本缓冲：跨事件攒到 flush 时再 fold（降低键冲突与开销） */
  let buffer: UsageEventSample[] = [];

  function drainBufferIntoQueue(): void {
    if (buffer.length === 0) return;
    const rows: DayAcc[] = foldUsageSamples(buffer);
    buffer = [];
    // fold 与队列同 key 合并
    queue.enqueue(rows);
  }

  async function flushQueue(): Promise<{ ok: boolean; status: number; queued: number }> {
    drainBufferIntoQueue();
    const batch = queue.drain().slice(0, maxBatch);
    if (batch.length === 0) {
      return { ok: true, status: 0, queued: 0 };
    }
    try {
      const r = await cfg.flush(batch);
      if (!r.ok) {
        // 失败回队（最简单：重新 enqueue），下次重试
        queue.enqueue(batch);
      }
      cfg.onFlushResult?.({ ok: r.ok, status: r.status, queued: batch.length });
      return { ok: r.ok, status: r.status, queued: batch.length };
    } catch (err) {
      queue.enqueue(batch);
      cfg.onError?.(err);
      return { ok: false, status: 0, queued: batch.length };
    }
  }

  function start(): void {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void flushQueue();
    }, interval);
    // 不阻止进程退出（Node）
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  function stop(): void {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (cfg.autoFlush !== false) {
    start();
  }

  return {
    onUsageSample(sample) {
      if (stopped) return;
      if (!sample?.provider || !sample?.model || !sample?.at) return;
      buffer.push(sample);
    },
    flushQueue,
    pending() {
      return buffer.length;
    },
    stop,
    start,
  };
}

/**
 * 自检：宿主缺少关键 API 时明确报错，不静默空转（DEV-GUIDE 规格卡 G）。
 */
export function selfCheckHost(host: {
  on?: (event: string, cb: (...args: unknown[]) => unknown) => unknown;
}): { ok: boolean; error?: string } {
  if (typeof host?.on !== "function") {
    return { ok: false, error: "当前宿主不支持 on()：与本采集器不兼容，已停止上报" };
  }
  return { ok: true };
}
