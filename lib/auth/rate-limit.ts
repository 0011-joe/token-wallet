/**
 * 登录/发信限流（P0，尽力而为）。
 *
 * 实现：进程内滑动窗口（Map）。适用于单实例 / 短生命周期 Serverless 实例：
 * - 冷启动会清空计数——这是已知取舍，单人自托管场景足够挡住刷邮件；
 * - 不引入 Redis/DB，保持零运维。
 *
 * 窗口默认：邮箱 5 次 / 15 分钟；IP 20 次 / 15 分钟；邀请码 IP 20 次 / 15 分钟。
 */

export interface RateLimitResult {
  ok: boolean;
  /** 距离窗口重置的秒数（ok=true 时为 0） */
  retryAfterSec: number;
  limit: number;
  remaining: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 5_000;

type Bucket = number[];

const buckets = new Map<string, Bucket>();

/** 测试用：清空全部计数。 */
export function resetRateLimits(): void {
  buckets.clear();
}

function prune(bucket: Bucket, now: number, windowMs: number): Bucket {
  return bucket.filter((t) => now - t < windowMs);
}

function enforceMemoryCap(): void {
  if (buckets.size <= MAX_BUCKETS) return;
  // 简单裁剪：删掉最旧的一批 key（插入序）
  const excess = buckets.size - MAX_BUCKETS;
  let i = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    i += 1;
    if (i >= excess) break;
  }
}

/**
 * 检查并（可选）记入一次请求。`count: false` 只查询不记入。
 */
export function hitRateLimit(opts: {
  key: string;
  limit: number;
  windowMs?: number;
  count?: boolean;
}): RateLimitResult {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  const key = opts.key;
  const raw = buckets.get(key) ?? [];
  const bucket = prune(raw, now, windowMs);

  if (bucket.length >= opts.limit) {
    const oldest = bucket[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, bucket);
    return { ok: false, retryAfterSec, limit: opts.limit, remaining: 0 };
  }

  if (opts.count !== false) {
    bucket.push(now);
    enforceMemoryCap();
  }
  buckets.set(key, bucket);
  return {
    ok: true,
    retryAfterSec: 0,
    limit: opts.limit,
    remaining: Math.max(0, opts.limit - bucket.length),
  };
}

/** 从 Request 提取客户端 IP（Vercel/常见代理头优先）。 */
export function clientIpFromRequest(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

export const EMAIL_SIGNIN_LIMIT = 5;
export const IP_SIGNIN_LIMIT = 20;
export const IP_INVITE_LIMIT = 20;

export function checkEmailSignInLimit(email: string): RateLimitResult {
  return hitRateLimit({
    key: `signin:email:${email.trim().toLowerCase()}`,
    limit: EMAIL_SIGNIN_LIMIT,
  });
}

export function checkIpSignInLimit(ip: string): RateLimitResult {
  return hitRateLimit({ key: `signin:ip:${ip}`, limit: IP_SIGNIN_LIMIT });
}

export function checkIpInviteLimit(ip: string): RateLimitResult {
  return hitRateLimit({ key: `invite:ip:${ip}`, limit: IP_INVITE_LIMIT });
}
