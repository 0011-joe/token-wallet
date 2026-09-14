/**
 * DELETE /api/budgets/[id] —— 停用预算（软删，保留历史）。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { id } = await params;
  const r = await db.budget.updateMany({
    where: { id, userId: user.id, isActive: true },
    data: { isActive: false },
  });
  if (r.count === 0) {
    return NextResponse.json({ error: "预算不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
