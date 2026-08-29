/**
 * M7/T7.2 注销账户接口（FR-6 / AC6-2）。
 *
 * DELETE /api/account：
 *   - body 必须为 { confirm: true }（前端二次确认弹窗后发送），否则 400；
 *   - 鉴权 = next-auth 会话 + email 回查（lib/auth/current-user.ts 的 getCurrentUser，
 *     该文件与 M6 agent 共用：M6 先写入，本任务直接复用，不再另起实现），未登录 401；
 *   - 删除在单个事务内完成（lib/account/delete-account.ts），成功 204；
 *   - 用户行删除后 cron（遍历 isActive=true 的 ApiKey）自然不再调用其 Key，
 *     即「不再被定时任务调用」由数据删除保证（见 delete-account.ts 注释）。
 *
 * 安全：本端点不读取、不返回任何 API Key 明文/密文。
 */
import { NextResponse } from "next/server";

import { deleteAccount } from "@/lib/account/delete-account";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { confirm } = (body ?? {}) as { confirm?: unknown };
  if (confirm !== true) {
    return NextResponse.json(
      { error: "注销需要二次确认：请确认后重试（body: { confirm: true }）" },
      { status: 400 }
    );
  }

  try {
    await db.$transaction((tx) => deleteAccount(tx, user.id));
  } catch (err) {
    // 鉴权通过后用户被并发注销等极端情况：与「账户不存在」同语义，不泄露细节
    if ((err as { code?: string }).code === "P2025") {
      return NextResponse.json({ error: "账户不存在或已注销" }, { status: 404 });
    }
    throw err;
  }
  return new NextResponse(null, { status: 204 });
}
