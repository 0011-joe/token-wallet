/**
 * T3.1 定时快照端点（规格卡 E）
 *
 * 鉴权：请求头 `x-cron-secret` 必须等于 env CRON_SECRET（常量时间比较，防时序侧信道）；
 * CRON_SECRET 未配置时返回 503 并明确提示（不静默）。
 *
 * 流程（遍历 active Key，逐个 try/catch 隔离，单 Key 失败不影响其他）：
 *   1. decryptKey 取明文 → fetchBalance（明文 Key 仅发往 api.deepseek.com，
 *      不出现在任何日志/响应；失败时不打印 message，只打 reason/statusCode/last4）；
 *   2. 成功：对 balanceInfos 中每个币种写一条 ok=true 的 BalanceSnapshot
 *      （fetchedAt=now UTC、各余额 parseFloat、isAvailable 按本次请求整体返回——同一 key
 *      多币种时每个币种 isAvailable 相同）；若 lastStatus !== "OK" 则重置 lastStatus="OK"、
 *      failCount=0；
 *   3. 失败：reason=INVALID/RATE_LIMITED/ERROR → lastStatus 对应值、failCount+1。
 *      本周期不再对该 key 重试（每个 key 每周期只拉取 1 次；多次 429 的指数退避/拉长间隔
 *      由调度侧应对，见计划 R2）。**不写 BalanceSnapshot**——取舍（规格卡 B/E）：
 *      快照表只存成功记录，失败时刻的余额不可信，写库会把「获取失败」伪装成真实余额
 *      参与差值计算；失败状态由 lastStatus/failCount 表达，看板用「最近成功快照」的
 *      新鲜度（stale）呈现「当前获取失败」。不抛未捕获异常（规格卡 B）；
 *   4. 解密失败（ENCRYPTION_KEY 错误/密文损坏）或 DB 异常：等同 ERROR 处理（lastStatus、
 *      failCount+1），并 push 进 failed。
 *
 * 时区：fetchedAt 一律 UTC（new Date()），月份/日的聚合基于 UTC（项目为个人工具，UTC 口径）。
 * 预警（M6）：AC5 的评估（evaluateAlerts → 站内 AlertEvent + 邮件）已在成功/失败路径后挂接；
 * 频控 24h 与渠道开关见文件底部 evaluateKeyAndDispatchAlerts。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";


import { db } from "@/lib/db";
import { decryptKey } from "@/lib/crypto/key-vault";
import { fetchBalance } from "@/lib/deepseek/client";
import {
  ALERT_TYPES,
  DEFAULT_FAIL_THRESHOLD_N,
  DEFAULT_LOW_BALANCE_THRESHOLD,
  evaluateAlerts,
  type AlertType,
} from "@/lib/alerts/evaluate";
import { renderAlertEmail } from "@/lib/email/templates";
import { sendAlertEmail } from "@/lib/email/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 常量时间比较，避免 x-cron-secret 比较的时序侧信道。 */
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const FAILURE_STATUS = {
  INVALID: "INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR: "ERROR",
} as const;

