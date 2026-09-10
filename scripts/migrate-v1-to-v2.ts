/**
 * v1 → v2 迁移执行脚本（DEV-GUIDE 规格卡 D）。
 *
 * 用法（在 deepbalance/ 目录，DATABASE_URL 指向目标库——生产执行前必须先人工备份）：
 *   npx tsx scripts/migrate-v1-to-v2.ts                  # 备份旧表 → 事务内搬数+对账 → 报告
 *   npx tsx scripts/migrate-v1-to-v2.ts --drop-legacy     # 迁移对账通过后，稳定一个版本周期，删旧表
 *   npx tsx scripts/migrate-v1-to-v2.ts --backup-only     # 只做备份
 *
 * 安全纪律：
 * - 迁移前强制备份（--backup-only 或默认流程第一步）；备份文件写入 --backup-dir（默认 .backups，已 gitignore 逻辑由调用方保证）；
 * - 对账（行数相等、金额合计误差为 0）不通过即中止并输出差异明细；
 * - 日志只记录行数与结论，绝无凭证明文/密文。
 */
import { db } from "../lib/db";
import {
  backupLegacyTables,
  dropLegacyTables,
  migrateLegacyData,
} from "../lib/migration/migrate-v1-to-v2";

const args = process.argv.slice(2);
const backupDir = args.find((a) => a.startsWith("--backup-dir="))?.split("=")[1] ?? ".backups";
const backupOnly = args.includes("--backup-only");
const dropLegacy = args.includes("--drop-legacy");

async function main(): Promise<void> {
  console.log(`[migrate] 目标库 host=${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(未配置)"}`);

  // 1) 强制备份
  const { file, backup } = await backupLegacyTables(db, backupDir);
  console.log(
    `[migrate] 备份完成 → ${file}（apiKeys=${backup.apiKeys.length} snapshots=${backup.snapshots.length}）`
  );
  if (backupOnly) {
    console.log("[migrate] --backup-only：仅备份，不搬数");
    await db.$disconnect();
    return;
  }

  // 2) 事务内搬数 + 对账
  try {
    const report = await db.$transaction(async (tx) => migrateLegacyData(tx));
    console.log(
      `[migrate] 迁移完成 migrated=${JSON.stringify(report.migrated)} reconciliation=${JSON.stringify(report.reconciliation)}`
    );
    if (dropLegacy) {
      await dropLegacyTables(db);
      console.log("[migrate] 旧表已删除（ApiKeyLegacy / BalanceSnapshotLegacy）");
    }
  } catch (err) {
    console.error(`[migrate] 迁移失败（事务已回滚，可恢复备份）：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main();
