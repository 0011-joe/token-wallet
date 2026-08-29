import path from "node:path";
import { defineConfig } from "vitest/config";

// 加载 .env.local（若存在），使 TEST_DATABASE_URL 能随项目配置生效
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // .env.local 不存在时忽略（例如 CI：由外部注入 TEST_DATABASE_URL）
}

export default defineConfig({
  test: {
    environment: "node",
    // 测试共享一个 Postgres 测试库：测试文件间串行执行，避免数据相互干扰
    fileParallelism: false,
    env: {
      // 测试连 Postgres 专用库（Neon 项目下另建 deepbalance_test），
      // 防止污染开发/生产数据；未设置 TEST_DATABASE_URL 时不静默降级
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
    },
  },
});
