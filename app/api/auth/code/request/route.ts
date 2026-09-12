/**
 * 请求邮箱登录验证码（OTP）。
 * POST { email } → 白名单/邀请 Cookie/限流 → 签发 6 位码并发送。
 * 响应恒 { ok: true }（已通过准入时），避免探测邮箱是否存在；
 * console 渠道且非 production 时额外返回 devCode 便于本地联调。
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import {
  INVITE_COOKIE_NAME,
  evaluateSignInAccess,
} from "@/lib/auth/access-control";
import { issueLoginCode } from "@/lib/auth/otp";
import {
  checkEmailOtpLimit,
  checkIpOtpLimit,
} from "@/lib/auth/rate-limit";
import { detectEmailChannel } from "@/lib/email/channel-status";
import { sendOtpEmail } from "@/lib/email/otp-mail";

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
  const { email } = body as { email?: unknown };
  if (typeof email !== "string" || !email.includes("@") || email.length > 254) {
    return NextResponse.json({ ok: false, error: "邮箱格式不正确" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  const ipRl = checkIpOtpLimit(ip);
  if (!ipRl.ok) {
    return NextResponse.json(
      { ok: false, error: `请求过于频繁，请 ${ipRl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfterSec) } }
    );
  }
  const emailRl = checkEmailOtpLimit(email);
  if (!emailRl.ok) {
    return NextResponse.json(
      { ok: false, error: `请求过于频繁，请 ${emailRl.retryAfterSec} 秒后再试` },
      { status: 429, headers: { "Retry-After": String(emailRl.retryAfterSec) } }
    );
  }

  let inviteCookie: string | null = null;
  try {
    const cookieStore = await cookies();
    inviteCookie = cookieStore.get(INVITE_COOKIE_NAME)?.value ?? null;
  } catch {
    inviteCookie = null;
  }

  const access = evaluateSignInAccess({ email, inviteCookie });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error },
      { status: access.status }
    );
  }

  const channel = detectEmailChannel();
  if (channel === "console") {
    // 生产禁止走 console 签发：避免验证码进日志、避免无法登录却静默成功
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "发信渠道未配置：请在环境变量中设置 RESEND_API_KEY（推荐验证自有域名）或 SMTP_*",
        },
        { status: 503 }
      );
    }
    const issuedDev = await issueLoginCode(email);
    console.log(
      `[auth-dev] 登录验证码 ${email.trim().toLowerCase()}: ${issuedDev.code}（10 分钟内有效）`
    );
    return NextResponse.json({ ok: true, devCode: issuedDev.code });
  }

  const issued = await issueLoginCode(email);
  try {
    await sendOtpEmail({ to: email.trim().toLowerCase(), code: issued.code });
  } catch (err) {
    // 不向客户端泄露发信细节，仅服务端告警
    console.error(
      "[auth:otp] send failed",
      err instanceof Error ? err.message : "unknown"
    );
  }

  return NextResponse.json({ ok: true });
}
