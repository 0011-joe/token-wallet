/**
 * T0.2 lib/money 单测
 * 覆盖：number/string/Decimal 对象 → 规范 6 位定点字符串；bigint 定点运算精度；
 * 负数 half-up 四舍五入；科学计数法；非法输入快速失败；展示格式化。
 */
import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatMoney,
  moneyAbs,
  moneyAdd,
  moneyCmp,
  moneyIsNegative,
  moneyIsZero,
  moneyMul,
  moneyNeg,
  moneySub,
  toMoney,
} from "../lib/money";

describe("toMoney:number（JSON number 最短十进制表示，无二进制误差）", () => {
  it("49.58894 → 49.588940（Kimi available_balance 样例）", () => {
    expect(toMoney(49.58894)).toBe("49.588940000");
  });
  it("3.00001 → 3.000010（Kimi cash_balance 样例）", () => {
    expect(toMoney(3.00001)).toBe("3.000010000");
  });
  it("0 → 0.000000000", () => {
    expect(toMoney(0)).toBe("0.000000000");
  });
  it("负数 -1.5 → -1.500000000", () => {
    expect(toMoney(-1.5)).toBe("-1.500000000");
  });
  it("0.1 + 0.2 类浮点陷阱：0.300000000", () => {
    expect(moneyAdd(toMoney(0.1), toMoney(0.2))).toBe("0.300000000");
  });
  it("Infinity / NaN 抛错", () => {
    expect(() => toMoney(Infinity)).toThrow();
    expect(() => toMoney(NaN)).toThrow();
  });
});

describe("toMoney:string", () => {
  it("6.32 → 6.320000000", () => {
    expect(toMoney("6.32")).toBe("6.320000000");
  });
  it("0.000001 保精度", () => {
    expect(toMoney("0.000001000")).toBe("0.000001000");
  });
  it("9 位以内不截断：1.2345678 → 1.234567800", () => {
    expect(toMoney("1.2345678")).toBe("1.234567800");
  });
  it("9 位以内不截断：1.2345674 → 1.234567400", () => {
    expect(toMoney("1.2345674")).toBe("1.234567400");
  });
  it("超 9 位四舍五入（half-up）：1.2345678901 → 1.234567890", () => {
    expect(toMoney("1.2345678901")).toBe("1.234567890");
  });
  it("超 9 位四舍五入（half-up 进位）：1.2345678906 → 1.234567891", () => {
    expect(toMoney("1.2345678906")).toBe("1.234567891");
  });
  it("科学计数法：1e-7 → 0.000000100（9 位精度保留）", () => {
    expect(toMoney("1e-7")).toBe("0.000000100");
  });
  it("科学计数法：1.5e3 → 1500.000000000", () => {
    expect(toMoney("1.5e3")).toBe("1500.000000000");
  });
  it("科学计数法：2e-6 → 0.000002000", () => {
    expect(toMoney("2e-6")).toBe("0.000002000");
  });
  it("非法输入抛错（快速失败，不静默降级）", () => {
    expect(() => toMoney("abc")).toThrow();
    expect(() => toMoney("12.34.5")).toThrow();
    expect(() => toMoney("")).toThrow();
    expect(() => toMoney(null)).toThrow();
    expect(() => toMoney(undefined)).toThrow();
  });
});

describe("toMoney:Prisma Decimal 类对象", () => {
  it("有 toString 的对象走 toString", () => {
    expect(toMoney({ toString: () => "7.77" })).toBe("7.770000000");
  });
});

describe("定点运算（bigint，无 float）", () => {
  it("moneyAdd：0.1 + 0.2 = 0.300000000", () => {
    expect(moneyAdd("0.100000000", "0.200000000")).toBe("0.300000000");
  });
  it("moneySub：1.5 - 0.500001 = 0.999999000", () => {
    expect(moneySub("1.500000000", "0.500001000")).toBe("0.999999000");
  });
  it("moneySub 负结果：1 - 2 = -1.000000000", () => {
    expect(moneySub("1.000000000", "2.000000000")).toBe("-1.000000000");
  });
  it("moneyMul：1.5 × 2 = 3.000000000", () => {
    expect(moneyMul("1.500000000", "2.000000000")).toBe("3.000000000");
  });
  it("moneyMul：0.1 × 0.2 = 0.020000000", () => {
    expect(moneyMul("0.100000000", "0.200000000")).toBe("0.020000000");
  });
  it("moneyMul 四舍五入：1.000001 × 1.000001 ≈ 1.000002000", () => {
    expect(moneyMul("1.000001000", "1.000001000")).toBe("1.000002000");
  });
  it("moneyCmp / isZero / isNegative", () => {
    expect(moneyCmp("1.000000000", "2.000000000")).toBe(-1);
    expect(moneyCmp("2.000000000", "2.000000000")).toBe(0);
    expect(moneyCmp("2.000001000", "2.000000000")).toBe(1);
    expect(moneyIsZero("0.000000000")).toBe(true);
    expect(moneyIsZero("-0.000000000")).toBe(true);
    expect(moneyIsNegative("-0.000001000")).toBe(true);
    expect(moneyIsNegative("0.000001000")).toBe(false);
  });
  it("moneyAbs / moneyNeg", () => {
    expect(moneyAbs("-1.500000000")).toBe("1.500000000");
    expect(moneyAbs("1.500000000")).toBe("1.500000000");
    expect(moneyNeg("1.500000000")).toBe("-1.500000000");
    expect(moneyNeg("-1.500000000")).toBe("1.500000000");
  });
});

describe("展示格式化（half-up，负数按绝对值舍入）", () => {
  it("formatMoney：¥49.59", () => {
    expect(formatMoney("49.588940000", "CNY")).toBe("¥49.59");
  });
  it("formatMoney：$-2.00（负数 half-up，符号在前与 v1 行为一致）", () => {
    expect(formatMoney("-1.999999000", "USD")).toBe("$-2.00");
  });
  it("formatMoney 千分位：¥1,234,567.89", () => {
    expect(formatMoney("1234567.891000000", "CNY")).toBe("¥1,234,567.89");
  });
  it("formatMoney 未知币种前缀回退", () => {
    expect(formatMoney("1.000000000", "EUR")).toBe("EUR 1.00");
  });
  it("formatAmount：6.33", () => {
    expect(formatAmount("6.325000000")).toBe("6.33");
  });
  it("formatAmount：-1.98（-1.984 舍入）", () => {
    expect(formatAmount("-1.984000000")).toBe("-1.98");
  });
});
