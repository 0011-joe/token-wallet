# token-wallet 部署与运维手册（v1 上线 2026-08-29 · v2 多平台版上线 2026-09-11）

> 本文档记录生产环境全貌：架构、入口、凭证位置、日常操作、排障。
> **安全红线：本文档不含任何密钥值**——凭证只标注"放在哪"；密钥本体存密码管理器 / Vercel 控制台。
> 行内链接为平台控制台入口，点击即达。

## 1. 架构总览

```
手机 / 电脑（任意网络）
  ↓ HTTPS（Let's Encrypt 自动续签）
<your-domain>
  └─ Vercel 项目 token-wallet（Next.js 16.3.3, Node runtime）
       ├─ NextAuth v4 邮箱魔法链接  ──→  Resend 发信（onboarding@resend.dev）
       ├─ Prisma 7 + @prisma/adapter-pg
       │    └─ Neon Postgres（ap-southeast-1 新加坡，pooled 连接）
       └─ /api/cron/snapshot（x-cron-secret 鉴权）
            ├─ GitHub Actions hourly-snapshot（每小时 :13 触发，免费）
            └─ Vercel Cron（每天 06:14 UTC 兜底，Hobby 免费档每天限 1 次）
```

成本：Vercel / Neon / Resend 均为免费档（hobby / free / 100封每天）；域名 `<your-domain>` 由阿里云注册（约 ¥30~40/年，**建议开自动续费**）。

## 2. 入口一览

| 资源 | 地址 |
|---|---|
| 生产站点 | https://<your-domain> |
| Vercel 项目 | https://vercel.com/token-wallet/token-wallet |
| Neon 数据库 | https://console.neon.tech（项目含 `neondb` 主库 + `token-wallet_test` 测试库） |
| Resend 邮件 | https://resend.com/api-keys |
| GitHub 仓库 | https://github.com/0011-joe/token-wallet |
| GitHub Actions | https://github.com/0011-joe/token-wallet/actions |
| 本地仓库 | `D:/ALL_Applications/Kimi--talk/词元钱包/token-wallet`（git remote = token-wallet） |

## 3. 环境变量总账（Vercel → Settings → Environment Variables，全部 production）

| 变量 | 用途 | 值在哪 |
|---|---|---|
| `DATABASE_URL` | Neon **pooled** 主库连接串 | Neon 控制台复制；本地 `.env.local` 同值 |
| `TEST_DATABASE_URL` | 测试专用库（**仅本地**，Vercel 不配） | 本地 `.env.local` |
| `AUTH_SECRET` | NextAuth 会话签名 | **密码管理器备份**（Vercel 内不可导出） |
| `ENCRYPTION_KEY` | API Key AES-256 主密钥，**丢失=已存 Key 永久不可解** | **密码管理器备份**（Vercel 内不可导出） |
| `CRON_SECRET` | 快照端点鉴权暗号（双份：Vercel + GitHub Secrets） | 密码管理器 + GitHub Secrets |
| `NEXTAUTH_URL` | 回调基址 = `https://<your-domain>` | Vercel |
| `RESEND_API_KEY` | 邮件发送 | Vercel（Resend 控制台可重新生成） |
| `SMTP_FROM` | 发件人 `token-wallet <onboarding@resend.dev>` | Vercel |
| `DEEPSEEK_BASE_URL` | 未配置时用官方默认 `https://api.deepseek.com` | 可不配 |

## 4. 日常操作

### 4.1 改代码上线
1. 本地 `npm run dev`（已连 Neon 远程库）、`npm test`（连测试库，不污染线上）、`npm run typecheck`
2. 全绿后 push 到 `origin/main` → Vercel Git 集成自动部署（约 1 分钟）
3. 验证：打开 https://<your-domain>

### 4.2 新增 DeepSeek API Key / 看快照
生产站点登录 → 添加 Key（加密落库，只存 last4）→ 看板/预警设置页。

### 4.3 手动触发一次快照
```bash
curl -H "x-cron-secret: <CRON_SECRET>" https://<your-domain>/api/cron/snapshot
# 期望 {"ok":true,"processed":N,"failed":[]}
```

### 4.4 数据库变更（改 schema 后）
```bash
DATABASE_URL="<主库直连串>" npx prisma migrate dev --name <说明>   # 本地生成迁移
DATABASE_URL="<主库直连串>" npx prisma migrate deploy              # 云端建表（Vercel 构建也会自动跑）
npx prisma migrate deploy（测试库同理换 TEST_DATABASE_URL）
```
注意：直连串（去掉 `-pooler`）用于执行 DDL；运行时代码用 pooled 串。

