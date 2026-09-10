import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// 加载本地 env 文件（与 prisma.config.ts 同法；已存在的环境变量优先，文件不存在时忽略）。
// 这样 tsx 脚本（迁移/spike）无需额外传参即可拿到 DATABASE_URL；Next/Vercel 运行时由平台注入。
try {
  // 先加载 .env.local（本地覆盖优先），再加载 .env 作为默认值补充
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // 忽略：无 .env.local
}
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  // 忽略：无 .env（生产/CI 由平台注入）
}

// Prisma 7 必须显式提供 driver adapter；云 Postgres 路线用 PrismaPg。
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !process.env.VITEST) {
  // 生产/开发：缺失即快速失败（不静默降级）
  throw new Error("DATABASE_URL 未配置：请参考 .env.example 设置 Postgres 连接串");
}
// 测试环境（vitest）且未配置 DATABASE_URL 时：使用占位串构造 client，
// 使不依赖数据库的测试可正常收集；依赖数据库的测试文件以 skipIf 显式跳过。
const effectiveUrl = databaseUrl || "postgresql://unused:unused@127.0.0.1:5432/unused";
const adapter = new PrismaPg({ connectionString: effectiveUrl });

// 启动诊断：只打印主机名（连接串含密码凭据，绝不整体输出）
try {
  console.log("[token-wallet] db host =", new URL(effectiveUrl).host);
} catch {
  // DATABASE_URL 非合法 URL 时静默（PrismaPg 会在建连时报错）
}

// Prisma 单例：dev 热重载时复用全局实例，避免连接膨胀
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
