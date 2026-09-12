# token-wallet

一个人在一个面板里，自动看清 **DeepSeek / Kimi / 豆包（火山引擎）** 三个平台「还剩多少钱、状态是否正常、要不要充值」，并在余额过低 / 欠费 / 凭证失效时收到邮件提醒。MIT 开源，可一键部署到 Vercel + Neon Postgres。

> 本项目由 DeepBalance v1（DeepSeek 单平台 MVP）升级而来，v1 历史通过一次性迁移保留。

## 特性

- **三家官方原生余额**（native，无需 Cookie / 登录态抓取）
  - DeepSeek：`GET /user/balance`
  - Kimi：`GET /v1/users/me/balance`（v2.0 仅国内站）
  - 豆包（火山引擎）：费用中心 `QueryBalanceAcct`（火山签名 V4）
- **多平台凭证管理**：Bearer（模型 Key）与 AK/SK 两态表单，提交即连通性校验，失败给出可操作原因
- **跨平台总览**：分币种合计（CNY/USD 不混算）、平台卡、余额构成、数据新鲜度（stale）与故障隔离；快照过期时仪表盘显著提示「数据陈旧 / 数据截至 xx:xx」，不会把失败显示成 0
- **每小时自动快照**：GitHub Actions 触发 + Vercel Cron 兜底；全局并发限流、Kimi ≤3/min、单凭证 10s 超时
- **用量导入**：DeepSeek 官方用量 CSV（amount/cost）按平台/月份幂等导入
- **告警**：低余额 / 欠费 / 凭证连续失败 / 可用性翻转，站内 + 邮件，24h 频控，分平台阈值覆盖
- **安全**：凭证 AES-256-GCM 加密落库，仅展示脱敏标识；火山只读 IAM 子用户强制引导
- **金额精度**：全部 `Decimal(18,9)` 定点运算，无浮点误差；消耗数字统一标注「估算」
- **邮箱验证码登录**：6 位 OTP，10 分钟有效，最多 5 次尝试；可叠加邮箱白名单与邀请码准入

## 能力矩阵

| 能力 | DeepSeek | Kimi（国内站） | 豆包（火山引擎） |
| --- | --- | --- | --- |
| 余额端点 | `/user/balance` | `/v1/users/me/balance` | `QueryBalanceAcct`（billing） |
| 凭证 | Bearer 模型 Key | Bearer 模型 Key | AK/SK + 签名 V4（只读 IAM 子用户） |
| 余额模式 | native | native | native |
| 用量 | 官方 CSV 导入 | 接口受限，可能为估算，**不保证官方账单口径** | 接口受限，可能为估算，**不保证官方账单口径** |

> **用量口径说明**：DeepSeek 用量来自官方 CSV，可视为精确；Kimi / 豆包（火山引擎）用量受平台接口能力限制，展示值可能为余额快照差值等估算口径，**不能等同于官方账单**，请以各平台控制台账单为准。

## 快速开始（Vercel + Neon，约 30 分钟）

