"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutDashboard, GraduationCap, LineChart, CalendarClock,
  FolderOpen, Users2, Megaphone, UserCircle, ShieldCheck, Network, Video,
  ShoppingBag, Palmtree, Radio, Zap, Activity, ChevronDown, Gem, Hammer, Rocket, Building2, Compass, Trophy, Sparkles, Medal, CreditCard, Ghost, CandlestickChart, Crosshair, Radar, LifeBuoy, BarChart3, Smartphone, Gauge, Link2,
} from "lucide-react";

type Item = { href: string; label: string; icon: typeof LineChart; exact?: boolean };

const REG: Record<string, Item> = {
  dashboard: { href: "/portal", label: "Dashboard", icon: LayoutDashboard, exact: true },
  getApp: { href: "/install", label: "Get the App", icon: Smartphone },
  startHere: { href: "/portal/start-here", label: "Start Here", icon: Compass },
  team: { href: "/portal/team", label: "My Circle", icon: Network },
  prospects: { href: "/portal/prospects", label: "Next Up", icon: Video },
  training: { href: "/portal/training", label: "Affiliate Academy", icon: GraduationCap },
  compPlan: { href: "/portal/comp-plan", label: "The Comp Plan", icon: Trophy },
  genx: { href: "/portal/genx", label: "GENX", icon: Gem },
  omai: { href: "/portal/om-ai", label: "OM AI", icon: Sparkles },
  signals: { href: "/portal/signals", label: "OM AI Plays", icon: Zap },
  xaughost: { href: "/portal/xaughost", label: "MFXGHOST", icon: Ghost },
  charts: { href: "/portal/charts", label: "OM Charts", icon: CandlestickChart },
  command: { href: "/portal/market-command", label: "OM AI Market Command", icon: Crosshair },
  scanner: { href: "/portal/strategy-scanner", label: "OM Strategy Scanner", icon: Radar },
  scalp: { href: "/portal/scalp", label: "OM Scalp", icon: Gauge },
  leaderboard: { href: "/portal/leaderboard", label: "Leaderboard", icon: Medal },
  results: { href: "/portal/community", label: "Results", icon: BarChart3 },
  trading: { href: "/portal/trading", label: "The Floor", icon: LineChart },
  schedule: { href: "/portal/schedule", label: "What's On", icon: CalendarClock },
  resources: { href: "/portal/resources", label: "Resources", icon: FolderOpen },
  leadership: { href: "/portal/leadership", label: "The Inner Circle", icon: Users2 },
  updates: { href: "/portal/updates", label: "Mission Updates", icon: Megaphone },
  collection: { href: "/portal/collection", label: "The Collection", icon: ShoppingBag },
  experiences: { href: "/portal/experiences", label: "1M Experiences", icon: Palmtree },
  credits: { href: "/portal/credits", label: "Credits", icon: CreditCard },
  account: { href: "/portal/account", label: "Profile", icon: UserCircle },
  support: { href: "/portal/support", label: "Support", icon: LifeBuoy },
};

// The Ones = customers · The Builders = affiliates
// The Ones side is organized so the trading desk (The Floor) is the hub: the
// live rooms AND the AI tools (OM Charts, OM AI, OM AI Plays, XAUGHOST) all nest
// under it. Credits nests under Account. Leaderboard sits at the very bottom.
// Customer ("The Ones") nav — deliberately short. A short primary journey, then
// a small utility cluster. Trading lives INSIDE The Floor, not as many top-level
// links. Items archived from the customer menu (still reachable by URL, code
// intact): 1M Experiences, Community Results, Leaderboard, and the extra Floor
// tools (OM Scalp / OM Charts / OM Strategy Scanner / The Room / xGhost).
const ONES_PRIMARY = ["startHere", "schedule", "trading", "leadership", "updates", "collection"];
const ONES_UTILITY = ["getApp", "account", "support"];
const ONES = [...ONES_PRIMARY, ...ONES_UTILITY];
const BUILDERS = ["training", "getApp", "omai", "prospects", "team", "compPlan", "schedule", "leadership", "resources", "updates", "account", "support", "results", "leaderboard"];
const BUILDERS_ONLY = ["team", "prospects", "training", "resources", "compPlan"];
const ONES_ONLY = ["trading", "genx", "signals", "xaughost", "charts", "command", "scanner", "scalp"];

// Children shown under "The Floor". Two kinds: live-desk VIEWS (query-param
// views of /portal/trading) and standalone PAGES (their own routes). Rendered
// in this exact order.
type FloorChild =
  | { kind: "view"; view: string; label: string; icon: typeof LineChart }
  | { kind: "page"; key: string };
