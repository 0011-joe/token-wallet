/**
 * 定时快照端点（v2：遍历全部平台凭证，经 registry 走各 adapter；DEV-GUIDE §11）。
 *
 * 鉴权：x-cron-secret 或 Authorization: Bearer（Vercel Cron 约定）等于 CRON_SECRET，
 * 常量时间比较；CRON_SECRET 未配置时 503（不静默）。
 *
 * 流程：
 *   1. 装载全部 isActive 凭证（含密文）；
 *   2. 逐凭证：refreshCredential（解密 → adapter.fetchBalance → 成功写快照 + 复位状态，
 *      失败只更新 lastStatus/failCount、不写伪余额），单凭证异常不抛出（失败隔离，AC2.5）；
 *   3. 逐凭证评估告警（24h 频控）→ 站内 AlertEvent + 邮件；
 *   4. 返回脱敏汇总 { processed, failed[], byProvider }。
 * （M5 补并发限流编排：p-limit 全局 3、Kimi 令牌桶 ≤3/min、单请求 10s 超时。）
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import {
  ALERT_TYPES,
  DEFAULT_FAIL_THRESHOLD_N,
  DEFAULT_LOW_BALANCE_THRESHOLD,
  evaluateAlerts,
  type AlertType,
} from "@/lib/alerts/evaluate";
import { listActiveCredentialsWithSecret } from "@/lib/credentials/repo";
import { getProvider } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";
import { refreshCredential } from "@/lib/snapshot/runner";
import { runSnapshots } from "@/lib/snapshot/orchestrator";
import { toMoney, type Money } from "@/lib/money";
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

async function handleCron(request: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET 未配置：请在 .env 设置 CRON_SECRET 后调用本端点" },
      { status: 503 }
    );
  }
  const provided =
    request.headers.get("x-cron-secret") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secretMatches(provided, cronSecret)) {
    return NextResponse.json({ ok: false, error: "鉴权失败：x-cron-secret 不匹配" }, { status: 401 });
  }

  const credentials = await listActiveCredentialsWithSecret();
  const byId = new Map(credentials.map((c) => [c.id, c]));

  // 分平台限频：Kimi 3/min（adapter 声明）；其余不额外限频
  const rateLimitPerMin: Partial<Record<ProviderId, number>> = {
    kimi: 3,
  };

  const runResult = await runSnapshots({
    credentials: credentials.map((c) => ({ id: c.id, provider: c.provider })),
    globalConcurrency: 3,
    rateLimitPerMin,
    runOne: async (scheduled) => {
      const cred = byId.get(scheduled.id);
      if (!cred) {
        return { credentialId: scheduled.id, ok: false, reason: "ERROR" };
      }
      const adapter = getProvider(cred.provider);
      let refresh;
      if (!adapter) {
        // 平台未注册：视为 ERROR，只更新状态位
        await db.credential
          .update({ where: { id: cred.id }, data: { lastStatus: "ERROR", failCount: { increment: 1 } } })
          .catch(() => {});
        refresh = {
          credentialId: cred.id,
          ok: false,
          snapshots: 0,
          reason: "ERROR" as const,
          message: `provider ${cred.provider} 未注册`,
        };
      } else {
        refresh = await refreshCredential(
          {
            id: cred.id,
            provider: cred.provider,
            region: cred.region,
            iv: cred.iv,
            authTag: cred.authTag,
            ciphertext: cred.ciphertext,
          },
          adapter
        );
      }

      if (refresh.ok) {
        await evaluateAndDispatchAlerts(cred.id, cred.provider, cred.hint, cred.userId, "success");
      } else {
        console.warn(
          `[cron:snapshot] credential=${cred.id} provider=${cred.provider} hint=${cred.hint} fetch failed reason=${refresh.reason ?? "unknown"}`
        );
        await evaluateAndDispatchAlerts(cred.id, cred.provider, cred.hint, cred.userId, "failure");
      }
      return { credentialId: cred.id, ok: refresh.ok, reason: refresh.reason };
    },
  });

  return NextResponse.json({
    ok: true,
    processed: runResult.processed,
    failed: runResult.failed,
    byProvider: runResult.byProvider,
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handleCron(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handleCron(request);
}

// ── 预警评估与派发（AC5-1/2/3；告警扩展与去重键修正详见 M5） ──

const DEFAULT_ALERT_SETTINGS = {
  lowBalanceThreshold: DEFAULT_LOW_BALANCE_THRESHOLD,
  failThresholdN: DEFAULT_FAIL_THRESHOLD_N,
  emailEnabled: true,
  inappEnabled: true,
};

/**
 * 单凭证预警评估（站内 + 邮件）。设置读 AlertSetting（无记录用默认值）；
 * 频控：按 (type, credentialId) 查最近一次同类事件，24h 窗口内不重复（AC5-3）；
 * 告警内容只含平台/脱敏标识/类型/数值，绝无明文凭证（AC5.3）。
 */
