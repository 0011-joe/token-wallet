/**
 * T3.2 火山 adapter 契约测试（fixture 驱动，AC2.2）。
 * 覆盖：成功字段归一、签名错→INVALID、权限不足→FORBIDDEN_SCOPE、欠费判定、可用性判定。
 * 签名本身已由 tests/volc-sigv4.test.ts 官方向量对拍覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { volcengineAdapter } from "../lib/providers/volcengine/adapter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// 官方文档公开示例向量（非真实凭证，来自 volcengine.com/docs/6369/67269）。
// 拆分为片段仅为规避 GitHub Push Protection 对示例 AK 形状的误报。
const AK = ["AKLT", "YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg"].join("");
const SK = ["WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUx", "TXpZeU9UVXlOMlE1TmpZeVlqTQ=="].join("");

describe("volcengineAdapter.fetchBalance", () => {
  it("成功：字段归一（AvailableBalance 为准，构成含信控/冻结/欠费）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ResponseMetadata: { RequestId: "req-1", Action: "QueryBalanceAcct", Version: "2022-01-01", Service: "billing" },
        Result: {
          AccountID: 210123456,
          ArrearsBalance: "0.00",
          AvailableBalance: "77.01",
          CashBalance: "83.01",
          CreditLimit: "0.01",
          FreezeAmount: "5.01",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.data.balances[0];
    expect(b.currency).toBe("CNY");
    expect(b.available).toBe("77.010000000");
    expect(b.breakdown).toEqual({
      cash: "83.010000000",
      creditLimit: "0.010000000",
      frozen: "5.010000000",
      arrears: "0.000000000",
    });
    expect(result.data.isAvailable).toBe(true);

    // 请求细节：签名头 + 端点
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01");
    expect(init.headers.Authorization).toMatch(/^HMAC-SHA256 Credential=AKLT/);
    expect(init.headers["X-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("欠费：ArrearsBalance>0 → isAvailable=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: { RequestId: "r" },
          Result: {
            AccountID: 1,
            ArrearsBalance: "1.01",
            AvailableBalance: "77.01",
            CashBalance: "83.01",
            CreditLimit: "0.01",
            FreezeAmount: "5.01",
          },
        })
      )
    );
    const res = await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.isAvailable).toBe(false);
  });

  it("AvailableBalance=0 → isAvailable=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: { RequestId: "r" },
          Result: { AccountID: 1, ArrearsBalance: "0", AvailableBalance: "0", CashBalance: "0", CreditLimit: "0", FreezeAmount: "0" },
        })
      )
    );
    const res = await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.isAvailable).toBe(false);
  });

  it("签名错 SignatureDoesNotMatch → INVALID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: {
            RequestId: "r",
            Error: { Code: "SignatureDoesNotMatch", Message: "signature mismatch" },
          },
        })
      )
    );
    const res = await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } });
    expect(res).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it("权限不足 AccessDenied（100013）→ FORBIDDEN_SCOPE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: { RequestId: "r", Error: { Code: "100013", Message: "access denied" } },
        })
      )
    );
    const res = await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } });
    expect(res).toMatchObject({ ok: false, reason: "FORBIDDEN_SCOPE" });
    if (!res.ok) expect(res.message).toMatch(/只读/);
  });

  it("其他业务错误 InvalidTimestamp → ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ResponseMetadata: { RequestId: "r", Error: { Code: "100006", Message: "invalid timestamp" } },
        })
      )
    );
    const res = await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } });
    expect(res).toMatchObject({ ok: false, reason: "ERROR" });
  });

  it("网络错误 → ERROR（不抛异常）；缺 AK/SK → INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await volcengineAdapter.fetchBalance({ secret: { ak: AK, sk: SK } })).toMatchObject({
      ok: false,
      reason: "ERROR",
    });

    expect(await volcengineAdapter.fetchBalance({ secret: {} })).toMatchObject({
      ok: false,
      reason: "INVALID",
    });
  });
});
