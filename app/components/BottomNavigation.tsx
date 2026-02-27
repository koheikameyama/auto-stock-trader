"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useBadges } from "@/app/contexts/BadgeContext";
import { useTranslations } from "next-intl";

type BadgeKey = "dashboard" | "my-stocks" | "news" | "menu";

export default function BottomNavigation() {
  const pathname = usePathname();
  const { badges } = useBadges();
  const t = useTranslations("common.navigation");

  const navItems: {
    href: string;
    label: string;
    badgeKey: BadgeKey;
    icon: JSX.Element;
  }[] = [
    {
      href: "/dashboard",
      label: t("dashboard"),
      badgeKey: "dashboard",
      icon: (
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
          />
        </svg>
      ),
    },
    {
      href: "/my-stocks",
      label: t("myStocks"),
      badgeKey: "my-stocks",
      icon: (
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      ),
    },
    {
      href: "/news",
      label: t("news"),
      badgeKey: "news",
      icon: (
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
          />
        </svg>
      ),
    },
    {
      href: "/menu",
      label: t("menu"),
      badgeKey: "menu",
      icon: (
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      ),
    },
  ];

  // アクティブ状態の判定
  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    if (href === "/my-stocks") {
      return pathname.startsWith("/my-stocks");
    }
    if (href === "/news") {
      return pathname === "/news";
    }
    if (href === "/menu") {
      // その他メニュー配下のページもアクティブにする
      return (
        pathname === "/menu" ||
        pathname.startsWith("/settings") ||
        pathname.startsWith("/ai-report")
      );
    }
    return false;
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 safe-area-bottom">
      <div className="flex justify-around items-center h-16 max-w-lg mx-auto px-2 pb-[env(safe-area-inset-bottom)]">
        {navItems.map((item) => {
          const active = isActive(item.href);
          const hasBadge = badges[item.badgeKey];
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex flex-col items-center justify-center gap-0.5 flex-1 py-2 transition-colors ${
                active ? "text-blue-600" : "text-gray-500"
              }`}
            >
              <div className="relative">
                {item.icon}
                {hasBadge && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full" />
                )}
              </div>
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
