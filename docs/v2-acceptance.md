# token-wallet v2.0 验收记录（M8 / T8.1）

> 记录时间：2026-09-10（v2 全量回归）· 生产迁移与上线：2026-09-11 · 基线：DeepBalance v1（tag `v1.0.0`）
> 执行方式：本地全量回归（`npm test` / `npm run typecheck` / `npm run lint` / `npm run build`）

## 1. 全量回归结果

| 检查项 | 结果 |
| --- | --- |
| `npm test`（vitest） | **216 passed / 216**（22 个测试文件） |
| `npm run typecheck`（tsc --noEmit） | 通过（0 错误） |
| `npm run lint`（eslint） | 通过（0 错误 0 警告） |
| `npm run build`（Next 生产构建） | 成功 |

## 2. AC 逐条对照（PRD §6 / DEV-GUIDE §15）

### FR-1 多 Provider 凭证管理

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC1.1 切换平台表单字段/帮助文案正确 | ✅ | `components/credentials/cred-add-form.tsx`（按 `PROVIDER_META.kind` 动态渲染 bearer/aksk） |
| AC1.2 无效凭证即失败并返回可操作原因，不落库 | ✅ | `tests/cred-service.test.ts`（INVALID→422 / FORBIDDEN_SCOPE→422 / RATE_LIMITED→429 / ERROR→502，均断言 `rows=0`） |
| AC1.3 有效凭证一次提交成功并立即看到首份余额 | ✅ | `app/api/credentials/route.ts`（testCredential 成功后写首份快照并回显） |
| AC1.4 列表/日志/响应无明文凭证 | ✅ | `tests/cred-service.test.ts`（响应 JSON 不含明文；落库为信封密文可逆）；`tests/keyvault.test.ts` |
| AC1.5 删除凭证级联删快照，不影响其他平台 | ✅ | `app/api/credentials/[id]/route.ts` + Prisma `onDelete: Cascade`；`tests/account-route.test.ts` 级联断言 |
| AC1.6 豆包只读 IAM 引导 + 主账号/ARK Key 拦截 | ✅ | `validateCredentialInput` 拒绝非 `AKLT` 前缀；`PROVIDER_META.volcengine.guide` 引导文案；`FORBIDDEN_SCOPE` 提示绑定 `BillingCenterReadOnlyAccess` |

### FR-2 适配器层与三家自动余额

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC2.1 新增 Provider 不改主流程 | ✅ | `lib/providers/registry.ts`；`tests/providers-deepseek.test.ts`（注册/查找/重复注册） |
| AC2.2 火山签名官方向量对拍 + 签名错/欠费/信控解析 | ✅ | `tests/volc-sigv4.test.ts`（4 组官方向量逐字节一致，含完整 Authorization 头）；`tests/providers-volcengine.test.ts` |
| AC2.3 Kimi 成功/失败/cash 为负 fixture，number→Decimal 无精度丢失 | ✅ | `tests/providers-kimi.test.ts`（`49.58894 → 49.588940000`；code≠0/status≠true→ERROR；401/429；欠费 arrears） |
| AC2.4 DeepSeek 迁移后与 v1 逐字段一致 | ✅ | `tests/providers-deepseek.test.ts`（成功体字段逐项断言，Decimal 边界） |
| AC2.5 单凭证故障隔离，返回脱敏汇总 | ✅ | `lib/snapshot/orchestrator.ts` + `tests/snapshot-orchestrator.test.ts`（失败隔离、byProvider 汇总、failed 仅含 id/provider/reason） |
| AC2.6 10 凭证量级低于函数超时预算 | ✅ | `tests/snapshot-orchestrator.test.ts`（10 凭证、全局并发 ≤3、受限平台串行） |

### FR-3 跨平台总览

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC3.1 一屏分币种合计 + 各平台余额 | ✅ | `lib/dashboard/overview.ts` + `components/dashboard/overview-panel.tsx`；`tests/dashboard-overview.test.ts` |
| AC3.2 CNY 与 USD 不混算、无折算 | ✅ | 同测试（分币种独立合计） |
| AC3.3 平台故障显示失败/数据截至，不显示 0 | ✅ | 同测试（无快照凭证不贡献余额、计入 failed/stale）；UI 显示「数据截至 xx:xx」 |
| AC3.4 余额构成按真实字段渲染、缺项隐藏 | ✅ | `components/dashboard/balance-composition.tsx`（granted/voucher/cash/creditLimit/frozen 条件渲染） |
| AC3.5 日/月聚合按北京时间呈现、有测试 | ✅ | `lib/format.ts` `formatDateTime` 统一 `Asia/Shanghai`；`tests/billing-snapshot-delta.test.ts`（UTC 聚合口径） |

### FR-4 用量导入

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC4.1 v1 DeepSeek CSV 导入结果一致 | ✅ | `tests/usage-csv-parse.test.ts` + `tests/usage-models-route.test.ts`（样本合计 `2.8196908` 精确保留） |
| AC4.2 幂等键升级为 `[userId, provider, month]` | ✅ | `prisma/schema.prisma` + `tests/usage-import.test.ts`（同月覆盖不翻倍） |

### FR-5 告警

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC5.1 欠费/低余额/凭证连续失败均触发，24h 频控 | ✅ | `tests/alerts-evaluate.test.ts`（LOW_BALANCE/ARREARS/CREDENTIAL_FAILED/UNAVAILABLE + 频控窗口） |
| AC5.2 频控并发兜底 | ✅ | P2002 捕获 + 时间窗判断（`app/api/cron/snapshot/route.ts`）；去重键业务唯一 |
| AC5.3 告警内容只含平台/脱敏标识/类型/数值 | ✅ | `lib/alerts/evaluate.ts` 使用 `maskedHint`；消息断言不含明文 |

