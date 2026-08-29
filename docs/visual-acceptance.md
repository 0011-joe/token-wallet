# DeepBalance 视觉与交互验收报告

- 执行：QA（swarm-B），日期 2026-08-29（UTC 2026-08-28 22:50 收官轮）
- 环境：Windows / Node 24 / Edge（Playwright `channel: msedge`，headless）/ 服务 `next start` 端口 3000
- 数据：QA 用户 `qa-visual@example.com`；造数 `scripts/visual-check/seed.js`（幂等，本次 24 条快照 + 2 假 Key + 3 预警事件）
- Key：真实 DeepSeek Key 经表单导入（**明文仅运行时读入浏览器，未落任何文件/日志/报告**；报告仅以 `sk-…d8d7` 引用）
- 结果：**25 项全部 PASS（25/25，0 FAIL）**，第 7/8/10 三轮 + 并行重跑一轮共 4 次全绿复现

## 1. 总览

| 区段 | 检查项 | 结果 | 截图 |
| --- | --- | --- | --- |
| T1 | 未登录访问 `/dashboard` `/keys` `/settings` → 307 `/login` | PASS | — |
| T2a | 魔法链接生成（服务端控制台提取） | PASS | 01-login-page |
| T2b | 魔法链接回调后会话建立（**落地 `/login`，见缺陷 #2**） | PASS（告警） | — |
| T2c | 登录链路 → 会话 cookie → `/dashboard` 渲染 | PASS | 02-login-session-dashboard |
| T3a | 非法 Key 格式（`sk-123`）前端即时拦截 | PASS | 03-key-invalid-format |
| T3b | 真实 Key 导入（`sk-…d8d7`，实测校验通过并加密入库；重复添加 409 拒绝） | PASS | 04-rebind-409-already-bound |
| T4 | seed 造数（快照 24 条 / 缺口 / 不可用 / 充值 / USD / 事件 3 条） | PASS | — |
| T5a | 四卡数值（余额=最新快照 `¥1,281.50`；今日/本月估算 `¥0.55`/`¥26.60` 均挂估算标识×3；状态卡可调用） | PASS | 05-dashboard-four-cards |
| T5b | 「估算」标识 → 口径说明弹层开/关 | PASS | 06-estimate-dialog |
| T5c | 趋势 30 天：缺口日 2 个琥珀点 + 断点 + 图例；7/30/90 切换重绘（刻度 12/15/17） | PASS | 07/08/09 |
| T5d | 余额构成环形图（赠金 15.6% / 充值 86.5%） | PASS | 10-balance-composition |
| T5e | Key 切换下拉（4 选项；切到不可用 Key 显示「余额不足，无法调用」；切回复原） | PASS | 11-dashboard-keyB-unavailable |
| T5f | 分模型空态三步引导 + 官方链接；cost 单独上传报错；amount(+cost) 导入 → 占比行 + 币种 CNY；byType 明细 7 行 | PASS | 12/13/14/15 |
| T6 | 响应式：375×812 卡片纵向堆叠（宽 343）；1024 平面正常 | PASS | 16/17 |
| T7a | Key 列表掩码 `sk-••••xxxx` + 状态文字「正常」（3 处） | PASS | 18-keys-list-masked |
| T7b | Switch 启停：`aria-checked` true→false→true + 「已停用」标签反馈 | PASS | 19-keys-toggle-off |
| T7c | 删除：confirm 取消=保留 / 确认=删除（原生 confirm 无法截图，行为验证） | PASS | 20-keys-deleted |
| T8a | 设置页布局：默认 20/3/双勾选、3 条预警事件、当前邮箱、登出/注销按钮存在（未点击） | PASS | 21-settings-page |
| T8b | 预警设置 55/5/邮件关 → 保存「已保存」→ reload 值保留 → GET `/api/alerts` 一致 | PASS | 22-settings-saved |
| T8c | 恢复默认 20/3/勾选 → 保存 → 再次校验 | PASS | 23-settings-restored |

## 2. 截图证据

`scripts/visual-check/shots/`（23 张，见上表 `01`–`23`）。归档副本：`scripts/visual-check/evidence-final/`
（2026-08-29 06:50 收官轮：22 张 + results.json；外加 04-rebind-409 与 12-empty-guide 属补充轮证据）。
机器可读结果：`scripts/visual-check/results.json`（25 条记录，全部 `pass:true`，含 `keyALast4:"d8d7"`）。

## 3. 数值对账（本轮实测）

| 卡片 | 实测 | 来源 |
| --- | --- | --- |
| 账户总余额 | `¥1,281.50`（赠金 `¥200.00` / 充值 `¥1,108.10`，USD `$19.90` 多币种提示），更新于 5 分钟前 | 最新快照 |
| 今日消耗 | `¥0.55`（估算标识 + 「由余额快照差值估算」） | seed 摘要=SQL 复算一致 |
| 本月消耗 | `¥26.60`（= 逐日 1.35×19 − 充值段 + 跨日段 0.40 + 今日 0.55） | 逐笔对账一致 |
| 余额构成 | 赠金 `¥200.00`（15.6%）/ 充值 `¥1,108.10`（86.5%） | 环形图 2 扇区 |
| 趋势 30 天 | 缺口日 2 个（08/17 恢复日、08/28 跨午夜恢复日）+ 08/15 归并尖峰 2.70 | `dailyAggregate` 口径 |
| 分模型 | 2026-08 共 1 个模型（deepseek-v4-flash-vision-exp），合计费用 2.82，总 Token 15,239,352，byType 7 行 | 官方样本 amount CSV |
| 最近预警 | 3 条（低余额 / 不可用 critical / Key 异常） | seed 事件 |

