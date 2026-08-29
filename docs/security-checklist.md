# DeepBalance 安全审计清单（M7 / T7.3）

> 逐项对照 PRD §8 非功能需求（安全 / 隐私 / 性能 / 可访问性）与计划 §10 R4（Key 泄露一票否决）。
> 状态图例：**[已实现]** 当前代码已满足；**[建议]** 需上线 / 运维侧确认；**[待确认]** 依赖 M4/M6/E2E 或部署环境。
> 证据均为「文件:行号」，行号对应本仓库 `2026-08-28` 快照；M6（预警）与 M4（前端）并行合入中，
> 相关行号可能轻微漂移，阅读时以文件内注释为准。

## 1. API Key 安全（R4 一票否决项）

### 1.1 Key 只发往 api.deepseek.com —— [已实现]
- `lib/deepseek/client.ts:10` `DEFAULT_BASE_URL = "https://api.deepseek.com"`；
  唯一出网调用为 `client.ts:80` `fetch(\`${baseUrl}/user/balance\`)`，明文 Key 只进 `Authorization: Bearer` 请求头（`client.ts:83`）。
- 唯一可控变量：`DEEPSEEK_BASE_URL` 环境变量可覆盖 baseUrl（`client.ts:72`，`.env.example` 默认值仍为官方域名）。
  **[建议]** 部署时确认该变量为官方地址或留空——这是部署侧的信任边界，代码侧无其他出网路径。
- 校验口径：绑定 Key 的实测（`/api/keys` POST → `lib/keys/service.ts addKey`）与定时快照
  （`app/api/cron/snapshot/route.ts:95-97`）都走同一客户端，无绕过路径。

### 1.2 AES-256-GCM 落库（规格卡 A）—— [已实现]
- `lib/crypto/key-vault.ts:10` `ALGORITHM = "aes-256-gcm"`；`:11` `IV_LENGTH = 12`（GCM 推荐 12 字节随机 IV）。
- 每次加密生成新随机 IV（`key-vault.ts:40` `randomBytes(IV_LENGTH)`），同一明文两次加密产物不同。
- 落库字段：`prisma/schema.prisma` ApiKey 模型 `ciphertext / iv / authTag`（Bytes 三字段），**无任何明文字段**；
  对外类型 `ApiKeyRecord`（`lib/keys/service.ts:19-27`）只有 id/label/last4/isActive/failCount/lastStatus/createdAt。
- 主密钥来自 `ENCRYPTION_KEY`（64 位 hex → 32 字节，`key-vault.ts:20-31`）；缺失 / 格式错直接抛错，**不静默降级**。
- **[建议]** 上线按 PRD 将主密钥切到平台密钥托管（KMS），并规划轮换（当前无轮换机制）。

### 1.3 前端 / 日志 / 错误追踪无明文 Key —— [已实现]（grep 人工核验）
`grep -rn "console\.\(log\|warn\|error\)" app lib auth.ts --include="*.ts*"` 共 13 处命中
（含 3 行仅注释提及的说明行），10 处真实调用逐条人工核对：
- `app/api/cron/snapshot/route.ts:158,176`（快照失败 warn：只含 keyId/last4/reason/statusCode，
  代码注释明确「绝不打印明文 Key 与 message」）；`:303,309,315`（M6 预警段：邮件失败与预警日志
  只含 key.id/last4/severity/type，邮件模板只嵌 last4）。
- `app/api/events/route.ts:57,62`（本任务埋点：payload 已经 `sanitizeProps` + `redactSecretStrings`
  脱敏，见 1.8；写文件失败仅打 warn）。
- `app/api/usage/import/route.ts:87`（console.error 打印 Prisma 异常对象；CSV 的 `api_key` 列是
  官方脱敏值，见 1.7）。
- `lib/email/send.ts:31`（M6 开发态邮件预览，内容来自 `renderAlertEmail`，只含 last4/主题/文案——
  与 auth.ts 魔法链接同款开发态红线）；`:102`（SMTP 失败仅提示退回预览，不带 Key）。
- `auth.ts:38,45`：只打印魔法链接 URL（红线条款：链接仅服务端日志、开发态；不含 API Key）。
- `lib/deepseek/client.ts`：零 console 输出；`lib/keys/*`：零 console 输出。
结论：**无任何日志 / 响应路径打印明文 Key**。
- [建议] 上线接入错误追踪（Sentry 等）时配置 scrubbing 规则（`sk-[A-Za-z0-9_-]{8,}`），
  本清单 1.8 的脱敏正则可直接复用。
