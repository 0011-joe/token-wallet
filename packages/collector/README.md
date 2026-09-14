# @token-wallet/collector（MVP）

本地采集器骨架：把 DSH/宿主侧聚合后的日用量上报到 token-wallet。

## 约束（红线）

- 只上传 `(provider, model, date, 五桶 token, requests)`
- 禁止上传会话 ID/标题/prompt/响应/文件路径
- 密钥为服务端创建的 **每设备 ingestKey**（`/api/ingest-devices`）

## 最小用法

```ts
import { pushUsageDays } from "./index";

await pushUsageDays(
  { baseUrl: "https://your-domain", ingestKey: process.env.TW_INGEST_KEY! },
  [
    {
      provider: "deepseek",
      model: "deepseek-chat",
      date: "2026-09-14",
      inputTokens: "1000",
      outputTokens: "200",
      cacheHitTokens: "0",
      cacheMissTokens: "1000",
      reasoningTokens: "0",
      requests: 3,
    },
  ]
);
```

完整 DSH 事件挂钩（复用 v1 `session/event`）在后续卡接入；本骨架只保证 ingest 协议。
