/**
 * T2.1 deepseek-client 单测（规格卡 B）。
 * 全局 fetch 以 vi.stubGlobal mock，绝不发真实请求。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalance } from "../lib/deepseek/client";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBalance", () => {
  it("200：正确解析 is_available 与 balance_infos，URL/Authorization/超时信号正确", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "6.32",
            granted_balance: "0.00",
            topped_up_balance: "6.32",
          },
          {
            currency: "USD",
            total_balance: "1.23",
            granted_balance: "0.00",
            topped_up_balance: "1.23",
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBalance("sk-test12345678");

    expect(result).toEqual({
      ok: true,
      isAvailable: true,
      balanceInfos: [
        {
          currency: "CNY",
          totalBalance: "6.32",
          grantedBalance: "0.00",
          toppedUpBalance: "6.32",
        },
        {
          currency: "USD",
          totalBalance: "1.23",
          grantedBalance: "0.00",
          toppedUpBalance: "1.23",
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test12345678"
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("200 is_available=false 透传", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          is_available: false,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "0.00",
              granted_balance: "0.00",
              topped_up_balance: "0.00",
            },
          ],
        })
      )
    );
    const result = await fetchBalance("sk-test12345678");
    expect(result).toMatchObject({ ok: true, isAvailable: false });
  });

  it("baseUrl 覆盖生效（尾部斜杠被去除）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ is_available: true, balance_infos: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchBalance("sk-test12345678", { baseUrl: "http://127.0.0.1:9999/" });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:9999/user/balance");
  });

  it("401 → INVALID，携带 statusCode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const result = await fetchBalance("sk-test12345678");
    expect(result).toEqual({ ok: false, reason: "INVALID", statusCode: 401 });
  });

  it("403 → INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    const result = await fetchBalance("sk-test12345678");
    expect(result).toEqual({ ok: false, reason: "INVALID", statusCode: 403 });
  });

  it("429 → RATE_LIMITED，message 携带 Retry-After 头", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, { status: 429, headers: { "retry-after": "60" } })
      )
    );
    const result = await fetchBalance("sk-test12345678");
    expect(result).toEqual({
      ok: false,
      reason: "RATE_LIMITED",
      statusCode: 429,
      message: "60",
    });
  });

  it("429 无 Retry-After 头 → message 为 undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    const result = await fetchBalance("sk-test12345678");
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED", statusCode: 429 });
  });

  it("500 → ERROR，携带 statusCode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const result = await fetchBalance("sk-test12345678");
    expect(result).toEqual({ ok: false, reason: "ERROR", statusCode: 500 });
  });

  it("200 但响应体不是合法 JSON → ERROR，不抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not-json", { status: 200 }))
    );
    const result = await fetchBalance("sk-test12345678");
    expect(result).toEqual({
      ok: false,
      reason: "ERROR",
      statusCode: 200,
      message: "响应不是合法 JSON",
    });
  });

  it("fetch 网络错误（reject）→ ERROR，不抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    );
    const result = await fetchBalance("sk-test12345678");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ERROR");
    }
    // 返回值里不能出现 key 本身
    expect(JSON.stringify(result)).not.toContain("sk-test12345678");
  });

  it("超时（mock fetch 挂起直到 signal abort）→ ERROR，不抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted.", "AbortError"))
            );
          })
      )
    );
    const result = await fetchBalance("sk-test12345678", { timeoutMs: 25 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ERROR");
    }
  });
});