### 4.5 定时任务体系
- 每小时 13 分：GitHub Actions `hourly-snapshot`（需要仓库 Secrets `CRON_SECRET` + Variables `APP_URL`）
- 每天 06:14 UTC：Vercel Cron（`vercel.json`，请求头自动带 `Authorization: Bearer $CRON_SECRET`）

### 4.6 依赖安装的硬约束（勿删 `.npmrc`）
`next-auth@4.24.15` 声明 `peerOptional nodemailer@"^7.0.7"`，而本项目直接依赖 `nodemailer@^9`（`lib/email/mailer.ts` 自行 `createTransport`，`auth.ts` 用自定义 `sendVerificationRequest`，next-auth 内置的 nodemailer 通路从未被使用）。npm 7+ 会因此 ERESOLVE 直接失败，表现为 Vercel 构建挂在 `npm install`（`errorCode=module_not_found`、`"npm install" exited with 1`）。仓库根 `.npmrc` 的 `legacy-peer-deps=true` 就是为此而加，**删掉它构建立刻变红**。
另注：Vercel 项目 `nodeVersion` 为 `24.x`，CI（`.github/workflows/ci.yml`）与本机为 `22.x`，两者不同。

### 4.7 数据迁移（v1 → v2，已完成）

```bash
npx tsx scripts/migrate-v1-to-v2.ts                 # 备份 → 事务内搬数 + 对账（对账不过即整体回滚）
npx tsx scripts/migrate-v1-to-v2.ts --backup-only   # 只备份
npx tsx scripts/migrate-v1-to-v2.ts --drop-legacy   # 观察一个版本周期后删旧表
```

- 脚本自加载 `.env.local` 的 `DATABASE_URL`，**执行前务必确认它打印的目标 host** 是生产库；
- 2026-09-11 已在生产执行完毕（`Credential=1`、`BalanceSnapshot=103`、对账误差 0）。旧表 `ApiKeyLegacy`/`BalanceSnapshotLegacy` 暂留，观察期结束后再跑 `--drop-legacy`；
- 远端库上 100+ 次串行 INSERT 会超过 Prisma 默认 5s 交互式事务超时，脚本内已设 `timeout=120s`。

## 5. 常见故障排查

| 现象 | 排查 |
|---|---|
| 手机打不开站点 | ① 域名是否续费/过期（阿里云）；② `nslookup <your-domain>` 是否指向 `76.76.21.21`；③ Vercel 项目域名状态 |
| 邮件没收到 | ① Resend 控制台 Logs 看发送是否成功；② 发件人必须是 `onboarding@resend.dev`（未验证域名时）；③ 垃圾箱 |
| 点击链接报 token 无效 | 链接一次性：30 分钟内未用会过期；重新发送一次 |
| 快照没数据 | GitHub Actions 该 cron 运行日志；或手动 curl 4.3；看 Vercel 函数日志 |
| 页面冷启动慢（3~10s） | 免费档函数休眠，正常现象，可用后即秒开 |
| 本地 `npm run dev` 起不来 | 检查 `.env.local` 的 `DATABASE_URL`/`TEST_DATABASE_URL`（勿用 `file:` 开头） |
| 改了代码但生产没变 | 先看 Vercel → Deployments：**部署创建了但状态 ERROR 时，生产会静默继续服务上一个成功构建**，极易误判成"自动部署没触发"。点进 build 日志看具体报错（本例即 4.6 的 `npm install` ERESOLVE） |
| 本机 cron 端点返回 401 | `.env.local` 的 `CRON_SECRET` 与 Vercel 生产值可能不同（该变量在 Vercel 侧为 sensitive，不可导出查看）；以 GitHub Actions 里那份为准 |

## 6. 安全与备份清单

- [ ] `ENCRYPTION_KEY`、`AUTH_SECRET`、`CRON_SECRET` 已存密码管理器（Vercel 内不可导出）
- [ ] 阿里云开启域名自动续费
- [ ] （可选升级）Resend 验证 `<your-domain>` 域名后，`SMTP_FROM` 换 `noreply@<your-domain>`
- [ ] 密钥轮换：改 `ENCRYPTION_KEY` 会使已存 API Key 全部失效（需重新录入），非必要不动
