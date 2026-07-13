"use client";

import { useState } from "react";
import {
  Trophy,
  Crown,
  BarChart3,
  DollarSign,
  ChevronRight,
  ArrowLeft,
  Link2,
  Flame,
  Plus,
  CheckCircle2,
} from "lucide-react";

type Trader = {
  id: string;
  name: string;
  desc: string;
  monthly: number;
  total: number;
  winRate: number;
  profitFactor: number;
  maxDD: number;
  copiers: number;
  fee: number;
  hot?: boolean;
  copying?: boolean;
};

const TRADERS: Trader[] = [
  { id: "gold", name: "Gold_Master", desc: "Gold specialist. Precision entries around London & NY sessions.", monthly: 29.6, total: 29.6, winRate: 71, profitFactor: 2.9, maxDD: 12.4, copiers: 48, fee: 20, hot: true },
  { id: "ghosts", name: "XAU GHOSTS", desc: "A team of experts that learned under a professional for 10+ years. Profitable trades all day — precision entries.", monthly: 18.4, total: 18.4, winRate: 77, profitFactor: 3.4, maxDD: 15.5, copiers: 15, fee: 15, copying: true },
  { id: "hannah", name: "Hannah Gallagher", desc: "Swing trades on majors. Lower frequency, higher conviction.", monthly: 15.1, total: 15.1, winRate: 64, profitFactor: 2.1, maxDD: 9.8, copiers: 22, fee: 15 },
  { id: "alpha", name: "Alpha Pro", desc: "Index scalping with tight risk. Fast in, fast out.", monthly: 3.5, total: 3.5, winRate: 58, profitFactor: 1.6, maxDD: 7.2, copiers: 9, fee: 10 },
  { id: "kairos", name: "Kairos Nas100", desc: "Nasdaq momentum. New account building a track record.", monthly: 0.0, total: 0.0, winRate: 0, profitFactor: 0, maxDD: 0, copiers: 2, fee: 10 },
];

const SUBTABS = [
  { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  { id: "master", label: "Master Copy", icon: Crown },
  { id: "internal", label: "Internal Copier", icon: BarChart3 },
  { id: "affiliate", label: "Affiliate Earnings", icon: DollarSign },
] as const;

type SubId = (typeof SUBTABS)[number]["id"];

export function TradeSync() {
  const [sub, setSub] = useState<SubId>("leaderboard");
  const [selected, setSelected] = useState<Trader | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-extrabold tracking-tight">Copy Trading</h2>
        <p className="text-sm text-white/50">Follow professional traders or become a master trader.</p>
      </div>

      {/* Sub tabs */}
      <div className="flex flex-wrap gap-4 border-b border-white/10">
        {SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                setSub(t.id);
                setSelected(null);
              }}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-1 pb-2.5 text-sm font-semibold transition-colors ${
                active ? "border-emerald-400 text-white" : "border-transparent text-white/50 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {sub === "leaderboard" &&
        (selected ? (
          <TraderDetail trader={selected} onBack={() => setSelected(null)} />
        ) : (
          <Leaderboard onSelect={setSelected} />
        ))}
      {sub === "master" && (
        <Placeholder title="Master Copy" body="Become a master trader — let members copy your account. Application and payout setup land in a later phase." />
      )}
      {sub === "internal" && (
        <Placeholder title="Internal Copier" body="Mirror one of your own accounts to another. Configure source, destination and lot scaling here." />
      )}
      {sub === "affiliate" && (
        <Placeholder title="Affiliate Earnings" body="Track referrals and performance-fee earnings from the traders and copiers you bring in." />
      )}
    </div>
  );
}

/* --------------------------- Leaderboard --------------------------- */

