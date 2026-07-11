"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, LineChart, Radio, Megaphone, UserCircle } from "lucide-react";

const items = [
  { href: "/portal", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/portal/trading", label: "Trading", icon: LineChart },
  { href: "/portal/live", label: "Live Sessions", icon: Radio },
  { href: "/portal/updates", label: "Team Updates", icon: Megaphone },
  { href: "/portal/account", label: "Account", icon: UserCircle },
];

export function PortalNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Member portal" className="lg:sticky lg:top-24">
      <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
        {items.map((it) => {
          const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
          const Icon = it.icon;
          return (
            <li key={it.href} className="flex-shrink-0">
              <Link
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors focus-ring lg:w-full ${
                  active ? "bg-primary text-cream" : "text-charcoal/75 hover:bg-ice"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
