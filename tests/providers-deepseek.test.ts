/**
 * T1.2 DeepSeek adapter 契约测试（fixture 驱动，不依赖真实网络）。
 * 覆盖：成功归一（Decimal 字符串边界）、testCredential 首余额、401→INVALID、
 * 429→RATE_LIMITED（Retry-After）、结构不符/非 JSON→ERROR、网络错误不抛异常。
 * 另含 registry 注册/查找/重复注册（AC2.1）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepseekAdapter } from "../lib/providers/deepseek";
import { getProvider, getProviderOrThrow, registerProvider, listProviders } from "../lib/providers/registry";
import type { ProviderAdapter } from "../lib/providers/types";

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
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "6.32", granted_balance: "0.00", topped_up_balance: "6.32" },
    { currency: "USD", total_balance: "1.234", granted_balance: "0.00", topped_up_balance: "1.234" },
  ],
};

describe("deepseekAdapter.fetchBalance", () => {
  it("成功：URL/Authorization/超时信号正确，金额边界转 Decimal 字符串（AC2.4）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deepseekAdapter.fetchBalance({ secret: { key: "sk-test-key-12345678" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isAvailable).toBe(true);
    expect(result.data.mode).toBe("native");
    expect(result.data.balances).toHaveLength(2);
    expect(result.data.balances[0]).toMatchObject({
      currency: "CNY",
      available: "6.320000000",
      breakdown: { cash: "6.320000000", granted: "0.000000000" },
    });
    expect(result.data.balances[1].available).toBe("1.234000000");

    // 请求细节：URL + Bearer 头 + 超时信号
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.deepseek.com/user/balance");
    expect(init.headers.Authorization).toBe("Bearer sk-test-key-12345678");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("testCredential：成功返回首份归一余额（AC1.3）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(OK_BODY)));
    const res = await deepseekAdapter.testCredential({ key: "sk-test-key-12345678" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.balance.balances[0].available).toBe("6.320000000");
  });

  it("401/403 → INVALID（不抛异常）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    const res = await deepseekAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res).toMatchObject({ ok: false, reason: "INVALID", statusCode: 401 });
  });

  it("429 → RATE_LIMITED 且透出 Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({}, 429, { "retry-after": "60" }))
    );
    const res = await deepseekAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res).toMatchObject({ ok: false, reason: "RATE_LIMITED", statusCode: 429, message: "60" });
  });

  it("结构不符 → ERROR；非 JSON → ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })));
    const res = await deepseekAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res).toMatchObject({ ok: false, reason: "ERROR" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    const res2 = await deepseekAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res2).toMatchObject({ ok: false, reason: "ERROR" });
  });

  it("网络错误 → ERROR（以返回值表达，不抛未捕获异常）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await deepseekAdapter.fetchBalance({ secret: { key: "sk-x" } });
    expect(res).toMatchObject({ ok: false, reason: "ERROR" });
  });

  it("缺 key → INVALID", async () => {
    const res = await deepseekAdapter.fetchBalance({ secret: {} });
    expect(res).toMatchObject({ ok: false, reason: "INVALID" });
  });
});

describe("registry（AC2.1：新增 Provider 只加 adapter + 注册）", () => {
  it("deepseek 已注册可查；listProviders 包含它", () => {
    expect(getProvider("deepseek")).toBe(deepseekAdapter);
    expect(listProviders().map((a) => a.id)).toContain("deepseek");
  });

  it("getProviderOrThrow 对未注册 provider 抛错", () => {
    expect(() => getProviderOrThrow("volcengine" as never)).toThrow(/未注册/);
  });

  it("重复注册同一 id 抛错（编码错误保护）", () => {
    const fake: ProviderAdapter = {
      id: "deepseek",
      credentialKind: "bearer",
      balanceMode: "native",
      usageMode: "csv_import",
      testCredential: async () => ({ ok: true, balance: { mode: "native", isAvailable: true, balances: [] } }),
      fetchBalance: async () => ({ ok: true, data: { mode: "native", isAvailable: true, balances: [] } }),
    };
    expect(() => registerProvider(fake)).toThrow(/已注册/);
  });
});
