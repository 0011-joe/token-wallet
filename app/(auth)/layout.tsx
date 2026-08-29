export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-1 items-center justify-center px-6">
      {/* 氛围光晕（装饰层）：浅色轻蓝、深色深蓝，与落地页同风格 */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(42rem_28rem_at_50%_-14%,oklch(0.62_0.13_262/0.18),transparent_65%)] dark:bg-[radial-gradient(50rem_32rem_at_50%_-10%,oklch(0.38_0.14_262/0.38),transparent_65%)]"
      />
      {children}
    </div>
  );
}
