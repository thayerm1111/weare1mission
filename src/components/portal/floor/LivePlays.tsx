"use client";

import { useState } from "react";
import { Star, Clipboard, Bell, Users } from "lucide-react";
import { TradingViewChart } from "./TradingViewChart";

type Signal = {
  id: string;
  pair: string;
  symbol: string; // TradingView symbol
  side: "Buy Market" | "Sell Market";
  ep: string;
  sl: string;
  tps: string[];
  strength: number;
  createdAt: string;
  orderType: string;
  caller: string;
  active: boolean;
};

const SIGNALS: Signal[] = [
  {
    id: "s1",
    pair: "XAU/USD",
    symbol: "OANDA:XAUUSD",
    side: "Sell Market",
    ep: "4127",
    sl: "4135",
    tps: ["4125", "4123", "4121", "4115", "4110"],
    strength: 4,
    createdAt: "09:20 PM",
    orderType: "Scalp",
    caller: "Arabella Angeles",
    active: true,
  },
  {
    id: "s2",
    pair: "EUR/USD",
    symbol: "OANDA:EURUSD",
    side: "Buy Market",
    ep: "1.1421",
    sl: "1.1402",
    tps: ["1.1435", "1.1450", "1.1470"],
    strength: 5,
    createdAt: "01:09 PM",
    orderType: "Scalp",
    caller: "RJ Antuna",
    active: true,
  },
  {
    id: "s3",
    pair: "GBP/USD",
    symbol: "OANDA:GBPUSD",
    side: "Sell Market",
    ep: "1.3320",
    sl: "1.3345",
    tps: ["1.3300", "1.3280", "1.3255"],
    strength: 3,
    createdAt: "11:42 AM",
    orderType: "Swing",
    caller: "Gold_Master",
    active: false,
  },
];

export function LivePlays({
  isCaller = false,
  followerCount = 0,
}: {
  isCaller?: boolean;
  followerCount?: number;
}) {
  const [active, setActive] = useState<Signal>(SIGNALS[0]);

  return (
    <div className="space-y-3">
      {isCaller && (
        <div className="flex flex-col gap-3 rounded-2xl border border-gold/40 bg-gold/10 p-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-2 text-sm">
            <Users className="h-5 w-5 text-gold-light" />
            <span className="font-bold">{followerCount.toLocaleString()}</span>
            <span className="text-white/60">following your calls</span>
          </span>
          <button
            title="Posting goes live in the next phase"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:opacity-90"
          >
            <Bell className="h-4 w-4" /> Post a play
          </button>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        {/* Big chart */}
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-semibold text-white">{active.pair}</span>
            <span className="text-white/40">· tap a play to load it on the chart</span>
          </div>
          <TradingViewChart symbol={active.symbol} interval="15" height="80vh" />
        </div>

        {/* Signals list */}
        <div className="space-y-3">
          <p className="text-sm font-semibold text-white">Live plays</p>
          <div className="space-y-3 lg:max-h-[80vh] lg:overflow-y-auto lg:pr-1">
            {SIGNALS.map((s) => {
              const selected = s.id === active.id;
              const buy = s.side === "Buy Market";
              return (
                <button
                  key={s.id}
                  onClick={() => setActive(s)}
                  className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                    selected ? "border-gold bg-gold/[0.06]" : "border-white/10 bg-[#0f0f0f] hover:border-white/25"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                        <span className={`h-2 w-2 rounded-full ${s.active ? "bg-emerald-400" : "bg-white/30"}`} />
                        <span className={s.active ? "text-emerald-400" : "text-white/40"}>
                          {s.active ? "Active" : "Closed"}
                        </span>
                      </span>
                      <p className="mt-0.5 text-base font-extrabold tracking-tight">{s.pair}</p>
                    </div>
                    <span
                      className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                        buy ? "bg-emerald-500/15 text-emerald-300" : "bg-gold/15 text-gold-light"
                      }`}
                    >
                      {s.side}
                    </span>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <Cell label="EP" value={s.ep} />
                    <Cell label="SL" value={s.sl} />
                    {s.tps.map((tp, i) => (
                      <Cell key={i} label={`TP${i + 1}`} value={tp} />
                    ))}
                  </div>

                  <div className="mt-2 flex items-center justify-between text-xs text-white/50">
                    <span className="inline-flex items-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-3 w-3 ${i < s.strength ? "fill-gold-light text-gold-light" : "text-white/20"}`}
                        />
                      ))}
                    </span>
                    <span>
                      {s.orderType} · {s.createdAt}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-white/40">{s.caller}</p>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-2 py-1.5">
      <span className="text-xs text-white/50">{label}</span>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-white">
        {value}
        <Clipboard className="h-3 w-3 text-white/25" />
      </span>
    </div>
  );
}
