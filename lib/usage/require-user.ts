/**
 * M5 路由共用：把 next-auth session 解析成 userId。
 *
 * auth.ts 采用 JWT 策略，next-auth v4 的默认 session 回调只带
 * name / email / image（见 next-auth/core/routes/session.js），不含用户 id，
 * 因此以 email 回查 User；查不到视为未登录（返回 null）。
 */
import type { Session } from "next-auth";
import { db } from "@/lib/db";

export async function requireUserId(
  session: Session | null
): Promise<string | null> {
  const email = session?.user?.email;
  if (!email) return null;
  const user = await db.user.findUnique({ where: { email } });
  return user?.id ?? null;
}
