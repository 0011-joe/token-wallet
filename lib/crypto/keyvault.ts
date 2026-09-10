/**
 * token-wallet 凭证加密工具（T0.3，DEV-GUIDE 规格卡 C）
 *
 * AES-256-GCM：每凭证随机 12B IV；主密钥来自 ENCRYPTION_KEY（64 hex → 32 字节）。
 * 双格式兼容（v1 → v2 迁移路线②，零停机）：
 *   - 新写入统一为 JSON 信封：{"key":"sk-..."} 或 {"ak":"...","sk":"..."}；
 *   - 解密时先尝试 JSON.parse：对象 = 新信封；失败 = v1 旧裸字符串（legacy）；
 *   - 旧格式凭证首次使用/编辑时由调用方惰性重加密（decryptToPayload → encryptSecret）。
 * ENCRYPTION_KEY 缺失或格式错误快速失败（throw），禁止静默降级（红线）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM 推荐 iv 长度
const KEY_ENV = "ENCRYPTION_KEY";

export interface EncryptedBlob {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** 凭证明文负载：bearer 单段 key；aksk 两段 ak+sk */
export interface SecretPayload {
  key?: string;
  ak?: string;
  sk?: string;
}

export type DecryptOutcome =
  | { format: "legacy"; plaintext: string }
  | { format: "envelope"; payload: SecretPayload };

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

/** 凭证明文 → 信封 JSON 字符串（新写入统一格式）。 */
function payloadToEnvelope(secret: string | SecretPayload): string {
  if (typeof secret === "string") {
    return JSON.stringify({ key: secret });
  }
  const { key, ak, sk } = secret;
  if (key !== undefined) {
    return JSON.stringify({ key });
  }
  if (ak !== undefined && sk !== undefined) {
    return JSON.stringify({ ak, sk });
  }
  throw new Error("SecretPayload 必须包含 key（bearer）或 ak+sk（aksk）");
}

/** 明文（信封 JSON）→ 密文 blob；每次调用随机 IV。 */
export function encryptSecret(secret: string | SecretPayload): EncryptedBlob {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = payloadToEnvelope(secret);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

/** 解密：先解出明文，再按「JSON 信封 or 旧裸字符串」分类。authTag 不匹配抛错。 */
export function decryptSecret(blob: EncryptedBlob): DecryptOutcome {
  const plaintext = decryptRaw(blob);
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      ("key" in parsed || "ak" in parsed || "sk" in parsed)
    ) {
      return { format: "envelope", payload: parsed as SecretPayload };
    }
  } catch {
    // 非 JSON → legacy
  }
  return { format: "legacy", plaintext };
}

/** 统一出口：任何格式密文 → SecretPayload（legacy 视为 {"key": 明文}）。 */
export function decryptToPayload(blob: EncryptedBlob): SecretPayload {
  const outcome = decryptSecret(blob);
  if (outcome.format === "envelope") return outcome.payload;
  return { key: outcome.plaintext };
}

/** 判断密文是否为 v1 旧格式（决定是否惰性重加密）。 */
export function isLegacyFormat(blob: EncryptedBlob): boolean {
  return decryptSecret(blob).format === "legacy";
}

/** 仅解密裸明文（内部用）。 */
function decryptRaw(blob: EncryptedBlob): string {
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGORITHM, key, blob.iv);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString("utf8");
}

// ── 脱敏 ──

/** bearer 脱敏：只暴露后 4 位，如 "sk-****1a2b"。 */
export function maskBearerKey(sk: string): string {
  if (sk.length <= 4) return "sk-****";
  return `sk-****${sk.slice(-4)}`;
}

/** aksk 脱敏：AccessKeyId 前缀 + 尾 4 位，如 "AKLT****1a2b"（SecretAccessKey 永不展示）。 */
export function maskAccessKeyId(ak: string): string {
  if (ak.length <= 4) return "****";
  return `${ak.slice(0, 4)}****${ak.slice(-4)}`;
}