async function evaluateAndDispatchAlerts(
  credentialId: string,
  provider: ProviderId,
  hint: string,
  userId: string,
  mode: "success" | "failure"
): Promise<void> {
  try {
    if (!userId) {
      const row = await db.credential.findUnique({ where: { id: credentialId }, select: { userId: true } });
      if (!row) return;
      userId = row.userId;
    }
    const settingsRow = await db.alertSetting.findUnique({ where: { userId } });
    const base = settingsRow
      ? {
          lowBalanceThreshold: toMoney(settingsRow.lowBalanceThreshold),
          failThresholdN: settingsRow.failThresholdN,
          emailEnabled: settingsRow.emailEnabled,
          inappEnabled: settingsRow.inappEnabled,
        }
      : DEFAULT_ALERT_SETTINGS;
    // 分平台阈值覆盖（FR-5 / 计划锁定）：凭证级 > 平台级 > 全局默认
    const [provOverride, credOverride] = await Promise.all([
      db.alertOverride.findFirst({ where: { userId, provider, credentialId: null } }),
      db.alertOverride.findFirst({ where: { userId, provider, credentialId } }),
    ]);
    const settings = {
      lowBalanceThreshold:
        credOverride?.lowBalanceThreshold !== null && credOverride?.lowBalanceThreshold !== undefined
          ? toMoney(credOverride.lowBalanceThreshold)
          : provOverride?.lowBalanceThreshold !== null && provOverride?.lowBalanceThreshold !== undefined
            ? toMoney(provOverride.lowBalanceThreshold)
            : base.lowBalanceThreshold,
      failThresholdN:
        credOverride?.failThresholdN ?? provOverride?.failThresholdN ?? base.failThresholdN,
      emailEnabled:
        credOverride?.emailEnabled ?? provOverride?.emailEnabled ?? base.emailEnabled,
      inappEnabled:
        credOverride?.inappEnabled ?? provOverride?.inappEnabled ?? base.inappEnabled,
    };
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return;

    // 重新读最新凭证状态与快照（评估基于刷新后的状态）
    const key = await db.credential.findUnique({
      where: { id: credentialId },
      select: { id: true, provider: true, hint: true, failCount: true, lastStatus: true },
    });
    if (!key) return;

    const latestSnapshot = await db.balanceSnapshot.findFirst({
      where: { credentialId, ok: true },
      orderBy: { fetchedAt: "desc" },
      select: { currency: true, available: true, isAvailable: true, fetchedAt: true },
    });
    const prevSnapshot = latestSnapshot
      ? await db.balanceSnapshot.findFirst({
          where: {
            credentialId,
            ok: true,
            currency: latestSnapshot.currency,
            fetchedAt: { lt: latestSnapshot.fetchedAt },
          },
          orderBy: { fetchedAt: "desc" },
          select: { isAvailable: true },
        })
      : null;

    const latestView = latestSnapshot
      ? {
          available: toMoney(latestSnapshot.available) as Money,
          isAvailable: latestSnapshot.isAvailable,
          currency: latestSnapshot.currency,
        }
      : null;

    for (const type of ALERT_TYPES) {
      if (mode === "success" && type === "CREDENTIAL_FAILED") continue; // 成功路径不评估失败告警
      const lastEvent = await db.alertEvent.findFirst({
        where: { credentialId, type },
        orderBy: { createdAt: "desc" },
        select: { type: true, createdAt: true },
      });
      const lastAlert = lastEvent ? { type: lastEvent.type as AlertType, createdAt: lastEvent.createdAt } : null;
      const candidate = evaluateAlerts({
        settings,
        key: {
          id: key.id,
          provider: key.provider,
          hint: key.hint,
          failCount: key.failCount,
          lastStatus: key.lastStatus,
        },
        latestSnapshot: latestView,
        prevSnapshot,
        lastAlert,
      }).find((c) => c.type === type);
      if (!candidate) continue;

      if (settings.inappEnabled) {
        try {
          await db.alertEvent.create({
            data: {
              userId,
              provider,
              credentialId,
              type: candidate.type,
              message: candidate.message,
              dedupKey: candidate.dedupKey,
            },
          });
        } catch (err) {
          if ((err as { code?: string } | null)?.code !== "P2002") throw err;
          continue; // 并发同刻写入：视为已派发，跳过邮件防重
        }
      }

      if (settings.emailEnabled) {
        const { subject, html } = renderAlertEmail({
          type: candidate.type,
          last4: hint,
          message: candidate.message,
          severity: candidate.severity,
        });
        const sent = await sendAlertEmail({ to: user.email, subject, html });
        if (!sent.ok) {
          console.warn(`[cron:snapshot] credential=${credentialId} alert email failed: ${sent.error}`);
        }
      }

      console.log(
        `[cron:snapshot] alert=${candidate.type} credential=${credentialId} provider=${provider} severity=${candidate.severity} inapp=${settings.inappEnabled} email=${settings.emailEnabled}`
      );
    }
  } catch (err) {
    console.warn(
      `[cron:snapshot] credential=${credentialId} alert skip: ${err instanceof Error ? err.name : "unknown"}`
    );
  }
}
