/**
 * T0.5 火山签名 spike（go/no-go 闸门，DEV-GUIDE §10 / 决策 D1）。
 *
 * 用真实「费用中心只读 IAM 子用户」AK/SK 独立跑通一次 QueryBalanceAcct 签名调用与字段解析：
 *   npx tsx scripts/spike-volc-sig.ts
 * 环境变量：VOLC_AK（AccessKeyId）、VOLC_SK（SecretAccessKey，不打印）。
 *
 * 判定（D1 对冲）：跑通 → M3 继续；失败 → 输出原因，M3 顺延、先发 DeepSeek+Kimi。
 * 输出脱敏：只打印 AccountID 与金额字段，绝不打印 AK/SK/完整响应头。
 * host：billing.volcengineapi.com（官方费用中心文档；open.volcengineapi.com 为调试网关）。
 */
import path from "node:path";
import { signVolcRequest } from "../lib/providers/volcengine/sigv4";
import { toMoney } from "../lib/money";

// 便利：允许把只读 IAM 子用户凭证放在 .env.local（VOLC_AK / VOLC_SK），不必每次设环境变量。
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // 文件不存在时忽略
}

const HOST = "billing.volcengineapi.com";
const SERVICE = "billing";
const REGION = "cn-beijing";

interface QueryBalanceResult {
  AccountID?: number | string;
  AvailableBalance?: string;
  CashBalance?: string;
  CreditLimit?: string;
  FreezeAmount?: string;
  ArrearsBalance?: string;
}

async function main(): Promise<void> {
  const ak = process.env.VOLC_AK?.trim();
  const sk = process.env.VOLC_SK?.trim();
  if (!ak || !sk) {
    console.error("缺少 VOLC_AK / VOLC_SK 环境变量（费用中心只读 IAM 子用户凭证）");
    process.exit(2);
  }
  if (!/^AKLT/.test(ak)) {
    console.error("VOLC_AK 需以 AKLT 开头（IAM 子用户 AK）；ARK 推理 Key 与主账号不适用");
    process.exit(2);
  }

  const dateTime = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const signed = signVolcRequest({
    method: "GET",
    host: HOST,
    query: { Action: "QueryBalanceAcct", Version: "2022-01-01" },
    service: SERVICE,
    region: REGION,
    ak,
    sk,
    dateTime,
  });

  console.log(`[spike] GET ${signed.url}`);
  try {
    const res = await fetch(signed.url, {
      method: "GET",
      headers: signed.headers,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      console.error(`[spike] 响应非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
      process.exit(1);
    }

    const resp = body as {
      ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
      Result?: QueryBalanceResult;
    };
    const err = resp.ResponseMetadata?.Error;
    if (err) {
      const code = err.Code ?? "";
      const message = err.Message ?? "";
      console.error(`[spike] 业务错误 code=${code} message=${message}`);
      if (code === "SignatureDoesNotMatch" || code === "100010") {
        console.error("[spike] 结论：签名不匹配（INVALID）——检查 AK/SK 与时钟（X-Date 必须 UTC 且误差小）");
        process.exit(3);
      }
      if (code === "AccessDenied" || code === "100013") {
        console.error("[spike] 结论：无 billing 权限（FORBIDDEN_SCOPE）——请给子用户绑定 BillingCenterReadOnlyAccess");
        process.exit(4);
      }
      if (code === "InvalidTimestamp" || code === "100006") {
        console.error("[spike] 结论：时间戳非法（本机时钟偏差过大）");
        process.exit(5);
      }
      process.exit(1);
    }

    const result = resp.Result;
    if (!result) {
      console.error(`[spike] 无 Result 字段：${text.slice(0, 300)}`);
      process.exit(1);
    }
    console.log("[spike] ✅ 签名调用与字段解析成功（go）");
    console.log(`  AccountID        = ${result.AccountID ?? "-"}`);
    console.log(`  AvailableBalance = ${result.AvailableBalance !== undefined ? toMoney(result.AvailableBalance) : "-"}`);
    console.log(`  CashBalance      = ${result.CashBalance !== undefined ? toMoney(result.CashBalance) : "-"}`);
    console.log(`  CreditLimit      = ${result.CreditLimit !== undefined ? toMoney(result.CreditLimit) : "-"}`);
    console.log(`  FreezeAmount     = ${result.FreezeAmount !== undefined ? toMoney(result.FreezeAmount) : "-"}`);
    console.log(`  ArrearsBalance   = ${result.ArrearsBalance !== undefined ? toMoney(result.ArrearsBalance) : "-"}`);
  } catch (err) {
    console.error(`[spike] 网络/超时错误：${err instanceof Error ? err.name : "unknown"}`);
    process.exit(1);
  }
}

main();
