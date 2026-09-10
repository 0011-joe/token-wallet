/**
 * /api/credentials/[id] —— PATCH 启停·改名；DELETE 删除（级联删快照，AC1.5）。
 * 归属校验：不存在或非本用户 → 404（不泄露他人凭证是否存在）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { deleteCredential, updateCredential } from "@/lib/credentials/service";
import { credentialsRepo } from "@/lib/credentials/repo";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { isActive, label } = (body ?? {}) as { isActive?: unknown; label?: unknown };
  if (isActive !== undefined && typeof isActive !== "boolean") {
    return NextResponse.json({ error: "isActive 必须是布尔值" }, { status: 400 });
  }
  if (label !== undefined && (typeof label !== "string" || label.trim() === "")) {
    return NextResponse.json({ error: "label 必须是非空字符串" }, { status: 400 });
  }
  if (isActive === undefined && label === undefined) {
    return NextResponse.json({ error: "缺少可更新的字段（isActive 或 label）" }, { status: 400 });
  }

  const result = await updateCredential({
    userId: user.id,
    id,
    isActive: typeof isActive === "boolean" ? isActive : undefined,
    label: typeof label === "string" ? label.trim() : undefined,
    repo: credentialsRepo,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ credential: result.record });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id } = await params;
  const result = await deleteCredential({ userId: user.id, id, repo: credentialsRepo });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // 快照由 Prisma onDelete: Cascade 连带删除（AC1.5）
  return new NextResponse(null, { status: 204 });
}
