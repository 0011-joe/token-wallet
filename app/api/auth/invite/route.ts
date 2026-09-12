/**
 * 邀请码验证（P0）。
 * POST { email, inviteCode } → 校验白名单 + 邀请码，通过后下发短时 HttpOnly Cookie，
 * 供随后的 magic-link sendVerificationRequest 校验。不发登录邮件。
 */
import { NextResponse } from "next/server";
import {
  INVITE_COOKIE_MAX_AGE_SEC,
  INVITE_COOKIE_NAME,
  createInviteCookieValue,
  isEmailAllowed,
  verifyInviteCode,
} from "@/lib/auth/access-control";
import { checkIpInviteLimit } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "请求体无效" }, { status: 400 });
  }
  const { email, inviteCode } = body as { email?: unknown; inviteCode?: unknown };
  if (typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "邮箱格式不正确" }, { status: 400 });
  }
  if (typeof inviteCode !== "string" || inviteCode.length === 0) {
    return NextResponse.json({ ok: false, error: "请填写邀请码" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rl = checkIpInviteLimit(ip);
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: `尝试过于频繁，请 ${rl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  if (!isEmailAllowed(email)) {
    return NextResponse.json({ ok: false, error: "该邮箱不在允许列表内" }, { status: 403 });
  }
  if (!verifyInviteCode(inviteCode)) {
    return NextResponse.json({ ok: false, error: "邀请码无效" }, { status: 401 });
  }

  const value = createInviteCookieValue(email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(INVITE_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: INVITE_COOKIE_MAX_AGE_SEC,
  });
  return res;
}