1. **准备数据库**：在 [Neon](https://neon.tech) 创建一个 Postgres 项目，复制 **pooled** 连接串（含 `-pooler` 主机与 `?sslmode=require`）。
2. **部署到 Vercel**：Fork 本仓库 → Vercel 导入该仓库 → 配置环境变量（见下）→ Deploy。
3. **初始化数据库**：运行 `npx prisma migrate deploy`（或 Vercel build 已含 `prisma generate`，迁移由 CI 或手动执行）。
4. **配置定时任务**：GitHub 仓库 Settings → Actions secrets 添加 `CRON_SECRET`、variables 添加 `APP_URL`（生产地址）；`.github/workflows/snapshot.yml` 每小时触发，Vercel Cron 每日兜底。
5. 打开站点 → 输入邮箱接收 **6 位验证码**登录（见下）→ 添加平台凭证，即可看到首份余额。

### 登录方式（邮箱验证码 OTP）

- 登录页输入邮箱 → 发送 **6 位数字验证码**（不再使用魔法链接）。
- 验证码 **10 分钟**内有效；输错最多 **5 次**，超限后需重新获取。
- 准入控制（可叠加）：`ALLOWED_EMAILS` 白名单 + `INVITE_CODES` 邀请码；两者都配置时需同时满足。
- 公网部署务必配置邮件通道与至少一种准入，否则任何人都可尝试登录。

### 环境变量

> **注意**：仓库 `.gitignore` 规则为 `.env*`，因此 `.env.example` **不会入库**。本表是环境变量的权威说明，以 README 为准；本地可对照本表自行创建 `.env.local`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Neon pooled 连接串（含 `-pooler` 主机与 `?sslmode=require`） |
| `TEST_DATABASE_URL` | 本地测试 | 测试专用库，勿指向生产；Vercel 不配 |
| `AUTH_SECRET` | ✅ | 会话签名（`openssl rand -base64 32`） |
| `NEXTAUTH_URL` | ✅ | 站点域名，如 `https://<your-domain>` |
| `ENCRYPTION_KEY` | ✅ | 32 字节 hex（64 字符），凭证加密主密钥；丢失则已存凭证密文不可解，妥善备份 |
| `CRON_SECRET` | ✅ | 快照端点与 `/api/health` 共用鉴权密钥；双份：Vercel + GitHub Secrets |
| `APP_URL` | 生产建议 | 站点绝对地址；GitHub Actions 快照与服务端埋点拼 URL 用（Actions 侧配在 repository variables） |
| `RESEND_API_KEY` | 生产必配其一 | Resend 发信；**必须验证自有域名**后使用 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | 生产必配其一 | 自建 SMTP 通道（与 Resend 二选一；未配置时开发态验证码打印到服务端控制台） |
| `SMTP_FROM` | 生产必配 | 发件人，须使用**已验证自有域名**，如 `token-wallet <noreply@<your-domain>>` |
| `ALLOWED_EMAILS` | 公网建议 | 逗号分隔白名单；非空时仅列表内邮箱可登录 |
| `INVITE_CODES` | 公网建议 | 逗号分隔邀请码；非空时登录页强制验证邀请码 |
| `DEEPSEEK_BASE_URL` | 可不配 | 默认官方 `https://api.deepseek.com`；部署侧信任边界，勿指向非官方地址 |

#### Resend 发信注意（重要）

- **必须在 Resend 验证自有域名**，`SMTP_FROM` 使用该域名地址；`onboarding@resend.dev` 仅为 Resend 免费档未验证域名时的临时发件人，**通常只能发往你自己 Resend 账号绑定的邮箱**，公网场景下其他人收不到验证码。
- 登录信 / 预警信发不出去时，先查 Resend Logs，再确认域名验证与 `SMTP_FROM` 是否匹配。
- 发件域名与模板说明详见 [docs/onboarding-email.md](docs/onboarding-email.md)。

## 平台凭证获取

- **DeepSeek**：platform.deepseek.com → API Keys，创建 `sk-` 开头的模型 Key。
- **Kimi**：platform.moonshot.cn → API Key 管理（国内站 `sk-`，CNY）。国际站 v2.1 支持。
- **豆包（火山引擎）**：**必须**使用「费用中心只读」IAM 子用户的 AK/SK（推荐绑定系统策略 `BillingCenterReadOnlyAccess`），**禁止**主账号密钥或 ARK 推理 Key。查余额走费用中心，不属于推理 API。

## 安全模型

- 凭证在服务端 AES-256-GCM 加密落库（每凭证随机 IV，主密钥来自 `ENCRYPTION_KEY`），仅发起平台请求瞬间在内存中持有明文；日志、响应、邮件均不含明文。
- **自托管即信任边界**：服务端能解密凭证（这是功能所需）。请仅在你信任的 Vercel/服务器上部署，并妥善保管 `ENCRYPTION_KEY` 与平台凭证。
- 火山侧建议最小权限（只读账单），把泄露面收窄到「只读余额」，详见 `SECURITY.md`。

## 开发

```bash
npm install
npx prisma generate
npm run dev          # 本地开发
npm test             # vitest（连 TEST_DATABASE_URL）
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # 生产构建
```

## License

[MIT](LICENSE)
