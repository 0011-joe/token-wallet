import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // SQLite (dev.db) 并发写锁竞争：测试文件间串行执行，文件内仍并行
    fileParallelism: false,
    env: {
      // 测试与开发共用 SQLite（prisma/dev.db）；CI 里由 migrate deploy 建表
      DATABASE_URL: "file:./dev.db",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
    },
  },
});
