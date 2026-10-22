"use client";
import { useState } from "react";
import type { SignalRecord } from "@/lib/cashtrap/signals";
import { SYMBOL_SPECS, type CashtrapSymbol } from "@/lib/cashtrap/symbols";
import { usePoll } from "./useCashtrap";
import { C, fmtPx, localDateTime, localTime } from "./theme";

type SimRun = { id: string; params: { symbols: string[]; weeks: number; payouts: number[] }; report: { outcomeBasis?: string; bySymbol?: Record<string, unknown>; configVersion?: string; strategyVersion?: string } | null; signals: Record<string, Array<{ d: string; setup: number; conf: number; pub: number; entry: number | null; entryAt: number | null; exp: number | null; settle: number | null; result: string }>> | null; finished_at: string | null };
type HistoryPayload = { referenceFeed: SignalRecord[]; brokerVerified: SignalRecord[]; brokerNote: string; simulated: SimRun | null; setups: Array<{ id: string; symbol: string; direction: string; exhaustion_t: string; status: string; reason: string | null; published: boolean | null }> };

const RESULT_COLOR: Record<string, string> = { win: C.green, loss: C.red, tie: C.muted, unresolved: C.amber, missed: C.amber, pending: C.blue };

export function HistoryPanel() {
  const [tab, setTab] = useState<"reference" | "simulated" | "broker" | "setups">("reference");
  const { data, error } = usePoll<HistoryPayload>("/api/cashtrap/history?limit=150", 60_000);
  const tabs: Array<[typeof tab, string]> = [["reference", "Reference feed (live)"], ["simulated", "Simulated (replay)"], ["broker", "Broker-verified"], ["setups", "Setups"]];
  return (
    <section className="rounded-2xl border" style={{ borderColor: C.line, background: C.card }}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: C.line }}>
        <h2 className="text-base font-semibold" style={{ color: C.ink }}>Signal history</h2>
        <div className="flex flex-wrap gap-1 text-[12px]" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className="rounded-full px-3 py-1" style={{ background: tab === k ? C.purpleSoft : "transparent", color: tab === k ? C.purple : C.muted }}>{label}</button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto p-4">
        {!data ? <p className="text-sm" style={{ color: C.muted }}>{error ? `Could not load history: ${error}` : "Loading…"}</p>
          : tab === "reference" ? <SignalTable rows={data.referenceFeed} empty="No live signals yet." note="Reference-feed records: the entry and settlement are prices from the market-data feed, not a broker. Your own entry and your broker's settlement may differ." />
          : tab === "broker" ? <p className="text-sm" style={{ color: C.muted }}>{data.brokerNote}</p>
          : tab === "simulated" ? <SimTable run={data.simulated} />
          : <SetupTable rows={data.setups} />}
      </div>
    </section>
  );
}

