/**
 * v1 → v2 数据迁移（DEV-GUIDE 规格卡 D / PRD §8.3，决策 D3 保留历史）。
 *
 * 步骤（脚本侧）：备份 → 搬数 → 对账 →（灰度）→ 删旧表。
 * 任一步失败：恢复备份 + 代码回退 v1 tag（回滚预案）。
 *
 * 本模块提供纯数据函数（注入 PrismaClient，可在演练库单测）：
 * - backupLegacyTables：旧表（*Legacy）数据导出为 JSON 备份文件（清空重来的退路）；
 * - migrateLegacyData：ApiKeyLegacy→Credential、BalanceSnapshotLegacy→BalanceSnapshot、
 *   AlertEvent.credentialId 回填；完成后对账（行数相等、金额合计误差为 0），不通过即抛错
 *   （由调用方事务整体回滚）；
 * - dropLegacyTables：稳定一个版本周期后删除旧表。
 *
 * 金额纪律：Float → Decimal(18,9) 按 9 位四舍五入对齐（toMoney），对账按逐币种合计比对。
 * 密文：直接搬运（v1 裸串密文由 KeyVault 双格式兼容读取，惰性重加密；迁移期无需持有主密钥）。
 * UsageImport/ModelUsage 的 provider 回填已由 migration SQL 的 DEFAULT 'deepseek' 完成。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { toMoney } from "@/lib/money";

// ── 旧表行形状（raw SQL 结果） ──

interface LegacyApiKeyRow {
  id: string;
  userId: string;
  label: string;
  ciphertext: Buffer | Uint8Array | string;
  iv: Buffer | Uint8Array | string;
  authTag: Buffer | Uint8Array | string;
  last4: string;
  isActive: boolean;
  failCount: number;
  lastStatus: string | null;
  createdAt: Date | string;
}

interface LegacySnapshotRow {
  id: string;
  apiKeyId: string;
  fetchedAt: Date | string;
  currency: string;
  totalBalance: number | string;
  grantedBalance: number | string;
  toppedUpBalance: number | string;
  isAvailable: boolean;
  ok: boolean;
}

function toBuffer(v: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string") return Buffer.from(v);
  return Buffer.from(v);
}

function countOf(rows: unknown): number {
  const arr = rows as Array<{ n?: number | string | bigint }>;
  return Number(arr[0]?.n ?? 0);
}

export interface MigrationReport {
  legacyCounts: { apiKeys: number; snapshots: number; alertEvents: number };
  migrated: { credentials: number; snapshots: number; alertEventsRemapped: number };
  reconciliation: {
    rowsEqual: boolean;
    credentialsEqual: boolean;
    snapshotsEqual: boolean;
    amountDiffZero: boolean;
    amountDiffDetails: string[];
    usageProviderAllDeepseek: boolean;
  };
}

export interface LegacyBackup {
  exportedAt: string;
  apiKeys: Array<Omit<LegacyApiKeyRow, "ciphertext" | "iv" | "authTag"> & {
    ciphertext: string;
    iv: string;
    authTag: string;
  }>;
  snapshots: LegacySnapshotRow[];
}

/** 备份：读取旧表数据，写入 JSON 文件（退路）。返回文件路径与备份对象。 */
export async function backupLegacyTables(
  db: Prisma.TransactionClient,
  backupDir: string
): Promise<{ file: string; backup: LegacyBackup }> {
  const apiKeys = (await db.$queryRawUnsafe(
    `SELECT id, "userId", label, ciphertext, iv, "authTag", last4, "isActive", "failCount", "lastStatus", "createdAt" FROM "ApiKeyLegacy"`
  )) as LegacyApiKeyRow[];
  const snapshots = (await db.$queryRawUnsafe(
    `SELECT id, "apiKeyId", "fetchedAt", currency, "totalBalance", "grantedBalance", "toppedUpBalance", "isAvailable", ok FROM "BalanceSnapshotLegacy"`
  )) as LegacySnapshotRow[];

  const backup: LegacyBackup = {
    exportedAt: new Date().toISOString(),
    apiKeys: apiKeys.map((k) => ({
      ...k,
      ciphertext: toBuffer(k.ciphertext).toString("base64"),
      iv: toBuffer(k.iv).toString("base64"),
      authTag: toBuffer(k.authTag).toString("base64"),
    })),
    snapshots,
  };
  mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `v1-backup-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 2), "utf8");
  return { file, backup };
}

/**
 * 搬数 + 对账（调用方用 $transaction 包裹；任一对账失败抛错 → 事务回滚）。
 * 执行前必须已备份（调用方保证）。
 */
export async function migrateLegacyData(db: Prisma.TransactionClient): Promise<MigrationReport> {
  const legacyCounts = {
    apiKeys: countOf(await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "ApiKeyLegacy"`)),
    snapshots: countOf(await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "BalanceSnapshotLegacy"`)),
    alertEvents: countOf(await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AlertEvent"`)),
  };

  // 1) ApiKeyLegacy → Credential（密文直接搬运，keyVersion=1；hint=last4）
  const legacyKeys = (await db.$queryRawUnsafe(
    `SELECT id, "userId", label, ciphertext, iv, "authTag", last4, "isActive", "failCount", "lastStatus", "createdAt" FROM "ApiKeyLegacy" ORDER BY "createdAt" ASC`
  )) as LegacyApiKeyRow[];

  for (const k of legacyKeys) {
    const inserted = await db.$executeRawUnsafe(
      `INSERT INTO "Credential" (id, "userId", provider, kind, region, label, "secretCipher", iv, "authTag", "keyVersion", hint, "isActive", "failCount", "lastStatus", "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'deepseek', 'bearer', NULL, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10)`,
      k.userId,
      k.label,
      toBuffer(k.ciphertext),
      toBuffer(k.iv),
      toBuffer(k.authTag),
      k.last4,
      k.isActive,
      k.failCount,
      k.lastStatus,
      new Date(k.createdAt)
    );
    if (inserted !== 1) throw new Error(`Credential 插入失败: legacy id=${k.id}`);
  }

  // 重建映射 legacyKeyId -> new credential id：按 (userId, hint, createdAt) 对齐
  const newCreds = (await db.$queryRawUnsafe(
    `SELECT id, "userId", hint, "createdAt" FROM "Credential" ORDER BY "createdAt" ASC`
  )) as Array<{ id: string; userId: string; hint: string; createdAt: Date }>;
  const idMap = new Map<string, string>();
  for (const k of legacyKeys) {
    const match = newCreds.find(
      (c) =>
        c.userId === k.userId &&
        c.hint === k.last4 &&
        new Date(c.createdAt).getTime() === new Date(k.createdAt).getTime()
    );
    if (!match) throw new Error(`Credential 对齐失败: legacy id=${k.id}`);
    idMap.set(k.id, match.id);
  }

  // 2) BalanceSnapshotLegacy → BalanceSnapshot（Float → Decimal(18,9) 四舍五入对齐）
  const legacySnapshots = (await db.$queryRawUnsafe(
    `SELECT id, "apiKeyId", "fetchedAt", currency, "totalBalance", "grantedBalance", "toppedUpBalance", "isAvailable", ok FROM "BalanceSnapshotLegacy" ORDER BY "fetchedAt" ASC`
  )) as LegacySnapshotRow[];

  for (const s of legacySnapshots) {
    const newCredId = idMap.get(s.apiKeyId);
    if (!newCredId) throw new Error(`快照引用的 ApiKey 无对应 Credential: apiKeyId=${s.apiKeyId}`);
    const total = toMoney(s.totalBalance);
    const granted = toMoney(s.grantedBalance);
    const toppedUp = toMoney(s.toppedUpBalance);
    const inserted = await db.$executeRawUnsafe(
      `INSERT INTO "BalanceSnapshot" (id, "credentialId", provider, mode, "fetchedAt", currency, available, breakdown, "isAvailable", ok, stale)
       VALUES (gen_random_uuid()::text, $1, 'deepseek', 'native', $2, $3, $4, $5, $6, $7, false)`,
      newCredId,
      new Date(s.fetchedAt),
      s.currency,
      total,
      JSON.stringify({ granted, toppedUp }),
      s.isAvailable,
      s.ok
    );
    if (inserted !== 1) throw new Error(`BalanceSnapshot 插入失败: legacy id=${s.id}`);
  }

  // 3) AlertEvent.credentialId 映射回填（旧 apiKeyId → 新 credential id）
  let alertEventsRemapped = 0;
  const alertEvents = (await db.$queryRawUnsafe(
    `SELECT id, "credentialId" FROM "AlertEvent"`
  )) as Array<{ id: string; credentialId: string | null }>;
  for (const e of alertEvents) {
    if (e.credentialId === null) continue;
    const newCredId = idMap.get(e.credentialId);
    if (newCredId) {
      await db.$executeRawUnsafe(`UPDATE "AlertEvent" SET "credentialId" = $1 WHERE id = $2`, newCredId, e.id);
      alertEventsRemapped += 1;
    }
  }

  // 4) 对账：行数相等、金额合计误差为 0（按币种）、usage provider 全部 deepseek
  const newCredCount = countOf(await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Credential"`));
  const newSnapshotCount = countOf(await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "BalanceSnapshot"`));

  const legacyTotals = (await db.$queryRawUnsafe(
    `SELECT currency, SUM("totalBalance") AS s FROM "BalanceSnapshotLegacy" GROUP BY currency ORDER BY currency`
  )) as Array<{ currency: string; s: number | string }>;
  const newTotals = (await db.$queryRawUnsafe(
    `SELECT currency, SUM(available)::text AS s FROM "BalanceSnapshot" GROUP BY currency ORDER BY currency`
  )) as Array<{ currency: string; s: number | string }>;

  const amountDiffDetails: string[] = [];
  let amountDiffZero = true;
  if (legacyTotals.length !== newTotals.length) {
    amountDiffZero = false;
    amountDiffDetails.push(`币种组数不一致: legacy=${legacyTotals.length} new=${newTotals.length}`);
  } else {
    for (let i = 0; i < legacyTotals.length; i++) {
      const legacy = toMoney(legacyTotals[i].s);
      const next = toMoney(newTotals[i].s);
      if (legacy !== next) {
        amountDiffZero = false;
        amountDiffDetails.push(`${legacyTotals[i].currency}: legacy=${legacy} new=${next}`);
      }
    }
  }

  const usageProviderAllDeepseek =
    countOf(await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "UsageImport" WHERE provider <> 'deepseek'`)) === 0;

  const report: MigrationReport = {
    legacyCounts,
    migrated: { credentials: legacyKeys.length, snapshots: legacySnapshots.length, alertEventsRemapped },
    reconciliation: {
      rowsEqual: newCredCount === legacyKeys.length && newSnapshotCount === legacySnapshots.length,
      credentialsEqual: newCredCount === legacyKeys.length,
      snapshotsEqual: newSnapshotCount === legacySnapshots.length,
      amountDiffZero,
      amountDiffDetails,
      usageProviderAllDeepseek,
    },
  };

  if (!report.reconciliation.rowsEqual || !report.reconciliation.amountDiffZero) {
    throw new Error(
      `迁移对账失败（回滚事务）：rowsEqual=${report.reconciliation.rowsEqual} amountDiffZero=${report.reconciliation.amountDiffZero} ${amountDiffDetails.join("; ")}`
    );
  }
  return report;
}

/** 稳定一个版本周期后：删除旧表（执行前必须已通过迁移对账）。 */
export async function dropLegacyTables(db: Prisma.TransactionClient): Promise<void> {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "BalanceSnapshotLegacy"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "ApiKeyLegacy"`);
}
