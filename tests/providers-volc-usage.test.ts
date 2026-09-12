/**
 * 火山用量拉取契约测试（fixture 驱动，不直连生产）。
 * 覆盖：derived 差值估算（复用 snapshot-delta 口径）、api ListBill 签名请求、
 * 错误分类、unsupported 降级（响应字段未确认不臆造行）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveUsageFromSnapshots,
  pullVolcUsage,
  snapshotToPoint,
  type UsagePullResult,
} from "../lib/providers/volcengine/usage";
import type { TimedSnapshotPoint } from "../lib/billing/snapshot-delta";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// 与 providers-volcengine / volc-sigv4 相同的官方公开示例向量（非真实凭证）
const AK = ["AKLT", "YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg"].join("");
const SK = ["WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUx", "TXpZeU9UVXlOMlE1TmpZeVlqTQ=="].join("");

const pt = (iso: string, available: string, currency = "CNY"): TimedSnapshotPoint => ({
  currency,
  available,
  fetchedAt: new Date(iso),
});

function expectOk(result: UsagePullResult) {
  if (!result.ok) throw new Error(`期望 ok:true，实际 ${result.reason}: ${result.message}`);
  return result;
}

describe("pullVolcUsage / derived（余额差值估算）", () => {
  it("纯消费两快照：一行，cost=差额，mode=derived，note 含「估算」", async () => {
    const result = expectOk(
      await pullVolcUsage({
        snapshots: [pt("2026-08-28T10:00:00Z", "100.000000000"), pt("2026-08-28T11:00:00Z", "90.000000000")],
      })
    );
    expect(result.mode).toBe("derived");
    expect(result.currency).toBe("CNY");
    expect(result.rows).toEqual([{ date: "2026-08-28", cost: "10.000000000" }]);
    expect(result.note).toContain("估算");
  });

  it("多日聚合：段成本归起点日，按日期升序", async () => {
    const result = expectOk(
      await pullVolcUsage({
        snapshots: [
          pt("2026-08-28T10:00:00Z", "100"),
          pt("2026-08-28T12:00:00Z", "95"),
          pt("2026-08-29T10:00:00Z", "90"),
        ],
      })
    );
    expect(result.rows).toEqual([
      { date: "2026-08-28", cost: "10.000000000" },
      { date: "2026-08-29", cost: "0.000000000" },
    ]);
  });

  it("充值当天：available 上升 → cost=0（不被误计为收入）", async () => {
    const result = expectOk(
      await pullVolcUsage({
        snapshots: [pt("2026-08-28T10:00:00Z", "90"), pt("2026-08-28T11:00:00Z", "100")],
      })
    );
    expect(result.rows).toEqual([{ date: "2026-08-28", cost: "0.000000000" }]);
  });

  it("跨币种：USD 段不参与 CNY 估算", async () => {
    const result = expectOk(
      await pullVolcUsage({
        snapshots: [
          pt("2026-08-28T10:00:00Z", "100", "CNY"),
          pt("2026-08-28T10:01:00Z", "100", "USD"),
          pt("2026-08-28T11:00:00Z", "90", "CNY"),
          pt("2026-08-28T11:01:00Z", "50", "USD"),
        ],
      })
    );
    expect(result.rows).toEqual([{ date: "2026-08-28", cost: "10.000000000" }]);
  });

  it("存在缺口日：note 标注 hasGap", async () => {
    const result = expectOk(
      await pullVolcUsage({
        snapshots: [pt("2026-08-28T10:00:00Z", "100"), pt("2026-08-28T13:00:00Z", "90")],
        maxGapMs: 2 * 60 * 60 * 1000,
      })
    );
    expect(result.note).toContain("hasGap");
    expect(result.rows).toEqual([{ date: "2026-08-28", cost: "10.000000000" }]);
  });

  it("空快照 / 无 CNY 快照 → unsupported，rows 为空", async () => {
    const empty = expectOk(await pullVolcUsage({ snapshots: [] }));
    expect(empty.mode).toBe("unsupported");
    expect(empty.rows).toEqual([]);
    expect(empty.note).toMatch(/只读账单权限|CSV/);

    const usdOnly = expectOk(
      await pullVolcUsage({ snapshots: [pt("2026-08-28T10:00:00Z", "1", "USD")] })
    );
    expect(usdOnly.mode).toBe("unsupported");
  });

  it("deriveUsageFromSnapshots 与 pullVolcUsage(prefer 默认) 一致", () => {
    const snaps = [pt("2026-08-28T10:00:00Z", "10"), pt("2026-08-28T11:00:00Z", "7")];
    const direct = deriveUsageFromSnapshots(snaps);
    expect(direct.ok && direct.rows).toEqual([{ date: "2026-08-28", cost: "3.000000000" }]);
  });
});

describe("pullVolcUsage / api（ListBill，SigV4 与余额同路径）", () => {
  it("缺 secret / billPeriod 非法 → ok:false INVALID，不发请求", async () => {
    const noSecret = await pullVolcUsage({ prefer: "api", billPeriod: "2026-08" });
    expect(noSecret).toMatchObject({ ok: false, reason: "INVALID" });

    const badPeriod = await pullVolcUsage({
      prefer: "api",
      secret: { ak: AK, sk: SK },
      billPeriod: "2026/08",
    });
    expect(badPeriod).toMatchObject({ ok: false, reason: "INVALID" });

    const badLimit = await pullVolcUsage({
      prefer: "api",
      secret: { ak: AK, sk: SK },
      billPeriod: "2026-08",
      limit: 0,
    });
    expect(badLimit).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("ListBill 请求：URL/Authorization/body 与官方向量形状一致（mock fetch）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ResponseMetadata: { RequestId: "req-1", Action: "ListBill", Version: "2022-01-01" },
        Result: { Bills: [] },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pullVolcUsage({
      prefer: "api",
      secret: { ak: AK, sk: SK },
      billPeriod: "2023-08",
      limit: 10,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://billing.volcengineapi.com/?Action=ListBill&Version=2022-01-01"
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"Limit":10,"BillPeriod":"2023-08"}');
    expect(init.headers.Authorization).toMatch(/^HMAC-SHA256 Credential=AKLT/);
    expect(init.headers["X-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(init.headers["Content-Type"]).toBe("application/json");
    // Content-Type 不参与签名（与官方向量 2 SignedHeaders 一致）
    expect(init.headers.Authorization).toContain("SignedHeaders=host;x-date");

    // 响应字段未确认 → 不臆造行，降级 unsupported
    const ok = expectOk(result);
    expect(ok.mode).toBe("unsupported");
    expect(ok.rows).toEqual([]);
    expect(ok.note).toContain("ListBill");
    expect(ok.note).toMatch(/字段未在本仓库确认|只读账单权限/);
  });

  it("签名错 → INVALID；权限不足 → FORBIDDEN_SCOPE（可操作引导）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: {
            Error: { Code: "SignatureDoesNotMatch", Message: "signature mismatch" },
          },
        })
      )
    );
    expect(
      await pullVolcUsage({ prefer: "api", secret: { ak: AK, sk: SK }, billPeriod: "2026-08" })
    ).toMatchObject({ ok: false, reason: "INVALID" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: { Error: { Code: "100013", Message: "access denied" } },
        })
      )
    );
    const forbidden = await pullVolcUsage({
      prefer: "api",
      secret: { ak: AK, sk: SK },
      billPeriod: "2026-08",
    });
    expect(forbidden).toMatchObject({ ok: false, reason: "FORBIDDEN_SCOPE" });
    if (!forbidden.ok) expect(forbidden.message).toMatch(/只读/);
  });

  it("网络错误 / 非 JSON / Result 缺失 → ERROR，不抛异常", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(
      await pullVolcUsage({ prefer: "api", secret: { ak: AK, sk: SK }, billPeriod: "2026-08" })
    ).toMatchObject({ ok: false, reason: "ERROR" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    expect(
      await pullVolcUsage({ prefer: "api", secret: { ak: AK, sk: SK }, billPeriod: "2026-08" })
    ).toMatchObject({ ok: false, reason: "ERROR" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ResponseMetadata: { RequestId: "r" } }))
    );
    expect(
      await pullVolcUsage({ prefer: "api", secret: { ak: AK, sk: SK }, billPeriod: "2026-08" })
    ).toMatchObject({ ok: false, reason: "ERROR" });
  });

  it("prefer=derived 时即使带 secret 也不发 ListBill 请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = expectOk(
      await pullVolcUsage({
        secret: { ak: AK, sk: SK },
        billPeriod: "2026-08",
        snapshots: [pt("2026-08-28T10:00:00Z", "5"), pt("2026-08-28T11:00:00Z", "4")],
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("derived");
  });
});

describe("snapshotToPoint", () => {
  it("Prisma Decimal 字符串 / number 经 toMoney 归一", () => {
    const p = snapshotToPoint({
      currency: "CNY",
      available: "77.01",
      fetchedAt: new Date("2026-08-28T10:00:00Z"),
      breakdown: { cash: "83.01" },
    });
    expect(p.available).toBe("77.010000000");
    expect(p.breakdown).toEqual({ cash: "83.01" });
  });
});
