/**
 * M5 / T5.1 CSV 解析与校验（规格卡 D 前半）。
 *
 * 列名以 M1 探针 Q1（scripts/spike-notes.md）为准，不得臆造：
 *   amount 文件：user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount
 *   cost 文件：  user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency
 *
 * 费用口径：amount 文件单行 cost = price × amount（request_count 无单价，记为 0）。
 * 金额量级 ≤ 个位，用 Number 直接相乘即可（IEEE-754 误差远小于 1e-12，
 * 与官方 cost 文件合计一致，AC4-1，见 tests/usage-csv-parse.test.ts）。
 * cost 文件（Q4）：解析出合计 / 币种，随 amount 一起入库（UsageImport.currency），
 * models 接口返回真实币种；wallet_type 只解析不落库（前端暂未消费）。
 */
import Papa from "papaparse";
import { z } from "zod";

/** M1 探针 Q1：type 取值全集（不得增删） */
export const USAGE_TYPES = [
  "input_cache_hit_tokens",
  "input_cache_miss_tokens",
  "output_tokens",
  "request_count",
] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

/** M1 探针 Q1：amount 文件必需列（顺序即官方导出顺序，多余列忽略） */
export const REQUIRED_COLUMNS = [
  "user_id",
  "start_time_iso",
  "end_time_iso",
  "model",
  "api_key_name",
  "api_key",
  "type",
  "price",
  "amount",
] as const;

/** M1 探针 Q1：cost 文件必需列（顺序即官方导出顺序，多余列忽略） */
export const REQUIRED_COST_COLUMNS = [
  "user_id",
  "start_time_iso",
  "end_time_iso",
  "model",
  "wallet_type",
  "cost",
  "currency",
] as const;

export interface ParsedUsageRow {
  model: string;
  /** amount 文件里的 api_key 打码值（官方已脱敏，原样存储） */
  apiKeyRef: string | null;
  type: UsageType;
  /** request_count 行为 null（官方该行 price 为空串） */
  unitPrice: number | null;
  /** token 数或请求次数，非负整数 */
  amount: number;
  /** price × amount；request_count 为 0 */
  cost: number;
}

export interface ParsedUsage {
  /** "YYYY-MM"，从 start_time_iso 提取；整单内所有行必须同月 */
  month: string;
  rows: ParsedUsageRow[];
}

export interface ParsedCost {
  /** "YYYY-MM"，从 start_time_iso 提取；整单内所有行必须同月 */
  month: string;
  /** cost 列合计（多行求和；IEEE-754 误差与官方合计一致，AC4-1） */
  totalCost: number;
  /** 币种（官方取值如 CNY / USD），整单所有行必须一致 */
  currency: string;
  /** 首个非空 wallet_type 值（官方取值为 Paid 等） */
  walletType?: string;
}

/** 格式非法（列缺失 / type 非法 / 数值非法 / 编码异常等），message 面向用户可读 */
export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/** 表头第 1 行，数据从第 2 行起（用于报错定位） */
const HEADER_LINES = 1;

// papaparse 默认不转类型，全部字段是 string；这里只取需要的字段，
// 官方增列不受影响；必需列缺失在解析前单独报「缺少列：xxx」。
const rowSchema = z.object({
  model: z.string().min(1, "model 为空"),
  api_key: z.string().min(1, "api_key 为空"),
  type: z.enum(USAGE_TYPES, {
    message: `type 取值非法，合法值：${USAGE_TYPES.join(" / ")}`,
  }),
  amount: z.string().transform((v, ctx) => {
    const s = v.trim();
    if (!/^\d+$/.test(s)) {
      ctx.addIssue({ code: "custom", message: "amount 必须是非负整数" });
      return z.NEVER;
    }
    return Number(s);
  }),
  price: z.string().transform((v, ctx) => {
    const s = v.trim();
    if (s === "") return null; // request_count 行无单价（M1 探针 Q1）
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: "custom", message: "price 必须是数字（或空串）" });
      return z.NEVER;
    }
    return n;
  }),
});

const MONTH_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function extractMonth(iso: string, rowNo: number): string {
  const m = MONTH_RE.exec(iso.trim());
  if (!m) {
    throw new CsvParseError(`第 ${rowNo} 行 start_time_iso 无法识别月份：${iso}`);
  }
  return `${m[1]}-${m[2]}`;
}

/**
 * 解析官方 amount CSV（UTF-8 文本）。
 * 非法格式一律抛 CsvParseError（绝不静默丢弃），message 带定位与原因（AC4-3）。
 */
