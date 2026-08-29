/**
 * DeepBalance Key 加密工具（T0.4）
 *
 * AES-256-GCM：每把钥匙随机 12B IV，密文与 authTag 一并存储，
 * 主密钥来自环境变量 ENCRYPTION_KEY（64 位 hex → 32 字节）。
 * 规格卡 A：每 Key 随机 iv、明文不落盘、无日志输出。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM 推荐 iv 长度
const KEY_ENV = "ENCRYPTION_KEY";

export interface EncryptedKey {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** 从环境变量读取主密钥；缺失或格式错误直接抛错（不静默降级）。 */
export function getMasterKey(): Buffer {
  const hex = process.env[KEY_ENV]?.trim();
  if (!hex) {
    throw new Error(
      `${KEY_ENV} 未配置：请设置 64 位十六进制主密钥（32 字节），例如 crypto.randomBytes(32).toString('hex')`
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${KEY_ENV} 必须是 64 个十六进制字符（对应 32 字节 AES-256 密钥）`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * 加密明文 API Key。
 * 每次调用生成新的随机 IV——同一明文两次加密产物不同。
 */
export function encryptKey(plaintext: string): EncryptedKey {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, authTag, ciphertext };
}

/**
 * 解密。authTag 不匹配（密钥错误/数据被篡改）时抛出异常。
 */
export function decryptKey(encrypted: EncryptedKey): string {
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** 脱敏展示：只暴露后 4 位，如 "sk-****1a2b"。 */
export function maskKey(sk: string): string {
  if (sk.length <= 4) {
    return "sk-****";
  }
  return `sk-****${sk.slice(-4)}`;
}
