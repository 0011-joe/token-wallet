/**
 * GET/POST /api/budgets —— 预算列表与创建。
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { validateBudgetInput } from "@/lib/billing/budget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().min(1),
  period: z.enum(["day", "month", "custom"]).default("month"),
  scope: z.enum(["global", "provider", "modelPattern"]).default("global"),
  provider: z.string().nullish(),
  modelPattern: z.string().nullish(),
  windowStart: z.string().nullish(),
  windowEnd: z.string().nullish(),
  warnPct: z.number().int().default(80),
  criticalPct: z.number().int().default(100),
  runwayAlertDays: z.number().int().nullish(),
});

function toView(b: {
  id: string;
  amount: unknown;
  currency: string;
  period: string;
  scope: string;
  provider: string | null;
  modelPattern: string | null;
  warnPct: number;
  criticalPct: number;
  runwayAlertDays: number | null;
  isActive: boolean;
}) {
  return {
    id: b.id,
    amount: String(b.amount),
    currency: b.currency,
    period: b.period,
    scope: b.scope,
    provider: b.provider,
    modelPattern: b.modelPattern,
    warnPct: b.warnPct,
    criticalPct: b.criticalPct,
    runwayAlertDays: b.runwayAlertDays,
    isActive: b.isActive,
  };
}

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const rows = await db.budget.findMany({
    where: { userId: user.id, isActive: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ budgets: rows.map(toView) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数无效" },
      { status: 400 }
    );
  }
  const err = validateBudgetInput(parsed.data);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const created = await db.budget.create({
    data: {
      userId: user.id,
      amount: parsed.data.amount,
      currency: parsed.data.currency.toUpperCase(),
      period: parsed.data.period,
      scope: parsed.data.scope,
      provider: parsed.data.provider ?? null,
      modelPattern: parsed.data.modelPattern ?? null,
      windowStart: parsed.data.windowStart
        ? new Date(parsed.data.windowStart)
        : null,
      windowEnd: parsed.data.windowEnd ? new Date(parsed.data.windowEnd) : null,
      warnPct: parsed.data.warnPct,
      criticalPct: parsed.data.criticalPct,
      runwayAlertDays: parsed.data.runwayAlertDays ?? 3,
    },
  });
  return NextResponse.json({ budget: toView(created) }, { status: 201 });
}
