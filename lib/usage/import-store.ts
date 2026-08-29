/**
 * M5 / T5.2 幂等入库（规格卡 D 后半）：数据层纯函数，route 薄调用，便于单测。
 *
 * 幂等键 = (userId, month) 唯一约束（prisma/schema.prisma @@unique([userId, month])）。
 * 同月重复上传：update 分支「删除旧行 + 重建」，保证覆盖而非翻倍（AC4-2）；
 * 任何一步抛错都由调用方的事务整体回滚（AC4-3：解析失败根本不会走到这里）。
 * currency 语义（Q4 决策）：create 分支按入参落值；update 分支仅在入参非 null
 * （本次带 cost 文件）时覆盖，入参为 null（本次只传 amount）时保留旧值——
 * 避免「先传 cost 后只传 amount」的重新导入把已有币种抹掉。
 */
import type { Prisma } from "@prisma/client";
import type { ParsedUsageRow } from "./csv-parse";

/** upsert 写入用的行字段（importId 由关系嵌套自动补上） */
function toCreateData(rows: ParsedUsageRow[]): Prisma.ModelUsageCreateWithoutImportInput[] {
  return rows.map((r) => ({
    model: r.model,
    apiKeyRef: r.apiKeyRef,
    type: r.type,
    unitPrice: r.unitPrice,
    amount: r.amount,
    cost: r.cost,
  }));
}

export interface UpsertUsageImportResult {
  /** (userId, month) 对应的 UsageImport.id（重复导入命中同一行） */
  importId: string;
  /** 本次写入的明细行数 */
  rowCount: number;
}

/**
 * 在同一事务里按 (userId, month) upsert：
 * - create 分支：新建 Import + 嵌套创建全部行；
 * - update 分支（同月重传）：覆盖 fileName / importedAt，deleteMany 旧行后重建，
 *   行数不会翻倍。
 * 调用方负责 db.$transaction(...) 包裹。
 */
export async function upsertUsageImport(
  tx: Prisma.TransactionClient,
  userId: string,
  month: string,
  fileName: string,
  rows: ParsedUsageRow[],
  /** 来自 cost 文件的币种（CNY | USD 等）；null=本次未提供 cost 文件 */
  currency: string | null = null
): Promise<UpsertUsageImportResult> {
  const importedAt = new Date();
  const imp = await tx.usageImport.upsert({
    where: { userId_month: { userId, month } },
    create: {
      userId,
      month,
      fileName,
      importedAt,
      currency,
      rows: { create: toCreateData(rows) },
    },
    update: {
      fileName,
      importedAt,
      // 见文件头注释：currency=null（不带 cost 文件）时不动币种，保留旧值
      ...(currency !== null ? { currency } : {}),
      rows: { deleteMany: {}, create: toCreateData(rows) },
    },
  });
  return { importId: imp.id, rowCount: rows.length };
}
