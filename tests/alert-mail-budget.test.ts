/**
 * 邮件模板支持预算告警类型。
 */
import { describe, expect, it } from "vitest";

import { renderAlertEmail } from "@/lib/email/templates";

describe("renderAlertEmail budget types", () => {
  it("BUDGET_WARN 标题与币种标签", () => {
    const r = renderAlertEmail({
      type: "BUDGET_WARN",
      last4: "CNY",
      message: "预算已用 85%",
      severity: "warning",
    });
    expect(r.subject).toContain("预算预警");
    expect(r.subject).toContain("CNY");
    expect(r.subject).not.toContain("sk-****");
    expect(r.html).toContain("预算阈值");
  });

  it("RUNWAY_SHORT 文案含估算建议", () => {
    const r = renderAlertEmail({
      type: "RUNWAY_SHORT",
      last4: "CNY",
      message: "runway 2 天",
      severity: "warning",
    });
    expect(r.subject).toContain("runway");
    expect(r.html).toContain("估算");
  });
});
