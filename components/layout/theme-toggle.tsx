"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme/theme-provider";

/**
 * 主题切换按钮（顶栏）：点击在浅色/深色间切换并持久化。
 * 图标用 dark: variant 双渲染（纯 CSS 显隐，避免 SSR hydration 不一致）；
 * aria-label 保持恒定（不随主题变，避免 hydration mismatch），
 * 当前主题态用 aria-pressed 表达（服务端初始渲染后由客户端即时更新）。
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label="切换主题"
      aria-pressed={isDark}
      title="切换浅色 / 深色主题"
    >
      <Sun aria-hidden className="size-4 dark:hidden" />
      <Moon aria-hidden className="hidden size-4 dark:block" />
    </Button>
  );
}