- 补充证据：`grep -rn "sk-[A-Za-z0-9_-]{8,}" app lib auth.ts docs scripts --include="*.ts*"` 零命中——
  源码树不存在任何 sk- 明文常量（样本/测试为打码值）。

### 1.4 传输 TLS —— [已实现] / [建议]
- 代码无任何硬编码明文 http 出网地址；HTTPS 由托管平台 / 反代终止。
- **[建议]** T8 部署验收时确认：全站 HTTPS + HSTS + 无 http 明文魔法链接日志（开发态除外，见 auth.ts 红线注释）。

### 1.5 一键删除 Key —— [已实现]
- `app/api/keys/route.ts:92` DELETE → `lib/keys/service.ts deleteKey` → `lib/keys/repo.ts deleteById`（以 (id,userId) 联合条件校验归属）。
- 关联快照由 `onDelete: Cascade` 连带删除（schema：`ApiKey.snapshots` / `BalanceSnapshot.apiKeyId`）。
- 删除策略 = 同时删除关联数据（计划 §11 Q3 默认值 [同时删除]）。

### 1.6 错误响应不泄 Key —— [已实现]
- 添加失败消息均不含明文：`lib/keys/service.ts:71`（格式 400）、`:101`（422 无效）、`:120/:137`（409 已绑定）、429 只带 Retry-After。
- 所有 Key 相关响应体只包含掩码字段（`ApiKeyRecord`）；密文不离开仓储层（`lib/keys/repo.ts:25-34` `toRecord` 白名单转换）。
- 归属校验失败统一 404（`app/api/dashboard/route.ts:83`、keys service `:167/:179`）：不向他人泄露「该 Key 是否存在」。

### 1.7 CSV 无注入面 —— [已实现]
- `lib/usage/csv-parse.ts:15-16`：papaparse 结构化解析 + zod 类型校验（必需列、type 枚举、数值合法），
  非法整单拒绝入库（`CsvParseError`）。
- 入库全部走 Prisma 参数化查询（`lib/usage/import-store.ts:45` `usageImport.upsert` + `modelUsage.createMany`），
  **无任何 SQL 字符串拼接**——Prisma 参数化天然免疫 SQL 注入（说明性结论，无拼接即无注入面）。
- CSV 中 `api_key` 列为官方脱敏值，原样存入 `ModelUsage.apiKeyRef`（`csv-parse.ts:42` 注释），非真实 Key，无二次暴露。

### 1.8 埋点无 Key 泄露面 —— [已实现]
- `lib/analytics.ts:35-39`：上报属性先经 `sanitizeProps`（扁平化，对象/数组丢弃）与 `redactSecretStrings`
  （`sk-...` → `sk-***`）处理，事件日志不可能出现 Key；服务端入库前再脱敏一次（`app/api/events/route.ts` 双保险）。
- 埋点端点无鉴权（事件本身无敏感数据；刷量 / 伪造顾虑见路由注释，可在网关补同源校验——[建议]）。

### 1.9 数据导出红线 —— [已实现]
- `app/api/account/export/route.ts`：全部查询用 **select 字段白名单**（不选 ciphertext/iv/authTag），
  结构性排除加密材料；测试 `tests/account-route.test.ts` 断言响应原文不含密文 base64 与明文 Key。

### 1.10 环境与文件资产 —— [已实现]
- `.gitignore:34` `.env*`（ENCRYPTION_KEY / AUTH_SECRET / CRON_SECRET 等不入库）；
  `.gitignore:48` `/scripts/analytics-events.ndjson`（埋点本地落盘文件，生成数据不入库）。
- **[建议]** 上线前检查 `prisma/dev.db` 不入库（当前仓库无该文件，gitignore 无明确条目，仅依赖本地未提交——建议补一行）。

## 2. 隐私与账户（FR-6）

### 2.1 AC6-1 多端云同步：数据以服务端为准 —— [已实现]（架构性，无独立代码改动）
- 架构事实：所有业务数据（Key/快照/用量/预警设置/预警事件）只存云端 DB（Prisma），
  客户端不落任何业务数据（grep 核验：`localStorage/sessionStorage/indexedDB` 在 app/lib 零命中，仅个别组件用 React state/query 缓存）。
- 验证方式（写入 M8 验收记录）：同一账号在两台设备（或两个浏览器 profile）分别登录，
  任意一端添加 Key / 导入 CSV / 修改预警阈值后，另一端刷新数据一致——两端都读同一 DB 行。

