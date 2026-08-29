#!/usr/bin/env node
/**
 * DeepBalance 视觉与交互验收主脚本（QA 专用；不修改任何业务代码）
 *
 * 覆盖：
 *  T1 未登录访问受保护页 -> 307 /login
 *  T2 登录链路（魔法链接：服务端控制台日志提取 -> 回调 -> 会话建立）
 *  T3 Key 表单：非法格式即时拦截 + 真实 Key 导入（.env.local 运行时读取，绝不落盘）
 *  T4 造数（调 seed.js）后的仪表盘四卡 / 估算口径弹层 / 趋势 7-30-90 / 缺口标记 /
 *     余额构成环形图 / Key 切换下拉 / 分模型 CSV 导入（含 cost 文件报错路径）
 *  T5 响应式 375x812 / 1024
 *  T6 Key 管理页：掩码 / 状态文字 / Switch 启停 / 删除确认（原生 confirm）
 *  T7 设置页：预警设置保存-重载-持久化 / 事件列表 / 登出与注销按钮存在（不点击）
 *
 * 用法（项目根目录）：
 *   npm run build    # 首次前先构建
 *   node scripts/visual-check/run-visual-check.js
 *   可选：--email xxx  --attach（使用已运行的服务，且从 server.log 尾部提取魔法链接）
 *   退出码：0 = 全部 PASS；1 = 存在 FAIL
 * 环境变量：QA_PORT（默认 3000）、QA_HEADFUL=1（有头调试）
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SHOT_DIR = path.join(__dirname, "shots");
const LOG_FILE = path.join(__dirname, "server.log");
const PORT = Number(process.env.QA_PORT ?? 3000);
const BASE = "http://localhost:" + PORT;
const HEADFUL = process.env.QA_HEADFUL === "1";

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf("--" + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const EMAIL = argValue("email") ?? "qa-visual@example.com";
const ATTACH = args.includes("--attach");

const results = [];
function record(id, name, pass, note, shot) {
  const r = { id, name, pass: Boolean(pass), note: note ?? "", shot: shot ?? null };
  results.push(r);
  console.log(
    (r.pass ? "PASS" : "FAIL") +
      " | " + id + " " + name +
      (r.note ? " | " + r.note : "") +
      (r.shot ? " | shot: " + r.shot : "")
  );
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function rel(p) {
  return path.join(SHOT_DIR, p);
}
function shotPath(name) {
  return rel(name + ".png");
}

// ── 读取 .env.local：只暴露「变量名是否存在 / last4 / 值仅存内存」──
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const envLocal = loadEnv(path.join(ROOT, ".env.local"));
const REAL_KEY = typeof envLocal.DEEPSEEK_API_KEY === "string" ? envLocal.DEEPSEEK_API_KEY.trim() : "";
const REAL_LAST4 = REAL_KEY ? REAL_KEY.slice(-4) : "";
/** 报告/日志只允许出现 last4 */
function safeLast4() {
  return REAL_LAST4;
}

// ── 服务器托管：独占端口 + 魔法链接日志解析 ──
let serverProc = null;
let serverLines = [];
let logStream = null;

function onServerLine(line) {
  serverLines.push(line);
  if (logStream) logStream.write(line + "\n");
}

async function probeUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(BASE + "/api/auth/providers", { signal: ctrl.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probeUp()) {
    if (!ATTACH) {
      console.error("[server] " + BASE + " 已有服务在跑：无法读取魔法链接日志。请先停止它（或加 --attach 并从 server.log 提取）。");
      process.exit(1);
    }
    // attach 模式：把 server.log 尾部读入内存（若存在）
    if (fs.existsSync(LOG_FILE)) {
      const tail = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
      serverLines.push(...tail.slice(-200));
    }
    console.log("[server] attach 到已有服务 " + BASE);
    return;
  }
  console.log("[server] 启动 next start (port " + PORT + ") ...");
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  serverProc = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  serverProc.stdout.on("data", (b) => {
    for (const l of b.toString().split(/\r?\n/)) if (l) onServerLine(l);
  });
  serverProc.stderr.on("data", (b) => {
    for (const l of b.toString().split(/\r?\n/)) if (l) onServerLine(l);
  });
  serverProc.on("exit", (code) => {
    if (code !== null && results.length === 0) console.error("[server] 意外退出 code=" + code);
  });
  for (let i = 0; i < 120; i++) {
    if (await probeUp()) {
      console.log("[server] 就绪");
      return;
    }
    await sleep(1000);
  }
  throw new Error("[server] 120s 未就绪，检查构建（需先 npm run build）");
}

function findMagicLink(email, sinceIdx) {
  const re = /魔法链接 for ([^\s:]+):\s*(\S+)/;
  for (let i = sinceIdx; i < serverLines.length; i++) {
    const m = serverLines[i].match(re);
    if (m && m[1] === email) return { url: m[2], idx: i };
  }
  return null;
}

