/**
 * 数据源健康自检端点（NFR 7.3 / T5.4）：结构化脱敏，无鉴权（不含任何凭证信息）。
 *
 * GET /api/health → { ok, database, generatedAt, providers: { [provider]: {
 *   credentialCount, okCount, failedCount, staleCount, lastSuccessAt, lastStatuses } } }
 */
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { STALE_AFTER_MS } from "@/lib/dashboard/overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FAILURE_STATUSES = new Set(["INVALID", "FORBIDDEN_SCOPE", "RATE_LIMITED", "ERROR"]);

export async function GET(): Promise<NextResponse> {
  const now = new Date();
  const nowMs = now.getTime();

  let database: "ok" | "error" = "ok";
  let credentials: Array<{
    provider: string;
    lastStatus: string | null;
    failCount: number;
    lastSuccessAt: Date | null;
  }> = [];

  try {
    credentials = await db.credential.findMany({
      where: { isActive: true },
      select: {
        provider: true,
        lastStatus: true,
        failCount: true,
        lastSuccessAt: true,
      },
    });
  } catch {
    database = "error";
  }

  const providers: Record<string, {
    credentialCount: number;
    okCount: number;
    failedCount: number;
    staleCount: number;
    lastSuccessAt: string | null;
    lastStatuses: Record<string, number>;
  }> = {};

  for (const c of credentials) {
    const p = providers[c.provider] ?? {
      credentialCount: 0,
      okCount: 0,
      failedCount: 0,
      staleCount: 0,
      lastSuccessAt: null as string | null,
      lastStatuses: {},
    };
    p.credentialCount += 1;
    const status = c.lastStatus ?? "UNKNOWN";
    p.lastStatuses[status] = (p.lastStatuses[status] ?? 0) + 1;
    if (status === "OK") p.okCount += 1;
    else if (FAILURE_STATUSES.has(status)) p.failedCount += 1;
    if (c.lastSuccessAt) {
      if (nowMs - c.lastSuccessAt.getTime() > STALE_AFTER_MS) p.staleCount += 1;
      const iso = c.lastSuccessAt.toISOString();
      if (p.lastSuccessAt === null || iso > p.lastSuccessAt) p.lastSuccessAt = iso;
    } else {
      p.staleCount += 1;
    }
    providers[c.provider] = p;
  }

  return NextResponse.json(
    {
      ok: database === "ok" && Object.values(providers).every((p) => p.failedCount < p.credentialCount),
      database,
      generatedAt: now.toISOString(),
      providers,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
