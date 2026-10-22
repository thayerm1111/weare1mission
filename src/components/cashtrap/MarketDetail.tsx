"use client";
import { useEffect, useState } from "react";
import type { ChartPoint } from "@/lib/cashtrap/chart";
import type { Zone } from "@/lib/cashtrap/zones";
import type { SignalRecord } from "@/lib/cashtrap/signals";
import type { DmiStatus } from "@/lib/cashtrap/dmi";
import type { Decision } from "@/lib/cashtrap/engine";
import type { Snapshot } from "@/lib/cashtrap/snapshot";
import type { SymbolSpec } from "@/lib/cashtrap/symbols";
import { MarketChart } from "./MarketChart";
import { CheckIcon, checklistRows, StatusBadge } from "./MarketCard";
import { usePoll } from "./useCashtrap";
import { C, countdown, fmt1, fmtPx, localDateTime, localTime, type Status } from "./theme";

type MarketPayload = {
  symbol: string; spec: SymbolSpec; points: ChartPoint[]; zones: Zone[];
  setups: Array<{ id: string; direction: "BUY" | "SELL"; exhaustion_t: string; status: string; reason: string | null; confirm_t: string | null; published: boolean | null; zone: Zone | null }>;
  signals: SignalRecord[]; decision: Decision | null; snapshot: Snapshot | null; dmi: DmiStatus; serverNow: number;
};

