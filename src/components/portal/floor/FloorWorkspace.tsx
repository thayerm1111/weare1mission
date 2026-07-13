"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Radio, Zap, Activity, Repeat } from "lucide-react";
import { TheRoom } from "./TheRoom";
import { LivePlays } from "./LivePlays";
import { MarketPulse } from "./MarketPulse";
import { TradeSync } from "./TradeSync";

const TABS = [
  { id: "room", label: "The Room", icon: Radio },
  { id: "plays", label: "Live Plays", icon: Zap },
  { id: "pulse", label: "Market Pulse", icon: Activity },
  { id: "sync", label: "Trade Sync", icon: Repeat },
] as const;

type TabId = (typeof TABS)[number]["id"];

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
  const tab: TabId = (TABS.some((t) => t.id === raw) ? raw : "room") as TabId;

  const go = (id: TabId) => router.replace(`/portal/trading?view=${id}`, { scroll: false });

  return (
    <div className="overflow-hidden rounded-2xl border border-[#100c07] bg-[#17130d] text-white shadow-card">
      {/* In-page tab bar — mobile only; on desktop the sidebar drives the view */}
      <div className="border-b border-white/10 p-2 lg:hidden">
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => go(t.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${
                  active ? "bg-white text-black" : "text-white/55 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-2.5 sm:p-3">
        {tab === "room" && <TheRoom />}
        {tab === "plays" && <LivePlays isCaller={isCaller} followerCount={followerCount} />}
        {tab === "pulse" && <MarketPulse />}
        {tab === "sync" && <TradeSync />}
      </div>
    </div>
  );
}
