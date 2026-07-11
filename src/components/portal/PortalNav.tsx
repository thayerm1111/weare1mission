"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, GraduationCap, LineChart, CalendarClock,
  FolderOpen, Users2, Megaphone, UserCircle,
} from "lucide-react";

/**
 * Member back-office navigation.
 * Add/remove sections here. All routes live under /portal/* and are login-gated.
 */
const items = [
  { href: "/portal", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/portal/training", label: "Training", icon: GraduationCap },
  { href: "/portal/trading", label: "Trading", icon: LineChart },
  { href: "/portal/schedule", label: "Schedule", icon: CalendarClock },
  { href: "/portal/resources", label: "Resources", icon: FolderOpen },
  { href: "/portal/leadership", label: "Leadership", icon: Users2 },
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
