/**
 * v1 兼容层（M0 临时保留，M1 切换调用方后删除）。
 * v1 语义：加密裸字符串、解密回裸字符串——底层委托给新的双格式 keyvault。
 * encryptKey 写入的已是 JSON 信封（{"key":...}），decryptKey 对旧密文同样可解。
 */
import { decryptToPayload, encryptSecret, getMasterKey, maskBearerKey } from "./keyvault";

export type EncryptedKey = {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
};

export { getMasterKey };

export function encryptKey(plaintext: string): EncryptedKey {
  return encryptSecret(plaintext);
}

export function decryptKey(encrypted: EncryptedKey): string {
  const payload = decryptToPayload(encrypted);
  if (typeof payload.key !== "string") {
    throw new Error("密文为 aksk 信封，decryptKey 仅支持 bearer");
  }
  return payload.key;
}

export function maskKey(sk: string): string {
  return maskBearerKey(sk);
}
