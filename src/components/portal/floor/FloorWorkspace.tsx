"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, Sparkles, Zap, Activity, TrendingUp, Ghost } from "lucide-react";
import { FloorHome } from "./FloorHome";
import { LivePlays } from "./LivePlays";
import { MarketPulse } from "./MarketPulse";

// The Floor workspace holds the launcher (home) plus the two in-desk views:
// Market Pulse and Live Plays. OM AI, OM AI Plays and MFXGHOST are their own
// routes — the launcher cards and the in-tool switcher link out to them. The Room
// and xGhost are archived from the customer Floor (routes/components preserved).
const VIEW_TABS = [
  { id: "home", label: "Floor" },
  { id: "pulse", label: "Market Pulse" },
  { id: "plays", label: "Live Plays" },
] as const;

type TabId = (typeof VIEW_TABS)[number]["id"];

// The five experiences, for the switcher shown once you're inside a tool. Mix of
// in-desk views (Market Pulse, Live Plays) and standalone routes.
type SwitchItem = { key: string; label: string; icon: typeof LayoutGrid } & (
  | { view: string }
  | { href: string }
);
const SWITCHER: SwitchItem[] = [
  { key: "home", label: "Floor", icon: LayoutGrid, view: "home" },
  { key: "omai", label: "OM AI", icon: Sparkles, href: "/portal/om-ai" },
  { key: "signals", label: "OM AI Plays", icon: Zap, href: "/portal/signals" },
  { key: "pulse", label: "Market Pulse", icon: Activity, view: "pulse" },
  { key: "plays", label: "Live Plays", icon: TrendingUp, view: "plays" },
  { key: "xaughost", label: "MFXGHOST", icon: Ghost, href: "/portal/xaughost" },
];

export function FloorWorkspace({
  isCaller = false,
  followerCount = 0,
}: {
  isCaller?: boolean;
  followerCount?: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("view");
  const tab: TabId = (VIEW_TABS.some((t) => t.id === raw) ? raw : "home") as TabId;

  const go = (id: string) =>
    router.replace(id === "home" ? "/portal/trading" : `/portal/trading?view=${id}`, { scroll: false });

  const pill = (active: boolean) =>
    `inline-flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${
      active ? "bg-primary text-cream" : "text-charcoal/55 hover:bg-offwhite hover:text-charcoal"
    }`;

  return (
    <div className="overflow-hidden rounded-2xl border border-[#E7E4DD] bg-cream text-charcoal shadow-card">
      {/* In-tool switcher — appears once you're inside a Floor tool so the other
          experiences stay one tap away. The launcher (home) uses its own cards. */}
      {tab !== "home" && (
        <div className="border-b border-ice p-2">
          <div className="flex gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {SWITCHER.map((s) => {
              const Icon = s.icon;
              if ("href" in s) {
                return (
                  <Link key={s.key} href={s.href} className={pill(false)}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {s.label}
                  </Link>
                );
              }
              const active = s.view === tab;
              return (
                <button key={s.key} onClick={() => go(s.view)} className={pill(active)}>
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="p-2.5 sm:p-3">
        {tab === "home" && <FloorHome onGo={go} />}
        {tab === "plays" && <LivePlays isCaller={isCaller} followerCount={followerCount} />}
        {tab === "pulse" && <MarketPulse />}
      </div>
    </div>
  );
}
