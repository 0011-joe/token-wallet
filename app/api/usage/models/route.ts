/**
 * M5 / T5.3 后端：GET /api/usage/models?month=YYYY-MM —— 分模型聚合查询。
 *
 * - 鉴权；month 缺失或非法 → 400
 * - 该用户该月未导入 → { month, models: [], totalCost: 0, totalTokens: 0, currency: null }
 *   （空态引导由前端负责，AC4-4）
 * - 有数据：按 model 聚合，totalCost 降序；sharePct = 模型 cost / 全月 cost × 100（2 位小数）
 * - byType：按 type × 单价保留原始行（同 type 多档价格 → 多行），同档合并 amount/cost
 * - currency：来自 UsageImport.currency（cost 文件解析入库，CNY | USD 等）；
 *   未导入 / 未带 cost 文件时为 null（前端显示「币种未接入」小字）
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { USAGE_TYPES, type UsageType } from "@/lib/usage/csv-parse";
import { requireUserId } from "@/lib/usage/require-user";

const MONTH_RE = /^\d{4}-\d{2}$/;

/** type 的规范展示顺序（决定 byType 输出顺序） */
const TYPE_ORDER = USAGE_TYPES;

interface ModelAgg {
  model: string;
  /** 三种 token type 的 amount 合计 */
  tokens: number;
  /** request_count 的 amount 合计 */
  requests: number;
  cost: number;
  /** 分组键 = type + "::" + 单价；同键合并且单价相同 → 保留一档 */
  byType: Map<string, { type: UsageType; unitPrice: number | null; amount: number; cost: number }>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  const userId = await requireUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH_RE.test(month)) {
    return NextResponse.json(
      { error: "缺少或非法 month 参数（格式 YYYY-MM）" },
      { status: 400 }
    );
  }

  const imp = await db.usageImport.findUnique({
    where: { userId_month: { userId, month } },
    include: { rows: true },
  });

  // AC4-4：未导入 → 空数组，引导由前端负责
  if (!imp) {
    return NextResponse.json({
      month,
      models: [],
      totalCost: 0,
      totalTokens: 0,
      currency: null,
    });
  }

  const aggs = new Map<string, ModelAgg>();
  for (const row of imp.rows) {
    let agg = aggs.get(row.model);
    if (!agg) {
      agg = {
        model: row.model,
        tokens: 0,
        requests: 0,
        cost: 0,
        byType: new Map(),
      };
      aggs.set(row.model, agg);
    }
    agg.cost += row.cost;
    if (row.type === "request_count") {
      agg.requests += row.amount;
    } else {
      agg.tokens += row.amount;
    }
    const key = `${row.type}::${row.unitPrice ?? ""}`;
    const entry = agg.byType.get(key);
    if (entry) {
      entry.amount += row.amount;
      entry.cost += row.cost;
    } else {
      agg.byType.set(key, {
        type: row.type as UsageType,
        unitPrice: row.unitPrice,
        amount: row.amount,
        cost: row.cost,
      });
    }
  }

  const totalCost = [...aggs.values()].reduce((s, a) => s + a.cost, 0);

  const models = [...aggs.values()]
    .map((a) => {
      // 只有 request_count 的模型，totalTokens 退化为请求次数
      const totalTokens = a.tokens > 0 ? a.tokens : a.requests;
      const byType = [...a.byType.values()]
        .sort(
          (x, y) =>
            TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) ||
            (x.unitPrice ?? -1) - (y.unitPrice ?? -1)
        )
        .map((e) => ({ type: e.type, amount: e.amount, cost: e.cost }));
      return {
        model: a.model,
        totalTokens,
        totalCost: a.cost,
        sharePct: totalCost > 0 ? round2((a.cost / totalCost) * 100) : 0,
        byType,
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost || a.model.localeCompare(b.model));

  return NextResponse.json({
    month,
    models,
    totalCost,
    totalTokens: models.reduce((s, m) => s + m.totalTokens, 0),
    currency: imp.currency, // cost 文件入库的币种；未带 cost 文件为 null
  });
}
