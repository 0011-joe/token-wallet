/**
 * P0 登录准入 + 限流单测（不依赖数据库）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInviteCookieValue,
  evaluateSignInAccess,
  isEmailAllowed,
  isEmailAllowlistEnabled,
  isInviteRequired,
  parseEmailAllowlist,
  parseInviteCodes,
  verifyInviteCode,
  verifyInviteCookieValue,
} from "@/lib/auth/access-control";
import {
  checkEmailSignInLimit,
  checkIpInviteLimit,
  resetRateLimits,
} from "@/lib/auth/rate-limit";
import { getEmailStatus } from "@/lib/email/channel-status";

describe("access-control parse", () => {
  it("逗号/分号/换行均可分隔，邮箱小写归一", () => {
    expect(parseEmailAllowlist("A@x.com, b@x.com\nC@x.com;")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  it("空串 = 未启用白名单/邀请", () => {
    expect(parseEmailAllowlist("")).toEqual([]);
    expect(parseInviteCodes("   ")).toEqual([]);
    expect(isEmailAllowlistEnabled("")).toBe(false);
    expect(isInviteRequired("")).toBe(false);
  });

  it("白名单未配置时任意邮箱可过；配置后仅列表内可过", () => {
    expect(isEmailAllowed("any@x.com", "")).toBe(true);
    expect(isEmailAllowed("A@x.com", "a@x.com,other@x.com")).toBe(true);
    expect(isEmailAllowed("evil@x.com", "a@x.com")).toBe(false);
  });

  it("邀请码：未配置放行；配置后须精确匹配", () => {
    expect(verifyInviteCode(null, "")).toBe(true);
    expect(verifyInviteCode("wrong", "good-code")).toBe(false);
    expect(verifyInviteCode("good-code", "other,good-code")).toBe(true);
    expect(verifyInviteCode("", "good-code")).toBe(false);
  });
});

describe("invite cookie", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret-for-invite-cookie");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("往返一致，邮箱大小写不敏感", () => {
    const cookie = createInviteCookieValue("User@Example.com");
    expect(verifyInviteCookieValue("user@example.com", cookie)).toBe(true);
    expect(verifyInviteCookieValue("other@example.com", cookie)).toBe(false);
  });

  it("篡改签名则失败", () => {
    const cookie = createInviteCookieValue("a@x.com");
    const bad = cookie.slice(0, -2) + "xx";
    expect(verifyInviteCookieValue("a@x.com", bad)).toBe(false);
    expect(verifyInviteCookieValue("a@x.com", "not-a-cookie")).toBe(false);
    expect(verifyInviteCookieValue("a@x.com", null)).toBe(false);
  });
});

describe("evaluateSignInAccess", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret-for-invite-cookie");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("无白名单无邀请 → 直接放行", () => {
    expect(evaluateSignInAccess({ email: "a@x.com", allowlistRaw: "", inviteCodesRaw: "" })).toEqual(
      { ok: true }
    );
  });

  it("白名单拒绝 → 403", () => {
    const r = evaluateSignInAccess({
      email: "b@x.com",
      allowlistRaw: "a@x.com",
      inviteCodesRaw: "",
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("开启邀请码但无 Cookie → 401；有有效 Cookie → 放行", () => {
    const codesRaw = "invite-1";
    const deny = evaluateSignInAccess({
      email: "a@x.com",
      allowlistRaw: "",
      inviteCodesRaw: codesRaw,
      inviteCookie: null,
    });
    expect(deny).toMatchObject({ ok: false, status: 401 });

    const cookie = createInviteCookieValue("a@x.com");
    const allow = evaluateSignInAccess({
      email: "a@x.com",
      allowlistRaw: "",
      inviteCodesRaw: codesRaw,
      inviteCookie: cookie,
    });
    expect(allow).toEqual({ ok: true });
  });
});

describe("rate-limit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("邮箱 5 次后拒绝并给出 retryAfter", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkEmailSignInLimit("a@x.com").ok).toBe(true);
    }
    const blocked = checkEmailSignInLimit("a@x.com");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    // 其它邮箱不受影响
    expect(checkEmailSignInLimit("b@x.com").ok).toBe(true);
  });

  it("邀请接口 IP 限流独立于邮箱", () => {
    for (let i = 0; i < 20; i++) {
      expect(checkIpInviteLimit("1.2.3.4").ok).toBe(true);
    }
    expect(checkIpInviteLimit("1.2.3.4").ok).toBe(false);
    expect(checkIpInviteLimit("5.6.7.8").ok).toBe(true);
  });
});

describe("email channel-status", () => {
  it("未配置 → console；Resend 优先；SMTP 次之", () => {
    expect(getEmailStatus({})).toMatchObject({ configured: false, channel: "console" });
    expect(
      getEmailStatus({ RESEND_API_KEY: "re_x", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" })
    ).toMatchObject({ configured: true, channel: "resend" });
    expect(getEmailStatus({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" })).toMatchObject({
      configured: true,
      channel: "smtp",
    });
  });
});
