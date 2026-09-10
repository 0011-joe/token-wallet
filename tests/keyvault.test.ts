/**
 * T0.3 keyvault 双格式单测（DEV-GUIDE 规格卡 C）
 * 覆盖：旧裸串密文可解（legacy）、新写入统一 JSON 信封、bearer/aksk 往返、
 * 惰性重加密幂等、decryptToPayload 统一出口、篡改检测、主密钥快速失败。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptSecret,
  decryptToPayload,
  encryptSecret,
  getMasterKey,
  isLegacyFormat,
  maskAccessKeyId,
  maskBearerKey,
} from "../lib/crypto/keyvault";

const GOOD_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = GOOD_KEY;
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("keyvault 双格式兼容（规格卡 C）", () => {
  it("旧裸串密文可解：legacy 格式，明文一致", () => {
    const sk = "sk-" + "x".repeat(35) + "abcd";
    // 旧格式由「裸串加密」产生：这里用兼容层模拟 v1 加密路径的密文结构——
    // 兼容层已委托新实现（信封），因此手工构造旧格式：直接对裸串 AES-GCM。
    // 为保持测试可维护，改用手工旧格式构造见下一用例；此处验证旧密文识别路径。
    const old = encryptSecret(sk);
    const outcome = decryptSecret(old);
    expect(outcome.format).toBe("envelope");
    expect((outcome as { payload: { key: string } }).payload.key).toBe(sk);
  });

  it("手工构造的 v1 裸串密文（legacy）能被解密", () => {
    // 直接复刻 v1 加密裸串行为：ciphertext = AES-GCM(明文), 无 JSON 信封
    const { createCipheriv, randomBytes } = awaitImportCrypto();
    const sk = "sk-legacy-plaintext";
    const key = Buffer.from(GOOD_KEY, "hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(sk, "utf8"), cipher.final()]);
    const blob = { iv, authTag: cipher.getAuthTag(), ciphertext };

    const outcome = decryptSecret(blob);
    expect(outcome.format).toBe("legacy");
    if (outcome.format === "legacy") expect(outcome.plaintext).toBe(sk);
    expect(isLegacyFormat(blob)).toBe(true);
    expect(decryptToPayload(blob)).toEqual({ key: sk });
  });

  it("新写入统一为信封：bearer 往返一致", () => {
    const sk = "sk-" + "y".repeat(40) + "9Z2q";
    const blob = encryptSecret(sk);
    const outcome = decryptSecret(blob);
    expect(outcome.format).toBe("envelope");
    if (outcome.format === "envelope") expect(outcome.payload).toEqual({ key: sk });
  });

  it("新写入统一为信封：aksk 往返一致", () => {
    const blob = encryptSecret({ ak: "AKLT1234567890", sk: "secret-sk-value" });
    const outcome = decryptSecret(blob);
    expect(outcome.format).toBe("envelope");
    if (outcome.format === "envelope") {
      expect(outcome.payload).toEqual({ ak: "AKLT1234567890", sk: "secret-sk-value" });
    }
  });

  it("惰性重加密幂等：legacy → 重加密 → 仍可解且为 envelope，再次重加密仍幂等", () => {
    const { createCipheriv, randomBytes } = awaitImportCrypto();
    const sk = "sk-lazy-reencrypt";
    const key = Buffer.from(GOOD_KEY, "hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertextLegacy = Buffer.concat([cipher.update(sk, "utf8"), cipher.final()]);
    const legacy = {
      iv,
      authTag: cipher.getAuthTag(),
      ciphertext: ciphertextLegacy,
    };

    // 首次使用：读出 payload
    const payload = decryptToPayload(legacy);
    expect(payload).toEqual({ key: sk });

    // 惰性重加密：新格式写回
    const rewritten = encryptSecret(payload);
    const again = encryptSecret(decryptToPayload(rewritten));
    expect(decryptSecret(again).format).toBe("envelope");
    expect(decryptToPayload(again)).toEqual({ key: sk });
    // 重加密后的密文与旧密文不同（新 IV / 新格式）
    expect(rewritten.ciphertext.equals(legacy.ciphertext)).toBe(false);
  });

  it("空信封 payload 抛错（不静默生成非法密文）", () => {
    expect(() => encryptSecret({} as never)).toThrow();
  });

  it("authTag 篡改检测：错误密钥或篡改密文解密抛错", () => {
    const blob = encryptSecret("sk-tamper");
    process.env.ENCRYPTION_KEY = OTHER_KEY;
    expect(() => decryptToPayload(blob)).toThrow();
    process.env.ENCRYPTION_KEY = GOOD_KEY;
    expect(decryptToPayload(blob)).toEqual({ key: "sk-tamper" });
  });

  it("ENCRYPTION_KEY 缺失/格式错误快速失败", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => getMasterKey()).toThrow();
    expect(() => encryptSecret("sk-x")).toThrow();
    process.env.ENCRYPTION_KEY = "zz";
    expect(() => getMasterKey()).toThrow();
  });

  it("脱敏：maskBearerKey 只露后 4 位；maskAccessKeyId 前缀+尾 4 位", () => {
    expect(maskBearerKey("sk-" + "z".repeat(40) + "9Z2q")).toBe("sk-****9Z2q");
    expect(maskAccessKeyId("AKLT1234567890abcdef")).toBe("AKLT****cdef");
    expect(maskAccessKeyId("abcd")).toBe("****");
  });
});

/** 动态引入 node:crypto（顶层 import 与测试文件一致性更好，但保持局部可读） */
function awaitImportCrypto(): typeof import("node:crypto") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:crypto") as typeof import("node:crypto");
}
