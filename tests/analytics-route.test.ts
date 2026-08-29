/**
 * M7/T7.3 埋点自测：脱敏红线 + /api/events 端点契约。
 * 重点：任何事件日志/文件中不得出现 sk- 开头的明文（R4 一票否决的埋点侧闭环）。
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EVENT_NAMES, redactSecretStrings, sanitizeProps } from "../lib/analytics";
import { POST } from "../app/api/events/route";

const EVENTS_FILE = path.join(process.cwd(), "scripts", "analytics-events.ndjson");
const ORIGINAL_LINES = fs.existsSync(EVENTS_FILE)
  ? fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean).length
  : 0;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  // 还原到测试前的行数（追加的内容删掉），避免无仓库文件
  const remaining = fs.existsSync(EVENTS_FILE)
    ? fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean)
    : [];
  fs.writeFileSync(EVENTS_FILE, remaining.slice(0, ORIGINAL_LINES).join("\n") + (ORIGINAL_LINES > 0 ? "\n" : ""), "utf8");
});

describe("sanitize 红线", () => {
  it("sk- 开头的密钥在字符串中被替换为 sk-***", () => {
    const out = redactSecretStrings("token=sk-abcdefghijklmnopqrstuvwxyz0123456789A1B2 end");
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(out).toContain("sk-***");
  });

  it("props 扁平化：对象/数组丢弃，字符串脱敏，原始类型保留", () => {
    const safe = sanitizeProps({
      label: "我的 sk-abcdefghijklmnopqrstuv1234 备注",
      ttvMs: 1234,
      ok: true,
      nested: { a: 1 },
      arr: [1, 2],
    });
    expect(safe).toEqual({ label: "我的 sk-*** 备注", ttvMs: 1234, ok: true });
  });
});

describe("POST /api/events", () => {
  it("未知事件名 / 非法 JSON / 超大 payload → 400", async () => {
    const bad = (body: string) =>
      new Request("http://x/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await POST(bad(JSON.stringify({ name: "nope" })))).status).toBe(400);
    expect((await POST(bad("not-json"))).status).toBe(400);
    expect((await POST(bad(JSON.stringify({ name: "ttv", props: { x: "y".repeat(5000) } })))).status).toBe(400);
  });

  it("合法事件 → 204，文件追加且不含 sk- 明文", async () => {
    const payload = JSON.stringify({
      name: "ttv",
      props: { startAtMs: 1720000000000, note: "bad sk-abcdefghijklmnopqrstuvwxyz0123 key" },
    });
    const res = await POST(
      new Request("http://x/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })
    );
    expect(res.status).toBe(204);

    const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.name).toBe("ttv");
    expect(last.props.startAtMs).toBe(1720000000000);
    // 脱敏红线：落盘内容不得含 sk- 明文
    expect(last.props.note).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(last.props.note).toContain("sk-***");
    expect(EVENT_NAMES).toContain("alert_sent"); // alert_sent 类型为 M6 保留
  });
});
