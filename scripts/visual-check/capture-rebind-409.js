#!/usr/bin/env node
/** 补充证据：重复添加同一个真实 Key -> 409「该 Key 已绑定」（AC1-4 去重提示）。 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const SHOT_DIR = path.join(__dirname, "shots");
const LOG_FILE = path.join(__dirname, "server.log");
const BASE = "http://localhost:3000";
const EMAIL = "qa-visual@example.com";

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = (m[2] || "").trim().replace(/^"|"$/g, "");
  }
  return out;
}
const KEY = (loadEnv(path.join(ROOT, ".env.local")).DEEPSEEK_API_KEY || "").trim();
const last4 = KEY.slice(-4);

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
  } catch { return false; }
}

async function main() {
  if (!KEY) throw new Error("无 DEEPSEEK_API_KEY");
  if (await probe()) throw new Error("端口 3000 被占用，跳过（证据以记录为准）");
  serverProc = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", "3000"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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
    for (const l of lines.slice(-60)) { const m = l.match(re); if (m && m[1] === EMAIL) magic = m[2]; }
    if (!magic) await sleep(1000);
  }
  if (!magic) throw new Error("魔法链接未获取到");
  await page.goto(magic, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await page.goto(BASE + "/keys", { waitUntil: "networkidle" });
  await page.fill("#key-api-key", KEY);
  await page.click("button:has-text('添加 Key')");
  await page.locator("p[role='alert']").filter({ hasText: "已绑定" }).first().waitFor({ state: "visible", timeout: 30000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "04-rebind-409-already-bound.png"), fullPage: true });
  console.log("409 已绑定提示截图完成 (sk-…" + last4 + ")");
  await browser.close();
  try { spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
  process.exit(0);
}
main().catch((e) => {
  console.error(e.message);
  try { if (serverProc) spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
  process.exit(1);
});
