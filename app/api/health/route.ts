/**
 * 数据源健康自检端点（NFR 7.3 / T5.4）：结构化脱敏。
 *
 * P0 鉴权：需携带 CRON_SECRET（或 AUTH_SECRET 兜底）——
 *   Authorization: Bearer <secret>  或  x-health-secret: <secret>
 * 两者均未配置时：开发态（NODE_ENV !== "production"）放行，生产 503（不静默暴露统计）。
 *
 * GET /api/health → { ok, database, generatedAt, providers: { [provider]: {
 *   credentialCount, okCount, failedCount, staleCount, lastSuccessAt, lastStatuses } } }
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { STALE_AFTER_MS } from "@/lib/dashboard/overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FAILURE_STATUSES = new Set(["INVALID", "FORBIDDEN_SCOPE", "RATE_LIMITED", "ERROR"]);

function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorizeHealth(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!expected) {
    if (process.env.NODE_ENV !== "production") return null;
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET/AUTH_SECRET 未配置：健康检查端点在生产环境拒绝匿名访问" },
      { status: 503 }
    );
  }
  const provided =
    request.headers.get("x-health-secret") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json(
      { ok: false, error: "鉴权失败：需要 CRON_SECRET（Authorization: Bearer 或 x-health-secret）" },
      { status: 401 }
    );
  }
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = authorizeHealth(request);
  if (denied) return denied;

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
