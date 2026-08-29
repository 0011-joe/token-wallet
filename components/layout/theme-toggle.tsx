"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme/theme-provider";

/**
 * 主题切换按钮（顶栏）：点击在浅色/深色间切换并持久化。
 * 图标用 dark: variant 双渲染（纯 CSS 显隐，避免 SSR hydration 不一致）；
 * aria-label / title 在挂载后对齐真实主题（挂载前用中性文案）。
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted && theme === "dark";
  const label = !mounted
    ? "切换主题"
    : isDark
      ? "当前深色主题，点击切换到浅色"
      : "当前浅色主题，点击切换到深色";

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={label}
      title={label}
    >
      <Sun aria-hidden className="size-4 dark:hidden" />
      <Moon aria-hidden className="hidden size-4 dark:block" />
    </Button>
  );
}
