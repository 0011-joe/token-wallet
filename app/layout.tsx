import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/lib/theme/theme-provider";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DeepBalance",
  description: "DeepSeek 用量监控",
};

/**
 * 防 FOUC：在 hydration 前根据 localStorage["theme"]（或系统 prefers-color-scheme）
 * 给 <html> 设置 dark class，避免深色用户刷新时闪白。
 * 取值逻辑与 lib/theme/theme-provider.tsx 保持一致。
 */
const themeInitScript = [
  'try{var t=localStorage.getItem("theme");',
  'if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){',
  'document.documentElement.classList.add("dark");}',
  "}catch(e){}",
].join("\n");

export default function RootLayout({ children }: LayoutProps<"/">) {
  // dark class 由 <head> 内联脚本在 hydration 前写入，因此跳过 <html> 属性一致性检查
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
