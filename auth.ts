/**
 * NextAuth 配置：PrismaAdapter + 邮箱验证码（Credentials）。
 *
 * 登录流（取代 v1/v2.0 魔法链接）：
 * 1. POST /api/auth/code/request 签发 6 位码（白名单/邀请 Cookie/限流在发码端点）；
 * 2. 前端 signIn("credentials", { email, code }) → authorize 调 verifyLoginCode；
 * 3. JWT session；callbacks 带入 user.id 与 email。
 *
 * 安全红线：验证码明文只出现在发信与（开发态）响应/控制台，绝不写日志文件或回传到已登录会话。
 */
import type { NextAuthOptions } from "next-auth";
import NextAuth from "next-auth";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";

import { db } from "@/lib/db";
import { verifyLoginCode } from "@/lib/auth/otp";

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
    Credentials({
      id: "credentials",
      name: "邮箱验证码",
      credentials: {
        email: { label: "邮箱", type: "email" },
        code: { label: "验证码", type: "text" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim();
        const code = credentials?.code?.trim();
        if (!email || !code) return null;
        const outcome = await verifyLoginCode(email, code);
        if (!outcome.ok) return null;
        return { id: outcome.userId, email: outcome.email };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = (token.email as string | undefined) ?? session.user.email;
        (session.user as { id?: string }).id = (token.id as string | undefined) ?? "";
      }
      return session;
    },
  },
};

export default NextAuth(authOptions);
