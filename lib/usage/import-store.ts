/**
 * 幂等入库（v2：按平台；幂等键 [userId, provider, month]）。
 * 同月同平台重复上传：update 分支「删除旧行 + 重建」，保证覆盖而非翻倍（AC4-2）；
 * 任何一步抛错都由调用方的事务整体回滚（AC4-3：解析失败根本不会走到这里）。
 * currency 语义：create 分支按入参落值；update 分支仅在入参非 null（本次带 cost 文件）
 * 时覆盖，入参为 null（本次只传 amount）时保留旧值。
 */
import type { Prisma } from "@prisma/client";
import type { ProviderId } from "@/lib/providers/types";
import { toMoney } from "@/lib/money";
import type { ParsedUsageRow } from "./csv-parse";

function toCreateData(provider: ProviderId, rows: ParsedUsageRow[]): Prisma.ModelUsageCreateWithoutImportInput[] {
  return rows.map((r) => ({
    provider,
    model: r.model,
    apiKeyRef: r.apiKeyRef,
    type: r.type,
    unitPrice: r.unitPrice !== null ? toMoney(r.unitPrice) : null,
    amount: r.amount,
    cost: toMoney(r.cost),
  }));
}

export interface UpsertUsageImportResult {
  importId: string;
  rowCount: number;
}

export async function upsertUsageImport(
  tx: Prisma.TransactionClient,
  userId: string,
  provider: ProviderId,
  month: string,
  fileName: string,
  rows: ParsedUsageRow[],
  currency: string | null = null
): Promise<UpsertUsageImportResult> {
  const importedAt = new Date();
  const imp = await tx.usageImport.upsert({
    where: { userId_provider_month: { userId, provider, month } },
    create: {
      userId,
      provider,
      month,
      fileName,
      importedAt,
      currency,
      rows: { create: toCreateData(provider, rows) },
    },
    update: {
      fileName,
      importedAt,
      ...(currency !== null ? { currency } : {}),
      rows: { deleteMany: {}, create: toCreateData(provider, rows) },
    },
  });
  return { importId: imp.id, rowCount: rows.length };
}
