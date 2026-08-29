/**
 * M6 路由共用：把 next-auth session 解析为当前用户（id + email）。
 *
 * 模式复制自 lib/usage/require-user.ts（M5 的 requireUserId，按 email 回查 User）——
 * 独立成文件，避免直接修改其他 agent 负责的模块。
 * auth.ts 采用 JWT 策略，next-auth v4 默认 session 回调只带 name/email/image，
 * 不含用户 id，因此以 email 回查 User；查不到视为未登录（返回 null）。
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";

export interface CurrentUser {
  id: string;
  email: string;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) return null;
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  return user ?? null;
}
