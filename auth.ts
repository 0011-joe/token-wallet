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
      from: process.env.SMTP_FROM ?? "DeepBalance <noreply@localhost>",
      async sendVerificationRequest({ identifier, url }) {
        const smtpConfigured = Boolean(
          process.env.SMTP_HOST &&
            process.env.SMTP_USER &&
            process.env.SMTP_PASS
        );
        const resendConfigured = Boolean(process.env.RESEND_API_KEY);
        if (smtpConfigured || resendConfigured) {
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
