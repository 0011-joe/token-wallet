/**
 * lib/email 邮件发送测试（M6 预警邮件 sendAlertEmail + Auth.js 魔法链接邮件）。
 *
 * 策略：mails 模块在用例内用 vi.doMock + vi.resetModules 后动态 import，
 * 隔离各渠道 mock；process.env 在 beforeEach 清空、afterEach 还原，
 * 避免污染其他测试文件。
 *
 * 红线：不以任何形式打印真实魔法链接 URL / API Key 明文；
 * 断言仅覆盖 mock 调用参数与测试内自造的假数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 邮件相关环境变量（beforeEach 清空 / afterEach 还原）。 */
const ENV_KEYS = [
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_FROM",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.doUnmock("resend");
  vi.doUnmock("nodemailer");
  vi.doUnmock("@/lib/email/mailer");
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** mock 句柄（文件级共享，每个用例 clearAllMocks 清理调用记录）。 */
const resendSendMock = vi.fn();
const createTransportMock = vi.fn();
const transportSendMailMock = vi.fn();
const mailerSendMailMock = vi.fn();

describe("M6 预警邮件 sendAlertEmail（lib/email/send.ts）", () => {
  it("RESEND_API_KEY 配置 → 走 resend SDK，发送参数（to/subject/html）不含 Key 明文", async () => {
    const secretKey = "sk-resend-test-secret-123456";
    process.env.RESEND_API_KEY = secretKey;
    vi.doMock("resend", () => ({
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: resendSendMock } };
      }),
    }));
    resendSendMock.mockResolvedValue({ id: "test-msg-id" });
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    const result = await sendAlertEmail({
      to: "user@example.com",
      subject: "预警 subject",
      html: "<p>余额预警：sk-****1234</p>",
    });

    expect(result).toEqual({ ok: true });
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const arg = resendSendMock.mock.calls[0][0];
    expect(arg.to).toBe("user@example.com");
    expect(arg.subject).toBe("预警 subject");
    expect(arg.html).toBe("<p>余额预警：sk-****1234</p>");
    expect(arg.from).toContain("DeepBalance");
    // 红线：发送参数不得含 API Key 明文（注意掩码 sk-****1234 允许存在）
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("sk-resend-test");
  });

  it("RESEND 发送失败 → 返回 ok:false（不降级控制台预览，与 M6 行为一致）", async () => {
    process.env.RESEND_API_KEY = "sk-resend-fail";
    vi.doMock("resend", () => ({
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: resendSendMock } };
      }),
    }));
    resendSendMock.mockRejectedValue(new Error("invalid api key"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    const result = await sendAlertEmail({
      to: "u@example.com",
      subject: "S",
      html: "<p>x</p>",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("resend");
      expect(result.error).toContain("invalid api key");
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("SMTP 配置（587）→ nodemailer createTransport/sendMail 参数正确（secure=false）", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "smtp-user";
    process.env.SMTP_PASS = "smtp-pass";
    process.env.SMTP_PORT = "587";
    vi.doMock("nodemailer", () => ({
      default: { createTransport: createTransportMock },
    }));
    createTransportMock.mockReturnValue({ sendMail: transportSendMailMock });
    transportSendMailMock.mockResolvedValue({ messageId: "m1" });
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    const result = await sendAlertEmail({
      to: "u@example.com",
      subject: "SMTP subject",
      html: "<p>smtp body</p>",
    });

    expect(result).toEqual({ ok: true });
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "smtp-user", pass: "smtp-pass" },
      })
    );
    expect(transportSendMailMock).toHaveBeenCalledTimes(1);
    const arg = transportSendMailMock.mock.calls[0][0];
    expect(arg.to).toBe("u@example.com");
    expect(arg.subject).toBe("SMTP subject");
    expect(arg.html).toBe("<p>smtp body</p>");
  });

  it("SMTP 端口 465 且未设 SMTP_SECURE → secure=true（按端口自动判定）", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    process.env.SMTP_PORT = "465";
    vi.doMock("nodemailer", () => ({
      default: { createTransport: createTransportMock },
    }));
    createTransportMock.mockReturnValue({ sendMail: transportSendMailMock });
    transportSendMailMock.mockResolvedValue({});
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    await sendAlertEmail({ to: "u@example.com", subject: "S", html: "<p>x</p>" });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true })
    );
  });

  it("SMTP_SECURE 显式设置优先于端口推断", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "false";
    vi.doMock("nodemailer", () => ({
      default: { createTransport: createTransportMock },
    }));
    createTransportMock.mockReturnValue({ sendMail: transportSendMailMock });
    transportSendMailMock.mockResolvedValue({});
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    await sendAlertEmail({ to: "u@example.com", subject: "S", html: "<p>x</p>" });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: false })
    );
  });

  it("SMTP 发送失败 → console.warn + 降级控制台预览，不抛异常（与 M6 行为一致）", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    vi.doMock("nodemailer", () => ({
      default: { createTransport: createTransportMock },
    }));
    createTransportMock.mockReturnValue({ sendMail: transportSendMailMock });
    transportSendMailMock.mockRejectedValue(new Error("auth rejected"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    const result = await sendAlertEmail({
      to: "u@example.com",
      subject: "S",
      html: "<p>x</p>",
    });

    expect(result).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("SMTP 发送失败");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("邮件预览");
  });

  it("未配置任何邮件渠道 → 控制台预览（不抛异常）", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();

    const { sendAlertEmail } = await import("@/lib/email/send");
    const result = await sendAlertEmail({
      to: "u@example.com",
      subject: "S",
      html: "<p>x</p>",
    });

    expect(result).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("邮件预览");
  });
});