### FR-6 / FR-7 工程化与技术债

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC6.2 仓库与历史 grep 不到真实秘密 | ✅ | git 全历史扫描：仅有测试占位值；无连接串/密钥/真实 `re_` 值；`docs/deployment.md` 个人域名已脱敏 |
| AC6.3 LICENSE/SECURITY/.env.example 齐全，依赖 License 兼容 | ✅ | `LICENSE`(MIT)、`SECURITY.md`、`.env.example`(仅占位符)、`CONTRIBUTING.md`、Issue/PR 模板；生产依赖 License：MIT / ISC / Apache-2.0 / MIT-0（无 copyleft） |
| FR-7 Decimal / cron 并发 / 快照保留 / 密钥版本位 | ✅ | `lib/money.ts`（Decimal(18,9) 定点）；`lib/snapshot/orchestrator.ts`；`lib/snapshot/retention.ts`（180 天降采样）；`Credential.keyVersion` |

### 待人工验证项（依赖外部账号，无法自动执行）

| 项 | 说明 |
| --- | --- |
| AC6.1 全新 Vercel/Neon 账号 30 分钟跑通 | 需用户账号实测（README 已给出逐步路径） |
| T0.5 火山签名真实 spike（go/no-go） | 需真实「费用中心只读 IAM 子用户」AK/SK：`VOLC_AK=... VOLC_SK=... npx tsx scripts/spike-volc-sig.ts`（签名已通过官方向量 4 组逐字节对拍） |
| T8.2 灰度与双读比对 | 未做：单用户规模直接全量切换，未跑双读比对与视觉回归重截（见 §4） |
| T8.3 剩余步骤 | 生产迁移与切读已完成（见 §4），剩「观察一个版本周期 → `npx tsx scripts/migrate-v1-to-v2.ts --drop-legacy`」 |

## 3. 迁移演练（T8.2，测试库）

`tests/migration.test.ts` 在测试库完整演练并全部通过：
- 备份导出（含密文 base64）→ 事务内搬数 → 对账（行数相等、按币种金额合计误差 0）→ 失败场景事务回滚（Credential 不残留）→ `dropLegacyTables` 幂等。

## 4. 生产迁移与上线（T8.3，2026-09-11）

生产库 Neon `neondb`；库内与部署时间戳均为 UTC。

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 备份 | ✅ 6 份 JSON 快照（各 `apiKeys=1 / snapshots=103`） | `.backups/v1-backup-*.json` |
| `prisma migrate deploy` | ✅ `20260910142500_v2_multi_provider` 已应用 | `_prisma_migrations` finished `2026-09-10T16:03:47Z`；表已改名 `ApiKey→ApiKeyLegacy`、`BalanceSnapshot→BalanceSnapshotLegacy` |
| 搬数 + 对账 | ✅ `credentials=1 / snapshots=103 / alertEventsRemapped=11` | `rowsEqual`、`amountDiffZero`、`usageProviderAllDeepseek` 均 true；CNY `1391.229999999999 → 1391.230000000`；`ciphertext`/`iv`/`authTag` 逐字节一致；AlertEvent 悬空引用 0 |
| 切读（部署 v2） | ✅ 部署 `96dc694` READY（48s） | `/` 标题 `DeepBalance → token-wallet`；`/api/health` 由 404 → 200 且 `providers.deepseek.credentialCount=1` |
| 观察一个版本周期 | ⏳ 待办 | 基线：快照 103 条、最新 `2026-09-10T14:37:50Z`（改表前每小时取数正常，后因改表中断） |
| `--drop-legacy` | ⏳ 待办 | `ApiKeyLegacy` / `BalanceSnapshotLegacy` 仍在 |

执行中修掉的两个阻塞（均已推送并复验）：

1. `173b7aa` 迁移脚本事务超时 5s → 120s。远端库 104 次串行 INSERT 超出 Prisma 默认交互式事务超时，首次执行于 5.1s 触发回滚 —— **回滚干净**（`Credential=0`、旧表行数不变），生产回滚预案在这一步得到真实验证。
2. `96dc694` `.npmrc` 关闭 peer 强校验。`next-auth@4.24.15` 的 `peerOptional nodemailer@"^7.0.7"` 与根项目 `nodemailer@^9` 冲突，npm 7+ 直接 ERESOLVE → **生产部署自 2026-09-10 起 5 次全部 ERROR，生产因此一直卡在 2026-08-29 的 v1 构建**（排查路径见 `docs/deployment.md` §4.6 与 §5 排障表）。

遗留：切读后 `Credential.lastSuccessAt` 仍为 NULL（v1 旧表无此列），`/api/health` 显示 `staleCount=1`，待下一次整点 cron 取数后归零。

## 5. 已知项

1. 生产依赖中 4 项 `high` 来自 **prisma CLI 的 devDependency 链**（`@prisma/config`/`deepmerge-ts`/`mysql2`/`prisma`），仅在开发/迁移时运行，不进应用运行时；修复需 prisma 降到 6.x（major 回退），已记录为已知项。
2. NextAuth v4 长期兼容 → 升级 v5 属 ROADMAP B2（v2.0 明确不做）；`build` 与全部路由验证无阻断。
