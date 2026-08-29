// Prisma 7 配置：连接串移到此处（schema 内不再支持 url）
// 注意：Prisma 7 + prisma.config.ts 下 CLI 不再自动加载 .env 文件，手动加载；
// 已存在的环境变量（Vercel/CI 注入）优先，不会覆盖。
import path from "node:path";
import { defineConfig, env } from "prisma/config";

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // 文件不存在时忽略（生产环境由平台注入 DATABASE_URL）
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
