/**
 * DSH 事件 → 日聚合测试。
 */
import { describe, expect, it } from "vitest";

import {
  createMemoryQueue,
  foldUsageSamples,
  localDateKey,
} from "@/lib/collector/folds";

describe("localDateKey", () => {
  it("UTC 跨日事件按 Asia/Shanghai 归日", () => {
    expect(localDateKey("2026-09-14T16:30:00Z", "Asia/Shanghai")).toBe("2026-09-15");
    expect(localDateKey("2026-09-14T16:30:00Z", "UTC")).toBe("2026-09-14");
  });
});

describe("foldUsageSamples", () => {
  it("同日同模型累加五桶与 requests", () => {
    const rows = foldUsageSamples(
      [
        {
          at: "2026-09-15T02:00:00Z",
          provider: "deepseek",
          model: "deepseek-chat",
          inputTokens: "100",
          outputTokens: "10",
          cacheHitTokens: "5",
        },
        {
          at: "2026-09-15T03:00:00Z",
          provider: "deepseek",
          model: "deepseek-chat",
          inputTokens: "50",
          outputTokens: "5",
        },
      ],
      "UTC"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe("150");
    expect(rows[0]?.outputTokens).toBe("15");
    expect(rows[0]?.cacheHitTokens).toBe("5");
    expect(rows[0]?.requests).toBe(2);
  });

  it("输出仅含聚合字段", () => {
    const rows = foldUsageSamples([
      {
        at: "2026-09-15T02:00:00Z",
        provider: "deepseek",
        model: "m",
        inputTokens: 1,
      },
    ]);
    const keys = Object.keys(rows[0]!).sort();
    expect(keys).toEqual(
      [
        "cacheHitTokens",
        "cacheMissTokens",
        "date",
        "inputTokens",
        "model",
        "outputTokens",
        "provider",
        "reasoningTokens",
        "requests",
      ].sort()
    );
  });
});

describe("memory queue", () => {
  it("enqueue 合并同 key，drain 清空", () => {
    const q = createMemoryQueue();
    q.enqueue([
      {
        provider: "deepseek",
        model: "m",
        date: "2026-09-15",
        inputTokens: "1",
        outputTokens: "0",
        cacheHitTokens: "0",
        cacheMissTokens: "0",
        reasoningTokens: "0",
        requests: 1,
      },
    ]);
    q.enqueue([
      {
        provider: "deepseek",
        model: "m",
        date: "2026-09-15",
        inputTokens: "2",
        outputTokens: "0",
        cacheHitTokens: "0",
        cacheMissTokens: "0",
        reasoningTokens: "0",
        requests: 1,
      },
    ]);
    const out = q.drain();
    expect(out).toHaveLength(1);
    expect(out[0]?.inputTokens).toBe("3");
    expect(out[0]?.requests).toBe(2);
    expect(q.drain()).toHaveLength(0);
  });
});
