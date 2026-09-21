"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Gauge, Layers, Radio, Target } from "lucide-react";

/* ============================================================================
   COMMAND CENTER XAUUSD — the market read, as the engine sees it.

   Institutional terminal, not a casino: no confetti, no fake motion, nothing on
   screen that the engine did not actually measure. Where a number is missing,
   the panel says so instead of drawing a zero.
   ========================================================================== */

type Tf = { state: string; slope: number | null; efficiency: number | null; atr: number | null; rsi: number | null; sequence: string | null; positionInRange: number | null };
type Level = { price: number; kind: string; label: string; distanceAtr?: number };
type Snap = {
  live: boolean; open?: boolean; reason?: string; ageSeconds?: number; at?: string; price?: number; bid?: number | null; ask?: number | null;
  spread?: number | null; session?: string; regime?: string; pressure?: number;
  timeframes?: Record<string, Tf>; levels?: Level[]; warnings?: string[];
};

const C = {
  panel: "#0B1017", raised: "#121A24", line: "rgba(255,255,255,0.08)", text: "#EAF1F8",
  mut: "rgba(234,241,248,0.60)", mut2: "rgba(234,241,248,0.38)",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", cyan: "#22D3EE", gold: "#FFC24B",
};

const TF_ORDER = ["1d", "4h", "1h", "15m", "5m", "1m"];
const pretty = (s?: string | null) => (s ? s.replace(/_/g, " ") : "—");
const toneOf = (state: string) =>
  /strong_up|uptrend|bullish/.test(state) ? C.green : /strong_down|downtrend|bearish/.test(state) ? C.red
  : /breakout|expansion/.test(state) ? C.gold : /compression|range/.test(state) ? C.cyan : C.mut;

export function CommandCenter({ className = "" }: { className?: string }) {
  const [s, setS] = useState<Snap | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch("/api/command-center/snapshot", { cache: "no-store" }); if (r.ok && alive) setS(await r.json()); } catch { /* keeps the last read */ }
    };
    void load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!s) return <div className={`h-64 animate-pulse rounded-2xl ${className}`} style={{ background: C.panel }} />;

  const warnings = s.warnings ?? [];
  const pressure = s.pressure ?? 0;
  const bull = Math.round(50 + pressure / 2);

  return (
    <section className={`overflow-hidden rounded-2xl border ${className}`} style={{ borderColor: C.line, background: C.panel, color: C.text }}>
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: C.line }}>
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `${C.gold}1a`, color: C.gold }}><Layers className="h-4 w-4" /></span>
          <div>
            <p className="text-[13px] font-black tracking-tight">COMMAND CENTER <span style={{ color: C.gold }}>XAUUSD</span></p>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Atlas · market read</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {s.price != null && (
            <div className="text-right">
              <p className="text-xl font-black tabular-nums leading-none">{s.price.toFixed(2)}</p>
              <p className="text-[10px]" style={{ color: C.mut2 }}>
                {s.bid != null && s.ask != null ? `${s.bid.toFixed(2)} / ${s.ask.toFixed(2)}` : "single feed"}
                {s.spread != null ? ` · spread ${s.spread.toFixed(2)}` : ""}
              </p>
            </div>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold"
            style={{ background: s.live ? `${C.green}1a` : `${C.amber}1a`, color: s.live ? C.green : C.amber }}>
            <Radio className="h-3 w-3" /> {s.live ? `LIVE · ${s.ageSeconds}s` : s.open === false ? "MARKET CLOSED" : "NO LIVE READ"}
          </span>
        </div>
      </div>

      {!s.live && s.reason && (
        <div className="px-4 py-3 text-[12px]" style={{ color: C.mut }}>{s.reason}</div>
      )}

      {s.live && (
        <div className="grid gap-px" style={{ background: C.line, gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
          {/* session + regime */}
          <div className="p-4" style={{ background: C.panel }}>
            <p className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}><Activity className="h-3.5 w-3.5" /> Market</p>
            <p className="text-[15px] font-black capitalize">{pretty(s.regime)}</p>
            <p className="mt-0.5 text-[12px] capitalize" style={{ color: C.mut }}>{pretty(s.session)} session</p>

            <p className="mt-4 mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Pressure</p>
            <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.07)" }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, Math.min(98, bull))}%`, background: pressure >= 0 ? C.green : C.red }} />
            </div>
            <p className="mt-1.5 text-[11px]" style={{ color: C.mut }}>
              {bull}% buyers · {100 - bull}% sellers
              <span style={{ color: C.mut2 }}> — estimated from closes, wicks and momentum, not order flow</span>
            </p>
          </div>

          {/* timeframe matrix */}
          <div className="p-4" style={{ background: C.panel }}>
            <p className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}><Gauge className="h-3.5 w-3.5" /> Timeframes</p>
            <div className="space-y-1.5">
              {TF_ORDER.filter((tf) => s.timeframes?.[tf]).map((tf) => {
                const v = s.timeframes![tf];
                return (
                  <div key={tf} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="w-10 font-bold tabular-nums" style={{ color: C.mut }}>{tf}</span>
                    <span className="flex-1 truncate font-semibold capitalize" style={{ color: toneOf(v.state) }}>{pretty(v.state)}</span>
                    <span className="tabular-nums text-[11px]" style={{ color: C.mut2 }}>
                      {v.efficiency != null ? `eff ${(v.efficiency * 100).toFixed(0)}%` : ""}
                    </span>
                  </div>
                );
              })}
              {!TF_ORDER.some((tf) => s.timeframes?.[tf]) && <p className="text-[12px]" style={{ color: C.mut2 }}>No timeframe has enough closed bars yet.</p>}
            </div>
          </div>

          {/* levels */}
          <div className="p-4" style={{ background: C.panel }}>
            <p className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}><Target className="h-3.5 w-3.5" /> Nearest levels</p>
            <div className="space-y-1.5">
              {(s.levels ?? []).slice(0, 6).map((l, i) => (
                <div key={`${l.kind}-${i}`} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="truncate" style={{ color: C.mut }}>{l.label}</span>
                  <span className="tabular-nums font-semibold">{l.price.toFixed(2)}</span>
                  <span className="w-14 text-right tabular-nums text-[11px]" style={{ color: C.mut2 }}>{l.distanceAtr != null ? `${l.distanceAtr} ATR` : ""}</span>
                </div>
              ))}
              {!(s.levels ?? []).length && <p className="text-[12px]" style={{ color: C.mut2 }}>No levels mapped yet.</p>}
            </div>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="border-t px-4 py-2.5" style={{ borderColor: C.line, background: "rgba(251,191,36,0.05)" }}>
          <p className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.amber }}><AlertTriangle className="h-3.5 w-3.5" /> Atlas is flagging</p>
          <ul className="space-y-0.5">
            {warnings.slice(0, 4).map((w, i) => <li key={i} className="text-[11.5px]" style={{ color: C.mut }}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5" style={{ borderColor: C.line }}>
        <span className="text-[10px]" style={{ color: C.mut2 }}>
          ATLAS reads the market here. Trading lives in the full Command Center, on accounts you connect and authorise.
        </span>
        <a href="/command-center"
          className="shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em]"
          style={{ background: `${C.gold}1a`, color: C.gold, border: `1px solid ${C.gold}44`, textDecoration: "none" }}>
          Open ATLAS →
        </a>
      </div>
    </section>
  );
}
