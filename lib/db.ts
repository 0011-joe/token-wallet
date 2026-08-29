import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 必须显式提供 driver adapter；云 Postgres 路线用 PrismaPg。
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL 未配置：请参考 .env.example 设置 Postgres 连接串");
}
const adapter = new PrismaPg({ connectionString: databaseUrl });

// 启动诊断：只打印主机名（连接串含密码凭据，绝不整体输出）
try {
  console.log("[deepbalance] db host =", new URL(databaseUrl).host);
} catch {
  // DATABASE_URL 非合法 URL 时静默（PrismaPg 会在建连时报错）
}

// Prisma 单例：dev 热重载时复用全局实例，避免连接膨胀
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
