"use client";

import * as React from "react";

export type Theme = "light" | "dark";

interface ThemeContextValue {
  /** 当前主题（初始值：localStorage["theme"] 或系统 prefers-color-scheme） */
  theme: Theme;
  /** 切换主题并持久化到 localStorage["theme"]（此后不再跟随系统） */
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function storedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem("theme");
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function applyThemeClass(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * 主题 Provider（自定义实现，不引入任何依赖）：
 * - 初始值：localStorage["theme"]，否则系统 prefers-color-scheme
 *   （与 app/layout.tsx 的 <head> 内联脚本取值一致）；
 * - setTheme：写 localStorage + 切换 <html> 的 dark class（Tailwind 的
 *   dark: variant 依赖它，见 globals.css @custom-variant dark）；
 * - 未手动选择主题时监听系统主题变化并跟随。
 * 防 FOUC：class 由 <head> 内联脚本在 hydration 前设置，本组件只保持一致。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(
    () => storedTheme() ?? systemTheme()
  );

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    applyThemeClass(next);
    try {
      window.localStorage.setItem("theme", next);
    } catch {
      // 隐私模式等场景下 localStorage 不可用：本次会话内仍生效
    }
  }, []);

  React.useEffect(() => {
    // 挂载后与 <head> 内联脚本对齐（服务端无 DOM，class 只由客户端设置）
    applyThemeClass(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      // 用户已手动选择过主题 → 不再跟随系统
      if (storedTheme() !== null) return;
      const next: Theme = e.matches ? "dark" : "light";
      setThemeState(next);
      applyThemeClass(next);
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
    }
    return () => {
      if (typeof mq.removeEventListener === "function") {
        mq.removeEventListener("change", onChange);
      }
    };
    // 仅挂载时监听一次；跟随逻辑由 storedTheme() 守卫
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 <ThemeProvider> 内使用");
  return ctx;
}
