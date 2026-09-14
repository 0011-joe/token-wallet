-- CreateEnum
CREATE TYPE "UsageSource" AS ENUM ('csv_official', 'host_measured', 'derived_estimate');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('day', 'month', 'custom');

-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('global', 'provider', 'modelPattern');

-- CreateTable
CREATE TABLE "Price" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "input" DECIMAL(18,9) NOT NULL,
    "output" DECIMAL(18,9) NOT NULL,
    "cacheHit" DECIMAL(18,9),
    "cacheMiss" DECIMAL(18,9),
    "reasoning" DECIMAL(18,9),
    "sourceUrl" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "Price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceWindow" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "weekdayMask" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "tz" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "multiplier" DECIMAL(6,3) NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageDaily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "tz" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "source" "UsageSource" NOT NULL,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheHitTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheMissTokens" BIGINT NOT NULL DEFAULT 0,
    "reasoningTokens" BIGINT NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(18,9),
    "costComplete" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageIngest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "nonce" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadHash" TEXT NOT NULL,
    "batchCount" INTEGER NOT NULL,
    "accepted" INTEGER NOT NULL,
    "rejected" INTEGER NOT NULL,

    CONSTRAINT "UsageIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "BudgetScope" NOT NULL DEFAULT 'global',
    "provider" TEXT,
    "modelPattern" TEXT,
    "period" "BudgetPeriod" NOT NULL DEFAULT 'month',
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "warnPct" INTEGER NOT NULL DEFAULT 80,
    "criticalPct" INTEGER NOT NULL DEFAULT 100,
    "runwayAlertDays" INTEGER DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Price_provider_model_effectiveFrom_currency_key" ON "Price"("provider", "model", "effectiveFrom", "currency");

-- CreateIndex
CREATE INDEX "Price_provider_model_effectiveFrom_idx" ON "Price"("provider", "model", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PriceWindow_provider_effectiveFrom_idx" ON "PriceWindow"("provider", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "UsageDaily_userId_provider_model_date_source_key" ON "UsageDaily"("userId", "provider", "model", "date", "source");

-- CreateIndex
CREATE INDEX "UsageDaily_userId_date_idx" ON "UsageDaily"("userId", "date");

-- CreateIndex
CREATE INDEX "UsageDaily_userId_provider_date_idx" ON "UsageDaily"("userId", "provider", "date");

-- CreateIndex
CREATE INDEX "IngestDevice_userId_idx" ON "IngestDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageIngest_nonce_key" ON "UsageIngest"("nonce");

-- CreateIndex
CREATE INDEX "UsageIngest_userId_receivedAt_idx" ON "UsageIngest"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "Budget_userId_isActive_idx" ON "Budget"("userId", "isActive");
