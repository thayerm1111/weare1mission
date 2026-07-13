"use client";

import { useState } from "react";
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
  const [tab, setTab] = useState<TabId>("room");

  return (
    <div className="overflow-hidden rounded-3xl border border-black bg-[#0a0a0a] text-white shadow-card">
      {/* Tab bar */}
      <div className="border-b border-white/10 p-2.5">
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
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