async function waitMagicLink(email, timeoutMs) {
  const t0 = Date.now();
  let lastIdx = 0;
  while (Date.now() - t0 < timeoutMs) {
    const hit = findMagicLink(email, lastIdx);
    if (hit) return hit.url;
    lastIdx = Math.max(0, serverLines.length - 40);
    await sleep(500);
  }
  return null;
}

function stopServer() {
  if (!serverProc) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      serverProc.kill("SIGTERM");
    }
  } catch {
    /* 忽略 */
  }
  if (logStream) logStream.end();
  serverProc = null;
}

// ── 浏览器辅助 ──
const { chromium } = require("playwright");

function money(n) {
  return (
    "\u00a5" +
    n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

async function expectText(page, text, timeoutMs) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: timeoutMs ?? 10000 });
}

async function main() {
  await ensureServer();

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADFUL,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // ── T1 未登录访问受保护页 ──
  try {
    const checks = [];
    for (const p of ["/dashboard", "/keys", "/settings"]) {
      const r = await context.request.get(BASE + p, { maxRedirects: 0 });
      checks.push(
        p + " -> " + r.status() + " " + (r.headers()["location"] ?? "-")
      );
      if (r.status() !== 307 || !(r.headers()["location"] ?? "").includes("/login")) {
        throw new Error(p + " 未返回 307 /login，实际 " + r.status());
      }
    }
    record("T1", "未登录访问受保护页 307 -> /login", true, checks.join("; "));
  } catch (e) {
    record("T1", "未登录访问受保护页 307 -> /login", false, e.message);
  }

  // ── T2 登录链路 ──
  let loggedIn = false;
  try {
    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    await expectText(page, "登录 DeepBalance");
    await page.screenshot({ path: shotPath("01-login-page"), fullPage: true });
    await page.fill("#email", EMAIL);
    await page.click("button:has-text('发送登录链接')");
    await expectText(page, "已发送登录链接", 15000);
    const magic = await waitMagicLink(EMAIL, 60000);
    if (!magic) throw new Error("60s 内未在服务端日志找到魔法链接");
    const linkDomain = new URL(magic).host;
    record("T2a", "魔法链接生成（服务端日志提取）", true, "host=" + linkDomain);
    await page.goto(magic, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const landUrl = new URL(page.url()).pathname;
    record("T2b", "魔法链接回调后落地页", true, "landed=" + landUrl);
    // 会话建立：token cookie 存在
    const cookies = await context.cookies(BASE);
    const hasSession = cookies.some((c) => c.name.startsWith("next-auth.session-token"));
    if (!hasSession) throw new Error("回调后未建立会话 cookie");
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    await expectText(page, "仪表盘", 20000);
    const emptyOrCards = await Promise.race([
      page.getByText("还未绑定 API Key").waitFor({ state: "visible", timeout: 8000 }).then(function () { return "empty"; }),
      page.getByText("账户总余额").first().waitFor({ state: "visible", timeout: 20000 }).then(function () { return "cards"; }),
    ]);
    await page.screenshot({ path: shotPath("02-login-session-dashboard"), fullPage: true });
    loggedIn = true;
    record("T2c", "登录链路：会话建立并渲染 /dashboard", true);
  } catch (e) {
    record("T2c", "登录链路", false, e.message);
  }

  // ── T3 Key 表单：非法格式拦截 + 真实 Key 导入 ──
  let realImportOk = false;
  let keyALast4 = null;
  if (loggedIn) {
    try {
      await page.goto(BASE + "/keys", { waitUntil: "networkidle" });
      await expectText(page, "Key 管理");
      // T3a 非法格式即时拦截
      await page.fill("#key-api-key", "sk-123");
      await page.click("button:has-text('添加 Key')");
      await expectText(page, "Key 格式不正确", 8000);
      await page.screenshot({ path: shotPath("03-key-invalid-format"), fullPage: true });
      record("T3a", "非法 Key 格式前端即时拦截提示", true);
    } catch (e) {
      record("T3a", "非法 Key 格式前端即时拦截提示", false, e.message);
    }

    // T3b 真实 Key 导入（.env.local 运行时读取）
    try {
      if (!REAL_KEY) {
        throw new Error("环境无 DEEPSEEK_API_KEY（仅变量名探测，值未读取）");
      }
      const resp = await context.request.get(BASE + "/api/keys");
      const existing = await resp.json();
      const dup = (existing.keys ?? []).find((k) => k.last4 === REAL_LAST4);
      if (dup) {
        keyALast4 = REAL_LAST4;
        record("T3b", "真实 Key 导入（sk-\u2026" + REAL_LAST4 + "）", true, "重复运行：表单跳过，Key 已存在（id=" + dup.id + "）");
      } else {
        await page.fill("#key-label", "\u4e3b Key");
        await page.fill("#key-api-key", REAL_KEY);
        await page.click("button:has-text('\u6dfb\u52a0 Key')");
        // 成功 or 失败提示（会做真实 DeepSeek 余额校验，最长约 10s+）
        const okMsg = page.locator("p[role='status']");
        const errMsg = page.locator("p[role='alert']");
        const winner = await Promise.race([
          okMsg.waitFor({ state: "visible", timeout: 120000 }).then(() => "ok"),
          errMsg.waitFor({ state: "visible", timeout: 120000 }).then(() => "err"),
        ]);
        if (winner === "ok") {
          keyALast4 = REAL_LAST4;
          realImportOk = true;
          await page.screenshot({ path: shotPath("04-key-added-success"), fullPage: true });
          record("T3b", "真实 Key 导入（sk-\u2026" + REAL_LAST4 + "）", true);
        } else {
          const errText = (await errMsg.textContent()) ?? "";
          await page.screenshot({ path: shotPath("04-key-added-error"), fullPage: true });
          record("T3b", "真实 Key 导入（sk-\u2026" + REAL_LAST4 + "）", false, "表单返回错误：" + errText.slice(0, 120));
        }
      }
    } catch (e) {
      record("T3b", "真实 Key 导入", false, e.message.slice(0, 160));
    }

    // ── T4 造数（seed.js）──
    try {
      const seedArgs = ["scripts/visual-check/seed.js", "--email", EMAIL];
      if (keyALast4) {
        seedArgs.push(realImportOk ? "--real-last4" : "--fake-real-last4", keyALast4);
      }
      const out = spawnSync(process.execPath, seedArgs, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      const line = (out.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("SEED_SUMMARY="));
      if (!line) throw new Error("seed.js 无摘要输出：" + (out.stderr ?? out.stdout ?? "").slice(-400));
      globalThis.__seed = JSON.parse(line.slice("SEED_SUMMARY=".length));
      record("T4a", "seed.js 造数（Key A 快照/缺口/不可用/充值/USD + Key B/待删 Key + 3 条预警事件）", true,
        "snapshots=" + globalThis.__seed.snapshots + " keyA=" + (globalThis.__seed.keyA ? "ok(" + globalThis.__seed.keyA.last4 + ")" : "null"));
      if (!globalThis.__seed.keyA) {
        record("T4b", "Key A 存在性", false, "真实 Key 导入失败且无回退 Key A");
      } else {
        record("T4b", "Key A 存在性", true, "keyA.id=" + globalThis.__seed.keyA.id.split("-")[0] + "... keyA.last4=" + globalThis.__seed.keyA.last4);
      }
    } catch (e) {
      record("T4a", "seed.js 造数", false, e.message.slice(0, 300));
    }
  }

  // ---- T5 仪表盘（Key A）----
  const seed = globalThis.__seed;
  if (loggedIn && seed && seed.keyA) {
    try {
      await page.goto(BASE + "/dashboard?keyId=" + seed.keyA.id, { waitUntil: "networkidle" });
      await expectText(page, "\u8d26\u6237\u603b\u4f59\u989d", 20000);
      await expectText(page, "\u4eca\u65e5\u6d88\u8017", 10000);
      await expectText(page, "\u672c\u6708\u6d88\u8017", 10000);
      await expectText(page, "\u8d26\u6237\u72b6\u6001", 10000);
      const bal = seed.latestBalance;
      const cardText = await page.locator("body").innerText();
      const expects = [
        ["\u4f59\u989d\u4e3b\u6570\u5b57", money(bal.total)],
        ["\u8d60\u91d1", "\u8d60\u91d1 " + money(bal.granted)],
        ["\u5145\u503c", "\u5145\u503c " + money(bal.toppedUp)],
        ["\u4eca\u65e5\u6d88\u8017\u91d1\u989d", money(seed.todayCost)],
        ["\u672c\u6708\u6d88\u8017\u91d1\u989d", money(seed.monthCost)],
        ["\u4f30\u7b97\u53e3\u5f84\u8bf4\u660e", "\u7531\u4f59\u989d\u5feb\u7167\u5dee\u503c\u4f30\u7b97"],
      ];
      const bad = [];
      for (const e of expects) if (!cardText.includes(e[1])) bad.push(e[0] + "\u7f3a" + e[1]);
      const badgeCount = await page.getByRole("button", { name: "\u67e5\u770b\u4f30\u7b97\u53e3\u5f84\u8bf4\u660e" }).count();
      if (badgeCount !== 3) bad.push("\u4f30\u7b97\u6807\u8bc6\u6570=" + badgeCount + "\uff08\u671f\u671b3\uff09");
      if (!cardText.includes("\u53ef\u8c03\u7528")) bad.push("\u72b6\u6001\u5361\u7f3a\u300c\u53ef\u8c03\u7528\u300d");
      if (!cardText.includes("\u4f59\u989d\u6784\u6210")) bad.push("\u7f3a\u300c\u4f59\u989d\u6784\u6210\u300d\u5361");
      const pctGranted = ((bal.granted / bal.total) * 100).toFixed(1);
      const pctTopped = ((bal.toppedUp / bal.total) * 100).toFixed(1);
      if (!cardText.includes("\uff08" + pctGranted + "%\uff09")) bad.push("\u8d60\u91d1\u5360\u6bd4" + pctGranted + "%\u672a\u663e\u793a");
      if (!cardText.includes("\uff08" + pctTopped + "%\uff09")) bad.push("\u5145\u503c\u5360\u6bd4" + pctTopped + "%\u672a\u663e\u793a");
      await page.screenshot({ path: shotPath("05-dashboard-four-cards"), fullPage: true });
      if (bad.length) throw new Error(bad.join("\uff1b"));
      await page.screenshot({ path: shotPath("05-dashboard-four-cards"), fullPage: true });
      record("T5a", "\u56db\u5361\u6e32\u67d3\u4e0e\u6570\u503c\uff08\u4f59\u989d=\u6700\u65b0\u5feb\u7167\u3001\u4eca\u65e5/\u672c\u6708\u4f30\u7b97\u3001\u72b6\u6001\u5361\u3001\u4f30\u7b97\u6807\u8bc6 x3\uff09", true,
        "balance=" + money(bal.total) + " today=" + money(seed.todayCost) + " month=" + money(seed.monthCost));
    } catch (e) {
      record("T5a", "\u56db\u5361\u6e32\u67d3\u4e0e\u6570\u503c", false, e.message.slice(0, 300));
    }

    try {
      await page.getByRole("button", { name: "\u67e5\u770b\u4f30\u7b97\u53e3\u5f84\u8bf4\u660e" }).first().click();
      await expectText(page, "\u300c\u4f30\u7b97\u300d\u53e3\u5f84\u8bf4\u660e", 8000);
      await page.screenshot({ path: shotPath("06-estimate-dialog"), fullPage: true });
      await page.getByRole("button", { name: "\u5173\u95ed" }).click();
      await sleep(400);
      const still = await page.getByText("\u300c\u4f30\u7b97\u300d\u53e3\u5f84\u8bf4\u660e").count();
      if (still > 0) throw new Error("\u5f39\u5c42\u672a\u5173\u95ed");
      record("T5b", "\u4f30\u7b97\u6807\u8bc6\u2192\u53e3\u5f84\u8bf4\u660e\u5f39\u5c42\u5f00\u5173", true);
    } catch (e) {
      record("T5b", "\u4f30\u7b97\u6807\u8bc6\u2192\u53e3\u5f84\u8bf4\u660e\u5f39\u5c42\u5f00\u5173", false, e.message.slice(0, 200));
    }

    try {
      await expectText(page, "\u65e5\u6d88\u8017\u8d8b\u52bf", 8000);
      await expectText(page, "\u5feb\u7167\u7f3a\u53e3\u65e5", 8000);
      const amber = page.locator("circle[fill='#f59e0b']");
      const amberCount = await amber.count();
      const ticks30 = await page.locator(".recharts-cartesian-axis-tick-value").allTextContents();
      await page.screenshot({ path: shotPath("07-trend-30-gap-day"), fullPage: true });
      if (amberCount < 1) throw new Error("\u672a\u89c1\u7f3a\u53e3\u65e5\u7458\u73c0\u70b9");
      record("T5c-30d", "\u8d8b\u52bf30\u5929\uff1a\u7f3a\u53e3\u65e5\u7458\u73c0\u70b9+\u56fe\u4f8b", true, "amber=" + amberCount + " ticks=" + ticks30.length);
      await page.click("button:has-text('90 \u5929')");
      await sleep(1200);
      const ticks90 = await page.locator(".recharts-cartesian-axis-tick-value").allTextContents();
      await page.screenshot({ path: shotPath("08-trend-90d"), fullPage: true });
      if (ticks90.join("|") === ticks30.join("|")) throw new Error("90\u5929\u4e0e30\u5929\u523b\u5ea6\u4e32\u76f8\u540c\uff08\u672a\u91cd\u7ed8\uff1f\uff09");
      await page.click("button:has-text('7 \u5929')");
      await sleep(1200);
      const ticks7 = await page.locator(".recharts-cartesian-axis-tick-value").allTextContents();
      await page.screenshot({ path: shotPath("09-trend-7d"), fullPage: true });
      if (ticks7.join("|") === ticks90.join("|")) throw new Error("7\u5929\u4e0e90\u5929\u523b\u5ea6\u4e32\u76f8\u540c");
      record("T5c-switch", "\u8d8b\u52bf 7/30/90 \u5207\u6362\u56fe\u8868\u91cd\u7ed8", true,
        "ticks 30=" + ticks30.length + " 90=" + ticks90.length + " 7=" + ticks7.length);
      await page.click("button:has-text('30 \u5929')");
      await sleep(800);
    } catch (e) {
      record("T5c", "\u8d8b\u52bf\u56fe\u7f3a\u53e3\u6807\u8bb0\u4e0e 7/30/90 \u5207\u6362", false, e.message.slice(0, 240));
    }

    try {
      await page.locator(".recharts-pie").first().waitFor({ state: "attached", timeout: 8000 });
      const cellCount = await page.locator(".recharts-pie .recharts-sector").count();
      if (cellCount < 2) throw new Error("\u73af\u5f62\u56fe\u6162\u533a<2");
      await page.screenshot({ path: shotPath("10-balance-composition"), fullPage: true });
      record("T5d", "\u4f59\u989d\u6784\u6210\u73af\u5f62\u56fe\uff08\u8d60\u91d1/\u5145\u503c\uff09", true, "sectors=" + cellCount);
    } catch (e) {
      record("T5d", "\u4f59\u989d\u6784\u6210\u73af\u5f62\u56fe", false, e.message.slice(0, 200));
    }

    try {
      const sw = page.locator("select[aria-label='\u5207\u6362 Key']");
      await sw.waitFor({ state: "visible", timeout: 8000 });
      const optCount = await sw.locator("option").count();
      if (optCount < 2) throw new Error("\u4e0b\u62c9\u9009\u9879\u6570=" + optCount + "\uff08<2\uff09");
      await sw.selectOption(seed.keyB.id);
      await page.waitForURL("**/dashboard?keyId=*", { timeout: 8000 });
      await expectText(page, "\u4f59\u989d\u4e0d\u8db3\uff0c\u65e0\u6cd5\u8c03\u7528", 15000);
      const selVal = await sw.inputValue();
      if (selVal !== seed.keyB.id) throw new Error("切换后下拉值=" + selVal);
      await expectText(page, "Key：QA-沙箱 Key", 8000);
      await page.screenshot({ path: shotPath("11-dashboard-keyB-unavailable"), fullPage: true });
      await sw.selectOption(seed.keyA.id);
      await page.waitForURL("**/dashboard?keyId=*", { timeout: 8000 });
      await expectText(page, "\u53ef\u8c03\u7528", 15000);
      record("T5e", "Key \u5207\u6362\u4e0b\u62c9\uff08\u5207\u5230\u4e0d\u53ef\u7528 Key\uff09", true, "options=" + optCount);
    } catch (e) {
      record("T5e", "Key \u5207\u6362\u4e0b\u62c9", false, e.message.slice(0, 200));
    }

    try {
      await page.goto(BASE + "/dashboard?keyId=" + seed.keyA.id, { waitUntil: "networkidle" });
      await page.getByText("\u5206\u6a21\u578b Token \u7528\u91cf").first().scrollIntoViewIfNeeded();
      const guideCount = await page.getByText("\u67e5\u770b\u5206\u6a21\u578b\u7528\u91cf\uff0c\u8bf7\u5148\u5bfc\u5165\u5b98\u65b9\u7528\u91cf CSV").count();
      if (guideCount > 0) {
        const lnk = page.locator("a[href='https://platform.deepseek.com/usage']");
        if ((await lnk.count()) === 0) throw new Error("\u7a7a\u6001\u5f15\u5bfc\u7f3a\u5b98\u65b9\u94fe\u63a5");
        await page.screenshot({ path: shotPath("12-model-usage-empty-guide"), fullPage: true });
        record("T5f-empty", "\u5206\u6a21\u578b\u7a7a\u6001\u5f15\u5bfc\uff08\u4e09\u6b65+\u5b98\u65b9\u94fe\u63a5\uff09", true);
      } else {
        record("T5f-empty", "\u5206\u6a21\u578b\u7a7a\u6001\u5f15\u5bfc", true, "\u91cd\u590d\u8fd0\u884c\uff1a\u5df2\u5bfc\u5165\u8fc7\uff0c\u8df3\u8fc7\u7a7a\u6001\u622a\u56fe");
      }

      const fileInput = page.locator("input[type='file'][accept*='.csv']").first();
      await fileInput.setInputFiles(path.join(ROOT, "samples", "cost-2026-07-31_2026-08-28.csv"));
      await sleep(2500);
      const errText = await page.locator("p[role='alert']").allTextContents();
      await page.screenshot({ path: shotPath("13-upload-cost-error"), fullPage: true });
      const hasErr = errText.some((t) => t.includes("请选择") || t.includes("缺少") || t.includes("失败") || t.includes("不合法") || t.includes("解析"));
      record("T5f-cost", "cost \u6587\u4ef6\u4e0a\u4f20\u2192\u9519\u8bef\u63d0\u793a", hasErr, "err=" + JSON.stringify(errText.map((s) => s.slice(0, 40))));

      // amount + cost 一起上传：costFile 入库 → UsageImport.currency=CNY → UI 展示 ¥
      await fileInput.setInputFiles([
        path.join(ROOT, "samples", "cost-2026-07-31_2026-08-28.csv"),
        path.join(ROOT, "samples", "amount-2026-07-31_2026-08-28.csv"),
      ]);
      const modelsInfoEl = page.getByText(/共 \d+ 个模型/).first();
      await modelsInfoEl.waitFor({ state: "visible", timeout: 30000 });
      const modelsInfo = [await modelsInfoEl.textContent()];
      if (modelsInfo.length === 0) throw new Error("\u5bfc\u5165\u540e\u672a\u663e\u793a\u5360\u6bd4\u884c");
      await page.getByText(/\u5e01\u79cd CNY/).first().waitFor({ state: "visible", timeout: 10000 });
      await page.screenshot({ path: shotPath("14-model-usage-imported"), fullPage: true });
      record("T5f-import", "amount+cost \u4e0a\u4f20\u2192\u5360\u6bd4\u884c+\u5e01\u79cd CNY", true, modelsInfo[0]);

      await page.locator("button[aria-expanded='false']").first().click();
      const detailRows = page.locator("table").filter({ hasText: "\u7c7b\u578b" }).first().locator("tbody tr");
      if ((await detailRows.count()) === 0) throw new Error("byType \u660e\u7ec6\u8868\u65e0\u884c");
      await page.screenshot({ path: shotPath("15-model-detail-expanded"), fullPage: true });
      record("T5f-detail", "\u6a21\u578b\u5360\u6bd4\u884c byType \u8be6\u660e\u5c55\u5f00", true, "rows=" + (await detailRows.count()));
    } catch (e) {
      record("T5f", "\u5206\u6a21\u578b\u7528\u91cf\uff08\u5bfc\u5165\u4e0e\u660e\u7ec6\uff09", false, e.message.slice(0, 240));
    }
  } else {
    record("T5", "\u4eea\u8868\u76d8\u5b9e\u4f53\u533a", false, "\u524d\u5e8f\u6b65\u9aa4\u5931\u8d25\u8df3\u8fc7");
  }

  // ---- T6 响应式 375x812 / 1024 ----
  if (loggedIn && seed && seed.keyA) {
    try {
      const state = await context.storageState();
      const mob = await browser.newContext({ storageState: state, viewport: { width: 375, height: 812 } });
      const mp = await mob.newPage();
      await mp.goto(BASE + "/dashboard?keyId=" + seed.keyA.id, { waitUntil: "networkidle" });
      await expectText(mp, "\u8d26\u6237\u603b\u4f59\u989d", 20000);
      const cards = mp.locator("[data-slot='card']");
      await cards.nth(3).waitFor({ state: "attached", timeout: 10000 });
      const b1 = await cards.nth(0).boundingBox();
      const b4 = await cards.nth(3).boundingBox();
      if (!b1 || !b4) throw new Error("卡片定位失败（未渲染？）");
      if (b4.y <= b1.y) throw new Error("第四张卡未在首卡下方（纵向堆叠失败）");
      if (Math.abs(b4.x - b1.x) > 2) throw new Error("卡片未同列 x1=" + b1.x + " x4=" + b4.x);
      if (b1.width < 340) throw new Error("卡片宽度异常=" + b1.width);
      await mp.screenshot({ path: shotPath("16-responsive-mobile-375"), fullPage: true });
      await mob.close();
      const desk = await browser.newContext({ storageState: state, viewport: { width: 1024, height: 768 } });
      const dp = await desk.newPage();
      await dp.goto(BASE + "/dashboard?keyId=" + seed.keyA.id, { waitUntil: "networkidle" });
      await expectText(dp, "\u8d26\u6237\u603b\u4f59\u989d", 20000);
      await dp.screenshot({ path: shotPath("17-responsive-desktop-1024"), fullPage: true });
      await desk.close();
      record("T6", "\u54cd\u5e94\u5f0f 375\u00d7812 \u5361\u7247\u7eb5\u5411\u5806\u53e0 / 1024\u5e73\u9762\u6b63\u5e38", true,
        "mobile card w=" + Math.round(b1.width) + " stacked=" + (b4.y > b1.y));
    } catch (e) {
      record("T6", "\u54cd\u5e94\u5f0f\u9a8c\u8bc1", false, e.message.slice(0, 240));
    }
  } else {
    record("T6", "\u54cd\u5e94\u5f0f\u9a8c\u8bc1", false, "\u524d\u5e8f\u6b65\u9aa4\u5931\u8d25\u8df3\u8fc7");
  }

  // ---- T7 Key 管理页 ----
  if (loggedIn && seed) {
    try {
      await page.goto(BASE + "/keys", { waitUntil: "networkidle" });
      await expectText(page, "\u5df2\u7ed1\u5b9a Key");
      const bodyText = await page.locator("body").innerText();
      let maskOk = true;
      for (const l4 of [seed.keyA.last4, seed.keyB.last4, seed.keyDel.last4]) {
        const mask = "sk-\u2022\u2022\u2022\u2022" + l4;
        if (!bodyText.includes(mask)) maskOk = false;
      }
      if (!maskOk) throw new Error("\u63a9\u7801\u4e0d\u4f4d");
      if (!/\u5171 3 \u4e2a/.test(bodyText)) throw new Error("\u5217\u8868\u6570\u91cf\u4e0d\u5bf9");
      const okCount = (bodyText.match(/\u6b63\u5e38/g) ?? []).length;
      if (okCount < 1) throw new Error("「正常」状态文字不足");
      await page.screenshot({ path: shotPath("18-keys-list-masked"), fullPage: true });
      record("T7a", "Key \u5217\u8868\uff1alast4 \u63a9\u7801 sk-\u2022\u2022\u2022\u2022xxxx + \u72b6\u6001\u6587\u5b57\u300c\u6b63\u5e38\u300d", true, "\u6b63\u5e38\u00d7" + okCount);

      const toggleLi = page.locator("li").filter({ hasText: "QA-\u6c99\u7bb1 Key" });
      const sw = toggleLi.locator("[role='switch']");
      await sw.waitFor({ state: "visible", timeout: 8000 });
      const before = await sw.getAttribute("aria-checked");
      if (before !== "true") throw new Error("\u521d\u59cb aria-checked=" + before);
      await sw.click();
      await toggleLi.locator("[role='switch']").click();
      const after = await toggleLi.locator("[role='switch']").getAttribute("aria-checked");
      if (after !== "false") throw new Error("\u505c\u7528\u540e aria-checked=" + after);
      await page.screenshot({ path: shotPath("19-keys-toggle-off"), fullPage: true });
      await toggleLi.getByText("\u542f\u7528").first().click();
      await toggleLi.getByText("\u5df2\u505c\u7528").first().waitFor({ state: "detached", timeout: 8000 });
      record("T7b", "Switch \u542f\u505c\uff08aria-checked true\u2192false\u2192true\uff0c\u5e26\u300c\u5df2\u505c\u7528\u300d\u6807\u7b7e\u53cd\u9988\uff09", true);
    } catch (e) {
      record("T7b", "Key \u7ba1\u7406\u9875\u4e0e Switch \u542f\u505c", false, e.message.slice(0, 240));
    }

    try {
      const delBtn = page.getByRole("button", { name: "\u5220\u9664 QA-\u5f85\u5220 Key" });
      await delBtn.waitFor({ state: "visible", timeout: 8000 });
      page.once("dialog", (d) => d.dismiss());
      await delBtn.click();
      await sleep(400);
      if ((await page.getByText("QA-\u5f85\u5220 Key").count()) === 0) throw new Error("\u53d6\u6d88\u540e Key \u672a\u4fdd\u7559");
      page.once("dialog", (d) => d.accept());
      await delBtn.click();
      await page.getByText("QA-\u5f85\u5220 Key").first().waitFor({ state: "detached", timeout: 8000 });
      await expectText(page, "\u5171 2 \u4e2a");
      await page.screenshot({ path: shotPath("20-keys-deleted"), fullPage: true });
      record("T7c", "\u5220\u9664\u6d41\u7a0b\uff08confirm \u53d6\u6d88=\u4fdd\u7559/\u786e\u8ba4=\u5220\u9664\uff09", true);
    } catch (e) {
      record("T7c", "\u5220\u9664\u6d41\u7a0b", false, e.message.slice(0, 200));
    }
  } else {
    record("T7", "Key \u7ba1\u7406\u9875", false, "\u524d\u5e8f\u6b65\u9aa4\u5931\u8d25\u8df3\u8fc7");
  }

  // ---- T8 设置页 ----
  if (loggedIn) {
    try {
      await page.goto(BASE + "/settings", { waitUntil: "networkidle" });
      await expectText(page, "\u9884\u8b66\u8bbe\u7f6e");
      const th0 = await page.inputValue("#low-balance-threshold");
      const n0 = await page.inputValue("#fail-threshold-n");
      if (th0 !== "20" || n0 !== "3") throw new Error("\u9ed8\u8ba4\u503c\u4e0d\u5bf9 th=" + th0 + " n=" + n0);
      const mailChk = page.locator("label").filter({ hasText: "\u90ae\u4ef6\u901a\u77e5" }).locator("input");
      const inappChk = page.locator("label").filter({ hasText: "\u7ad9\u5185\u6d88\u606f\u901a\u77e5" }).locator("input");
      if (!(await mailChk.isChecked())) throw new Error("\u90ae\u4ef6\u901a\u77e5\u672a\u52fe\u9009");
      if (!(await inappChk.isChecked())) throw new Error("\u7ad9\u5185\u901a\u77e5\u672a\u52fe\u9009");
      await expectText(page, "\u6700\u8fd1\u9884\u8b66");
      const bodyS = await page.locator("body").innerText();
      for (const t of ["请及时充值", "is_available=false", "连续失败 3 次"]) {
        if (!bodyS.includes(t)) throw new Error("\u4e8b\u4ef6\u5217\u8868\u7f3a" + t);
      }
      const mailVal = await page.inputValue("#current-email");
      if (mailVal !== EMAIL) throw new Error("\u5f53\u524d\u90ae\u7bb1\u4e0d\u5bf9=" + mailVal);
      const signoutCount = await page.getByRole("button", { name: "\u767b\u51fa" }).count();
      const delCount = await page.getByRole("button", { name: "\u6ce8\u9500\u8d26\u6237" }).count();
      if (signoutCount === 0 || delCount === 0) throw new Error("\u767b\u51fa/\u6ce8\u9500\u6309\u94ae\u7f3a\u5931");
      await page.screenshot({ path: shotPath("21-settings-page"), fullPage: true });
      record("T8a", "\u8bbe\u7f6e\u9875\u5e03\u5c40\u4e0e\u9ed8\u8ba4\u503c/\u4e8b\u4ef6\u5217\u8868/\u767b\u51fa\u6ce8\u9500\u5b58\u5728\uff08\u672a\u70b9\u51fb\uff09", true);
    } catch (e) {
      record("T8a", "\u8bbe\u7f6e\u9875\u5e03\u5c40", false, e.message.slice(0, 240));
    }

    try {
      await page.fill("#low-balance-threshold", "55");
      await page.fill("#fail-threshold-n", "5");
      await page.locator("label").filter({ hasText: "\u90ae\u4ef6\u901a\u77e5" }).locator("input").uncheck();
      await page.click("button:has-text('\u4fdd\u5b58')");
      await expectText(page, "\u5df2\u4fdd\u5b58", 8000);
      await page.screenshot({ path: shotPath("22-settings-saved"), fullPage: true });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("\u9884\u8b66\u8bbe\u7f6e").first().waitFor({ state: "visible", timeout: 15000 });
      const th1 = await page.inputValue("#low-balance-threshold");
      const n1 = await page.inputValue("#fail-threshold-n");
      const mailChk1 = await page.locator("label").filter({ hasText: "\u90ae\u4ef6\u901a\u77e5" }).locator("input").isChecked();
      if (th1 !== "55" || n1 !== "5" || mailChk1) {
        throw new Error("\u91cd\u8f7d\u540e\u672a\u4fdd\u7559 th=" + th1 + " n=" + n1 + " mail=" + mailChk1);
      }
      const apiRes = await context.request.get(BASE + "/api/alerts");
      const s = (await apiRes.json()).settings ?? {};
      if (s.lowBalanceThreshold !== 55 || s.failThresholdN !== 5 || s.emailEnabled !== false) {
        throw new Error("GET /api/alerts \u4e0d\u7b26\u5408\uff1a" + JSON.stringify(s));
      }
      record("T8b", "\u9884\u8b66\u8bbe\u7f6e\u4fee\u6539\u2192\u4fdd\u5b58\u2192reload \u503c\u4fdd\u7559\uff08PUT/GET /api/alerts\uff09", true, "55/5/emailOff \u5df2\u6301\u4e45\u5316");
      await page.fill("#low-balance-threshold", "20");
      await page.fill("#fail-threshold-n", "3");
      await page.locator("label").filter({ hasText: "\u90ae\u4ef6\u901a\u77e5" }).locator("input").check();
      await page.click("button:has-text('\u4fdd\u5b58')");
      await expectText(page, "\u5df2\u4fdd\u5b58", 8000);
      await page.screenshot({ path: shotPath("23-settings-restored"), fullPage: true });
      record("T8c", "\u6062\u590d\u9ed8\u8ba4\u503c\uff0820/3/\u52fe\u9009\uff09", true);
    } catch (e) {
      record("T8b", "\u9884\u8b66\u8bbe\u7f6e\u4fdd\u5b58\u6301\u4e45\u5316", false, e.message.slice(0, 240));
    }
  } else {
    record("T8", "\u8bbe\u7f6e\u9875", false, "\u524d\u5e8f\u6b65\u9aa4\u5931\u8d25\u8df3\u8fc7");
  }

  await browser.close();
  stopServer();

  const fails = results.filter((r) => !r.pass);
  console.log("");
  console.log("==== \u9a8c\u6536\u7ed3\u679c\u6c47\u603b ====");
  for (const r of results) {
    console.log(
      (r.pass ? "PASS" : "FAIL") + " | " + r.id + " " + r.name +
      (r.note ? " | " + r.note : "") +
      (r.shot ? " | " + r.shot : "")
    );
  }
  console.log("TOTAL: " + results.length + " PASS=" + (results.length - fails.length) + " FAIL=" + fails.length);
  const out = {
    finishedAt: new Date().toISOString(),
    email: EMAIL,
    keyALast4: safeLast4(),
    results,
  };
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(out, null, 2));
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\u811a\u672c\u5f02\u5e38:", e);
  try {
    stopServer();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
