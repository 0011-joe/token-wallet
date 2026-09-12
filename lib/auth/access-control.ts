/**
 * 登录准入（P0）：邮箱白名单 + 邀请码。
 *
 * 环境变量：
 * - ALLOWED_EMAILS：逗号分隔邮箱列表。非空时，仅列表内邮箱可请求魔法链接（大小写不敏感）。
 *   为空 = 不启用白名单（兼容既有单人部署）。
 * - INVITE_CODES：逗号分隔邀请码。非空时，请求登录前必须先通过 POST /api/auth/invite
 *   换取短时 HttpOnly Cookie（见 COOKIE），sendVerificationRequest 会校验该 Cookie。
 *   为空 = 不启用邀请码。
 *
 * Cookie 设计（防伪造）：
 * - 名：tw_invite_ok
 * - 值：base64url(lower(email)) + "." + HMAC-SHA256(lower(email), AUTH_SECRET)
 * - 有效期 10 分钟，HttpOnly / SameSite=Lax / Path=/（无 Secure：本地 http 开发可用；
 *   生产 HTTPS 下浏览器仍会按 SameSite 策略处理，泄露面仅为同源 XSS 场景）。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const INVITE_COOKIE_NAME = "tw_invite_ok";
export const INVITE_COOKIE_MAX_AGE_SEC = 600;

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseEmailAllowlist(raw: string | undefined = process.env.ALLOWED_EMAILS): string[] {
  return splitList(raw).map((e) => e.toLowerCase());
}

export function parseInviteCodes(raw: string | undefined = process.env.INVITE_CODES): string[] {
  return splitList(raw);
}

export function isEmailAllowlistEnabled(raw?: string): boolean {
  return parseEmailAllowlist(raw).length > 0;
}

export function isInviteRequired(raw?: string): boolean {
  return parseInviteCodes(raw).length > 0;
}

/** 白名单未配置 → 放行；已配置 → 邮箱须在列表内（小写比较）。 */
export function isEmailAllowed(
  email: string,
  allowlistRaw?: string
): boolean {
  const list = parseEmailAllowlist(allowlistRaw);
  if (list.length === 0) return true;
  return list.includes(email.trim().toLowerCase());
}

/** 邀请码校验：未配置 → true（不要求）；已配置 → 须精确匹配其一。 */
export function verifyInviteCode(
  code: string | null | undefined,
  codesRaw?: string
): boolean {
  const codes = parseInviteCodes(codesRaw);
  if (codes.length === 0) return true;
  if (typeof code !== "string" || code.length === 0) return false;
  // 常量时间比较：逐个用 timingSafeEqual，避免通过响应时间猜码
  const provided = Buffer.from(code, "utf8");
  for (const c of codes) {
    const expected = Buffer.from(c, "utf8");
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

function getInviteSecret(): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("AUTH_SECRET 未配置：邀请码 Cookie 签名需要会话密钥");
  }
  return Buffer.from(secret, "utf8");
}

function hmacEmail(email: string): string {
  return createHmac("sha256", getInviteSecret()).update(email).digest("base64url");
}

/** 生成邀请通过 Cookie（email 归一为小写）。 */
export function createInviteCookieValue(email: string): string {
  const norm = email.trim().toLowerCase();
  const encoded = Buffer.from(norm, "utf8").toString("base64url");
  return `${encoded}.${hmacEmail(norm)}`;
}

/** 校验 Cookie 是否对应当前邮箱且签名有效。 */
export function verifyInviteCookieValue(email: string, cookieValue: string | null | undefined): boolean {
  if (!cookieValue) return false;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return false;
  const encoded = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  let norm: string;
  try {
    norm = Buffer.from(encoded, "base64url").toString("utf8").toLowerCase();
  } catch {
    return false;
  }
  const expected = hmacEmail(norm);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return norm === email.trim().toLowerCase();
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 429; error: string };

/**
 * 请求魔法链接前的准入判定（白名单 + 邀请 Cookie）。
 * 限流在调用方（rate-limit）单独检查，便于分别返回 429 与文案。
 */
export function evaluateSignInAccess(opts: {
  email: string;
  inviteCookie?: string | null;
  allowlistRaw?: string;
  inviteCodesRaw?: string;
}): AccessDecision {
  if (!isEmailAllowed(opts.email, opts.allowlistRaw)) {
    return { ok: false, status: 403, error: "该邮箱不在允许列表内，无法登录" };
  }
  if (isInviteRequired(opts.inviteCodesRaw)) {
    if (!verifyInviteCookieValue(opts.email, opts.inviteCookie)) {
      return { ok: false, status: 401, error: "需要有效邀请码（请先在登录页验证）" };
    }
  }
  return { ok: true };
}
