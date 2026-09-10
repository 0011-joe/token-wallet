/**
 * 凭证管理业务逻辑（M1 / FR-1）——纯函数 + 依赖注入，route 薄调用。
 *
 * 决策顺序（沿用 v1 并泛化）：
 *   格式预校验(400) → testCredential 实测(422/429/502，失败一律不落库) → 重复检测(409) → 加密入库。
 * 安全红线：明文只存在于「测试调用瞬间」，绝不写日志、回传；响应仅含 hint 等脱敏字段。
 */
import type { Prisma } from "@prisma/client";
import { encryptSecret, type SecretPayload } from "@/lib/crypto/keyvault";
import type { CredentialKind, ProviderId, TestResult } from "@/lib/providers/types";

/** bearer Key 格式：sk- 开头，后接至少 8 位字母/数字/下划线/连字符（DeepSeek/Kimi 通用） */
export const KEY_FORMAT_RE = /^sk-[A-Za-z0-9_-]{8,}$/;
/** 火山 AK 格式：AKLT 开头（子用户与主账号同为 AKLT；ARK 推理 Key 等其它格式一律拒绝） */
export const VOLC_AK_FORMAT_RE = /^AKLT[A-Za-z0-9]{8,}$/;
export const DEFAULT_CREDENTIAL_LABEL = "未命名";

export interface CredentialRecord {
  id: string;
  provider: ProviderId;
  kind: CredentialKind;
  region: string | null;
  label: string;
  hint: string;
  meta: Prisma.JsonValue | null;
  isActive: boolean;
  failCount: number;
  lastStatus: string | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
}

export interface CreateCredentialInput {
  provider: ProviderId;
  kind: CredentialKind;
  region: string | null;
  label: string;
  secretCipher: Buffer;
  iv: Buffer;
  authTag: Buffer;
  hint: string;
  meta: Prisma.InputJsonValue | null;
  keyVersion: number;
  isActive: boolean;
}

export interface CredentialsRepo {
  findByProviderAndHint(userId: string, provider: ProviderId, hint: string): Promise<CredentialRecord | null>;
  create(userId: string, input: CreateCredentialInput): Promise<CredentialRecord>;
  listByUser(userId: string): Promise<CredentialRecord[]>;
  getById(userId: string, id: string): Promise<CredentialRecord | null>;
  updateById(userId: string, id: string, data: { isActive?: boolean; label?: string }): Promise<CredentialRecord | null>;
  deleteById(userId: string, id: string): Promise<boolean>;
}

/** 并发写入触发 (userId, provider, hint) 唯一约束时抛出，service 归为 409。 */
export class DuplicateCredentialError extends Error {
  constructor() {
    super("duplicate (userId, provider, hint)");
    this.name = "DuplicateCredentialError";
  }
}

export type TestCredentialFn = (secret: SecretPayload, opts?: { region?: string }) => Promise<TestResult>;

export type AddCredentialResult =
  | { ok: true; record: CredentialRecord; test: Extract<TestResult, { ok: true }> }
  | { ok: false; status: 400 | 422 | 409 | 429 | 502; error: string };

/** 格式预校验（AC1.2 前端拦截的后端兜底）：合法返回 null，否则用户可读原因。 */
export function validateCredentialInput(opts: {
  provider: ProviderId;
  kind: CredentialKind;
  secret: SecretPayload;
}): string | null {
  const { provider, kind, secret } = opts;
  if (kind === "bearer") {
    const key = secret.key;
    if (typeof key !== "string" || key.length === 0) return "缺少 API Key";
    if (!KEY_FORMAT_RE.test(key)) {
      return "Key 格式不正确：需以 sk- 开头，且后接至少 8 位字母、数字、下划线或连字符";
    }
    return null;
  }
  if (kind === "aksk") {
    if (provider !== "volcengine") return "该平台不支持 AK/SK 凭证";
    const { ak, sk } = secret;
    if (typeof ak !== "string" || ak.length === 0) return "缺少 AccessKey ID";
    if (typeof sk !== "string" || sk.length === 0) return "缺少 Secret AccessKey";
    if (!VOLC_AK_FORMAT_RE.test(ak)) {
      return "AccessKey ID 格式不正确：需以 AKLT 开头（费用中心只读 IAM 子用户，不是 ARK 推理 Key）";
    }
    return null;
  }
  return "未知凭证类型";
}