## 4. 发现的缺陷 / 风险（按严重度）

### #1【高危·产品语义】今日/本月消耗估算在真实 DeepSeek 数据下恒为 ¥0

`lib/billing/snapshot-delta.ts:47-54` 的 `deltaCost = -(Δtotal) + ΔtoppedUp + Δgranted`。
DeepSeek `/user/balance` 的恒等式为 `total_balance = granted_balance + topped_up_balance`
（M1 探针真实样本：`6.32 = 0.00 + 6.32`，见 `scripts/spike-notes.md` Q2），因此

```
Δcost = -(ΔG + ΔT) + ΔT + ΔG ≡ 0    （无论消费来自赠金还是充值、无论是否有充值/赠金事件）
```

即：**真实数据下今日/本月消耗、趋势日成本全部恒为 0**（页面显示 ¥0.00）。本轮 25 项 PASS 用的是
「消费只降 total、不改变 grant/topped 构成」的种子口径（与规格卡 C 的字面假设一致），回避了该恒等式；
一旦换成真实余额流（消费扣减对应桶），功能即失效。

- 佐证：单测 `tests/billing-snapshot-delta.test.ts` 的 fixtures（如 `total 100→90, granted=topped=0`）
  均破坏 `total=granted+topped` 恒等式，故公式在单测中"正常"；真实数据场景无覆盖。
- 建议：
  1. 口径改为「事件增量」建模：`Δcost = -Δtotal + max(0,ΔtoppedUp) + max(0,Δgranted)`（充值/赠金增量只计正值），
     并接受"充值足额时会低估当日消耗"的边界；或
  2. 在 Cron 快照落库时同步记录充值/赠金事件（新增表或字段）；或
  3. 至少为该恒等式补一条真实形态的单测（granted=0、topped=total 且消费扣 topped），标红当前实现。

### #2【低·UX】魔法链接登录后回落 `/login` 而非进入应用

T2b：`?callbackUrl=http%3A%2F%2Flocalhost%3A3000%2Flogin`（见 server.log），回调后落地 `/login`
（已登录亦显示登录表单）。建议：登录页 `signIn("email", { callbackUrl: "/dashboard" })`，或 `/login`
对已登录用户 `redirect("/dashboard")`。

### #3【低·观察】新导入 Key 在 Key 列表无状态文案（空窗至首次快照拉取）

真实导入路径（`lib/keys/service.ts addKey`）不写 `lastStatus`（保持 null），列表不显示「正常/待拉取」。
依代码语义，`lastStatus` 仅由 `/api/cron/snapshot` 更新（本环境无调度器进程，需外部触发）。
建议：添加即实测已通过，可直接置 `lastStatus:"OK"`；至少为 null 态补「待拉取」文案。

### #4【低·观察】首次 CSV 导入成功后「已导入…」提示被组件卸载吞掉

`ModelUsage` 空态 GuideBlock 在上传成功后因 models 查询刷新而被 ModelsBlock 替换，`UsageUpload` 卸载，
成功提示随即消失（脚本已改为等待占比行断言）。建议：成功态提升到 Card 级 toast/横幅，避免提示闪现。

### 非缺陷说明

- 余额构成占比 15.6%+86.5%=102.1%：QA 种子构造「消费只降 total」导致桶与总额不闭合；
  真实数据 `total=granted+topped` 时占比恰为 100%（公式输出与产品预期一致时无此现象）。
- 趋势图 08/15 尖峰 2.70：48h 缺口段的消耗归并到段起点日（08/15）+ 当日 1.35，属设计口径（PRD 段归并），非 bug。
- 缺口日判定阈值 2h（每小时 cron 默认）：QA 日频快照需以 `SNAPSHOT_GAP_MAX_MS=129600000`（36h）运行演示，
  仅作用本次 QA；生产默认口径不变。

## 5. 未覆盖 / 限于交互验证的项

| 项 | 状态 |
| --- | --- |
| 邮件真实发送（SMTP/Resend） | 未配置凭据 → 魔法链接走开发态控制台（auth.ts 分支正确），真实发送逻辑未端到端验证 |
| 注销账户（确实删除数据） | **红线：未点击**；按钮存在与二次确认 UI 已验证（T8a） |
| Key 明文展示 | 任何页面/日志/报告均无明文；密码输入框 + last4 掩码符合安全要求 |
| 生产部署形态（`next start` 已用） | dev 模式未测（一致构建产物） |

## 6. 复跑命令

```bash
cd deepbalance && npm install -D playwright && npm run build
SNAPSHOT_GAP_MAX_MS=129600000 node scripts/visual-check/run-visual-check.js   # 25 项全绿即验收通过
```

详见 `scripts/visual-check/README.md`（造数/清理/辅助截图脚本）。

## 7. 环境状态备注

- 验收数据在 `dev.db` QA 用户（`qa-visual@example.com`）下，与业务数据隔离；清理：
  `node scripts/visual-check/seed.js --email qa-visual@example.com --clean`。
- 并行 agent（swarm-A 邮件发送、swarm-C cost CSV/币种展示）在本次验收期间完成合入；
  收官轮（06:50）在合入后产物上运行：`T5f-cost` 文案更新为「cost 文件需与 amount 文件一起」、
  `T5f-import` 已见「币种 CNY」——均以最新代码为准通过。