export function parseUsageCsv(csvText: string): ParsedUsage {
  if (typeof csvText !== "string" || csvText.trim() === "") {
    throw new CsvParseError("CSV 内容为空");
  }
  // 编码异常：替换字符（U+FFFD）说明不是合法 UTF-8 文本
  if (csvText.includes("\uFFFD")) {
    throw new CsvParseError(
      "CSV 包含乱码字符（疑似非 UTF-8 编码），请导出为 UTF-8 后重新上传"
    );
  }
  // papaparse 会自行去掉 BOM，这里再兜底一次
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  // 必需列齐全（缺列 → 明确报「缺少列：xxx」）
  const fields = result.meta.fields ?? [];
  const missing = REQUIRED_COLUMNS.filter((c) => !fields.includes(c));
  if (missing.length > 0) {
    throw new CsvParseError(
      `缺少列：${missing.join("、")}（CSV 需包含：${REQUIRED_COLUMNS.join(", ")}）`
    );
  }

  if (result.errors.length > 0) {
    const e = result.errors[0];
    const at = typeof e.row === "number" ? `（第 ${e.row + HEADER_LINES + 1} 行）` : "";
    throw new CsvParseError(`CSV 解析错误${at}：${e.message}`);
  }

  if (result.data.length === 0) {
    throw new CsvParseError("CSV 无数据行（只有表头或空文件）");
  }

  let month: string | null = null;
  const rows: ParsedUsageRow[] = result.data.map((raw, i) => {
    const rowNo = i + HEADER_LINES + 1;
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path.join(".") || "行";
      // type 枚举错误消息为静态文案，附加实际值便于用户定位
      const detail =
        field === "type" ? `（实际值：${String(raw.type ?? "")}）` : "";
      throw new CsvParseError(
        `第 ${rowNo} 行「${field}」校验失败：${issue.message}${detail}`
      );
    }
    const { model, api_key, type, amount, price } = parsed.data;

    const rowMonth = extractMonth(String(raw.start_time_iso ?? ""), rowNo);
    if (month === null) {
      month = rowMonth;
    } else if (month !== rowMonth) {
      throw new CsvParseError("文件包含多个月份数据（请按月份分别导入）");
    }

    return {
      model,
      apiKeyRef: api_key,
      type,
      unitPrice: price,
      amount,
      cost: (price ?? 0) * amount,
    };
  });

  // 上面已保证 rows 非空，首行必然设置 month；此处兜底可让 TS 收窄类型
  if (month === null) {
    throw new CsvParseError("CSV 无数据行（只有表头或空文件）");
  }
  return { month, rows };
}

const costRowSchema = z.object({
  cost: z.string().transform((v, ctx) => {
    const s = v.trim();
    const n = Number(s);
    if (s === "" || !Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: "custom", message: "cost 必须是非负数字" });
      return z.NEVER;
    }
    return n;
  }),
  currency: z.string().transform((v, ctx) => {
    const s = v.trim();
    if (s === "") {
      ctx.addIssue({ code: "custom", message: "currency 为空" });
      return z.NEVER;
    }
    return s;
  }),
});

/**
 * 解析官方 cost CSV（UTF-8 文本）。
 * 返回 { month, totalCost, currency, walletType? }；非法格式一律抛
 * CsvParseError（AC4-3）：
 * - 必需列缺失 / cost 非数字或负数 / currency 为空 → 带定位报错；
 * - 多行时 cost 求和，currency 必须全文件一致（不一致 →「cost 文件币种不一致」）；
 * - 跨月 →「文件包含多个月份数据」；walletType 取首个非空值。
 */
export function parseCostCsv(csvText: string): ParsedCost {
  if (typeof csvText !== "string" || csvText.trim() === "") {
    throw new CsvParseError("CSV 内容为空");
  }
  if (csvText.includes("\uFFFD")) {
    throw new CsvParseError(
      "CSV 包含乱码字符（疑似非 UTF-8 编码），请导出为 UTF-8 后重新上传"
    );
  }
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const fields = result.meta.fields ?? [];
  const missing = REQUIRED_COST_COLUMNS.filter((c) => !fields.includes(c));
  if (missing.length > 0) {
    throw new CsvParseError(
      `缺少列：${missing.join("、")}（CSV 需包含：${REQUIRED_COST_COLUMNS.join(", ")}）`
    );
  }

  if (result.errors.length > 0) {
    const e = result.errors[0];
    const at = typeof e.row === "number" ? `（第 ${e.row + HEADER_LINES + 1} 行）` : "";
    throw new CsvParseError(`CSV 解析错误${at}：${e.message}`);
  }

  if (result.data.length === 0) {
    throw new CsvParseError("CSV 无数据行（只有表头或空文件）");
  }

  let month: string | null = null;
  let currency: string | null = null;
  let walletType: string | undefined;
  let totalCost = 0;

  for (const [i, raw] of result.data.entries()) {
    const rowNo = i + HEADER_LINES + 1;
    const parsed = costRowSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path.join(".") || "行";
      throw new CsvParseError(
        `第 ${rowNo} 行「${field}」校验失败：${issue.message}`
      );
    }
    const { cost, currency: cur } = parsed.data;

    const rowMonth = extractMonth(String(raw.start_time_iso ?? ""), rowNo);
    if (month === null) {
      month = rowMonth;
    } else if (month !== rowMonth) {
      throw new CsvParseError("文件包含多个月份数据（请按月份分别导入）");
    }

    if (currency === null) {
      currency = cur;
    } else if (currency !== cur) {
      throw new CsvParseError("cost 文件币种不一致");
    }

    const wt = String(raw.wallet_type ?? "").trim();
    if (walletType === undefined && wt !== "") walletType = wt;

    totalCost += cost;
  }

  // 上面已保证数据行非空，首行必然设置 month / currency；兜底让 TS 收窄类型
  if (month === null || currency === null) {
    throw new CsvParseError("CSV 无数据行（只有表头或空文件）");
  }
  return { month, totalCost, currency, walletType };
}