/** 脱敏标识（hint）：bearer → 后 4 位；aksk → AK 前缀+尾 4 位（SK 永不展示）。 */
export function deriveHint(kind: CredentialKind, secret: SecretPayload): string {
  if (kind === "aksk") {
    const ak = secret.ak ?? "";
    if (ak.length <= 4) return "****";
    return `${ak.slice(0, 4)}****${ak.slice(-4)}`;
  }
  const key = secret.key ?? "";
  return key.length <= 4 ? "****" : key.slice(-4);
}

/** 测试失败 → 可操作错误（AC1.2：签名错/权限不足/限流/网络可区分） */
function testFailureToError(result: Extract<TestResult, { ok: false }>): { status: 422 | 429 | 502; error: string } {
  switch (result.reason) {
    case "INVALID":
      return { status: 422, error: "凭证无效或已失效（签名不匹配 / 凭证被删除）" };
    case "FORBIDDEN_SCOPE":
      return {
        status: 422,
        error: "权限不足：请确认该 AK/SK 属于「费用中心只读」IAM 子用户，而非主账号或缺少只读策略的凭证",
      };
    case "RATE_LIMITED":
      return {
        status: 429,
        error: `验证失败：请求过于频繁（429）${result.message ? `，Retry-After: ${result.message}` : ""}，请稍后重试`,
      };
    case "ERROR":
      return {
        status: 502,
        error: `验证失败：平台接口暂时不可用${result.statusCode ? `（HTTP ${result.statusCode}）` : ""}，请稍后重试`,
      };
  }
}

/**
 * 添加凭证：格式校验 → 实测 → 去重 → 加密入库（AC1.2/1.3/1.4）。
 * 实测失败不保存、不创建任何记录；成功响应附带首份余额（由 testCredential 返回）。
 */
export async function addCredential(opts: {
  userId: string;
  provider: ProviderId;
  kind: CredentialKind;
  region?: string | null;
  label?: string;
  secret: SecretPayload;
  testFn: TestCredentialFn;
  repo: CredentialsRepo;
}): Promise<AddCredentialResult> {
  const formatError = validateCredentialInput({ provider: opts.provider, kind: opts.kind, secret: opts.secret });
  if (formatError) {
    return { ok: false, status: 400, error: formatError };
  }

  const test = await opts.testFn(opts.secret, { region: opts.region ?? undefined });
  if (!test.ok) {
    const mapped = testFailureToError(test);
    return { ok: false, status: mapped.status, error: mapped.error };
  }

  const hint = deriveHint(opts.kind, opts.secret);
  const existing = await opts.repo.findByProviderAndHint(opts.userId, opts.provider, hint);
  if (existing) {
    return { ok: false, status: 409, error: "该凭证已绑定（同平台同标识）" };
  }

  const blob = encryptSecret(opts.secret);
  let record: CredentialRecord;
  try {
    record = await opts.repo.create(opts.userId, {
      provider: opts.provider,
      kind: opts.kind,
      region: opts.region ?? null,
      label: opts.label?.trim() || DEFAULT_CREDENTIAL_LABEL,
      secretCipher: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      hint,
      meta: null,
      keyVersion: 1,
      isActive: true,
    });
  } catch (err) {
    if (err instanceof DuplicateCredentialError) {
      return { ok: false, status: 409, error: "该凭证已绑定（同平台同标识）" };
    }
    throw err;
  }
  return { ok: true, record, test };
}

export async function listCredentials(userId: string, repo: CredentialsRepo): Promise<CredentialRecord[]> {
  return repo.listByUser(userId);
}

export type UpdateCredentialResult =
  | { ok: true; record: CredentialRecord }
  | { ok: false; status: 404; error: string };

export async function updateCredential(opts: {
  userId: string;
  id: string;
  isActive?: boolean;
  label?: string;
  repo: CredentialsRepo;
}): Promise<UpdateCredentialResult> {
  const record = await opts.repo.updateById(opts.userId, opts.id, {
    ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  });
  return record ? { ok: true, record } : { ok: false, status: 404, error: "凭证不存在" };
}

export type DeleteCredentialResult = { ok: true } | { ok: false; status: 404; error: string };

/** 删除凭证（快照由 Prisma onDelete: Cascade 连带删除）；校验归属，否则 404。 */
export async function deleteCredential(opts: {
  userId: string;
  id: string;
  repo: CredentialsRepo;
}): Promise<DeleteCredentialResult> {
  const deleted = await opts.repo.deleteById(opts.userId, opts.id);
  return deleted ? { ok: true } : { ok: false, status: 404, error: "凭证不存在" };
}
