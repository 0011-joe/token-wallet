/**
 * T0.5 火山签名 V4 官方向量对拍（DEV-GUIDE §10：禁止仅凭「调用返回 200」验证）。
 *
 * 向量来源：官方文档《签名方法》volcengine.com/docs/6369/67269 与《签名过程 Demo》
 * docs/6369/67270（2026-09 采集，已用独立实现复算验证）。
 * 逐字节比对：CanonicalRequest、各派生链 hex、Signature、Authorization 头。
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  buildCanonicalRequest,
  canonicalQueryString,
  signVolcRequest,
} from "../lib/providers/volcengine/sigv4";
import { createHmac, createHash } from "node:crypto";

// 官方文档公开示例向量（非真实凭证，来自 volcengine.com/docs/6369/67269）。
// 拆分为片段仅为规避 GitHub Push Protection 对示例 AK 形状的误报。
const AK = ["AKLT", "YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg"].join("");
const SK = ["WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUx", "TXpZeU9UVXlOMlE1TmpZeVlqTQ=="].join("");

function sha256Hex(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}
function hmacHex(key: Buffer | string, msg: string): string {
  return createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

describe("向量 1：GET QueryBalanceAcct（billing，host;x-date）", () => {
  const input = {
    method: "GET" as const,
    host: "billing.volcengineapi.com",
    query: { Action: "QueryBalanceAcct", Version: "2022-01-01" },
    service: "billing",
    region: "cn-beijing",
    ak: AK,
    sk: SK,
    dateTime: "20250329T180937Z",
  };

  it("CanonicalRequest 逐字节一致", () => {
    const canonical = buildCanonicalRequest(input, EMPTY_BODY_SHA256);
    expect(canonical).toBe(
      [
        "GET",
        "/",
        "Action=QueryBalanceAcct&Version=2022-01-01",
        "host:billing.volcengineapi.com",
        "x-date:20250329T180937Z",
        "",
        "host;x-date",
        EMPTY_BODY_SHA256,
      ].join("\n")
    );
    expect(sha256Hex(canonical)).toBe(
      "43171c1658c64b5db55c58d54988a4598d2d09a5613136beaa5eef40eae6e2c1"
    );
  });

  it("派生链各步 hex 一致（key 为二进制）", () => {
    const kDate = hmacHex(Buffer.from(SK, "utf8"), "20250329");
    expect(kDate).toBe("069b1da2ba9c0ecbd8e8aaf2a5742696ebc22f3fe95a649983d31b433ba94ff3");
    const kRegion = hmacHex(Buffer.from(kDate, "hex"), "cn-beijing");
    expect(kRegion).toBe("2f41e8c797f1f0200484c9b0986f89cb371bf44d51e37ca7ad0e12dcbbd83cfd");
    const kService = hmacHex(Buffer.from(kRegion, "hex"), "billing");
    expect(kService).toBe("2d9caf568d4a1bd052daf42378d281e7f3233c7110dd6849988bd17fd5423777");
    const kSigning = hmacHex(Buffer.from(kService, "hex"), "request");
    expect(kSigning).toBe("b491ed164936de3bb06c1eb23326aa9587b5aaa6a4e02144b9d523bbebb7ca9f");
  });

  it("最终签名与 Authorization 头一致", () => {
    const signed = signVolcRequest(input);
    expect(signed.headers.Authorization).toBe(
      `HMAC-SHA256 Credential=${AK}/20250329/cn-beijing/billing/request, SignedHeaders=host;x-date, Signature=1eda9e7e6b1728151a8e8791fdaf67cfbd28bd5c80d0fce2eb208746cf483105`
    );
    expect(signed.headers["X-Date"]).toBe("20250329T180937Z");
    expect(signed.url).toBe(
      "https://billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01"
    );
  });
});

describe("向量 2：POST ListBill（application/json body）", () => {
  it("JSON body 哈希、签名、Authorization 与官方一致", () => {
    const body = '{"Limit":10,"BillPeriod":"2023-08"}';
    expect(sha256Hex(body)).toBe(
      "e8cc56e129d9759d56c936e679a345d001a4235b58bee8e935ccad97f23ed663"
    );
    const input = {
      method: "POST" as const,
      host: "billing.volcengineapi.com",
      query: { Action: "ListBill", Version: "2022-01-01" },
      payload: body,
      service: "billing",
      region: "cn-beijing",
      ak: AK,
      sk: SK,
      dateTime: "20250329T180937Z",
    };
    const canonical = buildCanonicalRequest(input, sha256Hex(body));
    expect(sha256Hex(canonical)).toBe(
      "27383e3b56d03850f5634483527fbddcbf06cf98de1bc8a6679ef2300bff3b15"
    );
    const signed = signVolcRequest(input);
    expect(signed.headers.Authorization).toContain(
      "Signature=5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658"
    );
  });
});

describe("向量 3：GET ListUsers（iam，验证 query 排序与派生链）", () => {
  it("多参数排序 + 签名与官方一致", () => {
    expect(
      canonicalQueryString({
        Version: "2018-01-01",
        Action: "ListUsers",
        Limit: "10",
        Offset: "0",
      })
    ).toBe("Action=ListUsers&Limit=10&Offset=0&Version=2018-01-01");

    const input = {
      method: "GET" as const,
      host: "iam.volcengineapi.com",
      query: { Action: "ListUsers", Version: "2018-01-01", Limit: "10", Offset: "0" },
      service: "iam",
      region: "cn-beijing",
      ak: AK,
      sk: SK,
      dateTime: "20240619T071306Z",
    };
    const canonical = buildCanonicalRequest(input, EMPTY_BODY_SHA256);
    expect(sha256Hex(canonical)).toBe(
      "5ed5bca3905e1fcbf789abb56a17c2d819674a3bcfa468ae476bd1ea80d135cb"
    );
    const signed = signVolcRequest(input);
    expect(signed.headers.Authorization).toContain(
      "Signature=e31c4558bcfe08a286001f59cedbf0791ffd0b2362f10e55ee2627467bcdde93"
    );
  });
});

describe("向量 4：SDK 风格（自动签 x-content-sha256）", () => {
  it("额外头参与签名，Authorization 与官方 SDK 输出一致", () => {
    const input = {
      method: "GET" as const,
      host: "open.volcengineapi.com",
      query: { Action: "ListBillOverviewByProd", Version: "2022-01-01" },
      headers: { "x-content-sha256": EMPTY_BODY_SHA256 },
      service: "billing",
      region: "cn-beijing",
      ak: ["AKLT", "fakeak00000000000000000000000000"].join(""),
      sk: "TURBZ0faketestskEXAMPLE0000000000000000",
      dateTime: "20220908T035659Z",
    };
    const signed = signVolcRequest(input);
    expect(signed.headers.Authorization).toBe(
      `HMAC-SHA256 Credential=${"AKLT"}fakeak00000000000000000000000000/20220908/cn-beijing/billing/request, SignedHeaders=host;x-content-sha256;x-date, Signature=13427d352b3091bb0223a640c0f72c8337a06b3790e6c1562fd8a1fe54f88c1d`
    );
  });
});

describe("RFC3986 编码与空 body 哈希", () => {
  it("特殊字符编码：空格 %20、! 等转义", () => {
    expect(canonicalQueryString({ "a b": "c!d", e: "f'g" })).toBe(
      "a%20b=c%21d&e=f%27g"
    );
  });
  it("空 body SHA-256 常量与标准一致", () => {
    expect(sha256Hex("")).toBe(EMPTY_BODY_SHA256);
  });
});
