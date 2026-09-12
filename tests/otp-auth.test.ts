/**
 * OTP 核心 + 发码 API（mock db，不依赖真实库）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loginCodeCreate = vi.fn();
const loginCodeUpdate = vi.fn();
const loginCodeUpdateMany = vi.fn();
const loginCodeFindFirst = vi.fn();
const userUpsert = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    loginCode: {
      create: (...a: unknown[]) => loginCodeCreate(...a),
      update: (...a: unknown[]) => loginCodeUpdate(...a),
      updateMany: (...a: unknown[]) => loginCodeUpdateMany(...a),
      findFirst: (...a: unknown[]) => loginCodeFindFirst(...a),
    },
    user: {
      upsert: (...a: unknown[]) => userUpsert(...a),
    },
  },
}));

import { generateOtpCode, hashOtpCode, issueLoginCode, verifyLoginCode } from "@/lib/auth/otp";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { POST as requestCodePost } from "@/app/api/auth/code/request/route";

describe("otp primitives", () => {
  it("generate 6 位数字", () => {
    const c = generateOtpCode();
    expect(c).toMatch(/^\d{6}$/);
  });

  it("hash 与邮箱大小写无关", () => {
    expect(hashOtpCode("123456", "A@x.com")).toBe(hashOtpCode("123456", "a@x.com"));
  });
});

describe("issue/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginCodeUpdateMany.mockResolvedValue({ count: 0 });
    loginCodeCreate.mockImplementation(async (args: { data: { email: string; codeHash: string; expiresAt: Date } }) => ({
      id: "lc_1",
      ...args.data,
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    }));
    loginCodeUpdate.mockResolvedValue({});
    userUpsert.mockResolvedValue({ id: "u1", email: "a@x.com" });
  });

  it("issue 会作废旧码并创建新码", async () => {
    const issued = await issueLoginCode("A@X.com");
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(loginCodeUpdateMany).toHaveBeenCalled();
    expect(loginCodeCreate).toHaveBeenCalled();
    const arg = loginCodeCreate.mock.calls[0]![0] as {
      data: { email: string };
    };
    expect(arg.data.email).toBe("a@x.com");
  });

  it("verify 成功：消费码并 upsert User", async () => {
    const code = "123456";
    loginCodeFindFirst.mockResolvedValue({
      id: "lc_1",
      email: "a@x.com",
      codeHash: hashOtpCode(code, "a@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    });
    const r = await verifyLoginCode("a@x.com", code);
    expect(r).toMatchObject({ ok: true, userId: "u1" });
    expect(userUpsert).toHaveBeenCalled();
  });

  it("verify 错误码 → attempts+1", async () => {
    loginCodeFindFirst.mockResolvedValue({
      id: "lc_1",
      email: "a@x.com",
      codeHash: hashOtpCode("999999", "a@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    });
    const r = await verifyLoginCode("a@x.com", "123456");
    expect(r.ok).toBe(false);
    expect(loginCodeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: 1 }),
      })
    );
  });

  it("过期 → 失败", async () => {
    loginCodeFindFirst.mockResolvedValue({
      id: "lc_1",
      email: "a@x.com",
      codeHash: hashOtpCode("123456", "a@x.com"),
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    });
    const r = await verifyLoginCode("a@x.com", "123456");
    expect(r.ok).toBe(false);
  });
});

describe("POST /api/auth/code/request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOWED_EMAILS", "");
    vi.stubEnv("INVITE_CODES", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SMTP_HOST", "");
    loginCodeUpdateMany.mockResolvedValue({ count: 0 });
    loginCodeCreate.mockResolvedValue({
      id: "lc_1",
      email: "a@x.com",
      codeHash: "h",
      expiresAt: new Date(Date.now() + 600_000),
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("非法 body → 400", async () => {
    const res = await requestCodePost(
      new Request("http://t/api/auth/code/request", {
        method: "POST",
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("console 渠道非 production → 返回 devCode", async () => {
    const res = await requestCodePost(
      new Request("http://t/api/auth/code/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@x.com" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; devCode?: string };
    expect(body.ok).toBe(true);
    expect(body.devCode).toMatch(/^\d{6}$/);
  });

  it("邮箱限流 3 次后 429", async () => {
    for (let i = 0; i < 3; i++) {
      await requestCodePost(
        new Request("http://t/api/auth/code/request", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" },
          body: JSON.stringify({ email: "limit@x.com" }),
        })
      );
    }
    const res = await requestCodePost(
      new Request("http://t/api/auth/code/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" },
        body: JSON.stringify({ email: "limit@x.com" }),
      })
    );
    expect(res.status).toBe(429);
  });

  it("白名单拒绝 → 403", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "only@x.com");
    const res = await requestCodePost(
      new Request("http://t/api/auth/code/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "8.8.8.8" },
        body: JSON.stringify({ email: "no@x.com" }),
      })
    );
    expect(res.status).toBe(403);
  });
});
