/**
 * T5.1 快照编排器单测（AC2.5/2.6）：全局并发、失败隔离、分平台汇总、Kimi 令牌桶。
 */
import { describe, expect, it, vi } from "vitest";
import { RateLimitedQueue, runSnapshots, type ScheduledCredential } from "../lib/snapshot/orchestrator";

function cred(id: string, provider: ScheduledCredential["provider"]): ScheduledCredential {
  return { id, provider };
}

describe("runSnapshots 并发与失败隔离（AC2.5）", () => {
  it("全局并发不超过 3；10 凭证全部完成并正确汇总", async () => {
    let current = 0;
    let maxConcurrent = 0;
    const credentials = Array.from({ length: 10 }, (_, i) => cred(`c${i}`, "deepseek"));

    const result = await runSnapshots({
      credentials,
      globalConcurrency: 3,
      runOne: async () => {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 5));
        current -= 1;
        return { credentialId: "", ok: true };
      },
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(result.processed).toBe(10);
    expect(result.failed).toHaveLength(0);
    expect(result.byProvider.deepseek.processed).toBe(10);
  });

  it("单凭证失败隔离：其余照常完成，failed 仅含脱敏信息", async () => {
    const result = await runSnapshots({
      credentials: [cred("ok1", "deepseek"), cred("bad", "kimi"), cred("ok2", "deepseek")],
      runOne: async (c) =>
        c.id === "bad"
          ? { credentialId: "bad", ok: false, reason: "INVALID" }
          : { credentialId: c.id, ok: true },
    });

    expect(result.processed).toBe(2);
    expect(result.failed).toEqual([{ credentialId: "bad", provider: "kimi", reason: "INVALID" }]);
    expect(result.byProvider.deepseek).toEqual({ processed: 2, failed: 0 });
    expect(result.byProvider.kimi).toEqual({ processed: 0, failed: 1 });
  });

  it("受限平台（kimi）内部串行：执行时间不重叠", async () => {
    let running = 0;
    let overlap = false;
    const credentials = [cred("k1", "kimi"), cred("k2", "kimi"), cred("k3", "kimi")];
    const result = await runSnapshots({
      credentials,
      rateLimitPerMin: { kimi: 60 }, // 高上限：避免真实窗口等待，仅验证串行
      runOne: async () => {
        if (running > 0) overlap = true;
        running += 1;
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
        return { credentialId: "", ok: true };
      },
    });
    expect(result.processed).toBe(3);
    expect(overlap).toBe(false);
  });
});

describe("RateLimitedQueue（Kimi ≤3/min 令牌桶）", () => {
  it("窗口内达上限则等待到窗口重置", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const q = new RateLimitedQueue(3, () => clock);
      const order: number[] = [];

      const t1 = q.acquire().then(() => order.push(1));
      clock += 1;
      const t2 = q.acquire().then(() => order.push(2));
      clock += 1;
      const t3 = q.acquire().then(() => order.push(3));
      clock += 1;
      // 第 4 个：窗口内已满，需等待到 60000ms 后
      const t4 = q.acquire().then(() => order.push(4));

      await vi.advanceTimersByTimeAsync(1);
      expect(order).toEqual([1, 2, 3]); // 前 3 个立即放行

      clock = 60_000; // 窗口重置
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all([t1, t2, t3, t4]);
      expect(order).toEqual([1, 2, 3, 4]);
    } finally {
      vi.useRealTimers();
    }
  });
});
