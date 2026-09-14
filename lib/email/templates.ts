/**
 * M6（T6.3）预警邮件 HTML 模板。
 *
 * 安全红线：只接收 last4（后 4 位掩码展示），绝不在邮件内容中内嵌 API Key 明文
 * （登录验证码邮件见 lib/email/otp-mail.ts，同样不落库/不进日志）。
 */
import type { AlertType } from "@/lib/alerts/evaluate";
import type { BudgetAlertType } from "@/lib/alerts/budget-evaluate";

type MailAlertType = AlertType | BudgetAlertType;

const TYPE_TITLES: Partial<Record<MailAlertType, string>> = {
  LOW_BALANCE: "低余额预警",
  ARREARS: "账户欠费预警",
  UNAVAILABLE: "账户不可用预警",
  CREDENTIAL_FAILED: "凭证异常预警",
  BUDGET_WARN: "预算预警",
  BUDGET_BREACH: "预算超支",
  RUNWAY_SHORT: "余额 runway 偏短",
};

/** 行动建议（不同事件给用户不同动作指引）。 */
const TYPE_ACTIONS: Partial<Record<MailAlertType, string>> = {
  LOW_BALANCE: "请为该平台账户充值，避免余额不足导致服务不可用。",
  ARREARS: "该平台账户已欠费，请尽快充值以避免服务中断。",
  UNAVAILABLE: "请登录对应平台官方控制台检查账户状态（欠费、实名或风控限制等）。",
  CREDENTIAL_FAILED:
    "请在对应平台官方控制台确认该凭证是否已失效；必要时在 token-wallet 中删除或重新绑定。",
  BUDGET_WARN: "可在设置中调整预算阈值，或减少本月用量。",
  BUDGET_BREACH: "请检查用量与预算设置；超支不拦截调用，仅提醒。",
  RUNWAY_SHORT: "按最近消耗速度余额偏低，请酌情充值（数字为估算）。",
};

const SEVERITY_LABEL: Record<"warning" | "critical", string> = {
  warning: "Warning",
  critical: "Critical",
};

export interface AlertEmailData {
  type: MailAlertType;
  /** Key 后 4 位（数据库中 last4 字段），仅用于脱敏展示 */
  last4: string;
  /** 事件描述（与站内 message 相同文案） */
  message: string;
  severity: "warning" | "critical";
}

/**
 * 渲染预警邮件：返回 subject 与内联样式的简易 HTML
 * （不依赖邮件客户端支持的复杂 CSS，兼容性优先）。
 */
export function renderAlertEmail(data: AlertEmailData): {
  subject: string;
  html: string;
} {
  const title = TYPE_TITLES[data.type] ?? "通知";
  const action = TYPE_ACTIONS[data.type] ?? "请在 token-wallet 中查看详情。";
  const tag =
    data.type.startsWith("BUDGET") || data.type === "RUNWAY_SHORT"
      ? data.last4
      : `sk-****${data.last4}`;
  const subject = `[token-wallet] ${title}（${tag}）`;

  const html = `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">
      <div style="padding:16px 24px;background:${data.severity === "critical" ? "#b91c1c" : "#b45309"};color:#ffffff;">
        <h2 style="margin:0;font-size:18px;font-weight:600;">${title}</h2>
        <p style="margin:4px 0 0;font-size:12px;opacity:.9;">token-wallet · ${SEVERITY_LABEL[data.severity]} · ${tag}</p>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 12px;font-size:14px;color:#333333;line-height:1.6;">${data.message}</p>
        <p style="margin:0 0 16px;font-size:13px;color:#666666;line-height:1.6;">建议：${action}</p>
        <hr style="margin:0 0 12px;border:none;border-top:1px solid #eeeeee;" />
        <p style="margin:0;font-size:12px;color:#999999;">
          本邮件由 token-wallet 自动发送，请勿直接回复。可在「设置 → 预警」中调整阈值与通知渠道。
        </p>
      </div>
    </div>
  </body>
</html>`;

  return { subject, html };
}
