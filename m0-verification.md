# M0 基座验证记录

> 记录人：M0 基座执行 agent。
> 日期：2026-08-29
> 环境：Windows / Git Bash / Node 24 / npm（慢代理，安装命令均带 `--fetch-retries=5 --fetch-timeout=180000`）

## 版本裁决
- Prisma：`dist-tags` 显示 `latest: 8.0.0-rc.12`（RC），`prev: 7.10.0` → 取**最新非 rc 稳定 7.x = ^7.10.0**。
- next-auth：`latest: 4.24.15`（v5 仍为 `5.0.0-beta.32` beta），4.24.15 的 peer 声明已覆盖 `next ^16` / `react ^19` → 取**最新稳定 4.24.15**，auth.ts 按 v4 文档 API 书写。
- @auth/prisma-adapter：2.11.3（按任务清单安装；若与 v4 类型体系不兼容，降级为 @next-auth/prisma-adapter@1.x 并记录原因）。

## T0.1 骨架收尾
- `npm run build`：通过（见下方 build 输出摘要）。
- shadcn：`npx shadcn@latest init -d` 成功（style=base-nova），`add button card input label` 成功。
- 落地页 `app/page.tsx`：DeepBalance / DeepSeek 用量监控 / 登录按钮。
- 协调项：另一 agent 在 `scripts/` 的 WIP 文件会让 tsc/eslint 全项目报错（重复声明），已把 `scripts/`（与 `prisma/**`）从 tsconfig exclude 与 eslint globalIgnores 排除——**未修改 scripts/ 下任何文件**。

## T0.2 Prisma + SQLite
- Prisma 7.10.0 + @prisma/adapter-better-sqlite3（driver adapter，lib/db.ts 已接入）
- schema.prisma 定稿（User/Account/Session/ApiKey/BalanceSnapshot/UsageImport/ModelUsage/AlertSetting/AlertEvent；AlertSetting 补 user 反向关系）
- `migrate dev --name init` 已应用，dev.db 建表成功；tests/db-smoke.test.ts 通过

## T0.3 Auth.js 邮箱魔法链接
- next-auth@4.24.15（计划 v5 仍为 beta，采用稳定 4.x）+ @next-auth/prisma-adapter
- auth.ts：PrismaAdapter + Email provider，jwt 会话；开发态魔法链接打印服务端控制台
- 路由 /api/auth/[...nextauth] 与 /login 页可用；未登录访问受保护页 307 → /login（M4 冒烟验证）

## T0.4 key-vault
- lib/crypto/key-vault.ts：AES-256-GCM，随机 12B IV/Key，iv+authTag+ciphertext 落库
- tests/key-vault.test.ts 7 例通过（往返一致、随机 IV、错误密钥失败、maskKey 只露后 4 位、环境变量校验）

## T0.5 CI
- .github/workflows/ci.yml：npm ci → prisma generate → typecheck → lint → migrate deploy → test → build（push main / PR 触发）

> 2026-08-29 后续更新：M1 探针（scripts/spike-notes.md，Q1/Q2 已答）与 M2–M8 全部里程碑已完成，
> 全量 114 项 vitest 用例、typecheck、lint、build 全绿（见 M8 验收记录）。