### 2.2 数据导出 —— [已实现]
- `GET /api/account/export`（JSON 附件下载）：user email、Key 元信息（last4 掩码）、
  最近 100 条快照、用量导入月份列表、预警设置；见 1.9 红线。

### 2.3 AC6-2 注销删除（二次确认 + 约定时限 + 停任务）—— [已实现]
- **二次确认**：`app/api/account/route.ts:36` `confirm !== true → 400`（前端弹窗确认后才发 `{confirm:true}`）。
- **删除范围**（`lib/account/delete-account.ts:18-23`，事务内，实测确认）：
  - 手动删 `alertEvent` / `usageImport`（无 User relation，无自动级联——临时库实测：`user.delete` 后二者残留）；
  - `user.delete`：ApiKey / BalanceSnapshot / AlertSetting / Account / Session 由 `onDelete: Cascade` 自动删
    （同实测：级联后计数均为 0）。
- **约定时限**：删除即生效（同步事务提交），满足「约定时限内删除」（本实现取即时删除口径）。
- **不再被定时任务调用**：cron 是无本地调度器的 HTTP 端点（外部定时触发），遍历 `isActive=true` 的 ApiKey
  （`app/api/cron/snapshot/route.ts:77-78`）；User 删除 → 其所有 ApiKey 行消失 → 任务自然不会再拉取该用户任何 Key。
  **不需要额外的任务停止机制**（`lib/account/delete-account.ts:11-13` 注释与 `tests/account-route.test.ts`
  「active Key 集合不再含该 Key」断言共同佐证）。

## 3. 性能（PRD §8）

### 3.1 仪表盘首屏可交互 ≤ 2s —— [待确认]（M4 负责实现，本清单记录基线）
- 基线：M4 用 TanStack Query（`@tanstack/react-query@5`，见 package.json）+ RSC；看板数据单请求聚合
  余额卡 + 今日/本月 + 趋势（`app/api/dashboard/route.ts`，无串行瀑布）；快照 / CSV 均在后台异步，不阻塞首屏。
- 验证建议（M8 执行，不必写性能测试）：`npm run build && npm run start` 后，用 DevTools Lighthouse（桌面 + 移动）
  或手动实测首屏可交互时间；目标 ≤ 2s [待产品确认]。

### 3.2 快照与 CSV 解析异步 —— [已实现]
- 快照：cron 端点后台逐个处理（用户无感知）；CSV：请求内事务完成（M5 返回结果即入库），
  页面由 M4/M5 的 loading 态承接，不阻塞渲染。

## 4. 可访问性（WCAG AA）

### 4.1 状态不只靠颜色 —— [已实现] / [待确认]
- M4 页面（`app/(app)/**`，M4 交付）：余额 / 状态卡配文字（不足 / 可调用）与图标；趋势缺口以浅色虚线 + 文字标注。
- **[待确认]** M8 用 axe DevTools / 键盘走查复核：正文对比度 ≥ 4.5:1、大字号 ≥ 3:1、只靠颜色的语义状态为零。

## 5. 成功指标埋点（PRD §1.2 / 计划 Q6）—— [已实现]（埋点先建，目标内测后回填）
- `lib/analytics.ts` `trackEvent` + `app/api/events/route.ts`（console.log 单行 JSON + 追加
  `scripts/analytics-events.ndjson`；生产应切 Postgres 表 / 第三方，见路由注释）。
- 事件类型：`dashboard_view`（M4 打开仪表盘）、`key_bound`（绑定成功）、`ttv`（注册 → 首次渲染余额卡，
  props.startAtMs 与服务端到达 ts 差值为 TTV）、`alert_sent`（M6 预警发送处挂接——M6 与 cron 文件由 M6 agent 合入，
  本任务不修改 cron 文件，类型与上报函数已就绪）。
- 目标值（周活跃 / 转化率 / TTV ≤ 3 分钟 / 快照成功率 ≥ 99% 等）：[待内测回填 Q6]。

## 结论
- R4 一票否决项（明文 Key 泄露面）：**未发现**。日志（1.3 逐条核验）、响应（掩码字段 + 白名单结构）、
  导出（红线测试）、埋点（脱敏双保险）、CSV（官方脱敏值）、落库（AES-256-GCM 无明文字段）六条路径均闭环。
- 遗留待办：T8 部署验收项（HTTPS/HSTS、Key 托管、错误追踪 scrubbing、Lighthouse、axe）——均为 [建议]/[待确认]，无阻塞。
