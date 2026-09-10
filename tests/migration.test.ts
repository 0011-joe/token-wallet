/**
 * T0.4 迁移演练测试（DEV-GUIDE 规格卡 D）：在测试库上对 *Legacy 表造数据，
 * 验证 备份 → 事务内搬数+对账 → 失败回滚 → 删旧表 全链路。
 * 断言：行数相等、金额合计误差为 0（按币种）、AlertEvent 重映射、密文原样搬运。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../lib/db";
import { toMoney } from "../lib/money";
import {
  backupLegacyTables,
  dropLegacyTables,
  migrateLegacyData,
} from "../lib/migration/migrate-v1-to-v2";

// 无 DATABASE_URL 时显式跳过（开源 fork 未配置 DB secret 的 CI 场景）；本地/配置后全跑
const describeDb = describe.skipIf(!process.env.DATABASE_URL);

const RUN = `mig-${Date.now()}`;
/** 固定 USER_ID：跨运行清理同一批测试数据（避免上一轮失败残留干扰） */
const USER_ID = "migration-test-user";
const KEY_A = `${RUN}-key-a`;
const KEY_B = `${RUN}-key-b`;

/** 往 Legacy 表灌测试数据（旧 schema 结构） */
async function seedLegacy(opts: { badSnapshotRef?: boolean } = {}) {
  await db.$executeRawUnsafe(
    `INSERT INTO "ApiKeyLegacy" (id, "userId", label, ciphertext, iv, "authTag", last4, "isActive", "failCount", "lastStatus", "createdAt")
     VALUES ($1, $2, '测试KeyA', $3, $3, $3, 'd8d7', true, 0, NULL, '2026-08-01T00:00:00Z')`,
    KEY_A,
    USER_ID,
    Buffer.from("cipher-a")
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "ApiKeyLegacy" (id, "userId", label, ciphertext, iv, "authTag", last4, "isActive", "failCount", "lastStatus", "createdAt")
     VALUES ($1, $2, '测试KeyB', $3, $3, $3, 'a1b2', true, 0, NULL, '2026-08-01T01:00:00Z')`,
    KEY_B,
    USER_ID,
    Buffer.from("cipher-b")
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "BalanceSnapshotLegacy" (id, "apiKeyId", "fetchedAt", currency, "totalBalance", "grantedBalance", "toppedUpBalance", "isAvailable", ok)
     VALUES ($1, $2, '2026-08-01T02:00:00Z', 'CNY', 100.5, 0, 100.5, true, true)`,
    `${RUN}-snap-1`,
    KEY_A
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "BalanceSnapshotLegacy" (id, "apiKeyId", "fetchedAt", currency, "totalBalance", "grantedBalance", "toppedUpBalance", "isAvailable", ok)
     VALUES ($1, $2, '2026-08-01T03:00:00Z', 'CNY', 90.25, 0, 90.25, true, true)`,
    `${RUN}-snap-2`,
    KEY_A
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "BalanceSnapshotLegacy" (id, "apiKeyId", "fetchedAt", currency, "totalBalance", "grantedBalance", "toppedUpBalance", "isAvailable", ok)
     VALUES ($1, $2, '2026-08-01T04:00:00Z', 'USD', 10.1234567891, 0, 10.1234567891, true, true)`,
    `${RUN}-snap-3`,
    KEY_B
  );
  if (opts.badSnapshotRef) {
    await db.$executeRawUnsafe(
      `INSERT INTO "BalanceSnapshotLegacy" (id, "apiKeyId", "fetchedAt", currency, "totalBalance", "grantedBalance", "toppedUpBalance", "isAvailable", ok)
       VALUES ($1, $2, '2026-08-01T05:00:00Z', 'CNY', 1, 0, 1, true, true)`,
      `${RUN}-snap-bad`,
      "no-such-key"
    );
  }
  // 造一条引用旧 key id 的预警事件（验证重映射）
  await db.alertEvent.create({
    data: {
      userId: USER_ID,
      provider: "deepseek",
      credentialId: KEY_A,
      type: "LOW_BALANCE",
      message: "迁移测试事件",
      dedupKey: `${RUN}-dedup`,
    },
  });
}

const CLEAN_USER_SQL = `"userId" LIKE 'mig-%' OR "userId" = 'migration-test-user'`;

