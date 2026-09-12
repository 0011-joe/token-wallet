/**
 * 邮件/登录策略状态（只读、无密钥）。登录页据此显示配置引导与邀请码开关。
 */
import { NextResponse } from "next/server";
import { getEmailStatus } from "@/lib/email/channel-status";
import { isEmailAllowlistEnabled, isInviteRequired } from "@/lib/auth/access-control";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const email = getEmailStatus();
  return NextResponse.json(
    {
      email,
      inviteRequired: isInviteRequired(),
      allowlistEnabled: isEmailAllowlistEnabled(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
