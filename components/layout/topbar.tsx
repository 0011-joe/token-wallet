"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Bell, LogOut, User } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CredSwitcher } from "@/components/dashboard/cred-switcher";
import { cn } from "@/lib/utils";
import { fetchCredentials } from "@/lib/api-client";

/** 顶栏：产品名、Key 切换下拉、预警铃铛 → /settings、账户入口 → /settings、登出。 */
export function TopBar() {
  const router = useRouter();
  const params = useSearchParams();
  const selectedCredentialId = params.get("credentialId");

  const { data } = useQuery({ queryKey: ["credentials"], queryFn: fetchCredentials });
  const credentials = data?.credentials ?? [];
  const selected = credentials.find((c) => c.id === selectedCredentialId) ?? null;

  function handleSelect(id: string) {
    if (!id) {
      router.push("/dashboard"); // 空 = 总览
      return;
    }
    router.push(`/dashboard?credentialId=${encodeURIComponent(id)}`);
  }

  async function handleSignOut() {
    await signOut({ callbackUrl: "/" });
  }

  const iconLinkClass = buttonVariants({ variant: "ghost", size: "icon" });

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <Link
          href="/dashboard"
          className="flex shrink-0 items-center font-heading text-base font-semibold tracking-tight"
        >
          token-wallet
        </Link>
        <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
        <CredSwitcher
          credentials={credentials}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
        />
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Link
            href="/settings"
            aria-label="预警设置"
            title="预警设置"
            className={iconLinkClass}
          >
            <Bell />
          </Link>
          <Link
            href="/settings"
            aria-label="账户设置"
            title="账户设置"
            className={cn(iconLinkClass, "hidden sm:inline-flex")}
          >
            <User />
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSignOut}
            className="hidden sm:inline-flex"
          >
            <LogOut />
            登出
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSignOut}
            aria-label="登出"
            title="登出"
            className="sm:hidden"
          >
            <LogOut />
          </Button>
        </div>
      </div>
    </header>
  );
}