async function handleCron(request: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET 未配置：请在 .env 设置 CRON_SECRET 后调用本端点" },
      { status: 503 }
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!secretMatches(provided, cronSecret)) {
    return NextResponse.json(
      { ok: false, error: "鉴权失败：x-cron-secret 不匹配" },
      { status: 401 }
    );
  }

  const keys = await db.apiKey.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });

  const now = new Date();
  const failed: string[] = [];
  let processed = 0; // 成功写入快照的 key 数；processed + failed.length = 本轮处理总数

  for (const key of keys) {
    try {
      // Prisma 7 的 Bytes 字段类型是 Uint8Array，key-vault 接口要 Buffer，复制转换
      const plaintext = decryptKey({
        iv: Buffer.from(key.iv),
        authTag: Buffer.from(key.authTag),
        ciphertext: Buffer.from(key.ciphertext),
      });

      const result = await fetchBalance(plaintext, {
        baseUrl: process.env.DEEPSEEK_BASE_URL,
      });

      if (result.ok) {
        for (const info of result.balanceInfos) {
          await db.balanceSnapshot.create({
            data: {
              apiKeyId: key.id,
              fetchedAt: now,
              currency: info.currency,
              totalBalance: parseFloat(info.totalBalance),
              grantedBalance: parseFloat(info.grantedBalance),
              toppedUpBalance: parseFloat(info.toppedUpBalance),
              isAvailable: result.isAvailable,
              ok: true,
            },
          });
        }
        if (key.lastStatus !== "OK") {
          await db.apiKey.update({
            where: { id: key.id },
            data: { lastStatus: "OK", failCount: 0 },
          });
        }
        processed += 1;
        // ── M6 预警（AC5-1/AC5-2）：本轮成功 → 评估低余额 / is_available 翻转 ──
        // 主币种口径与 dashboard 一致（CNY 优先，无 CNY 取第一个币种），分币种不混算；
        // prev 取同币种上一笔成功快照（严格早于本轮），判定 true→false 翻转（首见 false 也触发）。
        const mainInfo =
          result.balanceInfos.find((i) => i.currency === "CNY") ??
          result.balanceInfos[0] ??
          null;
        const prevSnapshot = mainInfo
          ? await db.balanceSnapshot.findFirst({
              where: {
                apiKeyId: key.id,
                ok: true,
                currency: mainInfo.currency,
                fetchedAt: { lt: now },
              },
              orderBy: { fetchedAt: "desc" },
              select: { isAvailable: true },
            })
          : null;
        // 注意：key 是循环开始时的快照值——成功路径已在上面重置 lastStatus="OK"/failCount=0，
        // 评估必须用重置后的状态（否则会用陈旧失败计数误报 KEY_FAILED）。
        await evaluateKeyAndDispatchAlerts(
          { ...key, lastStatus: "OK", failCount: 0 },
          {
            latestSnapshot: mainInfo
              ? {
                  totalBalance: parseFloat(mainInfo.totalBalance),
                  isAvailable: result.isAvailable,
                  currency: mainInfo.currency,
                }
              : null,
            prevSnapshot,
          }
        );
      } else {
        const status = FAILURE_STATUS[result.reason];
        await db.apiKey.update({
          where: { id: key.id },
          data: { lastStatus: status, failCount: key.failCount + 1 },
        });
        failed.push(key.id);
        // 只输出脱敏信息（keyId/last4/reason/statusCode），绝不打印明文 Key 与 message
        console.warn(
          `[cron:snapshot] key=${key.id} last4=${key.last4} fetch failed reason=${result.reason} statusCode=${result.statusCode ?? "-"}`
        );
        // ── M6（AC5-2/AC5-3）：连续失败达 N 次 → KEY_FAILED 预警（按更新后的 failCount 评估）──
        await evaluateKeyAndDispatchAlerts(
          { ...key, failCount: key.failCount + 1, lastStatus: status },
          { latestSnapshot: null, prevSnapshot: null }
        );
      }
    } catch (err) {
      // 解密失败或 DB 异常：按 ERROR 处理，不抛出、不影响其他 key
      await db.apiKey
        .update({
          where: { id: key.id },
          data: { lastStatus: "ERROR", failCount: key.failCount + 1 },
        })
        .catch(() => {}); // 极端情况（DB 完全不可用）下不再抛，留给下个周期
      failed.push(key.id);
      console.warn(
        `[cron:snapshot] key=${key.id} last4=${key.last4} decrypt/db error -> ERROR (${
          err instanceof Error ? err.name : "unknown"
        })`
      );
      // ── M6：解密/DB 异常按 ERROR 计，连续失败达 N 同样触发 KEY_FAILED 预警 ──
      await evaluateKeyAndDispatchAlerts(
        { ...key, failCount: key.failCount + 1, lastStatus: "ERROR" },
        { latestSnapshot: null, prevSnapshot: null }
      );
    }
  }

  return NextResponse.json({ ok: true, processed, failed });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handleCron(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handleCron(request);
}


// ── M6：预警评估与派发（T6.1/T6.2/T6.3，AC5-1/2/3）──

