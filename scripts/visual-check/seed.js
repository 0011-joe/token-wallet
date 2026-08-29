#!/usr/bin/env node
/**
 * DeepBalance 视觉验收造数脚本（QA 专用，只写 dev.db，不改业务代码）
 *
 * 用途：为 scripts/visual-check/run-visual-check.js 提供确定性的看板数据：
 *   - QA 用户（默认 qa-visual@example.com，魔法链接登录时由 NextAuth 创建或复用）；
 *   - Key A（真实 Key，通过表单导入）：14+ 天 / 20+ 条 CNY 快照、含 1 条
 *     isAvailable=false、含 1 段 >2h 缺口（gap 日 hasGap=true）、1 次充值、2 条 USD 快照；
 *   - Key B（QA-沙箱 Key）：最新快照 isAvailable=false（演示「余额不足」状态）；
 *   - 待删 Key：演示列表「确认删除」流程用；
 *   - 3 条 AlertEvent（最近预警列表渲染）。
 *
 * 幂等：重复运行先清掉本脚本可管理的 QA 数据再重建（不删除真实 Key A 本身，
 * 只重建它的快照；Key A 由 run-visual-check.js 通过表单导入）。
 *
 * 安全：本脚本绝不读写 API Key 明文；真实 Key 用 last4 识别（--real-last4 参数）。
 *
 * 用法（在项目根目录执行）：
 *   node scripts/visual-check/seed.js --email qa-visual@example.com --real-last4 d8d7
 *   node scripts/visual-check/seed.js --email qa-visual@example.com --fake-real-last4 d8d7  # 真实 Key 导入失败时的回退
 *   node scripts/visual-check/seed.js --email qa-visual@example.com --clean                # 清除全部 QA 数据（用户连带删）
 *
 * 输出：最后一行打印 JSON 摘要（keyId/last4/期望金额等），供检查脚本断言。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");

// -- 参数 --
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf("--" + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const EMAIL = argValue("email") ?? "qa-visual@example.com";
const REAL_LAST4 = argValue("real-last4");
const FAKE_REAL_LAST4 = argValue("fake-real-last4");
// 两种参数携带的都是 Key A 的 last4（区别仅在是否已通过表单实测导入）；
// 查找 Key A 时两者等价，否则 dup 跳过的重复运行会误入假造分支（P2002）
const KEYA_LAST4 = REAL_LAST4 ?? FAKE_REAL_LAST4;
const CLEAN = args.includes("--clean");

// -- 读取 .env.local（只取 DATABASE_URL；不解析、不打印任何密钥值）--
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}
const env = loadEnv(path.join(__dirname, "..", "..", ".env.local"));
const DATABASE_URL = env.DATABASE_URL ?? "file:./dev.db";

const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL });
const db = new PrismaClient({ adapter });

const DAY_MS = 24 * 60 * 60 * 1000;
const r2 = (n) => Math.round(n * 100) / 100;
const utcDateOnly = (d) => d.toISOString().slice(0, 10);

function nowUtcDate() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function main() {
  // -- 0. 用户 --
  let user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    user = await db.user.create({
      data: { email: EMAIL, emailVerified: new Date(), name: "QA 视觉验收" },
    });
  }

  if (CLEAN) {
    await db.alertEvent.deleteMany({ where: { userId: user.id } });
    await db.alertSetting.deleteMany({ where: { userId: user.id } });
    const keys = await db.apiKey.findMany({ where: { userId: user.id } });
    for (const k of keys) {
      await db.balanceSnapshot.deleteMany({ where: { apiKeyId: k.id } });
      await db.apiKey.delete({ where: { id: k.id } });
    }
    await db.user.delete({ where: { id: user.id } });
    console.log(JSON.stringify({ cleaned: true, email: EMAIL }));
    process.exit(0);
  }

  // -- 1. 清理本脚本可管理的 QA 数据（保留用户与真实 Key A）--
  const userKeys = await db.apiKey.findMany({ where: { userId: user.id } });
  const keyA = KEYA_LAST4
    ? userKeys.find((k) => k.last4 === KEYA_LAST4)
    : undefined;

  for (const k of userKeys) {
    if (k.label === "QA-沙箱 Key" || k.label === "QA-待删 Key") {
      await db.balanceSnapshot.deleteMany({ where: { apiKeyId: k.id } });
      await db.apiKey.delete({ where: { id: k.id } });
    } else if (k.last4 === KEYA_LAST4) {
      await db.balanceSnapshot.deleteMany({ where: { apiKeyId: k.id } });
    }
  }

  let realKeyA = keyA;
  if (realKeyA) {
    // 保证 Key A 是列表中最旧的 Key（列表按 createdAt asc -> 首 Key 即默认选中 Key A）
    realKeyA = await db.apiKey.update({
      where: { id: realKeyA.id },
      // lastStatus=OK：真实 Key 实测通过（T3 导入时后端已调 /user/balance 成功）
      data: { createdAt: new Date(Date.now() - 30 * DAY_MS), lastStatus: "OK", failCount: 0 },
    });
  }
  if (!realKeyA && FAKE_REAL_LAST4) {
    // 回退：真实 Key 导入失败时直接造一个 Key A（密文为随机字节，仅用于展示）
    realKeyA = await db.apiKey.create({
      data: {
        userId: user.id,
        label: "主 Key（沙箱回退）",
        ciphertext: crypto.randomBytes(64),
        iv: crypto.randomBytes(12),
        authTag: crypto.randomBytes(16),
        last4: FAKE_REAL_LAST4,
        isActive: true,
        lastStatus: "OK",
        failCount: 0,
      },
    });
  }

  await db.alertEvent.deleteMany({ where: { userId: user.id } });
  await db.alertSetting.deleteMany({ where: { userId: user.id } });
  // 清理历史遗留的孤儿快照（apiKey 已不存在的行，M4 遗留）
  await db.$executeRawUnsafe(
    "DELETE FROM BalanceSnapshot WHERE apiKeyId NOT IN (SELECT id FROM ApiKey)"
  );

  // -- 2. 造 Key B / 待删 Key --
  const keyB = await db.apiKey.create({
    data: {
      userId: user.id,
      label: "QA-沙箱 Key",
      ciphertext: crypto.randomBytes(64),
      iv: crypto.randomBytes(12),
      authTag: crypto.randomBytes(16),
      last4: "0001",
      isActive: true,
      lastStatus: "OK",
      failCount: 0,
      createdAt: new Date(Date.now() - 10 * DAY_MS),
    },
  });
  const keyDel = await db.apiKey.create({
    data: {
      userId: user.id,
      label: "QA-待删 Key",
      ciphertext: crypto.randomBytes(64),
      iv: crypto.randomBytes(12),
      authTag: crypto.randomBytes(16),
      last4: "0002",
      isActive: true,
      lastStatus: "OK",
      failCount: 0,
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    },
  });

  // -- 3. Key A 快照：21 天（每天 09:00 UTC，含缺口日 <-12d、不可用日 <-7d、充值日 <-5d）--
  const today = nowUtcDate();
  const BASE = 1258.1;
  const RATE = 1.35;
  const GAP_OFFSET = 12;   // 今天往前 12 天无快照 -> 恢复日（-11d）hasGap=true
  const UNAVAILABLE_OFFSET = 7;
  const TOPUP_OFFSET = 5;
  const TOPUP_AMOUNT = 50;
  const GRANTED = 200;
  const BASE_TOPUP = r2(BASE - GRANTED); // 消费不改变入账构成（规格卡 C 口径）
  const BASE_TOPUP_PLUS = r2(BASE_TOPUP + TOPUP_AMOUNT); // 充值日后恒值

  const daySnap = []; // {time, total, granted, toppedUp, isAvailable, currency}
  for (let d = 21; d >= 2; d--) {
    if (d === GAP_OFFSET) continue; // 缺口日：当天无快照
    const idx = 21 - d; // 0..19（与 d 反向：d=21 -> idx=0）
    let total = r2(BASE - RATE * idx);
    // 口径：规格卡 C 假设「消费只降 total，不改变 granted/topped_up 构成」；
    // 充值日 total 与 topped_up 同时 +TOPUP_AMOUNT（公式加回充值增量 → 段 cost 不变）
    let toppedUp = BASE_TOPUP;
    if (idx >= 21 - TOPUP_OFFSET) {
      total = r2(total + TOPUP_AMOUNT);
      toppedUp = r2(BASE_TOPUP + TOPUP_AMOUNT);
    }
    daySnap.push({
      time: new Date(today.getTime() - d * DAY_MS + 9 * 3600 * 1000),
      total,
      granted: GRANTED,
      toppedUp,
      isAvailable: d !== UNAVAILABLE_OFFSET,
    });
  }
  // 今天：00:20 / 08:20 / now-5min（确保 今日消耗 有 >=2 快照基准）
  const lastDayTotal = daySnap[daySnap.length - 1].total; // day-2 收盘
  const t1 = r2(lastDayTotal - 0.4);
  const t2 = r2(t1 - 0.3);
  const t3 = r2(t2 - 0.25);
  const nowMinus5 = new Date(Date.now() - 5 * 60 * 1000);
  daySnap.push(
    { time: new Date(today.getTime() + 20 * 60 * 1000), total: t1, granted: GRANTED, toppedUp: BASE_TOPUP_PLUS, isAvailable: true },
    { time: new Date(today.getTime() + 8 * 3600 * 1000), total: t2, granted: GRANTED, toppedUp: BASE_TOPUP_PLUS, isAvailable: true },
    { time: nowMinus5, total: t3, granted: GRANTED, toppedUp: BASE_TOPUP_PLUS, isAvailable: true }
  );
  // USD 币种：2 条（byCurrency 多币种展示）
  daySnap.push(
    { time: new Date(today.getTime() - 10 * DAY_MS + 9 * 3600 * 1000), total: 20.5, granted: 5, toppedUp: 15.5, isAvailable: true, currency: "USD" },
    { time: new Date(today.getTime() - 3 * DAY_MS + 9 * 3600 * 1000), total: 19.9, granted: 5, toppedUp: 14.9, isAvailable: true, currency: "USD" }
  );

  const snapshots = [];
  const snapTargetId = realKeyA ? realKeyA.id : keyB.id;
  for (const s of daySnap) {
    snapshots.push({
      apiKeyId: snapTargetId,
      fetchedAt: s.time,
      currency: s.currency ?? "CNY",
      totalBalance: s.total,
      grantedBalance: s.granted,
      toppedUpBalance: s.toppedUp,
      isAvailable: s.isAvailable,
      ok: true,
    });
  }
  if (realKeyA) {
    for (const s of snapshots) {
      await db.balanceSnapshot.create({ data: s });
    }
  }

  // -- 4. Key B 快照：最新一条 isAvailable=false --
  await db.balanceSnapshot.createMany({
    data: [
      {
        apiKeyId: keyB.id,
        fetchedAt: new Date(today.getTime() - 2 * DAY_MS + 9 * 3600 * 1000),
        currency: "CNY",
        totalBalance: 6.0,
        grantedBalance: 1.0,
        toppedUpBalance: 5.0,
        isAvailable: true,
        ok: true,
      },
      {
        apiKeyId: keyB.id,
        fetchedAt: new Date(today.getTime() - 1 * DAY_MS + 9 * 3600 * 1000),
        currency: "CNY",
        totalBalance: 5.5,
        grantedBalance: 1.0,
        toppedUpBalance: 4.5,
        isAvailable: true,
        ok: true,
      },
      {
        apiKeyId: keyB.id,
        fetchedAt: new Date(Date.now() - 3 * 60 * 1000),
        currency: "CNY",
        totalBalance: 5.2,
        grantedBalance: 1.0,
        toppedUpBalance: 4.2,
        isAvailable: false,
        ok: true,
      },
    ],
  });

  // -- 5. 预警设置（默认值）+ 3 条预警事件 --
  await db.alertSetting.create({
    data: {
      userId: user.id,
      lowBalanceThreshold: 20,
      failThresholdN: 3,
      emailEnabled: true,
      inappEnabled: true,
    },
  });
  const keyIdForEvents = realKeyA ? realKeyA.id : keyB.id;
  await db.alertEvent.createMany({
    data: [
      {
        userId: user.id,
        apiKeyId: keyIdForEvents,
        type: "LOW_BALANCE",
        message: "余额低于阈值（¥20.00），当前余额 ¥15.00，请及时充值。",
        dedupKey: randomUUID(),
        createdAt: new Date(Date.now() - 2 * 3600 * 1000),
      },
      {
        userId: user.id,
        apiKeyId: keyIdForEvents,
        type: "UNAVAILABLE",
        message: "账户不可用：官方接口返回 is_available=false，余额不足无法调用。",
        dedupKey: randomUUID(),
        createdAt: new Date(Date.now() - 26 * 3600 * 1000),
      },
      {
        userId: user.id,
        apiKeyId: keyIdForEvents,
        type: "KEY_FAILED",
        message: "Key（sk-…0001）连续失败 3 次（最近错误：INVALID）。",
        dedupKey: randomUUID(),
        createdAt: new Date(Date.now() - 3 * DAY_MS),
      },
    ],
  });

  // -- 6. 摘要 JSON（最后一行，供检查脚本断言）--
  // 以真实入库数据复算 today/month（口径与后端一致：段起点 >= fromMs 的逐段 delta 累加）
  const cnySnaps = await db.balanceSnapshot.findMany({
    where: { apiKeyId: snapTargetId, ok: true, currency: "CNY" },
    orderBy: { fetchedAt: "asc" },
  });
  function segDelta(a, b) {
    const c = -(b.totalBalance - a.totalBalance) + (b.toppedUpBalance - a.toppedUpBalance) + (b.grantedBalance - a.grantedBalance);
    return c > 0 ? c : 0;
  }
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  let todayCost = 0;
  let monthCost = 0;
  for (let k = 1; k < cnySnaps.length; k++) {
    const d = segDelta(cnySnaps[k - 1], cnySnaps[k]);
    if (cnySnaps[k - 1].fetchedAt >= todayStart) todayCost += d;
    if (cnySnaps[k - 1].fetchedAt >= monthStart) monthCost += d;
  }
  todayCost = r2(todayCost);
  monthCost = r2(monthCost);
  const latest = cnySnaps[cnySnaps.length - 1];
  const latestBalance = { total: latest.totalBalance, granted: latest.grantedBalance, toppedUp: latest.toppedUpBalance };
  const gapDate = new Date(today.getTime() - 11 * DAY_MS + 9 * 3600 * 1000);

  const summary = {
    email: EMAIL,
    userId: user.id,
    keyA: realKeyA
      ? { id: realKeyA.id, last4: realKeyA.last4, label: realKeyA.label }
      : null,
    keyB: { id: keyB.id, last4: keyB.last4, label: keyB.label },
    keyDel: { id: keyDel.id, last4: keyDel.last4, label: keyDel.label },
    latestBalance,
    todayCost,
    monthCost,
    gapDate: utcDateOnly(gapDate),
    snapshots: snapshots.length,
    fakeKeyA: !realKeyA,
  };
  console.log("SEED_SUMMARY=" + JSON.stringify(summary));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("seed failed:", e);
    process.exit(1);
  });
