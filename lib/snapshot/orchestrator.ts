/**
 * 快照编排器（T5.1 / AC2.5/2.6）：全局并发 + 分平台 QPS 限流 + 失败隔离。
 *
 * - 全局并发默认 3（p-limit）；
 * - 有 rateLimitPerMin 的平台（Kimi=3）内部串行并按窗口节流（简单令牌桶：窗口内达上限即等待）；
 * - 单凭证异常不抛出（refreshCredential 已返回值表达），失败只进 failed[]，不影响其他凭证；
 * - 返回脱敏汇总 { processed, failed[], byProvider }（AC2.5）。
 *
 * 依赖注入 runOne：生产传 refreshCredential；测试传 fake 以便并发/频控断言。
 */
import pLimit from "p-limit";
import type { ProviderId } from "@/lib/providers/types";

export interface ScheduledCredential {
  id: string;
  provider: ProviderId;
}

export interface RunOneResult {
  credentialId: string;
  ok: boolean;
  reason?: string;
}

export interface RunSnapshotsInput {
  credentials: ScheduledCredential[];
  runOne: (cred: ScheduledCredential) => Promise<RunOneResult>;
  /** provider → 每分钟上限（如 kimi=3）；未配置 = 不额外限频 */
  rateLimitPerMin?: Partial<Record<ProviderId, number>>;
  globalConcurrency?: number;
}

export interface RunSnapshotsResult {
  processed: number;
  failed: Array<{ credentialId: string; provider: ProviderId; reason: string }>;
  byProvider: Record<string, { processed: number; failed: number }>;
}

/** 极简令牌桶：串行 + 窗口节流。窗口内达上限则等待到下一窗口起点。 */
export class RateLimitedQueue {
  private timestamps: number[] = [];

  constructor(
    private readonly rate: number,
    private readonly now: () => number = Date.now
  ) {}

  async acquire(): Promise<void> {
    const windowMs = 60_000;
    const now = this.now();
    this.timestamps = this.timestamps.filter((t) => now - t < windowMs);
    if (this.timestamps.length >= this.rate) {
      const oldest = this.timestamps[0];
      const wait = windowMs - (now - oldest);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.timestamps.push(this.now());
  }
}

export async function runSnapshots(input: RunSnapshotsInput): Promise<RunSnapshotsResult> {
  const { credentials, runOne } = input;
  const globalConcurrency = input.globalConcurrency ?? 3;
  const globalLimit = pLimit(globalConcurrency);

  const result: RunSnapshotsResult = {
    processed: 0,
    failed: [],
    byProvider: {},
  };

  // 分平台受限队列（仅限声明 rateLimitPerMin 的平台）
  const rateQueues = new Map<ProviderId, RateLimitedQueue>();
  const rateByProvider = input.rateLimitPerMin ?? {};
  const limitedProviders = new Set<ProviderId>();
  for (const provider of Object.keys(rateByProvider) as ProviderId[]) {
    const rate = rateByProvider[provider];
    if (rate && rate > 0) {
      rateQueues.set(provider, new RateLimitedQueue(rate));
      limitedProviders.add(provider);
    }
  }

  // 受限平台内部串行（p-limit 1）；其余走全局并发
  const perProviderLimit = pLimit(1);

  const tasks = credentials.map((cred) =>
    globalLimit(async () => {
      const by = result.byProvider[cred.provider] ?? { processed: 0, failed: 0 };
      result.byProvider[cred.provider] = by;

      const execute = async () => {
        const r = await runOne(cred);
        if (r.ok) {
          result.processed += 1;
          by.processed += 1;
        } else {
          result.failed.push({ credentialId: cred.id, provider: cred.provider, reason: r.reason ?? "ERROR" });
          by.failed += 1;
        }
      };

      if (limitedProviders.has(cred.provider)) {
        await perProviderLimit(async () => {
          await rateQueues.get(cred.provider)!.acquire();
          await execute();
        });
      } else {
        await execute();
      }
    })
  );

  await Promise.all(tasks);
  return result;
}
