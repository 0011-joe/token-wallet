/**
 * 数据导出（PRD 隐私：「提供数据导出」）。
 *
 * GET /api/account/export —— 以 JSON 附件下载当前用户可导出的数据：
 *   - user：id + email；
 *   - credentials：凭证元信息（provider/kind/region/label/hint/isActive/failCount/lastStatus）；
 *   - snapshots：全部凭证最近 100 条快照（fetchedAt 倒序，金额 Decimal 字符串）；
 *   - usageImports：已导入用量的月份列表（含 provider）；
 *   - alertSetting：预警设置（若已配置）。
 *
 * 安全红线：全部查询都用 select 字段白名单，结构性排除 secretCipher / iv / authTag /
 * 明文凭证——导出文件不可能包含密文或任何可还原凭证的字段。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SNAPSHOT_EXPORT_LIMIT = 100;

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const credentials = await db.credential.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      provider: true,
      kind: true,
      region: true,
      label: true,
      hint: true,
      isActive: true,
      failCount: true,
      lastStatus: true,
      lastSuccessAt: true,
      createdAt: true,
    },
  });

  const [snapshots, usageImports, alertSetting] = await Promise.all([
    credentials.length > 0
      ? db.balanceSnapshot.findMany({
          where: { credentialId: { in: credentials.map((c) => c.id) } },
          orderBy: { fetchedAt: "desc" },
          take: SNAPSHOT_EXPORT_LIMIT,
          select: {
            id: true,
            credentialId: true,
            provider: true,
            mode: true,
            currency: true,
            available: true,
            breakdown: true,
            isAvailable: true,
            ok: true,
            fetchedAt: true,
          },
        })
      : Promise.resolve([]),
    db.usageImport.findMany({
      where: { userId: user.id },
      orderBy: { month: "asc" },
      select: { provider: true, month: true, importedAt: true },
    }),
    db.alertSetting.findUnique({ where: { userId: user.id } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    credentials: credentials.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    })),
    snapshots: snapshots.map((s) => ({
      ...s,
      available: s.available.toString(),
      fetchedAt: s.fetchedAt.toISOString(),
    })),
    usageImports: usageImports.map((i) => ({
      provider: i.provider,
      month: i.month,
      importedAt: i.importedAt.toISOString(),
    })),
    alertSetting: alertSetting
      ? {
          lowBalanceThreshold: alertSetting.lowBalanceThreshold.toString(),
          failThresholdN: alertSetting.failThresholdN,
          emailEnabled: alertSetting.emailEnabled,
          inappEnabled: alertSetting.inappEnabled,
        }
      : null,
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="token-wallet-export-${user.id}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
