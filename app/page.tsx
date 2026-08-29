import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function Home() {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-8 overflow-hidden px-6">
      {/* 氛围光晕：浅色轻蓝、深色深蓝，取色走 CSS 变量语义（装饰层，不参与交互） */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(46rem_30rem_at_50%_-18%,oklch(0.62_0.13_262/0.22),transparent_65%)] dark:bg-[radial-gradient(54rem_36rem_at_50%_-14%,oklch(0.42_0.15_262/0.4),transparent_65%)]"
      />
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          DeepBalance
        </h1>
        <p className="text-lg text-muted-foreground">DeepSeek 用量监控</p>
      </div>
      <Link
        href="/login"
        className={cn(buttonVariants({ size: "lg" }), "rounded-full px-8")}
      >
        登录
      </Link>
    </main>
  );
}
