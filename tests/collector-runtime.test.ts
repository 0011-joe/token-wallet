/**
 * 采集器 runtime + DSH 适配测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sampleFromDshEvent, type DshAssistantEvent } from "@/lib/collector/dsh-adapter";
import { createCollectorRuntime, selfCheckHost } from "@/lib/collector/runtime";

describe("sampleFromDshEvent", () => {
  it("assistant/message 提取五桶，cacheMiss = input - cacheRead", () => {
    const ev: DshAssistantEvent = {
      type: "assistant/message",
      data: {
        turn: 1,
        usage: {
          inputTokens: 1000,
          cacheReadTokens: 400,
          outputTokens: 200,
          reasoningTokens: 50,
        },
        message: { source: { model: "deepseek-chat", provider: "deepseek" } },
      },
    };
    const s = sampleFromDshEvent(ev, "unknown", "2026-09-15T02:00:00Z");
    expect(s).not.toBeNull();
    expect(s?.model).toBe("deepseek-chat");
    expect(s?.provider).toBe("deepseek");
    expect(s?.inputTokens).toBe(1000);
    expect(s?.cacheHitTokens).toBe(400);
    expect(s?.cacheMissTokens).toBe(600);
    expect(s?.reasoningTokens).toBe(50);
  });

  it("非 assistant/message 或缺 usage → null", () => {
    expect(sampleFromDshEvent({ type: "turn/end" }, "deepseek", "x")).toBeNull();
    expect(
      sampleFromDshEvent(
        { type: "assistant/message", data: { usage: undefined } },
        "deepseek",
        "x"
      )
    ).toBeNull();
    expect(sampleFromDshEvent(null, "deepseek", "x")).toBeNull();
  });

  it("事件未带 model → null（不臆造）", () => {
    const ev: DshAssistantEvent = {
      type: "assistant/message",
      data: { usage: { inputTokens: 1 }, message: { source: {} } },
    };
    expect(sampleFromDshEvent(ev, "deepseek", "x")).toBeNull();
  });
});

describe("collector runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("入样 → flush 调用上报并清空", async () => {
    const flush = vi.fn().mockResolvedValue({ ok: true, status: 200, body: {} });
    const rt = createCollectorRuntime({ flush, autoFlush: false });
    rt.onUsageSample({
      at: "2026-09-15T02:00:00Z",
      provider: "deepseek",
      model: "m",
      inputTokens: 10,
      outputTokens: 1,
    });
    expect(rt.pending()).toBe(1);
    const r = await rt.flushQueue();
    expect(r.ok).toBe(true);
    expect(r.queued).toBe(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(rt.pending()).toBe(0);
    rt.stop();
  });

  it("上报失败回队，下次重试", async () => {
    const flush = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, body: null })
      .mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    const rt = createCollectorRuntime({ flush, autoFlush: false });
    rt.onUsageSample({
      at: "2026-09-15T02:00:00Z",
      provider: "deepseek",
      model: "m",
      inputTokens: 5,
    });
    await rt.flushQueue();
    expect(rt.pending()).toBe(0); // drain 后进 queue，pending 只看 buffer
    // 第二次成功
    const r2 = await rt.flushQueue();
    expect(r2.ok).toBe(true);
    expect(flush).toHaveBeenCalledTimes(2);
    rt.stop();
  });

  it("autoFlush 到时自动 flush", async () => {
    const flush = vi.fn().mockResolvedValue({ ok: true, status: 200, body: {} });
    const rt = createCollectorRuntime({ flush, flushIntervalMs: 1000 });
    rt.onUsageSample({
      at: "2026-09-15T02:00:00Z",
      provider: "deepseek",
      model: "m",
      inputTokens: 1,
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(flush).toHaveBeenCalled();
    rt.stop();
  });

  it("selfCheckHost 缺 on() 报不兼容", () => {
    expect(selfCheckHost({} as never).ok).toBe(false);
    expect(selfCheckHost({ on: () => null }).ok).toBe(true);
  });
});