function SignalTable({ rows, empty, note }: { rows: SignalRecord[]; empty: string; note: string }) {
  if (!rows.length) return <p className="text-sm" style={{ color: C.muted }}>{empty} <span style={{ color: C.faint }}>{note}</span></p>;
  return (
    <>
      <table className="w-full min-w-[860px] text-left text-[12px]" style={{ color: C.ink }}>
        <thead style={{ color: C.faint }}><tr>{["Published", "Market", "Dir.", "Setup candle", "Confirmed", "Entry window", "Reference entry", "Expiry", "Settlement", "Result", "Payout", "Version"].map((h) => <th key={h} className="whitespace-nowrap pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((s) => {
            const p = SYMBOL_SPECS[s.symbol as CashtrapSymbol]?.precision ?? 5;
            return (
              <tr key={s.dedupeKey} className="border-t" style={{ borderColor: C.line }}>
                <td className="whitespace-nowrap py-1.5 pr-3">{localDateTime(s.publishedAt)}</td>
                <td className="pr-3">{s.symbol}</td>
                <td className="pr-3 font-semibold" style={{ color: s.direction === "CALL" ? C.green : C.red }}>{s.direction}</td>
                <td className="whitespace-nowrap pr-3">{localTime(s.setupCandleT)}</td>
                <td className="whitespace-nowrap pr-3">{localTime(s.confirmedAt)}</td>
                <td className="whitespace-nowrap pr-3">{localTime(s.entryWindowStart, true)}–{localTime(s.entryDeadline, true)}</td>
                <td className="whitespace-nowrap pr-3 font-mono">{fmtPx(s.referencePrice, p)}{s.referenceAt ? ` @ ${localTime(s.referenceAt, true)}` : ""}</td>
                <td className="whitespace-nowrap pr-3">{s.expiryMode === "duration" ? `${s.expiryDurationSec}s` : "fixed"}{s.expiryAt ? ` → ${localTime(s.expiryAt, true)}` : ""}</td>
                <td className="whitespace-nowrap pr-3 font-mono">{fmtPx(s.settlementPrice, p)}</td>
                <td className="pr-3 font-semibold" style={{ color: RESULT_COLOR[s.result] ?? C.ink }}>{s.result}</td>
                <td className="pr-3 font-mono">{s.payout == null ? "—" : s.payout.toFixed(2)}</td>
                <td className="whitespace-nowrap pr-3" style={{ color: C.faint }}>{s.strategyVersion} · {s.configVersion}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px]" style={{ color: C.faint }}>{note} Payout is shown only when a broker payout has been set.</p>
    </>
  );
}

function SimTable({ run }: { run: SimRun | null }) {
  if (!run) return <p className="text-sm" style={{ color: C.muted }}>No replay has been run yet. Admins can queue one below.</p>;
  const all = Object.entries(run.signals ?? {}).flatMap(([sym, list]) => list.map((s) => ({ sym, ...s }))).sort((a, b) => b.pub - a.pub).slice(0, 200);
  return (
    <>
      <p className="mb-2 text-[12px]" style={{ color: C.muted }}>Simulated records from the replay finished {run.finished_at ? localDateTime(Date.parse(run.finished_at)) : "—"} ({run.report?.strategyVersion} · {run.report?.configVersion}). {run.report?.outcomeBasis}</p>
      <table className="w-full min-w-[640px] text-left text-[12px]" style={{ color: C.ink }}>
        <thead style={{ color: C.faint }}><tr>{["Market", "Dir.", "Setup candle", "Confirmed", "Entry (proxy)", "Settlement (proxy)", "Result"].map((h) => <th key={h} className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {all.map((s, i) => {
            const p = SYMBOL_SPECS[s.sym as CashtrapSymbol]?.precision ?? 5;
            return (
              <tr key={`${s.sym}-${s.conf}-${i}`} className="border-t" style={{ borderColor: C.line }}>
                <td className="py-1.5 pr-3">{s.sym}</td>
                <td className="pr-3 font-semibold" style={{ color: s.d === "CALL" ? C.green : C.red }}>{s.d}</td>
                <td className="whitespace-nowrap pr-3">{localDateTime(s.setup)}</td>
                <td className="whitespace-nowrap pr-3">{localTime(s.conf)}</td>
                <td className="pr-3 font-mono">{fmtPx(s.entry, p)}</td>
                <td className="pr-3 font-mono">{fmtPx(s.settle, p)}</td>
                <td className="pr-3 font-semibold" style={{ color: RESULT_COLOR[s.result] ?? C.ink }}>{s.result}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function SetupTable({ rows }: { rows: HistoryPayload["setups"] }) {
  if (!rows.length) return <p className="text-sm" style={{ color: C.muted }}>No setups yet.</p>;
  return (
    <table className="w-full min-w-[640px] text-left text-[12px]" style={{ color: C.ink }}>
      <thead style={{ color: C.faint }}><tr>{["Exhaustion candle", "Market", "Dir.", "Status", "Why"].map((h) => <th key={h} className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id} className="border-t" style={{ borderColor: C.line }}>
            <td className="whitespace-nowrap py-1.5 pr-3">{localDateTime(Date.parse(s.exhaustion_t))}</td>
            <td className="pr-3">{s.symbol}</td>
            <td className="pr-3" style={{ color: s.direction === "BUY" ? C.green : C.red }}>{s.direction}</td>
            <td className="pr-3">{s.status}</td>
            <td className="pr-3" style={{ color: C.muted }}>{s.reason ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