function Leaderboard({ onSelect }: { onSelect: (t: Trader) => void }) {
  return (
    <div className="space-y-4">
      <ConnectCard />
      <div className="flex items-center justify-between">
        <p className="inline-flex items-center gap-2 text-sm font-semibold">
          <Trophy className="h-4 w-4 text-gold-light" /> Top Copy Traders
        </p>
        <span className="text-xs text-emerald-400">See all ({TRADERS.length})</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {TRADERS.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t)}
            className="rounded-2xl border border-white/10 bg-[#1e1810] p-4 text-left transition-colors hover:border-emerald-400/40"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-bold text-emerald-300">
                  {t.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-bold">{t.name}</p>
                  <p className="text-[11px] text-white/40">{t.copiers} copiers</p>
                </div>
              </div>
              {t.hot && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gold/20 px-2 py-0.5 text-[10px] font-bold text-gold-light">
                  <Flame className="h-3 w-3" /> #1 Today
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Stat mini label="Monthly" value={`${t.monthly >= 0 ? "+" : ""}${t.monthly}%`} good={t.monthly >= 0} />
              <Stat mini label="Win rate" value={`${t.winRate}%`} />
            </div>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
              View stats <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectCard() {
  const [connected, setConnected] = useState(false);
  return (
    <div className="rounded-2xl border border-white/10 bg-[#1e1810] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="inline-flex items-center gap-2 text-sm font-bold">
            <Link2 className="h-4 w-4 text-emerald-400" /> Connect your TradeLocker account
          </p>
          <p className="mt-1 text-xs text-white/50">
            Link your broker (e.g. Crucial Markets) to copy an approved trader. You approve every trade.
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input placeholder="Server (e.g. crucial-live)" className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none" />
        <input placeholder="Account number" className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none" />
        {connected ? (
          <span className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Connected
          </span>
        ) : (
          <button onClick={() => setConnected(true)} className="rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-black hover:opacity-90">
            Connect
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-white/40">
        Preview — live linking and order approval require TradeLocker API access (a later phase). Never
        share your withdrawal password.
      </p>
    </div>
  );
}

/* --------------------------- Trader detail --------------------------- */

function TraderDetail({ trader, onBack }: { trader: Trader; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-white/60 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Back to leaderboard
      </button>

      <div className="rounded-2xl border border-white/10 bg-[#1e1810] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2">
            <h3 className="text-lg font-extrabold tracking-tight">{trader.name}</h3>
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">
              Copy Trading
            </span>
          </div>
          <span className="text-sm text-white/50">{trader.copiers} copiers</span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-white/60">{trader.desc}</p>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Monthly" value={`${trader.monthly >= 0 ? "+" : ""}${trader.monthly}%`} good={trader.monthly >= 0} />
          <Stat label="Total" value={`${trader.total >= 0 ? "+" : ""}${trader.total}%`} good={trader.total >= 0} />
          <Stat label="Win rate" value={`${trader.winRate}%`} />
          <Stat label="Profit factor" value={`${trader.profitFactor}`} />
          <Stat label="Max DD" value={`${trader.maxDD}%`} bad />
          <Stat label="Copiers" value={`${trader.copiers}`} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-xs text-white/50">
            Performance fee <span className="ml-1 rounded-md bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-300">{trader.fee}% of profit</span>
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {trader.copying ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Already copying
              </span>
            ) : (
              <button className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:opacity-90">
                Copy trader
              </button>
            )}
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 hover:bg-white/5">
              <Plus className="h-4 w-4" /> Add account
            </button>
          </div>
        </div>
      </div>

      {/* Performance dashboard */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BigStat label="Net P&L" value="+$128.91" sub="113 trades" good />
        <BigStat label="Profit factor" value={`${trader.profitFactor}`} sub="Average" />
        <BigStat label="Lots traded" value="3.08" sub="113 trades" />
        <BigStat label="Total trades" value="113" sub="83 wins · 29 losses" />
      </div>

      <TradingCalendar />
    </div>
  );
}

/* --------------------------- Trading calendar --------------------------- */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Sample July 2026 — starts on Wednesday (offset 3). value = daily P&L.
const CAL: Record<number, number> = {
  1: 5, 2: -3, 3: 30, 6: 26, 7: 22, 8: -55, 9: 103, 10: 17, 13: -70,
};

function TradingCalendar() {
  const offset = 3; // July 1 2026 is a Wednesday
  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: 31 }, (_, i) => i + 1),
  ];
  const monthly = Object.values(CAL).reduce((a, b) => a + b, 0);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#1e1810] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="h-4 w-4 text-emerald-400" /> Trading Calendar
        </p>
        <div className="flex items-center gap-3 text-xs text-white/50">
          <span>
            Monthly P&L <span className="font-semibold text-emerald-400">+${monthly}</span>
          </span>
          <span>Jul 2026</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1.5">
        {DAYS.map((d) => (
          <div key={d} className="pb-1 text-center text-[11px] font-medium text-white/40">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const pnl = CAL[day];
          const has = pnl !== undefined;
          const good = (pnl ?? 0) >= 0;
          return (
            <div
              key={i}
              className={`aspect-square rounded-lg border p-1.5 text-left ${
                has
                  ? good
                    ? "border-emerald-500/30 bg-emerald-500/10"
                    : "border-red-500/30 bg-red-500/10"
                  : "border-white/5 bg-white/[0.02]"
              }`}
            >
              <div className="text-[10px] text-white/40">{day}</div>
              {has && (
                <div className={`text-[11px] font-bold ${good ? "text-emerald-400" : "text-red-400"}`}>
                  {good ? "+" : ""}${pnl}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------- bits --------------------------- */

function Stat({ label, value, good, bad, mini }: { label: string; value: string; good?: boolean; bad?: boolean; mini?: boolean }) {
  const color = good ? "text-emerald-400" : bad ? "text-red-400" : "text-white";
  return (
    <div className={`rounded-xl border border-white/10 bg-white/[0.03] ${mini ? "px-3 py-2" : "px-3 py-3"}`}>
      <p className="text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <p className={`mt-0.5 font-bold ${color} ${mini ? "text-sm" : "text-base"}`}>{value}</p>
    </div>
  );
}

function BigStat({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#1e1810] p-4">
      <p className="text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${good ? "text-emerald-400" : "text-white"}`}>{value}</p>
      <p className="mt-0.5 text-xs text-white/40">{sub}</p>
    </div>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#1e1810] p-6">
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1 max-w-xl text-sm text-white/50">{body}</p>
    </div>
  );
}