// The Floor experiences, in the flywheel order:
// GENX (flagship) → MFXGHOST (deep single-instrument desk) → OM AI (intelligence) →
// OM AI Plays (execution) → Market Pulse (discovery). Live Plays moved to the Dashboard
// (surfaced there as "Live Setups"). OM AI Market Command is hidden for now — routes and
// components are kept intact so it can be switched back on later.
// Also archived from the customer Floor menu: The Room, xGhost (5-pair), OM
// Scalp, OM Charts, OM Strategy Scanner.
const FLOOR_CHILDREN: FloorChild[] = [
  { kind: "view", view: "flow", label: "FLOW", icon: Link2 },
  { kind: "page", key: "genx" },
  { kind: "page", key: "xaughost" },
  { kind: "page", key: "omai" },
  { kind: "page", key: "signals" },
  { kind: "view", view: "pulse", label: "Market Pulse", icon: Activity },
];
// Page keys that now live inside The Floor submenu (used for active detection).
const FLOOR_PAGE_KEYS = FLOOR_CHILDREN.filter((c): c is Extract<FloorChild, { kind: "page" }> => c.kind === "page").map((c) => c.key);

type Side = "ones" | "builders";

export function PortalNav({ isAdmin = false, isOwner = false }: { isAdmin?: boolean; isOwner?: boolean }) {
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
    // Keep the side-aware dashboard hub (PathHub) in sync with the toggle.
    try { window.dispatchEvent(new CustomEvent("portal-side", { detail: s })); } catch { /* ignore */ }
  };

  const keys = side === "ones" ? ONES : BUILDERS;

  // Active key for the mobile header label — include the pages nested under The
  // Floor (and Credits under Account) so the label reflects the real page.
  const labelKeys = side === "ones" ? [...ONES, ...FLOOR_PAGE_KEYS, "credits"] : keys;
  const activeKey = labelKeys.find(match) ?? "dashboard";
  const CurrentIcon = (REG[activeKey] ?? REG.dashboard).icon;
  const activeViewChild = FLOOR_CHILDREN.find((v) => v.kind === "view" && v.view === activeView);
  const currentLabel =
    onFloor && activeView !== "home"
      ? `The Floor · ${activeViewChild && activeViewChild.kind === "view" ? activeViewChild.label : ""}`
      : pathname === "/portal"
      ? "Dashboard"
      : (REG[activeKey] ?? REG.dashboard).label;

  // Indented sub-link used for both the Floor children and Credits-under-Account.
  const SubLink = ({ href, label, Icon, active, compact }: { href: string; label: string; Icon: typeof LineChart; active: boolean; compact?: boolean }) => (
    <li>
      <Link
        href={href}
        onClick={() => setOpen(false)}
        aria-current={active ? "page" : undefined}
        className={`inline-flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
          active ? "bg-ice text-navy" : "text-charcoal/55 hover:bg-ice/60 hover:text-charcoal"
        }`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
      </Link>
    </li>
  );

  // Desktop-only grouping for The Ones (owner redesign 09-04): the same routes
  // and items, organized under monospaced micro-headers for product clarity.
  // Mobile keeps the existing flat list — the mobile experience is untouched.
  const ONES_GROUPS: { label: string; keys: string[] }[] = [
    { label: "Trading", keys: ["trading"] },
    { label: "Performance", keys: ["results", "schedule"] },
    { label: "One Mission", keys: ["startHere", "leadership"] },
    { label: "Build", keys: ["updates"] },
    { label: "More", keys: ["collection", "getApp", "account", "support"] },
  ];

  const Body = ({ compact, grouped }: { compact?: boolean; grouped?: boolean }) => (
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

      {/* Builder HQ — network dashboard (admins only for now) */}
      {side === "builders" && isAdmin && (
        <NavLink
          item={{ href: "/portal/builders", label: "Builder HQ", icon: Rocket }}
          active={pathname.startsWith("/portal/builders")}
          onNav={() => setOpen(false)}
        />
      )}

      {/* Network HQ — admin back office (owner only for now) */}
      {side === "builders" && isOwner && (
        <NavLink
          item={{ href: "/portal/mlm", label: "Network HQ", icon: Building2 }}
          active={pathname.startsWith("/portal/mlm")}
          onNav={() => setOpen(false)}
        />
      )}

      {/* Side items — customers get a short primary list plus a small utility
          cluster below a divider; builders keep their existing single list. */}
      {(() => {
        const renderKey = (key: string) => {
          const it = REG[key];
          const active = match(key);
          return (
            <div key={key}>
              <NavLink item={it} active={active} onNav={() => setOpen(false)} />

              {/* The Floor — the five experiences (Market Command stays admin-only) */}
              {key === "trading" && (
                <ul className={`mt-0.5 flex flex-col border-l border-[#E7E4DD] pl-2 ${compact ? "ml-4" : "ml-3"}`}>
                  {FLOOR_CHILDREN.filter((child) => !(child.kind === "page" && child.key === "command" && !isAdmin)).map((child) => {
                    if (child.kind === "view") {
                      const vActive = onFloor && activeView === child.view;
                      return (
                        <SubLink
                          key={`view-${child.view}`}
                          href={`/portal/trading?view=${child.view}`}
                          label={child.label}
                          Icon={child.icon}
                          active={vActive}
                          compact={compact}
                        />
                      );
                    }
                    const p = REG[child.key];
                    return (
                      <SubLink
                        key={`page-${child.key}`}
                        href={p.href}
                        label={p.label}
                        Icon={p.icon}
                        active={match(child.key)}
                        compact={compact}
                      />
                    );
                  })}
                </ul>
              )}

              {/* Account — Credits nested underneath */}
              {key === "account" && (
                <ul className={`mt-0.5 flex flex-col border-l border-[#E7E4DD] pl-2 ${compact ? "ml-4" : "ml-3"}`}>
                  <SubLink href={REG.credits.href} label={REG.credits.label} Icon={REG.credits.icon} active={match("credits")} compact={compact} />
                </ul>
              )}
            </div>
          );
        };
        if (side === "ones" && grouped) {
          return (
            <>
              {ONES_GROUPS.map((g) => (
                <div key={g.label}>
                  <p className="px-3.5 pb-1 pt-3 font-mono text-[9.5px] font-bold uppercase tracking-[0.22em] text-charcoal/40" aria-hidden="true">
                    {g.label}
                  </p>
                  {g.keys.map(renderKey)}
                </div>
              ))}
            </>
          );
        }
        return side === "ones" ? (
          <>
            {ONES_PRIMARY.map(renderKey)}
            <div className="my-2 h-px bg-[#E7E4DD]" role="separator" aria-hidden="true" />
            {ONES_UTILITY.map(renderKey)}
          </>
        ) : (
          <>{BUILDERS.map(renderKey)}</>
        );
      })()}

      {/* Approvals (admin) */}
      {isAdmin && (
        <NavLink
          item={{ href: "/portal/admin", label: "Approvals", icon: ShieldCheck }}
          active={pathname === "/portal/admin"}
          onNav={() => setOpen(false)}
        />
      )}

      {/* Credits & conversion (admin) */}
      {isAdmin && (
        <NavLink
          item={{ href: "/portal/admin/credits", label: "Credits", icon: CreditCard }}
          active={pathname.startsWith("/portal/admin/credits")}
          onNav={() => setOpen(false)}
        />
      )}

      {/* Learning Desk — AI self-audit / continuous learning (admin) */}
      {isAdmin && (
        <NavLink
          item={{ href: "/portal/learning", label: "Learning Desk", icon: BarChart3 }}
          active={pathname.startsWith("/portal/learning")}
          onNav={() => setOpen(false)}
        />
      )}

      {/* GENX Lab — recorded Gold signals & tracked outcomes (admin) */}
      {isAdmin && (
        <NavLink
          item={{ href: "/portal/genx-lab", label: "GENX Lab", icon: Gem }}
          active={pathname.startsWith("/portal/genx-lab")}
          onNav={() => setOpen(false)}
        />
      )}

      {/* My Results — private, honest record of the owner's own live accounts.
          Lives at /admin/results (outside the portal layout, admin-gated by the
          API which 404s non-admins), so a plain full-load <a> like the other
          /admin/* links below rather than a client-side <Link>. */}
      {isAdmin && (
        <a
          href="/admin/results"
          onClick={() => setOpen(false)}
          className="focus-ring inline-flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold text-charcoal/75 transition-colors hover:bg-ice"
        >
          <Activity className="h-4 w-4" aria-hidden="true" />
          My Results
        </a>
      )}

      {/* Fantasy — private tool, rendered ONLY for the owner account (isOwner is
          Matthew's email). A plain full-load <a> because /admin/fantasy serves raw
          HTML, which Next's client-side <Link> navigation can't handle. */}
      {isOwner && (
        <a
          href="/admin/fantasy"
          onClick={() => setOpen(false)}
          className="focus-ring inline-flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold text-charcoal/75 transition-colors hover:bg-ice"
        >
          <Trophy className="h-4 w-4" aria-hidden="true" />
          Fantasy
        </a>
      )}

      {/* Sports AI — private admin command center. Rendered ONLY for the owner
          account (isOwner). Plain full-load <a> because /admin/sports-ai serves
          raw HTML that Next's client-side <Link> can't handle. Server-side gated
          too, so this link is a convenience, not the security boundary. */}
      {isOwner && (
        <a
          href="/admin/sports-ai"
          onClick={() => setOpen(false)}
          className="focus-ring inline-flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold text-charcoal/75 transition-colors hover:bg-ice"
        >
          <Crosshair className="h-4 w-4" aria-hidden="true" />
          Sports AI
        </a>
      )}
    </div>
  );

  return (
    <>
      {/* Mobile: dropdown */}
      <div className="relative z-30 lg:hidden">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-xl border border-[#E7E4DD] bg-offwhite px-4 py-3 text-sm font-bold text-navy"
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
            <div className="absolute z-30 mt-2 max-h-[70vh] w-full overflow-y-auto rounded-2xl border border-[#E7E4DD] bg-cream p-2 shadow-card">
              <Body compact />
            </div>
          </>
        )}
      </div>

      {/* Desktop: sidebar */}
      <nav aria-label="Member portal" className="hidden min-w-0 lg:sticky lg:top-24 lg:block">
        <Body grouped />
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
