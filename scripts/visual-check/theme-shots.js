#!/usr/bin/env node
/**
 * 双主题视觉验收：light / dark 两组截图（/dashboard、/keys、/settings、/login 共 8 张）。
 * 流程：seed.js 造数 → 魔法链接登录 → 每页浅色截图 → 点顶栏切换按钮 → 深色截图。
 * /login 无顶栏按钮，用 localStorage + reload 切换（同时验证防 FOUC 脚本）。
 * 用法（项目根目录，先 npm run build）：
 *   node scripts/visual-check/theme-shots.js
 * 环境变量：QA_PORT（默认 3019）、QA_HEADFUL=1
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SHOT_DIR = path.join(__dirname, "shots", "theme");
const LOG_FILE = path.join(__dirname, "theme-server.log");
const PORT = Number(process.env.QA_PORT ?? 3019);
const BASE = "http://localhost:" + PORT;
const HEADFUL = process.env.QA_HEADFUL === "1";
const EMAIL = "qa-visual@example.com";
const KEYA_LAST4 = "8888";

fs.mkdirSync(SHOT_DIR, { recursive: true });

let serverProc = null;
let serverLines = [];
let logStream = null;
let consoleErrors = [];

function onServerLine(line) {
  serverLines.push(line);
  if (logStream) logStream.write(line + "\n");
}

async function probeUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(BASE + "/api/auth/providers", { signal: ctrl.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probeUp()) {
    throw new Error(BASE + " 已有服务在跑，无法读取魔法链接日志。请先停止它（或换 QA_PORT）。");
  }
  console.log("[server] next start (port " + PORT + ") ...");
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  serverProc = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // .env.local 未配 NEXTAUTH_URL 时 next-auth 默认 http://localhost:3000，
    // 这里显式覆盖到 QA 端口，让魔法链接与回调都走本方实例
    env: Object.assign({}, process.env, { NEXTAUTH_URL: BASE }),
  });
  logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
  serverProc.stdout.on("data", (b) => {
    for (const l of b.toString().split(/\r?\n/)) if (l) onServerLine(l);
  });
  serverProc.stderr.on("data", (b) => {
    for (const l of b.toString().split(/\r?\n/)) if (l) onServerLine(l);
  });
  for (let i = 0; i < 120; i++) {
    if (await probeUp()) {
      console.log("[server] 就绪");
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("[server] 120s 未就绪（需先 npm run build）");
}

function stopServer() {
  if (!serverProc) return;
  try {
    spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  if (logStream) logStream.end();
  serverProc = null;
}

function findMagicLink(email) {
  const re = /魔法链接 for ([^\s:]+):\s*(\S+)/;
  for (const line of serverLines) {
    const m = line.match(re);
    if (m && m[1] === email) return m[2];
  }
  return null;
}

async function waitMagicLink(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const url = findMagicLink(EMAIL);
    if (url) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function shot(name) {
  return path.join(SHOT_DIR, name + ".png");
}

const { chromium } = require("playwright");

async function main() {
  // 1. 造数
  console.log("[seed] ...");
  const seedArgs = ["scripts/visual-check/seed.js", "--email", EMAIL, "--fake-real-last4", KEYA_LAST4];
  const seedOut = spawnSync(process.execPath, seedArgs, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  const line = (seedOut.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("SEED_SUMMARY="));
  if (!line) {
    console.error("[seed] 失败：", seedOut.stderr || seedOut.stdout);
    process.exit(1);
  }
  const seed = JSON.parse(line.slice("SEED_SUMMARY=".length));
  console.log("[seed] keyA=" + (seed.keyA ? seed.keyA.id : "null"));

  await ensureServer();

  const browser = await chromium.launch({ channel: "msedge", headless: !HEADFUL });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });

  // 2. 魔法链接登录
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.getByText("登录 DeepBalance").first().waitFor({ state: "visible" });
  await page.fill("#email", EMAIL);
  await page.click("button:has-text('发送登录链接')");
  const magic = await waitMagicLink(60000);
  if (!magic) throw new Error("60s 内未找到魔法链接");
  await page.goto(magic, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const cookies = await context.cookies(BASE);
  if (!cookies.some((c) => c.name.startsWith("next-auth.session-token"))) {
    throw new Error("魔法链接回调后未建立会话");
  }
  console.log("[auth] 登录成功");

  // 3. 页面截图（有顶栏按钮的页：浅色 → 点按钮 → 深色；/login 用匿名上下文 + localStorage）
  const pages = [
    { name: "01-dashboard", url: "/dashboard?keyId=" + encodeURIComponent(seed.keyA.id), wait: "账户总余额", hasToggle: true },
    { name: "02-keys", url: "/keys", wait: "已绑定 Key", hasToggle: true },
    { name: "03-settings", url: "/settings", wait: "预警设置", hasToggle: true },
    { name: "04-login", url: "/login", wait: "登录 DeepBalance", hasToggle: false },
    { name: "05-landing", url: "/", wait: "DeepBalance", hasToggle: false },
  ];

  for (const pg of pages) {
    // /login 无顶栏按钮且登录态会重定向：新开无会话的上下文，localStorage + reload 切换
    if (!pg.hasToggle) {
      const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const ap = await anon.newPage();
      ap.setDefaultTimeout(20000);
      ap.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
      });
      await ap.goto(BASE + pg.url, { waitUntil: "networkidle" });
      await ap.getByText(pg.wait).first().waitFor({ state: "visible", timeout: 25000 });
      await ap.evaluate(() => localStorage.setItem("theme", "light"));
      await ap.reload({ waitUntil: "networkidle" });
      await ap.getByText(pg.wait).first().waitFor({ state: "visible", timeout: 25000 });
      await sleep(600);
      await ap.screenshot({ path: shot(pg.name + "-light"), fullPage: true });
      console.log("[shot] " + pg.name + "-light");
      // 深色：localStorage + reload（验证防 FOUC：domcontentloaded 即应有 dark class）
      await ap.evaluate(() => localStorage.setItem("theme", "dark"));
      await ap.goto(BASE + pg.url, { waitUntil: "domcontentloaded" });
      const preHydrationDark = await ap.evaluate(() => document.documentElement.classList.contains("dark"));
      await ap.getByText(pg.wait).first().waitFor({ state: "visible", timeout: 25000 });
      await sleep(600);
      await ap.screenshot({ path: shot(pg.name + "-dark"), fullPage: true });
      console.log("[shot] " + pg.name + "-dark preHydrationDark=" + preHydrationDark);
      await anon.close();
      continue;
    }

    // 强制浅色基线
    await context.addInitScript(() => {
      try { localStorage.setItem("theme", "light"); } catch (e) {}
    });
    await page.goto(BASE + pg.url, { waitUntil: "networkidle" });
    await page.getByText(pg.wait).first().waitFor({ state: "visible", timeout: 25000 });
    await sleep(600);
    const hasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    console.log("[shot] " + pg.name + "-light darkClass=" + hasDark);
    await page.screenshot({ path: shot(pg.name + "-light"), fullPage: true });

    // 点击顶栏切换按钮 → 深色截图
    await page.getByRole("button", { name: /主题/ }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"), null, { timeout: 5000 });
    await sleep(700);
    await page.screenshot({ path: shot(pg.name + "-dark"), fullPage: true });
    const stored = await page.evaluate(() => localStorage.getItem("theme"));
    console.log("[shot] " + pg.name + "-dark stored=" + stored);
  }

  // 4. 复位为浅色（避免 QA 用户下次打开是深色）
  await page.evaluate(() => localStorage.setItem("theme", "light"));

  await browser.close();
  stopServer();

  const files = fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith(".png")).sort();
  console.log("\n==== 截图清单（" + files.length + " 张） ====");
  for (const f of files) console.log("shots/theme/" + f);
  if (consoleErrors.length) {
    console.log("\n==== 页面 console error（" + consoleErrors.length + " 条） ====");
    for (const e of consoleErrors.slice(0, 10)) console.log(" - " + e);
  } else {
    console.log("\n页面 console error：0");
  }
  console.log("\n完成。");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("异常:", e);
    try { stopServer(); } catch (e2) { /* ignore */ }
    process.exit(1);
  });
