# 邮件发信引导（Resend / SMTP）运维手册

> 面向部署与运维。产品内对应「设置 → 邮件与发信」区块（`components/settings/email-onboarding.tsx`）。
> 渠道探测逻辑：`lib/email/channel-status.ts`（优先 RESEND_API_KEY → 其次 SMTP 三件套 → 否则 console）。
> **安全红线：本文不含任何密钥值**；密钥只写「放在哪」。

## 1. 渠道优先级

| 优先级 | 条件 | channel | 行为 |
|---|---|---|---|
| 1 | `RESEND_API_KEY` 非空 | `resend` | Resend SDK 发信 |
| 2 | `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` 齐全 | `smtp` | nodemailer 发信 |
| 3 | 以上皆无 | `console` | **不发信**：登录验证码只打印在服务端控制台（**生产会拒绝签发并返回 503**） |

状态只读接口：`GET /api/auth/email-status` → `{ email: { configured, channel, hint }, inviteRequired, allowlistEnabled }`。

## 2. 推荐路径：Resend

### 2.1 注册与 API Key

1. 打开 [resend.com](https://resend.com) 注册。
2. 进入 [API Keys](https://resend.com/api-keys) → Create API Key（Production；权限 Full access 或 Sending only）。
3. 复制 `re_` 开头的密钥（只显示一次，丢失去密码管理器备份后重新生成）。
4. 写入环境变量 `RESEND_API_KEY`：
   - 生产：Vercel → Settings → Environment Variables → Production；
   - 本地：`.env.local`。
5. 改完 **Redeploy / 重启** 才生效。

### 2.2 域名验证（生产必做）

1. 打开 [Domains](https://resend.com/domains) → Add Domain（如 `example.com`）。
2. 按 Resend 提示在 DNS 服务商添加：
   - **TXT**：域名验证 / SPF；
   - **CNAME**：DKIM；
   - **MX**：Return-Path（若提示）。
3. 等待状态变为 **Verified**（DNS 传播可能数分钟到数小时）。
4. 未验证域名时，发件人只能是 `onboarding@resend.dev`。

### 2.3 配置发件人

```text
SMTP_FROM="token-wallet <noreply@example.com>"
```

- 域名必须与 Resend **已验证**域名一致，否则 Resend 会拒发（403 / validation error）。
- 该变量 Resend 与 SMTP 路径共用（见 `lib/email/mailer.ts` 的 `emailFrom()`）。

### 2.4 免费档限制（务必知悉）

| 场景 | 限制 |
|---|---|
| 免费档 + 未验证域名 | 只能发往 **Resend 账号绑定邮箱**；发件人固定 `onboarding@resend.dev` |
| 免费档 + 已验证域名 | 可发任意收件人，但日发送量有限（当前约 100 封/天，以 Resend 控制台为准） |
| 超量 / 违规 | 发送失败，看 Resend Logs 中的 bounce / rate limit |

## 3. 备选路径：SMTP

在 **不配置** `RESEND_API_KEY` 时生效（有 Key 时 Resend 优先）。

| 变量 | 说明 |
|---|---|
| `SMTP_HOST` | 服务器主机名 |
| `SMTP_PORT` | 465（TLS 直连）或 587（STARTTLS） |
| `SMTP_USER` | 账号 |
| `SMTP_PASS` | 密码 / 授权码 |
| `SMTP_FROM` | 发件人，须被该服务商允许 |
| `SMTP_SECURE` | 可选：`true`/`false`；未设置时端口 465 自动 secure |

示例（企业邮 587）：

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=<授权码>
SMTP_FROM="token-wallet <noreply@example.com>"
```

## 4. 未配置时的危险状态

`channel=console` 时：

- 登录页提示「开发态请查看服务端控制台」；
- **其他邮箱无法登录**（验证码不会外发；生产环境发码接口直接 503）；
- 预警邮件降级为控制台预览。

生产环境上线检查清单必含：`RESEND_API_KEY` 或完整 SMTP 三件套 + 合法 `SMTP_FROM`。

## 5. 配置后自检

1. `GET /api/auth/email-status`（或设置页「邮件与发信」）确认 `channel` 与 `configured: true`。
2. 登录页对目标邮箱发送验证码，收件箱应在 1 分钟内到达（垃圾箱也查）。
3. Resend 用户打开 Logs 确认状态 delivered；SMTP 用户看服务端日志无 `smtp 发送失败`。

## 6. 排障表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 收不到邮件 | channel=console，未真正配置 | 查环境变量是否写入并 **Redeploy**；`/api/auth/email-status` 确认 channel |
| 收不到邮件 | Resend 免费档只发账号邮箱 | 验证自有域名，或用账号邮箱测试 |
| 收不到邮件 | 进了垃圾箱 / 被企业邮拦截 | 查垃圾箱；验证域名后 SPF/DKIM 齐全可显著降低拦截 |
| 收不到邮件 | DNS 未生效或记录填错 | Resend Domains 页看具体记录是否 Verified；用 `dig TXT/CNAME/MX` 核对 |
| 收不到邮件 | 触发 Resend 日发送量 | Resend Logs 看 rate limit；升级套餐或减少重试 |
| 发送接口 502 / 超时 | Resend/SMTP 服务或出网异常 | 稍后重试；查部署平台函数日志；确认运行时能访问 resend.com:443 / SMTP 端口 |
| 发送接口 502 | 本机/机房 DNS 解析失败 | 换 DNS 或检查容器网络 |
| from 被拒（validation / 403） | `SMTP_FROM` 域名未在 Resend 验证 | 改为 `noreply@已验证域名`，或先完成域名验证 |
| from 被拒 | SMTP 服务商不允许该发件地址 | 改成该邮箱账号本身或已授权别名 |
| `smtp 发送失败: Invalid login` | 授权码/密码错误，或未开 SMTP | 重置授权码；确认服务商已开启 SMTP |
| `smtp 发送失败: Greeting never received` | 端口/加密方式不匹配 | 465 配 TLS；587 走 STARTTLS（勿设 SMTP_SECURE=true） |
| 改了 Key 仍走旧渠道 | 进程缓存旧 env | Vercel 重新部署；本地重启 `npm run dev` |

## 7. 相关文件

| 路径 | 职责 |
|---|---|
| `lib/email/channel-status.ts` | 渠道探测与 hint（只读） |
| `lib/email/mailer.ts` | 统一发送：Resend → SMTP → unconfigured |
| `lib/email/otp-mail.ts` | 登录验证码邮件 |
| `lib/email/send.ts` | 预警邮件 |
| `app/api/auth/email-status/route.ts` | 状态只读 API |
| `components/settings/email-onboarding.tsx` | 设置页引导 UI |
| `docs/deployment.md` | 全局部署手册（环境变量总账） |
