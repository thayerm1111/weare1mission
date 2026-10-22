"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { C } from "./theme";

type Note = { key: string; label: string; origin: "owner-default" | "implementation" | "broker-required" };
const ORIGIN: Record<Note["origin"], { label: string; fg: string; bg: string }> = {
  "owner-default": { label: "your listed default", fg: C.blue, bg: C.blueSoft },
  implementation: { label: "implementation choice", fg: C.purple, bg: C.purpleSoft },
  "broker-required": { label: "broker setting needed", fg: C.amber, bg: C.amberSoft },
};

/** Your screenshot settings (fixed) next to every assumption the implementation makes (configurable). */
export function RulesPanel({ screenshot, notes, assumptions, strategyVersion, configVersion, dmiNotes }: { screenshot: Record<string, unknown>; notes: Note[]; assumptions: Record<string, unknown>; strategyVersion: string; configVersion: string; dmiNotes: string[] }) {
  const [open, setOpen] = useState(false);
  const s = screenshot as {
    bollinger: { length: number; stdDevMult: number }; rsi: { length: number; upper: number; lower: number }; rsiMa: { length: number };
    stochastic: { kLength: number; kSmoothing: number; dSmoothing: number; upper: number; middle: number; lower: number }; dmiStochastic: { dmiLength: number; stoLength: number };
  };
  const a = assumptions as { expiry?: { mode: string; durationSec?: number }; payoutRate?: number | null; tieRule?: string };
  return (
    <section className="rounded-2xl border" style={{ borderColor: C.line, background: C.card }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open}>
        <span className="text-base font-semibold" style={{ color: C.ink }}>Rules, settings and assumptions</span>
        <span className="inline-flex items-center gap-2 text-[11px]" style={{ color: C.faint }}>{strategyVersion} · {configVersion}<ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} /></span>
      </button>
      {open && (
        <div className="grid gap-4 border-t p-4 text-[13px] md:grid-cols-2" style={{ borderColor: C.line, color: C.ink }}>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Your screenshot settings (fixed)</p>
            <ul className="mt-2 space-y-1">
              <li>Bollinger Bands {s.bollinger.length}, SMA basis, close, ×{s.bollinger.stdDevMult}, offset 0</li>
              <li>RSI {s.rsi.length} on close, levels {s.rsi.upper}/{s.rsi.lower}; SMA({s.rsiMa.length}) line shown separately; divergence off; RSI BB filter off</li>
              <li>Stochastic {s.stochastic.kLength}/{s.stochastic.kSmoothing}/{s.stochastic.dSmoothing} (ordinary, not Stochastic RSI), levels {s.stochastic.upper}/{s.stochastic.middle}/{s.stochastic.lower}</li>
              <li>DMI-Stochastic DMIlength {s.dmiStochastic.dmiLength}, Stolength {s.dmiStochastic.stoLength}</li>
              <li>5-minute candles; completed candles only for actionable signals</li>
            </ul>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>The setup</p>
            <p className="mt-1 leading-snug" style={{ color: C.muted }}>
              Exhaustion candle (at its close): CALL — low below the lower band, RSI(4) &lt; 20, %K &lt; 20, range touching a support zone and closing at or above its lower edge.
              PUT — the mirror at resistance. It arms a setup; a fresh DMI B (CALL) or S (PUT) on that candle or the next two confirms it. Cancelled by an opposite DMI event, a close through the zone,
              an opposite exhaustion, or bad data. No engulfing, crossover, trend filter or close-back-inside rule.
            </p>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>DMI-Stochastic</p>
            {dmiNotes.map((x) => <p key={x} className="mt-1 leading-snug" style={{ color: C.muted }}>{x}</p>)}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Assumptions (configurable — not confirmed by you)</p>
            <ul className="mt-2 space-y-1.5">
              {notes.map((n) => (
                <li key={n.key} className="leading-snug">
                  <span className="mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: ORIGIN[n.origin].fg, background: ORIGIN[n.origin].bg }}>{ORIGIN[n.origin].label}</span>
                  {n.label}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px]" style={{ color: C.muted }}>
              In force now: expiry {a.expiry?.mode === "duration" ? `${a.expiry.durationSec}s from the reference entry (provisional)` : "fixed clock time"} · tie rule {a.tieRule} (assumed) · payout {a.payoutRate == null ? "not set" : `${Math.round(a.payoutRate * 100)}%`}.
              The chart timeframe (5 minutes) and the contract expiry are separate settings. No broker&apos;s expiry rules have been confirmed, so no signal is labelled broker-compatible.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
