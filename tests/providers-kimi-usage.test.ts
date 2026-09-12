/**
 * Kimi 用量：官方无明细 API → derived 估算 / unsupported（不臆造端点）。
 */
import { describe, expect, it } from "vitest";

import { pullKimiUsage } from "@/lib/providers/kimi-usage";

describe("pullKimiUsage", () => {
  it("无快照 → unsupported，ok:true", async () => {
    const r = await pullKimiUsage({ snapshots: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("unsupported");
    expect(r.rows).toEqual([]);
    expect(r.note).toMatch(/未公开|无法/);
  });

  it("仅 1 条快照 → unsupported", async () => {
    const r = await pullKimiUsage({
      snapshots: [{ fetchedAt: "2026-09-01T00:00:00Z", available: "10.000000000" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("unsupported");
  });

  it("两条快照余额下降 → derived 估算，cost 为 Decimal 字符串且 note 含估算", async () => {
    const r = await pullKimiUsage({
      snapshots: [
        { fetchedAt: "2026-09-01T00:00:00Z", available: "10.000000000" },
        { fetchedAt: "2026-09-02T00:00:00Z", available: "8.500000000" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("derived");
    expect(r.currency).toBe("CNY");
    expect(r.note).toContain("估算");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]!.cost).toMatch(/^\d+\.\d{9}$/);
  });
});
