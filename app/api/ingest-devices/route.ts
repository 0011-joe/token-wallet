/**
 * GET/POST /api/ingest-devices —— 采集设备列表与创建（创建时返回一次 ingestKey）。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { createIngestDevice, listIngestDevices } from "@/lib/usage/ingest-device";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const devices = await listIngestDevices(user.id);
  return NextResponse.json({ devices });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const name =
    typeof (body as { name?: unknown }).name === "string" &&
    (body as { name: string }).name.trim()
      ? (body as { name: string }).name.trim().slice(0, 64)
      : "未命名设备";
  const created = await createIngestDevice(user.id, name);
  return NextResponse.json(created, { status: 201 });
}
