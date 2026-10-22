"use client";
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { Snapshot } from "@/lib/cashtrap/snapshot";
import type { SymbolSpec } from "@/lib/cashtrap/symbols";
import type { DmiStatus } from "@/lib/cashtrap/dmi";
import { MarketCard } from "./MarketCard";
import { MarketDetail } from "./MarketDetail";
import { HistoryPanel } from "./HistoryPanel";
import { AlertsPanel } from "./AlertsPanel";
import { RulesPanel } from "./RulesPanel";
import { AdminPanel } from "./AdminPanel";
import { usePoll, useServerClock } from "./useCashtrap";
import { C } from "./theme";

type Dashboard = {
  serverNow: number; nextCloseAt: number; feed: string;
  cards: Array<{ symbol: string; spec: SymbolSpec; snapshot: Snapshot | null; stale: boolean }>;
  dmi: DmiStatus & { source: Record<string, string> };
  config: { strategyVersion: string; configVersion: string; screenshot: Record<string, unknown>; assumptions: Record<string, unknown>; notes: Array<{ key: string; label: string; origin: "owner-default" | "implementation" | "broker-required" }> };
  settings: { visibility: string; dmiMode: string; liveEnabled: boolean };
  isAdmin: boolean; unreadAlerts: number;
};

/** Cashtrap — four markets scanned independently on completed 5-minute candles. */
export function CashtrapDashboard({ isAdmin }: { isAdmin: boolean }) {
  const { data, error } = usePoll<Dashboard>("/api/cashtrap/dashboard", 5_000);
  const now = useServerClock(data?.serverNow);
  const [selected, setSelected] = useState("XAUUSD");
  const nextCloseAt = data ? Math.max(data.nextCloseAt, Math.ceil(now / 300_000) * 300_000) : 0;
  return (
    <div className="min-h-screen rounded-3xl px-3 py-4 sm:px-5 sm:py-5" style={{ background: C.page }}>
      <div className="mx-auto max-w-[1400px] space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" style={{ color: C.ink }}>Cashtrap</h1>
            <p className="text-[13px]" style={{ color: C.muted }}>Binary CALL/PUT signals from a fixed indicator rule set · USD/JPY, EUR/USD, XAU/USD, GBP/JPY · 5-minute candles</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {data && <span className="rounded-full border px-3 py-1.5" style={{ borderColor: data.dmi.available ? C.blueLine : "#F0C9C6", background: data.dmi.available ? C.blueSoft : C.redSoft, color: data.dmi.available ? C.blue : C.red }}>DMI: {data.dmi.label}</span>}
            {data && !data.settings.liveEnabled && <span className="rounded-full border px-3 py-1.5" style={{ borderColor: C.line, color: C.red }}>Live runner off</span>}
            <AlertsPanel />
          </div>
        </header>

        <div className="flex items-start gap-2 rounded-2xl border px-4 py-3 text-[12px]" style={{ borderColor: "#E5DFF7", background: C.purpleSoft, color: C.ink }}>
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: C.purple }} />
          <p>
            A signal provider only — nothing is traded automatically. Indicators are computed on completed candles from a reference feed ({data?.feed ?? "TwelveData"}), not your broker&apos;s prices or any OTC instrument.
            Results here are <b>reference-feed</b> (live) or <b>simulated</b> (replay), never broker-verified. &ldquo;5/5 conditions met&rdquo; is agreement of related indicators, not a probability of winning.
            Educational only — not financial advice.
          </p>
        </div>

        {error && !data && <p className="text-sm" style={{ color: C.red }}>{error === "forbidden" ? "Cashtrap is not open to your account yet." : `Could not load Cashtrap: ${error}`}</p>}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(data?.cards ?? []).map((c) => (
            <MarketCard key={c.symbol} spec={c.spec} snap={c.snapshot} now={now} nextCloseAt={nextCloseAt} selected={selected === c.symbol} onSelect={() => setSelected(c.symbol)} stale={c.stale} />
          ))}
        </div>

        {data && <MarketDetail symbol={selected} now={now} />}
        {data && <HistoryPanel />}
        {data && <RulesPanel screenshot={data.config.screenshot} notes={data.config.notes} assumptions={data.config.assumptions} strategyVersion={data.config.strategyVersion} configVersion={data.config.configVersion} dmiNotes={data.dmi.notes} />}
        {data && isAdmin && <AdminPanel />}
      </div>
    </div>
  );
}
