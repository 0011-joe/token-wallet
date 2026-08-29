/**
 * M6（T6.1）预警判定纯函数单测 —— 对齐 AC5-1/AC5-2/AC5-3。
 * 不触库、不发网络：直接调用 evaluateAlerts（纯函数）。
 * 频控窗口用 Date.now() 相对时间（4 小时内 / 25 小时前），避免依赖具体时间戳。
 */
import { describe, expect, it } from "vitest";
import {
  ALERT_TYPES,
  DEFAULT_FAIL_THRESHOLD_N,
  DEFAULT_LOW_BALANCE_THRESHOLD,
  FREQUENCY_WINDOW_MS,
  evaluateAlerts,
  type AlertCandidate,
} from "../lib/alerts/evaluate";

const KEY = {
  id: "key-1",
  last4: "d8d7",
  failCount: 0,
  lastStatus: null as string | null,
};
const SETTINGS = { lowBalanceThreshold: 20, failThresholdN: 3 };

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600_000);
}

function evaluate(overrides: Partial<Parameters<typeof evaluateAlerts>[0]> = {}) {
  return evaluateAlerts({
    settings: SETTINGS,
    key: KEY,
    latestSnapshot: null,
    prevSnapshot: null,
    ...overrides,
  });
}

const snap = (
  totalBalance: number,
  isAvailable = true,
  currency = "CNY"
) => ({ totalBalance, isAvailable, currency });

describe("LOW_BALANCE（AC5-1：跌破阈值 → 预警）", () => {
  it("余额 < 阈值 → 生成 LOW_BALANCE（warning / 正确的 dedupKey / 掩码 last4）", () => {
    const results = evaluate({
      latestSnapshot: snap(19.9),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "LOW_BALANCE",
      apiKeyId: "key-1",
      dedupKey: "LOW_BALANCE:key-1",
      severity: "warning",
    });
    expect(results[0].message).toContain("sk-****d8d7");
    expect(results[0].message).toContain("19.9CNY");
  });

  it("余额恰好等于阈值 → 不生成（要求严格小于）", () => {
    expect(evaluate({ latestSnapshot: snap(20) })).toEqual([]);
  });

  it("余额高于阈值 → 不生成", () => {
    expect(evaluate({ latestSnapshot: snap(50) })).toEqual([]);
  });

  it("阈值为 0 且余额为 0 → 不生成（0 < 0 不成立）", () => {
    expect(
      evaluate({
        settings: { ...SETTINGS, lowBalanceThreshold: 0 },
        latestSnapshot: snap(0),
      })
    ).toEqual([]);
  });

  it("无最新快照 → 不生成（首次失败等场景由 KEY_FAILED 覆盖）", () => {
    expect(evaluate({ latestSnapshot: null })).toEqual([]);
  });
});

describe("UNAVAILABLE（AC5-2：is_available 翻转 → 立即高级别预警）", () => {
  it("true→false 翻转 → 生成 UNAVAILABLE（critical）", () => {
    const results = evaluate({
      latestSnapshot: snap(30, false),
      prevSnapshot: { isAvailable: true },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "UNAVAILABLE",
      dedupKey: "UNAVAILABLE:key-1",
      severity: "critical",
    });
  });

  it("首次无 prev 且 is_available=false → 也生成（第一笔即不可用，立即告知）", () => {
    const results = evaluate({
      latestSnapshot: snap(30, false),
      prevSnapshot: null,
    });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("UNAVAILABLE");
  });

  it("持续 false（prev 也是 false）→ 不生成（不重复轰炸）", () => {
    expect(
      evaluate({
        latestSnapshot: snap(30, false),
        prevSnapshot: { isAvailable: false },
      })
    ).toEqual([]);
  });

  it("is_available 为 true → 不生成", () => {
    expect(
      evaluate({
        latestSnapshot: snap(30, true),
        prevSnapshot: { isAvailable: false },
      })
    ).toEqual([]);
  });
});

