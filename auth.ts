/**
 * NextAuth 配置：PrismaAdapter + Email 魔法链接。
 * 版本说明：计划案为 Auth.js v5，但 v5 至今仍是 beta（5.0.0-beta.x）；
 * 采用其稳定版 next-auth@4（已支持 Next 16 / React 19，能力等价）。
 *
 * 邮件发送策略（已定）：
 * - 未配置 SMTP_HOST/SMTP_USER/SMTP_PASS 与 RESEND_API_KEY：链接打印到服务端控制台（开发态）；
 * - 已配置：走 lib/email/verification-request.ts 真实发送（与 M6 预警邮件共用
 *   lib/email/mailer.ts：RESEND_API_KEY 优先，其次 SMTP）；发送失败抛错，
 *   next-auth 捕获后跳 /error?error=EmailSignin，用户可感知失败。
 * 红线：魔法链接 URL 只允许出现在发给用户的邮件与（未配置时的）服务端控制台，
 * 绝不进客户端/数据库/日志文件。
 */
import type { NextAuthOptions } from "next-auth";
import NextAuth from "next-auth";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import Email from "next-auth/providers/email";
import { db } from "@/lib/db";
import { sendVerificationRequestEmail } from "@/lib/email/verification-request";
import { evaluateSignInAccess } from "@/lib/auth/access-control";
import { checkEmailSignInLimit } from "@/lib/auth/rate-limit";
import { detectEmailChannel } from "@/lib/email/channel-status";
import { cookies } from "next/headers";
import { INVITE_COOKIE_NAME } from "@/lib/auth/access-control";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  secret: process.env.AUTH_SECRET,
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Email({
      from: process.env.SMTP_FROM ?? "token-wallet <noreply@localhost>",
      async sendVerificationRequest({ identifier, url }) {
        // P0 准入：白名单 + 邀请码 Cookie（在创建 token 之后、发信之前拦截）
        let inviteCookie: string | null = null;
        try {
          const cookieStore = await cookies();
          inviteCookie = cookieStore.get(INVITE_COOKIE_NAME)?.value ?? null;
        } catch {
          // cookies() 在部分非 App-Router 请求上下文不可用：视为无 Cookie，
          // 邀请码开启时 evaluateSignInAccess 会拒绝
        }
        const access = evaluateSignInAccess({
          email: identifier,
          inviteCookie,
        });
        if (!access.ok) {
          throw new Error(access.error);
        }
        const rl = checkEmailSignInLimit(identifier);
        if (!rl.ok) {
          throw new Error(`请求过于频繁，请 ${rl.retryAfterSec} 秒后再试`);
        }

        const channel = detectEmailChannel();
        if (channel !== "console") {
          // 已配置 → 真实发送（与 M6 预警邮件共用 mailer 渠道：RESEND 优先，其次 SMTP）
          const result = await sendVerificationRequestEmail(identifier, url);
          if (!result.ok) {
            // 发送失败抛错：next-auth 捕获后跳 /error?error=EmailSignin（错误信息不含 url）
            throw new Error(`魔法链接发送失败: ${result.error}`);
          }
          return;
        }
        // 开发态：邮件链接打印到服务端控制台（不配置 SMTP/Resend 也能测试登录）
        console.log(`[auth-dev] 魔法链接 for ${identifier}: ${url}`);
      },
    }),
  ],
};

export default NextAuth(authOptions);
