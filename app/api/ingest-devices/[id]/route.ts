/**
 * DELETE /api/ingest-devices/[id] —— 吊销设备。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { revokeIngestDevice } from "@/lib/usage/ingest-device";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { id } = await params;
  const ok = await revokeIngestDevice(user.id, id);
  if (!ok) return NextResponse.json({ error: "设备不存在或已吊销" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
