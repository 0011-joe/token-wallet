# DeepBalance M1 探针笔记

## Q1 CSV 结构结论

- 探针脚本: scripts/spike-csv.ts, 运行命令: node scripts/spike-csv.ts
- 文件1 amount-2026-07-31_2026-08-28.csv: 7 行数据; 列名: "user_id", "start_time_iso", "end_time_iso", "model", "api_key_name", "api_key", "type", "price", "amount"
- type 取值全集: input_cache_hit_tokens x2, input_cache_miss_tokens x2, request_count x1, output_tokens x2
- price 分布(type x price, 同 type 存在多档价格):
  - input_cache_hit_tokens | price=0.00000005 | 行数=1 | amount合计=14242048
  - input_cache_hit_tokens | price=0.0000001 | 行数=1 | amount合计=126464
  - input_cache_miss_tokens | price=0.0000015 | 行数=1 | amount合计=576617
  - input_cache_miss_tokens | price=0.000003 | 行数=1 | amount合计=76863
  - request_count | price=(空) | 行数=1 | amount合计=302
  - output_tokens | price=0.0000045 | 行数=1 | amount合计=212625
  - output_tokens | price=0.000009 | 行数=1 | amount合计=4735
- 模型 ID 全集: deepseek-v4-flash-vision-exp x7
- request_count: 行数=1, price=(空字符串) => 无价格
- api_key 字段: 7 行全部为打码形态(含 *), 长度=35x7, 唯一值 1 个; 打码规则: 长度=35; 是否以标准API key前缀(即 s 加 k 加连字符)开头: 是; 星号数=23; 星号分段长度序列(真实字符段长度): 8+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+0+4; 去除星号后非星字符数=12; 形状: xx-xxxxx***********************xxxx; api_key_name: 铠 x7
- 按模型 token 合计:
  - model=deepseek-v4-flash-vision-exp: input_cache_hit_tokens=14368512, input_cache_miss_tokens=653480, output_tokens=217360; request_count合计=302
- 文件2 cost-2026-07-31_2026-08-28.csv: 1 行数据; 列名: "user_id", "start_time_iso", "end_time_iso", "model", "wallet_type", "cost", "currency"
- wallet_type 取值: Paid x1
- cost 合计=2.8196908, currency=CNY

## Q2 余额接口结论

- 探针脚本: scripts/spike-balance.ts, 运行命令: node --env-file=.env.local scripts/spike-balance.ts
- 端点: GET https://api.deepseek.com/user/balance, Bearer 认证(已脱敏), 超时 10000ms, 共发起 2 次调用
- 第1次: HTTP 200, 耗时 144ms
- 第2次: HTTP 200, 耗时 139ms
- 200 响应 JSON 结构(字段路径	类型	样例):
  - $.is_available: boolean, 样例=true
  - $.balance_infos: array(len=1), 样例=
  - $.balance_infos[0].currency: string, 样例="CNY"
  - $.balance_infos[0].total_balance: string, 样例="6.32"
  - $.balance_infos[0].granted_balance: string, 样例="0.00"
  - $.balance_infos[0].topped_up_balance: string, 样例="6.32"
- 字段清单: $.is_available, $.balance_infos, $.balance_infos[0].currency, $.balance_infos[0].total_balance, $.balance_infos[0].granted_balance, $.balance_infos[0].topped_up_balance
- 限流情况: 未观察到限流相关响应头
- 请求头为 Authorization: Bearer <已脱敏>; 本笔记与输出不含任何明文 key 片段。
