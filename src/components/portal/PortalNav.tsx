"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutDashboard, GraduationCap, LineChart, CalendarClock,
  FolderOpen, Users2, Megaphone, UserCircle, ShieldCheck, Network, Video,
  ShoppingBag, Palmtree, Radio, Zap, Activity, Repeat,
} from "lucide-react";

/**
 * Member back-office navigation.
 * Add/remove sections here. All routes live under /portal/* and are login-gated.
 * The Approvals item only shows for admins.
 */
const items = [
  { href: "/portal", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/portal/team", label: "My Circle", icon: Network },
  { href: "/portal/prospects", label: "Next Up", icon: Video },
  { href: "/portal/training", label: "Creator Launchpad", icon: GraduationCap },
  { href: "/portal/trading", label: "The Floor", icon: LineChart },
  { href: "/portal/schedule", label: "What's On", icon: CalendarClock },
  { href: "/portal/resources", label: "Resources", icon: FolderOpen },
  { href: "/portal/leadership", label: "The Inner Circle", icon: Users2 },
  { href: "/portal/updates", label: "Mission Update", icon: Megaphone },
  { href: "/collection", label: "The Collection", icon: ShoppingBag },
  { href: "/experiences", label: "1M Experiences", icon: Palmtree },
  { href: "/portal/account", label: "Account", icon: UserCircle },
];

// Sub-tabs shown nested under "The Floor".
const floorViews = [
  { view: "room", label: "The Room", icon: Radio },
  { view: "plays", label: "Live Plays", icon: Zap },
  { view: "pulse", label: "Market Pulse", icon: Activity },
  { view: "sync", label: "Trade Sync", icon: Repeat },
];

export function PortalNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const onFloor = pathname.startsWith("/portal/trading");
  const activeView = params.get("view") ?? "room";

  const links = isAdmin
    ? [...items, { href: "/portal/admin", label: "Approvals", icon: ShieldCheck }]
    : items;

  return (
    <nav aria-label="Member portal" className="min-w-0 lg:sticky lg:top-24">
      <ul className="flex flex-wrap gap-1.5 pb-1 lg:flex-col lg:flex-nowrap lg:gap-1 lg:pb-0">
        {links.map((it) => {
          const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
          const Icon = it.icon;
          const isFloor = it.href === "/portal/trading";
          return (
            <li key={it.href} className="flex-shrink-0 lg:w-full">
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

              {/* Floor sub-tabs */}
              {isFloor && (
                <ul className="mt-1 flex flex-wrap gap-1 lg:ml-3 lg:flex-col lg:border-l lg:border-[#E4DCCB] lg:pl-2">
                  {floorViews.map((v) => {
                    const vActive = onFloor && activeView === v.view;
                    const VIcon = v.icon;
                    return (
                      <li key={v.view} className="flex-shrink-0 lg:w-full">
                        <Link
                          href={`/portal/trading?view=${v.view}`}
                          aria-current={vActive ? "page" : undefined}
                          className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors lg:w-full ${
                            vActive
                              ? "bg-ice text-navy"
                              : "text-charcoal/55 hover:bg-ice/60 hover:text-charcoal"
                          }`}
                        >
                          <VIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          {v.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
