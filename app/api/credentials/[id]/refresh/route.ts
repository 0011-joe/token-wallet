/**
 * POST /api/credentials/[id]/refresh —— 立即刷新（登录态 + 归属校验；单凭证限流在 M5 补）。
 * 复用 lib/snapshot/runner 的 refreshCredential（与 cron 同一领域逻辑，DEV-GUIDE §11）。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/providers/registry";
import { refreshCredential } from "@/lib/snapshot/runner";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const { id } = await params;

  const cred = await db.credential.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      provider: true,
      region: true,
      isActive: true,
      iv: true,
      authTag: true,
      secretCipher: true,
    },
  });
  if (!cred) {
    return NextResponse.json({ ok: false, error: "凭证不存在" }, { status: 404 });
  }
  if (!cred.isActive) {
    return NextResponse.json({ ok: false, error: "该凭证已停用" }, { status: 400 });
  }

  const adapter = getProvider(cred.provider);
  if (!adapter) {
    return NextResponse.json({ ok: false, error: "该平台暂未支持" }, { status: 400 });
  }

  const result = await refreshCredential(
    {
      id: cred.id,
      provider: cred.provider,
      region: cred.region,
      iv: cred.iv,
      authTag: cred.authTag,
      ciphertext: cred.secretCipher,
    },
    adapter
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.reason === "INVALID" ? "凭证无效或已失效"
          : result.reason === "FORBIDDEN_SCOPE" ? "权限不足（请使用费用中心只读 IAM 子用户凭证）"
          : result.reason === "RATE_LIMITED" ? "官方接口限流，请稍后重试"
          : "官方接口请求失败，请稍后重试",
        reason: result.reason,
      },
      { status: result.reason === "INVALID" || result.reason === "FORBIDDEN_SCOPE" ? 422 : 502 }
    );
  }

  // 读取最新快照回显
  const latest = await db.balanceSnapshot.findFirst({
    where: { credentialId: cred.id, ok: true },
    orderBy: { fetchedAt: "desc" },
  });
  return NextResponse.json({
    ok: true,
    snapshots: result.snapshots,
    latest: latest
      ? {
          currency: latest.currency,
          available: latest.available.toString(),
          isAvailable: latest.isAvailable,
          fetchedAt: latest.fetchedAt.toISOString(),
        }
      : null,
  });
}