describe("魔法链接邮件 sendVerificationRequestEmail（lib/email/verification-request.ts）", () => {
  it("mock mailer：to=identifier、正文含链接（HTML 转义后），且无任何 console 输出", async () => {
    // 测试内自造的假链接（非真实 token），仅用于断言 mock 调用参数
    const fakeUrl =
      "http://localhost:3000/api/auth/callback/email?token=fake-token-abc123&email=user@example.com";
    vi.doMock("@/lib/email/mailer", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/email/mailer")>();
      return { ...actual, sendMail: mailerSendMailMock };
    });
    mailerSendMailMock.mockResolvedValue({ ok: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();

    const { sendVerificationRequestEmail } = await import(
      "@/lib/email/verification-request"
    );
    const result = await sendVerificationRequestEmail("user@example.com", fakeUrl);

    expect(result).toEqual({ ok: true });
    expect(mailerSendMailMock).toHaveBeenCalledTimes(1);
    const arg = mailerSendMailMock.mock.calls[0][0];
    expect(arg.to).toBe("user@example.com");
    expect(arg.subject).toBe("DeepBalance 登录链接");
    expect(arg.html).toContain("登录 DeepBalance");
    // 链接以 HTML 转义形式嵌入（& → &amp;），token 值本身原样保留
    expect(arg.html).toContain(fakeUrl.replace(/&/g, "&amp;"));
    expect(arg.html).toContain("fake-token-abc123");
    // 红线：mock 发送期间不得打印链接/正文
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("mailer 返回未配置 → ok:false（错误信息不含 url）", async () => {
    const fakeUrl =
      "http://localhost:3000/api/auth/callback/email?token=fake-token-xyz";
    vi.doMock("@/lib/email/mailer", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/email/mailer")>();
      return { ...actual, sendMail: mailerSendMailMock };
    });
    mailerSendMailMock.mockResolvedValue({
      ok: false,
      channel: "unconfigured" as const,
      error: "未配置邮件渠道（RESEND_API_KEY 或 SMTP_HOST/USER/PASS）",
    });
    vi.resetModules();

    const { sendVerificationRequestEmail } = await import(
      "@/lib/email/verification-request"
    );
    const result = await sendVerificationRequestEmail("user@example.com", fakeUrl);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("未配置");
      expect(result.error).not.toContain(fakeUrl);
    }
  });
});
