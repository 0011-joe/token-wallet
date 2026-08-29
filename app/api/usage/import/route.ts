/**
 * M5 / T5.2 POST /api/usage/import —— CSV 上传 + 幂等入库（规格卡 D）。
 *
 * - multipart/form-data，字段名 file（amount CSV，必需）；可选字段 costFile（官方 cost CSV）
 * - 文件上限 10MB（amount / cost 各自校验）
 * - 解析失败 422（返回 CsvParseError 的可读 message），不写任何数据（AC4-3）
 * - 带 costFile 时：文件名需含 cost，解析出币种并校验与 amount 同月（不一致 422）；
 *   currency 随 amount 一起入库，同月重传覆盖（update 仅当带 costFile 时覆盖币种，
 *   不带则保留旧值，见 lib/usage/import-store.ts）
 * - 同月重传：事务内 upsert 覆盖，不翻倍（AC4-2）
 * - 成功 200：{ month, rows, models }
 * 安全：文件内容不回显；文件名只存 basename（防路径信息入库）。
 */
import path from "node:path";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { CsvParseError, parseCostCsv, parseUsageCsv, type ParsedCost } from "@/lib/usage/csv-parse";
import { upsertUsageImport } from "@/lib/usage/import-store";
import { requireUserId } from "@/lib/usage/require-user";

/** 10MB 上限（AC4：文件过大有大小限制与提示） */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  const userId = await requireUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { error: "请求格式错误：请以 multipart/form-data 上传文件" },
      { status: 400 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "表单解析失败" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少文件字段 file" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "文件超过 10MB 上限，请按月份分批导出后上传" },
      { status: 400 }
    );
  }

  // 可选：cost 文件（官方导出包内的 cost-*.csv），字段名 costFile
  const costEntry = form.get("costFile");
  let costFile: File | null = null;
  if (costEntry !== null) {
    if (!(costEntry instanceof File)) {
      return NextResponse.json(
        { error: "字段 costFile 必须是文件" },
        { status: 400 }
      );
    }
    if (costEntry.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "cost 文件超过 10MB 上限，请按月份分批导出后上传" },
        { status: 400 }
      );
    }
    if (!path.basename(costEntry.name).toLowerCase().includes("cost")) {
      return NextResponse.json(
        { error: "costFile 不是 cost CSV（文件名需包含 cost）" },
        { status: 400 }
      );
    }
    costFile = costEntry;
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    return NextResponse.json({ error: "文件读取失败" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseUsageCsv(text);
  } catch (err) {
    if (err instanceof CsvParseError) {
      // AC4-3：提示具体错误且不写入任何数据
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  let cost: ParsedCost | null = null;
  if (costFile) {
    let costText: string;
    try {
      costText = await costFile.text();
    } catch {
      return NextResponse.json({ error: "cost 文件读取失败" }, { status: 400 });
    }
    try {
      cost = parseCostCsv(costText);
    } catch (err) {
      if (err instanceof CsvParseError) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
      throw err;
    }
    if (cost.month !== parsed.month) {
      return NextResponse.json(
        { error: "amount 与 cost 月份不一致（请按同一月份分别导出后上传）" },
        { status: 422 }
      );
    }
  }

  // 文件名仅存 basename；空文件名兜底
  const fileName = path.basename(file.name) || "usage.csv";

  try {
    const result = await db.$transaction((tx) =>
      upsertUsageImport(
        tx,
        userId,
        parsed.month,
        fileName,
        parsed.rows,
        cost?.currency ?? null
      )
    );
    const modelCount = new Set(parsed.rows.map((r) => r.model)).size;
    return NextResponse.json({
      month: parsed.month,
      rows: result.rowCount,
      models: modelCount,
    });
  } catch (err) {
    console.error("[api/usage/import] 入库失败", err);
    return NextResponse.json(
      { error: "数据入库失败，请稍后重试" },
      { status: 500 }
    );
  }
}
