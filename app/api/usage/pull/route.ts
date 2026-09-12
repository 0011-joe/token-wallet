/**
 * POST /api/usage/pull —— 按平台拉取/估算用量并幂等入库（与 CSV 共用 [userId,provider,month]）。
 * body: { provider: 'kimi'|'volcengine', credentialId?: string }
 *
 * 流程：鉴权 → 须存在该平台凭证 → 加载余额快照 → dispatchUsagePull
 * → unsupported 200 不入库；ok:false 422；derived 按月 upsert 全量月份。
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/usage/require-user";
import type { ProviderId } from "@/lib/providers/types";
import {
  PULL_FILE_NAME,
  dispatchUsagePull,
  groupPullRowsByMonth,
  latestMonth,
  type PullSnapshotPoint,
} from "@/lib/usage/provider-pull";
import { upsertUsageImport } from "@/lib/usage/import-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED: ProviderId[] = ["kimi", "volcengine"];

async function loadSnapshotPoints(
  userId: string,
  provider: ProviderId,
  credentialId: string
): Promise<PullSnapshotPoint[]> {
  const rows = await db.balanceSnapshot.findMany({
    where: { provider, ok: true, credentialId, credential: { userId } },
    orderBy: { fetchedAt: "asc" },
    select: { currency: true, available: true, fetchedAt: true },
    take: 500,
  });
  return rows.map((r) => ({
    fetchedAt: r.fetchedAt,
    available: r.available as unknown as string | number,
    currency: r.currency,
  }));
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = await requireUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }
  const { provider, credentialId } = body as {
    provider?: unknown;
    credentialId?: unknown;
  };
  if (typeof provider !== "string" || !ALLOWED.includes(provider as ProviderId)) {
    return NextResponse.json(
      { error: "provider 仅支持 kimi | volcengine（DeepSeek 请用 CSV 导入）" },
      { status: 400 }
    );
  }
  const pid = provider as ProviderId;

  const cred = await db.credential.findFirst({
    where: {
      userId,
      provider: pid,
      isActive: true,
      ...(typeof credentialId === "string" && credentialId
        ? { id: credentialId }
        : {}),
    },
    select: { id: true },
  });
  if (!cred) {
    return NextResponse.json(
      { error: "尚未绑定该平台凭证，请先在「凭证管理」中添加" },
      { status: 400 }
    );
  }

  const snapshots = await loadSnapshotPoints(userId, pid, cred.id);
  const dispatched = await dispatchUsagePull(pid, { snapshots });
  if (dispatched.ok === false && "notReady" in dispatched && dispatched.notReady) {
    return NextResponse.json(
      {
        error: "provider usage not ready",
        message: `${pid} 用量拉取尚未就绪，请使用 CSV 导入或稍后再试`,
      },
      { status: 501 }
    );
  }
  if (dispatched.ok === false) {
    return NextResponse.json(
      { error: dispatched.message || "用量拉取失败" },
      { status: 422 }
    );
  }

  const result = dispatched.result;
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 422 });
  }

  if (result.mode === "unsupported" || result.rows.length === 0) {
    return NextResponse.json({
      ok: true,
      provider: pid,
      mode: result.mode,
      rows: 0,
      month: null,
      months: [],
      models: 0,
      note: result.note ?? "暂无可入库的用量数据",
      currency: result.currency,
    });
  }

  const byMonth = groupPullRowsByMonth(result.rows);
  const months = [...byMonth.keys()].sort();
  const month = latestMonth(months);
  if (!month) {
    return NextResponse.json({
      ok: true,
      provider: pid,
      mode: result.mode,
      rows: 0,
      month: null,
      months: [],
      models: 0,
      note: result.note ?? "用量行日期无法归月",
      currency: result.currency,
    });
  }

  let rowCount = 0;
  const modelSet = new Set<string>();
  await db.$transaction(async (tx) => {
    for (const m of months) {
      const rows = byMonth.get(m) ?? [];
      rowCount += rows.length;
      for (const r of rows) modelSet.add(r.model);
      await upsertUsageImport(tx, userId, pid, m, PULL_FILE_NAME, rows, result.currency);
    }
  });
  const modelCount = modelSet.size;

  return NextResponse.json({
    ok: true,
    provider: pid,
    mode: result.mode,
    rows: rowCount,
    month,
    months,
    models: modelCount,
    note: result.note,
    currency: result.currency,
  });
}
