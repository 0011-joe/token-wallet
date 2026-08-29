/**
 * T0.4 key-vault 单测
 * 规格卡 A：加解密往返、错误密钥失败、maskKey 只露后 4 位、缺 ENCRYPTION_KEY 抛错。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptKey,
  encryptKey,
  getMasterKey,
  maskKey,
} from "../lib/crypto/key-vault";

const GOOD_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = GOOD_KEY;
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("key-vault", () => {
  it("加解密往返一致", () => {
    const sk = "sk-" + "x".repeat(35) + "abcd";
    const enc = encryptKey(sk);
    expect(enc.iv).toBeInstanceOf(Buffer);
    expect(enc.authTag).toBeInstanceOf(Buffer);
    expect(enc.ciphertext).toBeInstanceOf(Buffer);
    expect(enc.ciphertext.equals(Buffer.from(sk))).toBe(false); // 密文不等于明文
    expect(decryptKey(enc)).toBe(sk);
  });

  it("每次加密产生随机 IV，同一明文两次产物不同", () => {
    const sk = "sk-1234567890abcdef";
    const a = encryptKey(sk);
    const b = encryptKey(sk);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("错误密钥解密失败（authTag 不匹配抛错）", () => {
    const enc = encryptKey("sk-should-not-decrypt");
    process.env.ENCRYPTION_KEY = OTHER_KEY;
    expect(() => decryptKey(enc)).toThrow();
    process.env.ENCRYPTION_KEY = GOOD_KEY;
    // 恢复后可正常解密
    expect(decryptKey(enc)).toBe("sk-should-not-decrypt");
  });

  it("maskKey 只暴露后 4 位", () => {
    const sk = "sk-" + "y".repeat(40) + "9Z2q";
    const masked = maskKey(sk);
    expect(masked).toBe("sk-****9Z2q");
    expect(masked.includes(sk.slice(5, -4))).toBe(false); // 中间段不泄露
  });

  it("短 Key 的 maskKey 只返回前缀", () => {
    expect(maskKey("abc")).toBe("sk-****");
  });

  it("缺 ENCRYPTION_KEY 抛错", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => getMasterKey()).toThrow();
    expect(() => encryptKey("sk-x")).toThrow();
  });

  it("非 64 位 hex 的 ENCRYPTION_KEY 抛错", () => {
    process.env.ENCRYPTION_KEY = "zz";
    expect(() => getMasterKey()).toThrow();
  });
});