/** 设置缺省值（与 schema @default 一致）；用户从未保存设置时使用，且**不创建**设置记录。 */
const DEFAULT_ALERT_SETTINGS = {
  lowBalanceThreshold: DEFAULT_LOW_BALANCE_THRESHOLD,
  failThresholdN: DEFAULT_FAIL_THRESHOLD_N,
  emailEnabled: true,
  inappEnabled: true,
};

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * 单个 Key 的预警评估与派发（站内 + 邮件）。
 * - 设置：读 AlertSetting；无记录用默认值（不创建记录，见 C3 口：无记录视同默认配置）；
 * - 频控（AC5-3）：按 (type, apiKeyId) 查最近一次同类事件，24h 窗口内不重复生成；
 *   dedupKey 唯一约束（P2002）作并发兜底（同刻写入视为已派发，跳过邮件防重）；
 * - 站内开关：inappEnabled=false 时**不写** AlertEvent（此时邮件频控无事件记录可查，
 *   取舍见汇报：该组合下邮件在条件持续期间可能每周期重复发送；默认两渠道都开，AC5-3 成立）；
 * - 邮件开关：emailEnabled=false 不发信，仍写站内事件（保留频控记录）；
 * - 全程 try/catch：预警链路任何失败只记日志，不影响本 Key 的快照结果与单 Key 失败隔离。
 *   红线：日志与邮件内容只含 keyId / last4 / 事件类型，绝无明文 Key。
 */
async function evaluateKeyAndDispatchAlerts(
  key: {
    id: string;
    userId: string;
    last4: string;
    failCount: number;
    lastStatus: string | null;
  },
  opts: {
    latestSnapshot: {
      totalBalance: number;
      isAvailable: boolean;
      currency: string;
    } | null;
    prevSnapshot: { isAvailable: boolean } | null;
  }
): Promise<void> {
  try {
    const row = await db.alertSetting.findUnique({
      where: { userId: key.userId },
    });
    const settings = row ?? DEFAULT_ALERT_SETTINGS;
    const user = await db.user.findUnique({
      where: { id: key.userId },
      select: { email: true },
    });
    if (!user) return;

    for (const type of ALERT_TYPES) {
      // 频控：最近一次同类事件（按 type 精确查询，跨类型不互扰）
      // schema 中 type 是字符串，此处收窄为 AlertType 联合（列值由本模块写入，只会有这三种）
      const lastEvent = await db.alertEvent.findFirst({
        where: { apiKeyId: key.id, type },
        orderBy: { createdAt: "desc" },
        select: { type: true, createdAt: true },
      });
      const lastAlert = lastEvent
        ? { type: lastEvent.type as AlertType, createdAt: lastEvent.createdAt }
        : null;
      const candidate = evaluateAlerts({
        settings,
        key,
        latestSnapshot: opts.latestSnapshot,
        prevSnapshot: opts.prevSnapshot,
        lastAlert,
      }).find((c) => c.type === type);
      if (!candidate) continue;

      // 站内（inappEnabled 开关）
      if (settings.inappEnabled) {
        try {
          await db.alertEvent.create({
            data: {
              userId: key.userId,
              apiKeyId: key.id,
              type: candidate.type,
              message: candidate.message,
              dedupKey: candidate.dedupKey,
            },
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // 并发同刻写入（dedupKey+createdAt 撞唯一约束）：视为已派发，跳过邮件防重复
          continue;
        }
      }

      // 邮件（emailEnabled 开关）：模板只嵌 last4，绝不内嵌明文 Key
      if (settings.emailEnabled) {
        const { subject, html } = renderAlertEmail({
          type: candidate.type,
          last4: key.last4,
          message: candidate.message,
          severity: candidate.severity,
        });
        const sent = await sendAlertEmail({ to: user.email, subject, html });
        if (!sent.ok) {
          console.warn(
            `[cron:snapshot] key=${key.id} last4=${key.last4} alert email failed: ${sent.error}`
          );
        }
      }

      console.log(
        `[cron:snapshot] alert=${candidate.type} key=${key.id} last4=${key.last4} severity=${candidate.severity} inapp=${settings.inappEnabled} email=${settings.emailEnabled}`
      );
    }
  } catch (err) {
    // 预警链路失败不影响快照处理与单 Key 失败隔离
    console.warn(
      `[cron:snapshot] key=${key.id} alert skip: ${
        err instanceof Error ? err.name : "unknown"
      }`
    );
  }
}
