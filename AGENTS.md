<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
## Git 提交门禁（本项目强制）

- 每次功能/修复改动完成后：先运行**对应的有效测试**（`npm test` 全量；改动局部时至少跑相关测试文件），并确保 `npm run typecheck` 通过；
- **测试与 typecheck 全绿后**才创建提交：`git add -A && git commit -m "feat/fix: ..."`（一次一个逻辑功能为一个 gate 提交）；
- 测试失败时**禁止提交**，修复至全绿后再提交；
- 红线：`.env*`、`*.db`、`*.log`、`scripts/visual-check/shots/`、`server.log` 已被 .gitignore 排除，`git status` 确认后才 `add -A`。

