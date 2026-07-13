"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutDashboard, GraduationCap, LineChart, CalendarClock,
  FolderOpen, Users2, Megaphone, UserCircle, ShieldCheck, Network, Video,
  ShoppingBag, Palmtree, Radio, Zap, Activity, Repeat, ChevronDown, Gem, Hammer,
} from "lucide-react";

type Item = { href: string; label: string; icon: typeof LineChart; exact?: boolean };

const REG: Record<string, Item> = {
  dashboard: { href: "/portal", label: "Dashboard", icon: LayoutDashboard, exact: true },
  team: { href: "/portal/team", label: "My Circle", icon: Network },
  prospects: { href: "/portal/prospects", label: "Next Up", icon: Video },
  training: { href: "/portal/training", label: "Creator Launchpad", icon: GraduationCap },
  trading: { href: "/portal/trading", label: "The Floor", icon: LineChart },
  schedule: { href: "/portal/schedule", label: "What's On", icon: CalendarClock },
  resources: { href: "/portal/resources", label: "Resources", icon: FolderOpen },
  leadership: { href: "/portal/leadership", label: "The Inner Circle", icon: Users2 },
  updates: { href: "/portal/updates", label: "Mission Update", icon: Megaphone },
  collection: { href: "/collection", label: "The Collection", icon: ShoppingBag },
  experiences: { href: "/experiences", label: "1M Experiences", icon: Palmtree },
  account: { href: "/portal/account", label: "Account", icon: UserCircle },
};

// The Ones = customers · The Builders = affiliates
const ONES = ["trading", "schedule", "leadership", "updates", "collection", "experiences", "account"];
const BUILDERS = ["team", "prospects", "training", "schedule", "resources", "leadership", "updates", "account"];
const BUILDERS_ONLY = ["team", "prospects", "training", "resources"];
const ONES_ONLY = ["trading"];

const floorViews = [
  { view: "room", label: "The Room", icon: Radio },
  { view: "plays", label: "Live Plays", icon: Zap },
  { view: "pulse", label: "Market Pulse", icon: Activity },
  { view: "sync", label: "Trade Sync", icon: Repeat },
];

type Side = "ones" | "builders";

export function PortalNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>("ones");

  const onFloor = pathname.startsWith("/portal/trading");
  const activeView = params.get("view") ?? "home";
  const match = (key: string) => {
    const it = REG[key];
    return it.exact ? pathname === it.href : pathname.startsWith(it.href);
  };

  // Pick the side that contains the current page; otherwise use the saved choice.
  useEffect(() => {
    const stored = typeof window !== "undefined" ? (localStorage.getItem("portal_side") as Side | null) : null;
    if (BUILDERS_ONLY.some(match)) setSide("builders");
    else if (ONES_ONLY.some(match)) setSide("ones");
    else if (stored === "builders" || stored === "ones") setSide(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const choose = (s: Side) => {
    setSide(s);
    try { localStorage.setItem("portal_side", s); } catch { /* ignore */ }
  };

  const keys = side === "ones" ? ONES : BUILDERS;

  const activeKey = keys.find(match) ?? "dashboard";
  const CurrentIcon = (REG[activeKey] ?? REG.dashboard).icon;
  const currentLabel =
    onFloor && activeView !== "home"
      ? `The Floor · ${floorViews.find((v) => v.view === activeView)?.label ?? ""}`
      : pathname === "/portal"
      ? "Dashboard"
      : (REG[activeKey] ?? REG.dashboard).label;

  const Body = ({ compact }: { compact?: boolean }) => (
    <div className="flex flex-col gap-1">
      {/* Dashboard (both sides) */}
      <NavLink item={REG.dashboard} active={pathname === "/portal"} onNav={() => setOpen(false)} />

      {/* Side toggle */}
      <div className="my-1.5 grid grid-cols-2 gap-1 rounded-full bg-ice p-1">
        <button
          onClick={() => choose("ones")}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-bold transition-colors ${
            side === "ones" ? "bg-primary text-cream" : "text-charcoal/55 hover:text-charcoal"
          }`}
        >
          <Gem className="h-3.5 w-3.5" /> The Ones
        </button>
        <button
          onClick={() => choose("builders")}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-bold transition-colors ${
            side === "builders" ? "bg-primary text-cream" : "text-charcoal/55 hover:text-charcoal"
          }`}
        >
          <Hammer className="h-3.5 w-3.5" /> The Builders
        </button>
      </div>

      {/* Side items */}
      {keys.map((key) => {
        const it = REG[key];
        const active = match(key);
        return (
          <div key={key}>
            <NavLink item={it} active={active} onNav={() => setOpen(false)} />
            {key === "trading" && (
              <ul className={`mt-0.5 flex flex-col border-l border-[#E4DCCB] pl-2 ${compact ? "ml-4" : "ml-3"}`}>
                {floorViews.map((v) => {
                  const vActive = onFloor && activeView === v.view;
                  const VIcon = v.icon;
                  return (
                    <li key={v.view}>
                      <Link
                        href={`/portal/trading?view=${v.view}`}
                        onClick={() => setOpen(false)}
                        aria-current={vActive ? "page" : undefined}
                        className={`inline-flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                          vActive ? "bg-ice text-navy" : "text-charcoal/55 hover:bg-ice/60 hover:text-charcoal"
                        }`}
                      >
                        <VIcon className="h-3.5 w-3.5" aria-hidden="true" /> {v.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}

      {/* Approvals (admin) */}
      {isAdmin && (
        <NavLink
          item={{ href: "/portal/admin", label: "Approvals", icon: ShieldCheck }}
          active={pathname.startsWith("/portal/admin")}
          onNav={() => setOpen(false)}
        />
      )}
    </div>
  );

  return (
    <>
      {/* Mobile: dropdown */}
      <div className="relative z-30 lg:hidden">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-xl border border-[#E4DCCB] bg-offwhite px-4 py-3 text-sm font-bold text-navy"
          aria-expanded={open}
        >
          <span className="inline-flex items-center gap-2.5">
            <CurrentIcon className="h-4 w-4" aria-hidden="true" /> {currentLabel}
          </span>
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
            <div className="absolute z-30 mt-2 max-h-[70vh] w-full overflow-y-auto rounded-2xl border border-[#E4DCCB] bg-cream p-2 shadow-card">
              <Body compact />
            </div>
          </>
        )}
      </div>

      {/* Desktop: sidebar */}
      <nav aria-label="Member portal" className="hidden min-w-0 lg:sticky lg:top-24 lg:block">
        <Body />
      </nav>
    </>
  );
}

function NavLink({ item, active, onNav }: { item: Item; active: boolean; onNav: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNav}
      aria-current={active ? "page" : undefined}
      className={`inline-flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors focus-ring ${
        active ? "bg-primary text-cream" : "text-charcoal/75 hover:bg-ice"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}
