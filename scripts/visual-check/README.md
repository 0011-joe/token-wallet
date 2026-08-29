# DeepBalance 视觉验收（visual-check）

真实浏览器（Playwright + 本机 Microsoft Edge，`channel: msedge`，无需下载浏览器）对仪表盘、Key 管理、设置页做端到端视觉/交互验收，并自动登录（魔法链接从服务端控制台日志提取）。

## 目录

| 文件 | 说明 |
| --- | --- |
| `run-visual-check.js` | 主验收脚本（T1 鉴权 → T2 登录 → T3 Key 表单 → T4 造数 → T5 仪表盘 → T6 响应式 → T7 Key 管理 → T8 设置） |
| `seed.js` | 造数脚本：QA 用户 / Key B（余额不足态）/ 待删 Key / Key A 快照（14+ 天、缺口日、不可用日、充值、USD）/ 3 条预警事件 |
| `shots/` | 截图输出（本 README 下 git 不管理，可随时重跑覆盖） |
| `results.json` | 机器可读的验收结果（PASS/FAIL + 截图清单） |
| `server.log` | 脚本托管的 `next start` 服务日志（魔法链接来源） |

## 复跑步骤

```bash
cd deepbalance
npm install -D playwright --fetch-retries=5 --fetch-timeout=180000   # 首次
npm run build                                                        # 业务代码变更后需重构建
node scripts/visual-check/run-visual-check.js
echo "exit=$?   # 0=全部 PASS, 1=存在 FAIL"
```

脚本会**自己启动** `next start`（端口 3000）并在结束时关闭它。不要先手动占用 3000 端口（否则脚本无法解析魔法链接日志，会报错退出）。

可选参数：

- `--email xxx@example.com`：登录用户（默认 `qa-visual@example.com`，未注册会自动创建）。
- `--attach`：使用已在运行的服务，并尝试从 `server.log` 尾部提取魔法链接（不推荐）。
- 环境变量 `QA_HEADFUL=1`：有头模式调试；`QA_PORT=3001`：换端口。

## 它做了什么

1. **T1** 未登录访问 `/dashboard` `/keys` `/settings` → 断言 307 → `/login`。
2. **T2** 登录链路：`/login` 输入邮箱 → 服务端日志提取魔法链接 → 打开链接 → 会话 cookie 建立。
3. **T3** 添加 Key：非法格式（`sk-123`）前端即时拦截提示；随后粘贴 `.env.local` 里的
   `DEEPSEEK_API_KEY`（**运行时读取，绝不写入脚本/日志/报告**，报告只引用 last4）实测校验入库。
4. **T4** `node scripts/visual-check/seed.js`：为 Key A 生成确定性的快照序列
   （余额 ¥1,281.50、今日消耗 ¥0.55、本月消耗 ¥26.60、缺口日琥珀点、多币种 USD）；
   导入分模型 CSV 时可同时选择 cost 文件（币种 CNY 随 amount 一起入库）。
5. **T5–T8** 四卡数值/估算口径弹层/趋势 7-30-90 切换/余额构成环形图/Key 切换下拉（含不可用态）/
   分模型空态引导 + cost 文件报错 + amount CSV 导入 + byType 明细/响应式 375×812 与 1024/
   Key 列表掩码与启停/删除确认/设置保存持久化。每步截图到 `shots/`。

## 造数与清理

`seed.js` 幂等：重复运行会先清掉 QA 数据再重建（真实 Key 行保留，只重建其快照）。

```bash
# 完整清除 QA 数据（QA 用户连同其 Key/快照/设置/事件一并删除）
node scripts/visual-check/seed.js --email qa-visual@example.com --clean
```

说明：QA 造数都在 `qa-visual@example.com` 名下（Key A 为真实导入的 Key，
last4 见 `results.json` 的 `keyALast4`）；清理前该用户的会话 cookie 已失效，
重新登录即可。

## 已知限制

- 删除 Key 的二次确认是浏览器原生 `window.confirm`，Playwright 无法截图；
  脚本用 dismiss/accept 两种路径验证行为（取消=保留、确认=删除）。
- 分模型 CSV 的 month 取自 `start_time_iso`，样本文件（2026-07-31 ~ 08-28）解析为
  `2026-08`；若月末跨月样本会 422（见 `T5f-cost` 的错误路径验证）。
- 真实 Key 的 POST /api/keys 会调 DeepSeek 官方余额接口（10s 超时）。网络不可达时
  脚本记录 FAIL 并回退为沙箱 Key A（`last4 8888`），其余验收照常。

## 说明与调优（QA 实测记录）

- **缺口阈值**：产品默认 `SNAPSHOT_GAP_MAX_MS` 缺省 2h（对应每小时 cron）。QA 种子为日频快照，
  若跑全程建议：`SNAPSHOT_GAP_MAX_MS=129600000 node scripts/visual-check/run-visual-check.js`
  （36h）——只把「48h 缺口」标记为缺口日（2 个琥珀点 + 面积线连续），否则全部日频间隔都会被标为缺口。
- **空态引导截图**：`node scripts/visual-check/capture-empty-guide.js`（先清该用户分模型导入记录 →
  登录 → 截 `12-model-usage-empty-guide.png` → 重传 amount CSV 恢复数据）。
- **重复添加 Key 的 409 证据**：`node scripts/visual-check/capture-rebind-409.js`（截 `04-rebind-409-already-bound.png`）。
- **证据归档**：任一轮完整 25 项全绿的截图与 `results.json` 会被复制到 `scripts/visual-check/evidence-final/`，
  避免后续并发运行覆盖。
- **清理**：`node scripts/visual-check/seed.js --email qa-visual@example.com --clean` 删除 QA 用户（连带 Key/快照/设置/事件），
  或手工：删除 User 行 cascade；UsageImport 单独 `deleteMany`。
- **已知断言口径**：T5a 的今日/本月金额为 seed.js 摘要中的「与后端同一公式复算值」——当前公式下
  数值由种子数据的 口径（消费只降 total、不改变 grant/topped 构成）决定；用真实 DeepSeek 数据时
  请留意报告中的缺陷 #1。
