#!/usr/bin/env node
/**
 * 独立小流程（可选辅助）：清空该用户的分模型导入记录 → 登录 → 截取
 * 「分模型 Token 用量」空态三步引导（12-model-usage-empty-guide.png）→
 * 重新上传 amount CSV 恢复数据（并截 14/15 佐证）。
 *
 * 用法：node scripts/visual-check/capture-empty-guide.js
 * 前置：端口 3000 空闲；需先 npm run build；数据为 QA 用户。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");
const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");

const ROOT = path.resolve(__dirname, "..", "..");
const SHOT_DIR = path.join(__dirname, "shots");
const LOG_FILE = path.join(__dirname, "server.log");
const BASE = "http://localhost:3000";
const EMAIL = "qa-visual@example.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lines = [];
let serverProc = null;

async function probe() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(BASE + "/api/auth/providers", { signal: c.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: "file:./dev.db" }),
  });
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) throw new Error("QA 用户不存在，请先跑 run-visual-check.js");
  await db.usageImport.deleteMany({ where: { userId: user.id } });
  await db.$disconnect();
  console.log("已清空分模型导入记录");

  if (await probe()) throw new Error("端口 3000 已被占用，请先释放");
  serverProc = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", "3000"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  const ws = fs.createWriteStream(LOG_FILE, { flags: "a" });
  serverProc.stdout.on("data", (b) => b.toString().split(/\r?\n/).forEach((l) => { if (l) { lines.push(l); ws.write(l + "\n"); } }));
  serverProc.stderr.on("data", (b) => b.toString().split(/\r?\n/).forEach((l) => { if (l) { lines.push(l); ws.write(l + "\n"); } }));
  for (let i = 0; i < 90; i++) { if (await probe()) break; await sleep(1000); }
  if (!(await probe())) throw new Error("服务器未就绪");

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15000);

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.fill("#email", EMAIL);
  await page.click("button:has-text('发送登录链接')");
  await page.getByText("已发送登录链接").first().waitFor({ timeout: 15000 });
  let magic = null;
  const re = /魔法链接 for ([^\s:]+):\s*(\S+)/;
  for (let i = 0; i < 60 && !magic; i++) {
    for (const l of lines.slice(-60)) {
      const m = l.match(re);
      if (m && m[1] === EMAIL) magic = m[2];
    }
    if (!magic) await sleep(1000);
  }
  if (!magic) throw new Error("魔法链接未获取到");
  await page.goto(magic, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
  const guide = page.getByText("查看分模型用量，请先导入官方用量 CSV");
  await guide.first().waitFor({ state: "visible", timeout: 30000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "12-model-usage-empty-guide.png"), fullPage: true });
  console.log("空态引导截图完成");
  const lnk = await page.locator("a[href='https://platform.deepseek.com/usage']").count();
  console.log("官方链接存在:", lnk > 0);
  // 恢复：重新上传 amount CSV
  await page.locator("input[type='file'][accept*='.csv']").first()
    .setInputFiles(path.join(ROOT, "samples", "amount-2026-07-31_2026-08-28.csv"));
  await page.getByText(/共 \d+ 个模型/).first().waitFor({ state: "visible", timeout: 30000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "14-model-usage-imported.png"), fullPage: true });
  console.log("CSV 重传完成，数据已恢复");
  await browser.close();
  try {
    spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch { /* ignore */ }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try { if (serverProc) spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
  process.exit(1);
});
