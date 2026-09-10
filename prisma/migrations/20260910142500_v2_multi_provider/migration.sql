-- token-wallet v2 破坏性升级迁移（DEV-GUIDE §7 / PRD §8.3，决策 D3 保留历史）
-- 旧表不删除：ApiKey / 旧 BalanceSnapshot 改名为 *Legacy，
-- 数据搬移由 scripts/migrate-v1-to-v2.ts 负责（先备份、后搬数、再对账）。

-- 1) 枚举
CREATE TYPE "Provider" AS ENUM ('deepseek', 'kimi', 'volcengine');
CREATE TYPE "CredentialKind" AS ENUM ('bearer', 'aksk');
CREATE TYPE "BalanceMode" AS ENUM ('native', 'derived', 'manual');

-- 2) 旧表改名保留（先改名再建同名新表）
ALTER TABLE "ApiKey" RENAME TO "ApiKeyLegacy";
ALTER TABLE "BalanceSnapshot" RENAME TO "BalanceSnapshotLegacy";
-- 旧表约束/索引同步改名：释放 "ApiKey_*" / "BalanceSnapshot_*" 命名空间，
-- 否则新建同名表时 PK/索引名冲突（42P07）
ALTER TABLE "ApiKeyLegacy" RENAME CONSTRAINT "ApiKey_pkey" TO "ApiKeyLegacy_pkey";
ALTER TABLE "BalanceSnapshotLegacy" RENAME CONSTRAINT "BalanceSnapshot_pkey" TO "BalanceSnapshotLegacy_pkey";
ALTER TABLE "ApiKeyLegacy" RENAME CONSTRAINT "ApiKey_userId_fkey" TO "ApiKeyLegacy_userId_fkey";
ALTER TABLE "BalanceSnapshotLegacy" RENAME CONSTRAINT "BalanceSnapshot_apiKeyId_fkey" TO "BalanceSnapshotLegacy_apiKeyId_fkey";
ALTER INDEX "ApiKey_userId_last4_key" RENAME TO "ApiKeyLegacy_userId_last4_key";
ALTER INDEX "BalanceSnapshot_apiKeyId_fetchedAt_idx" RENAME TO "BalanceSnapshotLegacy_apiKeyId_fetchedAt_idx";

-- 3) 新表：Credential（v1 ApiKey 泛化）
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "region" TEXT,
    "label" TEXT NOT NULL,
    "secretCipher" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "hint" TEXT NOT NULL,
    "meta" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastStatus" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- 4) 新表：BalanceSnapshot（归一化：available Decimal + breakdown/raw/stale）
CREATE TABLE "BalanceSnapshot" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "mode" "BalanceMode" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "available" DECIMAL(18,9) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "raw" JSONB,
    "isAvailable" BOOLEAN NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- 5) 新表：AlertOverride（全局默认 + 平台/凭证覆盖，FR-5）
CREATE TABLE "AlertOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "Provider",
    "credentialId" TEXT,
    "lowBalanceThreshold" DECIMAL(18,9),
    "failThresholdN" INTEGER,
    "emailEnabled" BOOLEAN,
    "inappEnabled" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertOverride_pkey" PRIMARY KEY ("id")
);

-- 6) UsageImport：加 provider（存量回填 deepseek），幂等键升级 [userId, provider, month]
ALTER TABLE "UsageImport" ADD COLUMN "provider" "Provider" NOT NULL DEFAULT 'deepseek';
ALTER TABLE "UsageImport" ALTER COLUMN "provider" DROP DEFAULT;
DROP INDEX "UsageImport_userId_month_key";
CREATE UNIQUE INDEX "UsageImport_userId_provider_month_key" ON "UsageImport"("userId", "provider", "month");

-- 7) ModelUsage：加 provider 冗余 + 金额列 Float → Decimal(18,6)
ALTER TABLE "ModelUsage" ADD COLUMN "provider" "Provider" NOT NULL DEFAULT 'deepseek';
ALTER TABLE "ModelUsage" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "ModelUsage" ALTER COLUMN "unitPrice" TYPE DECIMAL(18,9);
ALTER TABLE "ModelUsage" ALTER COLUMN "cost" TYPE DECIMAL(18,9);

-- 8) AlertSetting：阈值列 Float → Decimal(18,6)
ALTER TABLE "AlertSetting" ALTER COLUMN "lowBalanceThreshold" TYPE DECIMAL(18,9);

-- 9) AlertEvent：加 provider、apiKeyId → credentialId（可空）、弃用 [dedupKey, createdAt] 复合唯一
ALTER TABLE "AlertEvent" ADD COLUMN "provider" "Provider" NOT NULL DEFAULT 'deepseek';
ALTER TABLE "AlertEvent" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "AlertEvent" RENAME COLUMN "apiKeyId" TO "credentialId";
ALTER TABLE "AlertEvent" ALTER COLUMN "credentialId" DROP NOT NULL;
DROP INDEX "AlertEvent_dedupKey_createdAt_key";
CREATE INDEX "AlertEvent_userId_createdAt_idx" ON "AlertEvent"("userId", "createdAt");

-- 10) 新表索引
CREATE UNIQUE INDEX "Credential_userId_provider_hint_key" ON "Credential"("userId", "provider", "hint");
CREATE INDEX "BalanceSnapshot_credentialId_provider_fetchedAt_idx" ON "BalanceSnapshot"("credentialId", "provider", "fetchedAt");
CREATE INDEX "BalanceSnapshot_provider_fetchedAt_idx" ON "BalanceSnapshot"("provider", "fetchedAt");
CREATE UNIQUE INDEX "AlertOverride_userId_provider_credentialId_key" ON "AlertOverride"("userId", "provider", "credentialId");

-- 11) 外键
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertOverride" ADD CONSTRAINT "AlertOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
