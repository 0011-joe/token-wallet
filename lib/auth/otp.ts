/**
 * 邮箱登录验证码（OTP）核心逻辑。
 *
 * - 6 位数字；sha256(code:email) 存哈希，不落明文；
 * - 10 分钟过期；单码最多试 5 次；发新码时作废该邮箱旧未消费码；
 * - 验证成功：消费码、upsert User（emailVerified=now）。
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LENGTH = 6;

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, "0");
}

export function hashOtpCode(code: string, email: string): string {
  return createHash("sha256")
    .update(`${code}:${email.trim().toLowerCase()}`)
    .digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface IssuedOtp {
  id: string;
  code: string;
  expiresAt: Date;
}

/** 作废旧码并签发新码（返回明文 code，仅用于发信/dev 回显，禁止写日志以外的持久化）。 */
export async function issueLoginCode(email: string): Promise<IssuedOtp> {
  const norm = email.trim().toLowerCase();
  const now = new Date();
  await db.loginCode.updateMany({
    where: { email: norm, consumedAt: null },
    data: { consumedAt: now },
  });
  const code = generateOtpCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const row = await db.loginCode.create({
    data: {
      email: norm,
      codeHash: hashOtpCode(code, norm),
      expiresAt,
    },
  });
  return { id: row.id, code, expiresAt };
}

export type VerifyOtpOutcome =
  | { ok: true; email: string; userId: string }
  | { ok: false; error: string };

/**
 * 校验该邮箱最新一条未消费验证码。
 * 失败会累加 attempts；达到上限则消费该码。
 */
export async function verifyLoginCode(email: string, code: string): Promise<VerifyOtpOutcome> {
  const norm = email.trim().toLowerCase();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "验证码须为 6 位数字" };
  }

  const row = await db.loginCode.findFirst({
    where: { email: norm, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    return { ok: false, error: "验证码不存在或已失效，请重新获取" };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await db.loginCode.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    return { ok: false, error: "验证码已过期，请重新获取" };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await db.loginCode.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    return { ok: false, error: "尝试次数过多，请重新获取验证码" };
  }

  const expected = hashOtpCode(code, norm);
  if (!safeEqualHex(expected, row.codeHash)) {
    const attempts = row.attempts + 1;
    await db.loginCode.update({
      where: { id: row.id },
      data: {
        attempts,
        ...(attempts >= OTP_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
      },
    });
    return { ok: false, error: "验证码不正确" };
  }

  await db.loginCode.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  const now = new Date();
  const user = await db.user.upsert({
    where: { email: norm },
    create: { email: norm, emailVerified: now },
    update: { emailVerified: now },
    select: { id: true, email: true },
  });

  return { ok: true, email: user.email, userId: user.id };
}