describe("KEY_FAILED（连续失败达 N 次 → 提醒检查 Key）", () => {
  it("failCount>=N 且 lastStatus=INVALID → 生成 KEY_FAILED（warning）", () => {
    const results = evaluate({
      key: { ...KEY, failCount: 3, lastStatus: "INVALID" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "KEY_FAILED",
      dedupKey: "KEY_FAILED:key-1",
      severity: "warning",
    });
    expect(results[0].message).toContain("3 次");
  });

  it("failCount=N-1 → 不生成（未达阈值）", () => {
    expect(
      evaluate({ key: { ...KEY, failCount: 2, lastStatus: "INVALID" } })
    ).toEqual([]);
  });

  it("lastStatus 为 OK / null → 不生成", () => {
    expect(
      evaluate({ key: { ...KEY, failCount: 5, lastStatus: "OK" } })
    ).toEqual([]);
    expect(
      evaluate({ key: { ...KEY, failCount: 5, lastStatus: null } })
    ).toEqual([]);
  });

  it("RATE_LIMITED / ERROR 同样计为失败态", () => {
    expect(
      evaluate({ key: { ...KEY, failCount: 3, lastStatus: "RATE_LIMITED" } })
    ).toHaveLength(1);
    expect(
      evaluate({ key: { ...KEY, failCount: 3, lastStatus: "ERROR" } })
    ).toHaveLength(1);
  });

  it("自定义 N（failThresholdN=5）生效", () => {
    expect(
      evaluate({
        settings: { ...SETTINGS, failThresholdN: 5 },
        key: { ...KEY, failCount: 4, lastStatus: "INVALID" },
      })
    ).toEqual([]);
    expect(
      evaluate({
        settings: { ...SETTINGS, failThresholdN: 5 },
        key: { ...KEY, failCount: 5, lastStatus: "INVALID" },
      })
    ).toHaveLength(1);
  });
});

describe("频控（AC5-3：同类同 Key 24h 窗口内不重复）", () => {
  it("同类预警 1 小时前 → 不生成（条件仍成立但被抑制）", () => {
    expect(
      evaluate({
        latestSnapshot: snap(10),
        lastAlert: { type: "LOW_BALANCE", createdAt: hoursAgo(1) },
      })
    ).toEqual([]);
  });

  it("同类预警 25 小时前（窗口已过）→ 恢复生成", () => {
    const results = evaluate({
      latestSnapshot: snap(10),
      lastAlert: { type: "LOW_BALANCE", createdAt: hoursAgo(25) },
    });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("LOW_BALANCE");
  });

  it("不同类型的不算频控：近期 KEY_FAILED 不抑制 LOW_BALANCE", () => {
    const results = evaluate({
      latestSnapshot: snap(10),
      lastAlert: { type: "KEY_FAILED", createdAt: hoursAgo(1) },
    });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("LOW_BALANCE");
  });

  it("UNAVAILABLE 频控：24h 内同类不重复（余额高于阈值，只可能命 UNAVAILABLE）", () => {
    expect(
      evaluate({
        latestSnapshot: snap(30, false),
        prevSnapshot: { isAvailable: true },
        lastAlert: { type: "UNAVAILABLE", createdAt: hoursAgo(2) },
      })
    ).toEqual([]);
  });

  it("KEY_FAILED 频控：24h 内同类不重复", () => {
    expect(
      evaluate({
        key: { ...KEY, failCount: 5, lastStatus: "INVALID" },
        lastAlert: { type: "KEY_FAILED", createdAt: hoursAgo(12) },
      })
    ).toEqual([]);
  });
});

describe("导出常量与多类型同时命中", () => {
  it("频控窗口为 24h；默认阈值 20 / 默认 N=3", () => {
    expect(FREQUENCY_WINDOW_MS).toBe(24 * 3600_000);
    expect(DEFAULT_LOW_BALANCE_THRESHOLD).toBe(20);
    expect(DEFAULT_FAIL_THRESHOLD_N).toBe(3);
    expect(ALERT_TYPES).toEqual(["LOW_BALANCE", "UNAVAILABLE", "KEY_FAILED"]);
  });

  it("条件同时命中时一次返回多个候选（三种都应出现）", () => {
    const results: AlertCandidate[] = evaluate({
      latestSnapshot: snap(10, false),
      prevSnapshot: { isAvailable: true },
      key: { ...KEY, failCount: 4, lastStatus: "RATE_LIMITED" },
    });
    expect(results.map((r) => r.type).sort()).toEqual([
      "KEY_FAILED",
      "LOW_BALANCE",
      "UNAVAILABLE",
    ]);
    // 各 type 的 dedupKey 前缀正确
    for (const r of results) {
      expect(r.dedupKey).toBe(`${r.type}:key-1`);
    }
  });
});
