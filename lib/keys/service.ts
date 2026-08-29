/**
 * Key 管理业务逻辑（T2.1/T2.2/T2.3）——纯函数 + 依赖注入，route 薄调用。
 *
 * 注入两个依赖以便单测（不发真实网络、不碰真实数据库）：
 * - checkKey: 实测余额接口的函数；生产注入 lib/deepseek/client 的 fetchBalance
 * - repo: 仓储接口；生产注入 lib/keys/repo 的 keysRepo（Prisma 实现）
 *
 * 决策顺序（与任务规格一致）：
 *   格式预校验(400) → 实测(422/429/502，失败一律不保存) → 重复 last4 检测(409) → 加密入库
 */
import { encryptKey } from "@/lib/crypto/key-vault";
import type { BalanceResult } from "@/lib/deepseek/client";

/** 合法 Key 格式：sk- 开头，后接至少 8 位字母/数字/下划线/连字符 */
export const KEY_FORMAT_RE = /^sk-[A-Za-z0-9_-]{8,}$/;
export const DEFAULT_KEY_LABEL = "未命名";

/** 对外可见的 Key 记录：绝不包含 ciphertext / iv / authTag / 明文 */
export interface ApiKeyRecord {
  id: string;
  label: string;
  last4: string;
  isActive: boolean;
  failCount: number;
  lastStatus: string | null;
  createdAt: Date;
}

export interface CreateKeyInput {
  label: string;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  last4: string;
  isActive: boolean;
}

export interface KeysRepo {
  findByLast4(userId: string, last4: string): Promise<ApiKeyRecord | null>;
  create(userId: string, input: CreateKeyInput): Promise<ApiKeyRecord>;
  listByUser(userId: string): Promise<ApiKeyRecord[]>;
  getById(userId: string, id: string): Promise<ApiKeyRecord | null>;
  updateById(
    userId: string,
    id: string,
    data: { isActive?: boolean; label?: string }
  ): Promise<ApiKeyRecord | null>;
  deleteById(userId: string, id: string): Promise<boolean>;
}

/** 并发写入触发 (userId,last4) 唯一约束时抛出，service 归为 409。 */
export class DuplicateLast4Error extends Error {
  constructor() {
    super("duplicate (userId, last4)");
    this.name = "DuplicateLast4Error";
  }
}

export type KeyCheckFn = (apiKey: string) => Promise<BalanceResult>;

export type AddKeyResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; status: 400 | 422 | 409 | 429 | 502; error: string };

/** 格式预校验（AC1-2 后端兜底）：合法返回 null，否则返回用户可读原因。 */
export function validateKeyFormat(apiKey: string): string | null {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return "缺少 apiKey";
  }
  if (!KEY_FORMAT_RE.test(apiKey)) {
    return "Key 格式不正确：需以 sk- 开头，且后接至少 8 位字母、数字、下划线或连字符";
  }
  return null;
}

/** 掩码展示用：仅取明文后 4 位（如 "d8d7"）。 */
export function deriveLast4(apiKey: string): string {
  return apiKey.slice(-4);
}

/**
 * 添加 Key：格式校验 → 实测 → 去重 → 加密入库。
 * 实测失败（INVALID/RATE_LIMITED/ERROR）不保存、不创建任何记录（AC1-3）。
 */
export async function addKey(opts: {
  userId: string;
  apiKey: string;
  label?: string;
  checkKey: KeyCheckFn;
  repo: KeysRepo;
}): Promise<AddKeyResult> {
  const formatError = validateKeyFormat(opts.apiKey);
  if (formatError) {
    return { ok: false, status: 400, error: formatError };
  }

  const balance = await opts.checkKey(opts.apiKey);
  if (!balance.ok) {
    switch (balance.reason) {
      case "INVALID":
        return { ok: false, status: 422, error: "Key 无效或已失效" };
      case "RATE_LIMITED":
        return {
          ok: false,
          status: 429,
          error: `验证失败：请求过于频繁（429）${balance.message ? `，Retry-After: ${balance.message}` : ""}，请稍后重试`,
        };
      case "ERROR":
        return {
          ok: false,
          status: 502,
          error: `验证失败：DeepSeek 接口暂时不可用${balance.statusCode ? `（HTTP ${balance.statusCode}）` : ""}，请稍后重试`,
        };
    }
  }

  const last4 = deriveLast4(opts.apiKey);
  const existing = await opts.repo.findByLast4(opts.userId, last4);
  if (existing) {
    return { ok: false, status: 409, error: "该 Key 已绑定" };
  }

  const encrypted = encryptKey(opts.apiKey);
  let record: ApiKeyRecord;
  try {
    record = await opts.repo.create(opts.userId, {
      label: opts.label?.trim() || DEFAULT_KEY_LABEL,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      last4,
      isActive: true,
    });
  } catch (err) {
    // 并发双提交撞唯一约束 → 与普通去重同语义（AC1-4）
    if (err instanceof DuplicateLast4Error) {
      return { ok: false, status: 409, error: "该 Key 已绑定" };
    }
    throw err;
  }
  return { ok: true, record };
}

/** 列出当前用户全部 Key（按绑定时间升序）。 */
export async function listKeys(userId: string, repo: KeysRepo): Promise<ApiKeyRecord[]> {
  return repo.listByUser(userId);
}

export type UpdateKeyResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; status: 404; error: string };

/** 启停 / 改名；校验归属：不存在或非本用户 → 404。 */
export async function updateKey(opts: {
  userId: string;
  id: string;
  isActive?: boolean;
  label?: string;
  repo: KeysRepo;
}): Promise<UpdateKeyResult> {
  const record = await opts.repo.updateById(opts.userId, opts.id, {
    ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  });
  return record
    ? { ok: true, record }
    : { ok: false, status: 404, error: "Key 不存在" };
}

export type DeleteKeyResult = { ok: true } | { ok: false; status: 404; error: string };

/** 删除 Key（快照由 Prisma onDelete: Cascade 连带删除）；校验归属，否则 404。 */
export async function deleteKey(opts: {
  userId: string;
  id: string;
  repo: KeysRepo;
}): Promise<DeleteKeyResult> {
  const deleted = await opts.repo.deleteById(opts.userId, opts.id);
  return deleted ? { ok: true } : { ok: false, status: 404, error: "Key 不存在" };
}