async function cleanAll() {
  // 覆盖本轮与历史所有测试前缀（上一轮失败残留也要清掉）
  await db.$executeRawUnsafe(`DELETE FROM "AlertEvent" WHERE ${CLEAN_USER_SQL}`);
  await db.$executeRawUnsafe(`DELETE FROM "UsageImport" WHERE ${CLEAN_USER_SQL}`);
  // Credential 删除级联清理 BalanceSnapshot（FK ON DELETE CASCADE）
  await db.$executeRawUnsafe(`DELETE FROM "Credential" WHERE ${CLEAN_USER_SQL}`);
  // Legacy 表可能已被 dropLegacyTables 删除：容错清理
  for (const sql of [
    `DELETE FROM "ApiKeyLegacy" WHERE ${CLEAN_USER_SQL}`,
    `DELETE FROM "BalanceSnapshotLegacy" WHERE id LIKE 'mig-%'`,
  ]) {
    await db.$executeRawUnsafe(sql).catch(() => {});
  }
  await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE 'mig-%' OR id = 'migration-test-user'`);
}

beforeAll(async () => {
  // 上一次运行可能已 drop Legacy 表：幂等重建（v1 结构），保证测试可重复执行
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ApiKeyLegacy" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "label" TEXT NOT NULL,
      "ciphertext" BYTEA NOT NULL, "iv" BYTEA NOT NULL, "authTag" BYTEA NOT NULL,
      "last4" TEXT NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true,
      "failCount" INTEGER NOT NULL DEFAULT 0, "lastStatus" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ApiKeyLegacy_pkey" PRIMARY KEY ("id")
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BalanceSnapshotLegacy" (
      "id" TEXT NOT NULL, "apiKeyId" TEXT NOT NULL, "fetchedAt" TIMESTAMP(3) NOT NULL,
      "currency" TEXT NOT NULL, "totalBalance" DOUBLE PRECISION NOT NULL,
      "grantedBalance" DOUBLE PRECISION NOT NULL, "toppedUpBalance" DOUBLE PRECISION NOT NULL,
      "isAvailable" BOOLEAN NOT NULL, "ok" BOOLEAN NOT NULL DEFAULT true,
      CONSTRAINT "BalanceSnapshotLegacy_pkey" PRIMARY KEY ("id")
    )
  `);
  await db.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: `${RUN}@migration.test` },
    update: {},
  });
});

beforeEach(async () => {
  await cleanAll();
  // Credential.userId 有 FK 到 User：每次清空后重建测试用户
  await db.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: `${USER_ID}@migration.test` },
    update: {},
  });
});

afterAll(async () => {
  await cleanAll();
  await db.$disconnect();
});

describeDb("backupLegacyTables（迁移前强制备份）", () => {
  it("导出旧表全部数据到 JSON 文件（含密文 base64），文件可读", async () => {
    await seedLegacy();
    const dir = mkdtempSync(path.join(tmpdir(), "mig-backup-"));
    try {
      const { file, backup } = await backupLegacyTables(db, dir);
      expect(file.endsWith(".json")).toBe(true);
      expect(backup.apiKeys).toHaveLength(2);
      expect(backup.snapshots).toHaveLength(3);
      expect(backup.apiKeys[0].ciphertext).toBe(Buffer.from("cipher-a").toString("base64"));
      expect(backup.snapshots[2].totalBalance).toBe(10.1234567891);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeDb("migrateLegacyData（搬数 + 对账误差 0）", () => {
  it("行数相等、按币种金额合计误差为 0、密文原样搬运、AlertEvent 重映射", async () => {
    await seedLegacy();
    const report = await db.$transaction(async (tx) => migrateLegacyData(tx));

    expect(report.migrated.credentials).toBe(2);
    expect(report.migrated.snapshots).toBe(3);
    expect(report.migrated.alertEventsRemapped).toBe(1);
    expect(report.reconciliation.rowsEqual).toBe(true);
    expect(report.reconciliation.credentialsEqual).toBe(true);
    expect(report.reconciliation.snapshotsEqual).toBe(true);
    expect(report.reconciliation.amountDiffZero).toBe(true);
    expect(report.reconciliation.usageProviderAllDeepseek).toBe(true);

    const creds = await db.credential.findMany({ where: { userId: USER_ID }, orderBy: { createdAt: "asc" } });
    expect(creds).toHaveLength(2);
    expect(creds[0].provider).toBe("deepseek");
    expect(creds[0].kind).toBe("bearer");
    expect(creds[0].hint).toBe("d8d7");
    expect(creds[0].keyVersion).toBe(1);
    expect(creds[0].region).toBeNull();
    expect(Buffer.from(creds[0].secretCipher).toString()).toBe("cipher-a");

    const snaps = await db.balanceSnapshot.findMany({
      where: { credentialId: { in: creds.map((c) => c.id) } },
      orderBy: { fetchedAt: "asc" },
    });
    expect(snaps).toHaveLength(3);
    expect(toMoney(snaps[0].available)).toBe("100.500000000");
    expect(toMoney(snaps[2].available)).toBe("10.123456789"); // 9 位四舍五入
    expect(snaps[2].currency).toBe("USD");
    expect(snaps[0].breakdown).toEqual({ granted: "0.000000000", toppedUp: "100.500000000" });

    const evt = await db.alertEvent.findFirst({ where: { userId: USER_ID } });
    expect(evt?.credentialId).toBe(creds[0].id);
  });

  it("快照引用不存在的 Key → 抛错（调用方事务回滚，Credential 不残留）", async () => {
    await seedLegacy({ badSnapshotRef: true });
    await expect(db.$transaction(async (tx) => migrateLegacyData(tx))).rejects.toThrow(/对应 Credential/);
    const count = await db.credential.count({ where: { userId: USER_ID } });
    expect(count).toBe(0);
  });
});

describeDb("dropLegacyTables（稳定后删旧表）", () => {
  it("迁移对账通过后可删除旧表；再次删除幂等", async () => {
    await seedLegacy();
    await db.$transaction(async (tx) => migrateLegacyData(tx));
    await dropLegacyTables(db);
    await expect(
      db.$queryRawUnsafe(`SELECT COUNT(*) FROM "ApiKeyLegacy"`)
    ).rejects.toThrow();
    await dropLegacyTables(db); // 幂等
  });
});
