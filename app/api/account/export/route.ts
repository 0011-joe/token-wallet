/**
 * M7/T7.2 数据导出（PRD §8 隐私：「提供数据导出」；FR-6 正常能力）。
 *
 * GET /api/account/export —— 以 JSON 附件下载当前用户可导出的数据：
 *   - user：id + email；
 *   - keys：元信息（label/last4/isActive/failCount/lastStatus/createdAt）；
 *   - snapshots：全部 Key 最近 100 条快照（fetchedAt 倒序）；
 *   - usageImports：已导入用量的月份列表；
 *   - alertSetting：预警设置（若已配置）。
 *
 * 安全红线：全部查询都用 select 字段白名单，结构性排除 ciphertext / iv / authTag /
 * 明文 Key——导出文件不可能包含密文或任何可还原 Key 的字段。
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

  const keys = await db.apiKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      label: true,
      last4: true,
      isActive: true,
      failCount: true,
      lastStatus: true,
      createdAt: true,
    },
  });

  const [snapshots, usageImports, alertSetting] = await Promise.all([
    keys.length > 0
      ? db.balanceSnapshot.findMany({
          where: { apiKeyId: { in: keys.map((k) => k.id) } },
          orderBy: { fetchedAt: "desc" },
          take: SNAPSHOT_EXPORT_LIMIT,
          select: {
            id: true,
            currency: true,
            totalBalance: true,
            grantedBalance: true,
            toppedUpBalance: true,
            isAvailable: true,
            ok: true,
            fetchedAt: true,
          },
        })
      : Promise.resolve([]),
    db.usageImport.findMany({
      where: { userId: user.id },
      orderBy: { month: "asc" },
      select: { month: true, importedAt: true },
    }),
    db.alertSetting.findUnique({ where: { userId: user.id } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    keys,
    snapshots: snapshots.map((s) => ({ ...s, fetchedAt: s.fetchedAt.toISOString() })),
    usageImports: usageImports.map((i) => ({
      month: i.month,
      importedAt: i.importedAt.toISOString(),
    })),
    alertSetting: alertSetting
      ? {
          lowBalanceThreshold: alertSetting.lowBalanceThreshold,
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
      "Content-Disposition": `attachment; filename="deepbalance-export-${user.id}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
