/**
 * T2.1 Kimi adapter 契约测试（fixture 驱动，AC2.3）。
 * 覆盖：number→Decimal 无精度丢失、code/status 判定、401/429、欠费归一、可用性判定。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { kimiAdapter, KIMI_HOSTS } from "../lib/providers/kimi";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const OK_BODY = {
  code: 0,
  status: true,
  scode: "0x0",
  data: {
    available_balance: 49.58894,
    voucher_balance: 46.58893,
    cash_balance: 3.00001,
  },
};

describe("kimiAdapter.fetchBalance", () => {
  it("成功：code===0&&status===true，number→Decimal 无精度丢失（AC2.3）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const result = await kimiAdapter.fetchBalance({ secret: { key: "sk-moonshot-12345678" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.data.balances[0];
    expect(b.currency).toBe("CNY");
    expect(b.available).toBe("49.588940000");
    expect(b.breakdown).toMatchObject({
      cash: "3.000010000",
      voucher: "46.588930000",
    });
    expect(b.breakdown.arrears).toBeUndefined(); // cash 为正，无欠费
    expect(result.data.isAvailable).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.moonshot.cn/v1/users/me/balance");
    expect(init.headers.Authorization).toBe("Bearer sk-moonshot-12345678");
  });

  it("HTTP 200 但 code≠0 → ERROR（不能只看 200，红线 #5）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: 1, status: false, scode: "0x1", data: null }))
    );
    const res = await kimiAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res).toMatchObject({ ok: false, reason: "ERROR" });
    if (!res.ok) expect(res.message).toMatch(/code=1/);
  });

  it("status 不为 true → ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: 0, status: false, data: null }))
    );
    const res = await kimiAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res).toMatchObject({ ok: false, reason: "ERROR" });
  });

  it("401 → INVALID；429 → RATE_LIMITED（带 Retry-After）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    expect(await kimiAdapter.fetchBalance({ secret: { key: "sk-x" } })).toMatchObject({
      ok: false,
      reason: "INVALID",
      statusCode: 401,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({}, 429, { "retry-after": "60" }))
    );
    expect(await kimiAdapter.fetchBalance({ secret: { key: "sk-x" } })).toMatchObject({
      ok: false,
      reason: "RATE_LIMITED",
      statusCode: 429,
      message: "60",
    });
  });

  it("欠费：cash<0 → arrears=|cash|，available=voucher，isAvailable=voucher>0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          code: 0,
          status: true,
          data: { available_balance: 50, voucher_balance: 50, cash_balance: -5 },
        })
      )
    );
    const res = await kimiAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = res.data.balances[0];
    expect(b.available).toBe("50.000000000");
    expect(b.breakdown.cash).toBe("-5.000000000");
    expect(b.breakdown.voucher).toBe("50.000000000");
    expect(b.breakdown.arrears).toBe("5.000000000");
    expect(res.data.isAvailable).toBe(true);
  });

  it("available<=0 → isAvailable=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          code: 0,
          status: true,
          data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 },
        })
      )
    );
    const res = await kimiAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.isAvailable).toBe(false);
  });

  it("region 常量表：cn 与 intl（v2.1 预留位）", () => {
    expect(KIMI_HOSTS.cn).toBe("https://api.moonshot.cn");
    expect(KIMI_HOSTS.intl).toBe("https://api.moonshot.ai");
  });

  it("限频声明：rateLimitPerMin=3", () => {
    expect(kimiAdapter.rateLimitPerMin).toBe(3);
  });
});