export function MarketDetail({ symbol, now }: { symbol: string; now: number }) {
  const [n, setN] = useState(120);
  useEffect(() => { if (typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches) setN(60); }, []);
  const { data, error } = usePoll<MarketPayload>(`/api/cashtrap/market?symbol=${symbol}&n=${n}`, 20_000, [symbol, n]);
  if (!data) return <div className="rounded-2xl border p-6 text-sm" style={{ borderColor: C.line, background: C.card, color: C.muted }}>{error ? `Could not load ${symbol}: ${error}` : `Loading ${symbol}…`}</div>;
  const spec = data.spec;
  const snap = data.snapshot;
  const d = data.decision;
  const v = d?.values ?? null;
  const sig = snap?.signal ?? null;
  const rows = checklistRows(snap?.direction ?? d?.leading ?? null, snap?.checklist ?? (d?.leading && d.checklist ? d.checklist[d.leading] : null));
  const zone = data.zones.find((z) => z.id === (d?.zoneId ?? snap?.armed?.zone?.id)) ?? null;

  return (
    <section className="rounded-2xl border" style={{ borderColor: C.line, background: C.card }}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: C.line }}>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold" style={{ color: C.ink }}>{spec.label}</h2>
          {snap && <StatusBadge status={snap.status as Status} />}
        </div>
        <div className="flex items-center gap-1 text-[12px]" role="group" aria-label="Chart range">
          {[60, 120, 288].map((k) => (
            <button key={k} type="button" onClick={() => setN(k)} className="rounded-full px-2.5 py-1" style={{ background: n === k ? C.blueSoft : "transparent", color: n === k ? C.blue : C.muted }}>{k === 288 ? "24h" : `${(k * 5) / 60}h`}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {data.points.length ? <MarketChart points={data.points} zones={data.zones} setups={data.setups} signals={data.signals} precision={spec.precision} dmi={data.dmi} now={now} highlightZoneIds={[d?.zoneId, snap?.armed?.zone?.id, sig?.zone?.id].filter((x): x is string => !!x)} /> : <p className="py-16 text-center text-sm" style={{ color: C.muted }}>No stored candles yet — the runner fills them on its first pass.</p>}
          <p className="mt-2 text-[11px]" style={{ color: C.faint }}>Times in your local time zone. Candles: {spec.feedSymbol} 5-minute OHLC from the reference feed (not a broker&apos;s prices). Hollow triangles: armed setups (not signals). Solid: published signals.</p>
        </div>
        <aside className="space-y-3 text-[13px]" style={{ color: C.ink }}>
          {sig && (sig.status === "published" || sig.status === "active") && (
            <div className="rounded-xl p-3" style={{ background: sig.direction === "CALL" ? C.greenSoft : C.redSoft }}>
              <p className="text-sm font-semibold">{sig.direction} · {sig.status === "active" ? "active" : "entry window open"}</p>
              {sig.status === "published" && <p>Reference entry by <b>{localTime(sig.entryDeadline, true)}</b> — <span className="font-mono">{countdown(sig.entryDeadline - now)}</span></p>}
              {sig.status === "active" && <p>Entry {fmtPx(sig.referencePrice, spec.precision)} at {localTime(sig.referenceAt, true)} · expires {localTime(sig.expiryAt, true)} — <span className="font-mono">{countdown((sig.expiryAt ?? now) - now)}</span></p>}
              <p className="mt-1 text-[11px]" style={{ color: C.muted }}>Your own entry and your broker&apos;s settlement can differ from this reference.</p>
            </div>
          )}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Why this status</p>
            <p className="mt-1 leading-snug">{snap?.reason ?? d?.reason ?? "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Conditions {snap?.direction ? `(${snap.direction === "BUY" ? "CALL" : "PUT"} side)` : ""}</p>
            <ul className="mt-1 space-y-1">{rows.map((r) => <li key={r.label} className="flex items-center gap-2"><CheckIcon state={r.state} />{r.label}</li>)}</ul>
            <p className="mt-1 text-[11px]" style={{ color: C.purple }}>{snap?.checklist ? `${snap.met}/5 met — confluence of related indicators, not a probability.` : ""}</p>
          </div>
          {v && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Last completed candle ({localTime(v.t)})</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[12px]">
                <dt style={{ color: C.muted }}>Close</dt><dd>{fmtPx(v.close, spec.precision)}</dd>
                <dt style={{ color: C.muted }}>Low / High</dt><dd>{fmtPx(v.low, spec.precision)} / {fmtPx(v.high, spec.precision)}</dd>
                <dt style={{ color: C.muted }}>BB lower</dt><dd>{fmtPx(v.bbLower, spec.precision)}</dd>
                <dt style={{ color: C.muted }}>BB upper</dt><dd>{fmtPx(v.bbUpper, spec.precision)}</dd>
                <dt style={{ color: C.muted }}>RSI(4)</dt><dd>{fmt1(v.rsi)}</dd>
                <dt style={{ color: C.muted }}>RSI SMA(4)</dt><dd>{fmt1(v.rsiMa)}</dd>
                <dt style={{ color: C.muted }}>Stoch %K</dt><dd>{fmt1(v.stochK)}</dd>
                <dt style={{ color: C.muted }}>DMI-Stoch</dt><dd>{fmt1(v.dmiStochPrev)} → {fmt1(v.dmiStoch)}</dd>
              </dl>
            </div>
          )}
          {zone && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Contributing zone</p>
              <p className="mt-1 font-mono text-[12px]">{zone.kind} {fmtPx(zone.lower, spec.precision)}–{fmtPx(zone.upper, spec.precision)} ({zone.origin})</p>
              <p className="text-[11px]" style={{ color: C.muted }}>Created {localDateTime(zone.createdAt)}{zone.halfWidth != null ? ` · half-width ${fmtPx(zone.halfWidth, spec.precision + 1)} (0.15 × ATR ${fmtPx(zone.atrAtCreation, spec.precision + 1)})` : ""} · {zone.touches} touch(es){zone.invalidatedAt ? ` · broken ${localDateTime(zone.invalidatedAt)}` : ""}</p>
            </div>
          )}
          <div className="rounded-xl p-3 text-[12px]" style={{ background: data.dmi.available ? C.blueSoft : C.redSoft }}>
            <p className="font-semibold">{data.dmi.label}</p>
            {data.dmi.notes.map((x) => <p key={x} className="mt-0.5" style={{ color: C.muted }}>{x}</p>)}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Recent setups</p>
            <ul className="mt-1 space-y-1 text-[12px]">
              {data.setups.slice(-6).reverse().map((s) => (
                <li key={s.id} style={{ color: C.muted }}><span style={{ color: s.direction === "BUY" ? C.green : C.red }}>{s.direction}</span> {localTime(Date.parse(s.exhaustion_t))} — {s.status}{s.reason ? `: ${s.reason}` : ""}</li>
              ))}
              {!data.setups.length && <li style={{ color: C.faint }}>None in this range.</li>}
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}
