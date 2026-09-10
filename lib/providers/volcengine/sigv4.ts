/**
 * 火山引擎 OpenAPI 签名 V4（HMAC-SHA256）——零依赖手写实现（DEV-GUIDE §10 / R1）。
 *
 * 实现依据：官方文档《签名方法》volcengine.com/docs/6369/67269 与《签名过程 Demo》
 * docs/6369/67270；对拍向量见 tests/volc-sigv4.test.ts（4 组官方向量，逐字节比对）。
 *
 * 关键规则（与 AWS SigV4 的差异点）：
 * - 算法标识 HMAC-SHA256、日期头 X-Date、CredentialScope 以 /request 结尾；
 * - SigningKey 派生链的 key 必须是二进制字节（上一步 hex 解码），message 为纯字符串；
 * - Query 按参数名 ASCII 升序 + RFC3986 严格编码（空格 %20）；
 * - 必需头：Host 与 X-Date 参与签名；X-Content-Sha256 可选（默认不签，与官方向量 1 一致）。
 */
import { createHash, createHmac } from "node:crypto";

export const VOLC_SIG_ALGORITHM = "HMAC-SHA256";
/** 空 body 的 SHA-256（GET 默认） */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC3986 严格编码（encodeURIComponent 不转义 !'()*，需补齐） */
export function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hmacHex(key: Buffer | string, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

/** 规范化 Query 字符串：RFC3986 编码 + 按参数名 ASCII 升序 + & 连接 */
export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${rfc3986Encode(name)}=${rfc3986Encode(query[name])}`)
    .join("&");
}

export interface VolcSigV4Input {
  method: "GET" | "POST";
  host: string; // billing.volcengineapi.com（不携带 scheme/port）
  path?: string; // 默认 "/"
  query: Record<string, string>;
  /** 参与签名的额外头（小写头名 → 值）；host 与 x-date 自动纳入 */
  headers?: Record<string, string>;
  /** 请求体原文（POST 时必填；GET 默认空串） */
  payload?: string;
  service: string; // billing
  region: string; // cn-beijing
  ak: string;
  sk: string;
  /** UTC 时间 YYYYMMDDTHHMMSSZ（测试注入固定时间；运行时取当前时间） */
  dateTime: string;
}

export interface SignedRequest {
  /** 待发送的请求头（含 X-Date、Authorization） */
  headers: Record<string, string>;
  /** 完整 URL：https://host/path?canonicalQuery */
  url: string;
  method: "GET" | "POST";
  payload: string;
}

/** 构造 Canonical Request（供对拍测试断言中间值） */
export function buildCanonicalRequest(input: VolcSigV4Input, bodySha256: string): string {
  const method = input.method;
  const path = input.path ?? "/";
  const query = canonicalQueryString(input.query);
  const allHeaders: Record<string, string> = {
    host: input.host,
    "x-date": input.dateTime,
    ...(input.headers ?? {}),
  };
  const headerNames = Object.keys(allHeaders).sort((a, b) => a.localeCompare(b));
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${allHeaders[name].trim()}\n`)
    .join("");
  const signedHeaders = headerNames.join(";");
  return `${method}\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${bodySha256}`;
}

/** 签名主入口：返回可直接发送的请求（头 + URL）。 */
export function signVolcRequest(input: VolcSigV4Input): SignedRequest {
  const payload = input.payload ?? "";
  const bodySha256 = sha256Hex(payload);

  const canonicalRequest = buildCanonicalRequest(input, bodySha256);
  const date = input.dateTime.slice(0, 8); // YYYYMMDD

  const stringToSign =
    `${VOLC_SIG_ALGORITHM}\n${input.dateTime}\n${date}/${input.region}/${input.service}/request\n${sha256Hex(canonicalRequest)}`;

  // 派生链：key 为二进制（上一步 hex 解码），message 为纯字符串
  const kDate = hmacHex(Buffer.from(input.sk, "utf8"), date);
  const kRegion = hmacHex(Buffer.from(kDate, "hex"), input.region);
  const kService = hmacHex(Buffer.from(kRegion, "hex"), input.service);
  const kSigning = hmacHex(Buffer.from(kService, "hex"), "request");
  const signature = hmacHex(Buffer.from(kSigning, "hex"), stringToSign);

  const headerNames = Object.keys({
    host: input.host,
    "x-date": input.dateTime,
    ...(input.headers ?? {}),
  })
    .sort((a, b) => a.localeCompare(b))
    .join(";");

  const authorization =
    `${VOLC_SIG_ALGORITHM} Credential=${input.ak}/${date}/${input.region}/${input.service}/request, ` +
    `SignedHeaders=${headerNames}, Signature=${signature}`;

  const queryString = canonicalQueryString(input.query);
  return {
    headers: {
      "X-Date": input.dateTime,
      Authorization: authorization,
      ...(input.headers ?? {}),
    },
    url: `https://${input.host}${input.path ?? "/"}${queryString ? `?${queryString}` : ""}`,
    method: input.method,
    payload,
  };
}
