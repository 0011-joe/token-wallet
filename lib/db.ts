import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// Prisma 7 必须显式提供 driver adapter；SQLite 本地路线用 better-sqlite3。
// 上线切 Postgres 时替换为 PrismaPg 适配器（prisma.config.ts 同步改）。
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./dev.db",
});

// 启动诊断：打印实际连接的文件与进程 cwd（排查多库写入不一致）
console.log("[deepbalance] db url =", process.env.DATABASE_URL ?? "file:./dev.db", "| cwd =", process.cwd());

// Prisma 单例：dev 热重载时复用全局实例，避免连接膨胀
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
