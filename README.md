# token-wallet

一个人在一个面板里，自动看清 **DeepSeek / Kimi / 豆包（火山引擎）** 三个平台「还剩多少钱、状态是否正常、要不要充值」，并在余额过低 / 欠费 / 凭证失效时收到邮件提醒。MIT 开源，可一键部署到 Vercel + Neon Postgres。

> 本项目由 DeepBalance v1（DeepSeek 单平台 MVP）升级而来，v1 历史通过一次性迁移保留。

## 特性

- **三家官方原生余额**（native，无需 Cookie / 登录态抓取）
  - DeepSeek：`GET /user/balance`
  - Kimi：`GET /v1/users/me/balance`（v2.0 仅国内站）
  - 豆包（火山引擎）：费用中心 `QueryBalanceAcct`（火山签名 V4）
- **多平台凭证管理**：Bearer（模型 Key）与 AK/SK 两态表单，提交即连通性校验，失败给出可操作原因
- **跨平台总览**：分币种合计（CNY/USD 不混算）、平台卡、余额构成、数据新鲜度（stale）与故障隔离
- **每小时自动快照**：GitHub Actions 触发 + Vercel Cron 兜底；全局并发限流、Kimi ≤3/min、单凭证 10s 超时
- **用量导入**：DeepSeek 官方用量 CSV（amount/cost）按平台/月份幂等导入
- **告警**：低余额 / 欠费 / 凭证连续失败 / 可用性翻转，站内 + 邮件，24h 频控，分平台阈值覆盖
- **安全**：凭证 AES-256-GCM 加密落库，仅展示脱敏标识；火山只读 IAM 子用户强制引导
- **金额精度**：全部 `Decimal(18,9)` 定点运算，无浮点误差；消耗数字统一标注「估算」

## 能力矩阵

| 能力 | DeepSeek | Kimi（国内站） | 豆包（火山引擎） |
| --- | --- | --- | --- |
| 余额端点 | `/user/balance` | `/v1/users/me/balance` | `QueryBalanceAcct`（billing） |
| 凭证 | Bearer 模型 Key | Bearer 模型 Key | AK/SK + 签名 V4（只读 IAM 子用户） |
| 余额模式 | native | native | native |
| 用量 | CSV 导入 | 预留（v2.1） | 预留（v2.1） |

## 快速开始（Vercel + Neon，约 30 分钟）

1. **准备数据库**：在 [Neon](https://neon.tech) 创建一个 Postgres 项目，复制 **pooled** 连接串（含 `-pooler` 主机与 `?sslmode=require`）。
2. **部署到 Vercel**：Fork 本仓库 → Vercel 导入该仓库 → 配置环境变量（见下）→ Deploy。
3. **初始化数据库**：运行 `npx prisma migrate deploy`（或 Vercel build 已含 `prisma generate`，迁移由 CI 或手动执行）。
4. **配置定时任务**：GitHub 仓库 Settings → Actions secrets 添加 `CRON_SECRET`、variables 添加 `APP_URL`（生产地址）；`.github/workflows/snapshot.yml` 每小时触发，Vercel Cron 每日兜底。
5. 打开站点 → 登录 → 添加平台凭证，即可看到首份余额。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Neon pooled 连接串 |
| `TEST_DATABASE_URL` | 本地测试 | 测试专用库，勿指向生产 |
| `AUTH_SECRET` | ✅ | 会话签名（`openssl rand -base64 32`） |
| `NEXTAUTH_URL` | ✅ | 站点域名 |
| `ENCRYPTION_KEY` | ✅ | 32 字节 hex（64 字符），凭证加密主密钥，妥善备份 |
| `CRON_SECRET` | ✅ | 快照 + `/api/health` 鉴权，双份：Vercel + GitHub Secrets |
| `RESEND_API_KEY` / `SMTP_*` | 生产必配其一 | 邮件；未配置时仅开发态打印到控制台。**公网部署必须配置，否则他人无法收到魔法链接**；Resend 免费档请验证自有域名（勿依赖 `onboarding@resend.dev`） |
| `ALLOWED_EMAILS` | 建议 | 逗号分隔白名单；非空时仅列表内邮箱可登录。公网部署务必配置 |
| `INVITE_CODES` | 建议 | 逗号分隔邀请码；非空时登录页强制验证邀请码 |

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
