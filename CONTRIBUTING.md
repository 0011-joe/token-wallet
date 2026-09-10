# 贡献指南（Contributing）

欢迎提交 Issue 与 Pull Request。项目定位是**个人自托管的 AI 余额监控工具**，请保持改动小而聚焦。

## 开发流程

```bash
npm install
npx prisma generate
npm run dev        # 本地开发
npm test           # vitest（需要 TEST_DATABASE_URL 指向测试库）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # 生产构建
```

## 提交规范

- 一个 PR 只做一件事；涉及平台适配器时，请同时补充 fixture 单测（不依赖真实网络）。
- 金额领域层只允许 `Decimal` 字符串（`lib/money.ts`），禁止 float。
- 凭证明文不得进入日志、响应、错误信息或测试 fixture 中的真实值。
- 火山签名若改动，请用官方示例向量对拍（`tests/volc-sigv4.test.ts`）并保持逐字节一致。

## 约定

- 平台适配器位于 `lib/providers/`，新增平台只加 adapter 文件并注册，不改 cron/仪表盘/告警主流程。
- 迁移类改动必须：先备份、对账误差为 0、可回滚（见 `scripts/migrate-v1-to-v2.ts` 与 `lib/migration/`）。
- `.env*`、真实密钥、截图产物不得入库。
