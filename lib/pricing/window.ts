/**
 * 峰谷时段判定（红线 14 / D6b：窗口按事件时间匹配）。
 * 单一事实源：热图/费用/告警/邮件必须调用本模块，禁止另写一份。
 */
import { toMoney, type Money } from "@/lib/money";

export interface PriceWindowRow {
  provider: string;
  label: string;
  effectiveFrom: Date;
  /** bit0=周一 … bit6=周日 */
  weekdayMask: number;
  startMinute: number;
  endMinute: number;
  tz: string;
  multiplier: Money | string;
}

/** JS getUTCDay：0=周日…6=周六 → 我们的 bit0=周一…bit6=周日 */
function weekdayBitFromUtc(d: Date): number {
  const js = d.getUTCDay(); // 0 Sun
  return js === 0 ? 6 : js - 1; // Mon=0 … Sun=6
}

/**
 * 将 UTC 时刻转换到目标 tz 的「本地分钟」与星期（使用 Intl，无依赖）。
 * 用于在 PriceWindow.tz 定义的本地时钟下判断是否落在 [startMinute, endMinute)。
 */
export function localMinuteAndWeekday(
  at: Date,
  tz: string
): { minuteOfDay: number; weekdayBit: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const weekdayBit = map[wd] ?? 0;
  return { minuteOfDay: hour * 60 + minute, weekdayBit };
}

function isInWindow(
  row: PriceWindowRow,
  minuteOfDay: number,
  weekdayBit: number
): boolean {
  if ((row.weekdayMask & (1 << weekdayBit)) === 0) return false;
  const { startMinute: s, endMinute: e } = row;
  if (s === e) return false;
  if (s < e) return minuteOfDay >= s && minuteOfDay < e;
  // 跨午夜：命中「当日 s~1440」或「0~e」；跨午夜时次日凌晨属于上一日窗口
  // 简化：仅按「当前本地分钟」判断 s..1440 与 0..e（与 v1 跨午夜语义一致时用）
  return minuteOfDay >= s || minuteOfDay < e;
}

/** 取事件时刻生效的窗口行（provider + effectiveFrom ≤ at 的最近一行；多窗口叠加取命中的第一条，按 effectiveFrom 降序） */
export function pickWindow(
  provider: string,
  at: Date,
  windows: PriceWindowRow[]
): PriceWindowRow | null {
  const candidates = windows
    .filter(
      (w) =>
        w.provider === provider &&
        w.effectiveFrom.getTime() <= at.getTime()
    )
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());

  for (const w of candidates) {
    const { minuteOfDay, weekdayBit } = localMinuteAndWeekday(at, w.tz);
    if (isInWindow(w, minuteOfDay, weekdayBit)) return w;
  }
  return null;
}

/** 事件时刻倍率（无命中 '1.000'） */
export function windowMultiplierAt(
  provider: string,
  at: Date,
  windows: PriceWindowRow[]
): Money {
  const w = pickWindow(provider, at, windows);
  if (!w) return toMoney("1");
  return toMoney(w.multiplier);
}

export interface CurrentWindowInfo {
  label: string | null;
  multiplier: Money;
  nextChangeAt: Date | null;
}

/** 当前时段 + 粗略下次切换（分钟粒度扫描下一刻度，最多向前找 2 天） */
export function currentWindow(
  provider: string,
  at: Date,
  windows: PriceWindowRow[]
): CurrentWindowInfo {
  const hit = pickWindow(provider, at, windows);
  const multiplier = hit ? toMoney(hit.multiplier) : toMoney("1");
  // 扫描下一分钟起是否翻转（UI 倒计时用；纯函数、无 IO）
  let nextChangeAt: Date | null = null;
  const stepMs = 60_000;
  for (let i = 1; i <= 60 * 48; i++) {
    const t = new Date(at.getTime() + i * stepMs);
    const m = windowMultiplierAt(provider, t, windows);
    if (m !== multiplier) {
      nextChangeAt = t;
      break;
    }
  }
  return { label: hit?.label ?? null, multiplier, nextChangeAt };
}

export { weekdayBitFromUtc };
