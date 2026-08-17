"use client";

import { useState } from "react";
import { Gem, Loader2, ChevronDown } from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";
import { GenxFlow } from "./GenxFlow";

/**
 * GENX — flagship XAUUSD (Gold) decision engine, desktop portal edition.
 * Calls the SAME /api/genx endpoint the mobile app uses; every number is the
 * deterministic engine's, the AI writes only the market story. Dark-gold card so
 * GENX keeps its flagship identity inside the light portal.
 */
type Candle = { t: string; o: number; h: number; l: number; c: number };
type PathPt = { label: string; price: number | null; kind: string };
type Genx = {
  symbol: string; mode: string; market_regime: string;
  directional_bias: string; action: string; lifecycle: string;
  confidence_score: number;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop_loss: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  closest_support: number | null; closest_resistance: number | null; room_to_target_pips: number | null;
  market_structure: string; momentum: string; volatility: string;
  buyer_control: number; seller_control: number;
  bull_case_score: number; bear_case_score: number;
  expected_hold_minutes: [number, number];
  session: string; data_status: string; trigger_tf: string; context_tf: string;
  market_story: string[]; trade_reasoning: string[]; risk_factors: string[];
  invalidation_reason: string; trigger_condition: string; setup_type: string; engine_state: string;
  projected_path: PathPt[]; invalidation_price: number | null;
};
type Resp = { ok?: boolean; signal_id?: string | null; price?: number; data_status?: string; asOf?: string; genx?: Genx; candles?: Candle[]; error?: string; detail?: string; notConfigured?: string; balance?: number };

const MODES = [
  { id: "quick", label: "Quick", sub: "30–80 pips" },
  { id: "intraday", label: "Intraday", sub: "2–6 hrs" },
  { id: "swing", label: "Swing", sub: "Hours–days" },
] as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function actionLabel(a: string): string {
  switch (a) {
    case "BUY_NOW": return "BUY NOW";
    case "SELL_NOW": return "SELL NOW";
    case "BUY_LIMIT": return "BUY · LIMIT";
    case "SELL_LIMIT": return "SELL · LIMIT";
    case "BUY_STOP": return "BUY · STOP";
    case "SELL_STOP": return "SELL · STOP";
    case "WAIT_FOR_BUY_TRIGGER": return "WAIT · BUY SETUP";
    case "WAIT_FOR_SELL_TRIGGER": return "WAIT · SELL SETUP";
    default: return "WAIT";
  }
}
const confLabel = (c: number) => (c >= 74 ? "Strong" : c >= 62 ? "Building" : c >= 50 ? "Forming" : "Weak");
const sideOf = (a: string): "buy" | "sell" | "wait" =>
  a.startsWith("BUY") ? "buy" : a.startsWith("SELL") ? "sell" : a.includes("BUY") ? "buy" : a.includes("SELL") ? "sell" : "wait";
const fmtHold = (m: [number, number]) => {
  const f = (x: number) => (x >= 60 ? `${Math.round(x / 60)}h` : `${x}m`);
  return `${f(m[0])}–${f(m[1])}`;
};

/* ---------- projection chart ---------- */
/** Spread out label Y-positions so near-equal ones don't overlap. Order-preserving. */
function declutterY(ys: number[], minGap: number, top: number, bottom: number): number[] {
  const out = ys.slice();
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
  let prev = -Infinity;
  for (const i of order) { const v = Math.max(ys[i], prev + minGap); out[i] = v; prev = v; }
  const last = order[order.length - 1];
  const over = out[last] - bottom;
  if (over > 0) for (const i of order) out[i] -= over;
  const first = order[0];
  const under = top - out[first];
  if (under > 0) for (const i of order) out[i] += under;
  return out;
}

function GenxChart({ candles, g }: { candles: Candle[]; g: Genx }) {
  const cs = (candles || []).filter((c) => num(c.o) != null && num(c.h) != null && num(c.l) != null && num(c.c) != null).slice(-40);
  const path = (g.projected_path || []).filter((p) => num(p.price) != null) as { label: string; price: number; kind: string }[];
  if (cs.length < 4 && path.length < 2) return null;

  // Layout: candles + projection live in the plot; price labels get their own
  // right-hand gutter so they can never collide with the candles or each other.
  const W = 720, H = 264, padY = 22, padL = 10, gutterW = 78;
  const plotR = W - gutterW;
  const splitX = Math.round(padL + (plotR - padL) * 0.58);

  const levelsRaw = [
    { label: "R", price: num(g.closest_resistance), color: "#ff8fa0" },
    { label: "TP2", price: num(g.tp2), color: "#34d99a" },
    { label: "TP1", price: num(g.tp1), color: "#2ee88f" },
    { label: "Entry", price: num(g.entry), color: "#ffc24b" },
    { label: "S", price: num(g.closest_support), color: "#7fe6b5" },
    { label: "Stop", price: num(g.stop_loss), color: "#ff5d6c" },
  ].filter((l): l is { label: string; price: number; color: string } => l.price != null);

  const allPrices = [...cs.flatMap((c) => [c.h, c.l]), ...path.map((p) => p.price), ...levelsRaw.map((l) => l.price)];
  const min = Math.min(...allPrices), max = Math.max(...allPrices);
  const pad = ((max - min) || 1) * 0.06;
  const lo = min - pad, hi = max + pad, sp = (hi - lo) || 1;
  const y = (p: number) => padY + (1 - (p - lo) / sp) * (H - padY * 2);

  const n = cs.length;
  const cw = n ? (splitX - padL - 6) / n : 8;
  const bodyW = Math.max(2, Math.min(9, cw * 0.62));

  const pxs = path.length;
  const projX = (i: number) => splitX + (pxs > 1 ? (i / (pxs - 1)) * (plotR - splitX - 6) : 0);
  const projColor = g.directional_bias === "bullish" ? "#2ee88f" : g.directional_bias === "bearish" ? "#ff5d6c" : "#ffc24b";
  const poly = path.map((p, i) => `${projX(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");

  const labelY = declutterY(levelsRaw.map((l) => y(l.price)), 13, padY + 4, H - padY);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" style={{ maxHeight: 300 }} preserveAspectRatio="xMidYMid meet" role="img" aria-label="GENX price chart with projected path">
      {/* level lines (plot only) + decluttered labels in the right gutter */}
      {levelsRaw.map((l, i) => (
        <g key={`lv${i}`}>
          <line x1={padL} x2={plotR} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeWidth={1} strokeDasharray="2 6" opacity={0.22} />
          <line x1={plotR} x2={plotR + 7} y1={y(l.price)} y2={labelY[i]} stroke={l.color} strokeWidth={1} opacity={0.32} />
          <circle cx={plotR + 9} cy={labelY[i]} r={2} fill={l.color} />
          <text x={plotR + 14} y={labelY[i] + 3.2} fill={l.color} fontSize={9.5} opacity={0.95}>{l.label} {l.price}</text>
        </g>
      ))}
      {/* candles */}
      {cs.map((c, i) => {
        const x = padL + 2 + i * cw + cw / 2;
        const up = c.c >= c.o;
        const col = up ? "#2ee88f" : "#ff5d6c";
        const yo = y(c.o), yc = y(c.c);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} opacity={0.55} />
            <rect x={x - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(1, Math.abs(yc - yo))} rx={0.5} fill={col} opacity={0.9} />
          </g>
        );
      })}
      {/* now / split marker */}
      <line x1={splitX} x2={splitX} y1={padY} y2={H - padY} stroke="#ffffff" strokeWidth={1} strokeDasharray="2 6" opacity={0.1} />
      {/* projection */}
      {path.length > 1 && <polyline points={poly} fill="none" stroke={projColor} strokeWidth={2} strokeDasharray="5 4" opacity={0.9} />}
      {path.map((p, i) => {
        const px = projX(i), py = y(p.price);
        const anchor: "start" | "middle" | "end" = i === 0 ? "start" : i === path.length - 1 ? "end" : "middle";
        const tx = i === 0 ? px + 4 : i === path.length - 1 ? px - 2 : px;
        return (
          <g key={`p${i}`}>
            <circle cx={px} cy={py} r={3} fill={projColor} />
            <text x={tx} y={py - 9} fill={projColor} fontSize={9} textAnchor={anchor} opacity={0.95}>{p.label}</text>
          </g>
        );
      })}
      <text x={splitX + 4} y={H - 6} fill={projColor} fontSize={8.5} opacity={0.55}>Projected path →</text>
    </svg>
  );
}

/* ---------- level tile ---------- */
function LTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <p className="text-[10px] uppercase tracking-wide text-white/40">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${tone || "text-white"}`}>{value}</p>
      {sub && <p className="text-[11px] text-white/45">{sub}</p>}
    </div>
  );
}

export function GenxDesk() {
  const [mode, setMode] = useState<string>("quick");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  async function analyze() {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/genx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      const d: Resp = await r.json();
      if (d.notConfigured) { setErr("Gold market data isn’t configured on the server yet."); setRes(null); }
      else if (d.error === "insufficient_credits") { setErr(`Not enough credits to run GENX${typeof d.balance === "number" ? ` (balance ${d.balance})` : ""}.`); setRes(null); try { window.dispatchEvent(new Event("open-credits-flyer")); } catch { /* ignore */ } }
      else if (!r.ok || !d.ok) { setErr(d.detail || d.error || "GENX couldn’t read Gold right now — try again shortly."); setRes(null); }
      else setRes(d);
    } catch { setErr("Couldn’t reach the server."); }
    finally { setLoading(false); }
  }

  const g = res?.genx;
  const side = g ? sideOf(g.action) : "wait";
  const hasPlan = g ? num(g.entry) != null && num(g.stop_loss) != null : false;
  const cardTone = side === "buy" ? "border-emerald-400/30" : side === "sell" ? "border-red-400/30" : "border-amber-400/30";
  const actTone = side === "buy" ? "text-emerald-400" : side === "sell" ? "text-red-400" : "text-amber-300";

  return (
    <div className="rounded-2xl border border-amber-400/20 bg-[#0b0d14] p-5 text-white sm:p-6" style={{ backgroundImage: "radial-gradient(120% 80% at 0% 0%, rgba(255,194,75,0.06), transparent 60%)" }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300/80"><Gem className="h-3.5 w-3.5" /> Flagship · Gold intelligence engine</p>
          <h1 className="mt-1 bg-gradient-to-r from-amber-200 via-amber-400 to-amber-200 bg-clip-text font-serif text-4xl font-black tracking-tight text-transparent">GENX</h1>
          <p className="mt-1 text-sm text-white/50">Ask one question — “what should I do on Gold right now?” — and get a straight answer with the plan behind it.</p>
        </div>
        {res?.price != null && (
          <div className="text-right">
            <p className="text-2xl font-bold tabular-nums">${res.price}</p>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${res.data_status === "live" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/50"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${res.data_status === "live" ? "bg-emerald-400" : "bg-white/40"}`} /> {res.data_status === "live" ? "LIVE" : "REFERENCE"}
            </span>
          </div>
        )}
      </div>

      {/* mode selector */}
      <div className="mt-5 grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${mode === m.id ? "border-amber-400/50 bg-amber-400/[0.1]" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}>
            <p className="text-sm font-bold text-white">{m.label}</p>
            <p className="text-[11px] text-white/45">{m.sub}</p>
          </button>
        ))}
      </div>

      <button onClick={analyze} disabled={loading} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-300 to-amber-500 px-4 py-3 text-sm font-bold text-[#1a1204] transition hover:from-amber-200 hover:to-amber-400 disabled:opacity-60">
        {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing Gold…</> : res ? "Re-analyze Gold" : "Analyze Gold now"}
      </button>
      <p className="mt-1.5 text-center text-[11px] text-white/40">{CREDIT_COST.genx} credits per read</p>
      {loading && <p className="mt-2 text-center text-xs text-white/40">◆ Reading live Gold — structure, momentum, levels, liquidity…</p>}
      {err && <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300">{err}</div>}

      {g && (
        <>
          <div className={`mt-5 rounded-2xl border ${cardTone} bg-white/[0.02] p-5`}>
            <p className={`text-3xl font-black tracking-tight ${actTone}`}>{actionLabel(g.action)}</p>
            <p className="mt-1 text-sm text-white/60">
              <span className="text-lg font-bold text-white">{g.confidence_score}</span><span className="text-white/40">/100</span> · {confLabel(g.confidence_score)}
            </p>
            <p className="mt-1 text-[13px] text-white/50">
              Bias: {g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral"} · {g.market_structure} · {g.session}
            </p>

            {hasPlan ? (
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <LTile label="Entry" value={g.entry_low != null && g.entry_high != null ? `${g.entry_low}–${g.entry_high}` : String(g.entry)} />
                <LTile label="Stop loss" value={String(g.stop_loss)} sub={g.stop_pips != null ? `${g.stop_pips}p` : undefined} tone="text-red-300" />
                {g.tp1 != null && <LTile label="TP1" value={String(g.tp1)} sub={g.tp1_pips != null ? `+${g.tp1_pips}p` : undefined} tone="text-emerald-300" />}
                {g.tp2 != null && <LTile label="TP2" value={String(g.tp2)} sub={g.tp2_pips != null ? `+${g.tp2_pips}p` : undefined} tone="text-emerald-300" />}
                {g.tp3 != null && <LTile label="TP3" value={String(g.tp3)} sub={g.tp3_pips != null ? `+${g.tp3_pips}p` : undefined} tone="text-emerald-300" />}
                <LTile label="Expected hold" value={fmtHold(g.expected_hold_minutes)} />
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <LTile label="Preferred" value={g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral"} />
                <LTile label="Support" value={g.closest_support != null ? String(g.closest_support) : "—"} tone="text-emerald-300" />
                <LTile label="Resistance" value={g.closest_resistance != null ? String(g.closest_resistance) : "—"} tone="text-red-300" />
                <LTile label="Room" value={g.room_to_target_pips != null ? `${g.room_to_target_pips}p` : "—"} />
              </div>
            )}
            {g.trigger_condition && <p className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white/60">{g.trigger_condition}</p>}
          </div>

          <GenxFlow candles={res?.candles || []} g={g} price={res?.price ?? null} live={res?.data_status === "live"} />

          {g.market_story?.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">What GENX sees</h3>
              <div className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-white/75">
                {g.market_story.map((s, i) => <p key={i}>{s}</p>)}
              </div>
            </section>
          )}

          {g.trade_reasoning?.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">Why GENX likes it</h3>
              <ul className="mt-2 space-y-1 text-[13px] text-white/75">
                {g.trade_reasoning.map((s, i) => <li key={i} className="flex gap-2"><span className="text-amber-400">›</span>{s}</li>)}
              </ul>
            </section>
          )}

          <button onClick={() => setOpen((o) => !o)} className="mt-5 flex items-center gap-1.5 text-[12px] font-semibold text-white/50 hover:text-white/80">
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} /> Full breakdown
          </button>
          {open && (
            <div className="mt-3 space-y-4">
              <div className="grid grid-cols-3 gap-2.5">
                <LTile label="Structure" value={g.market_structure} />
                <LTile label="Momentum" value={g.momentum} />
                <LTile label="Volatility" value={g.volatility} />
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-white/50"><span>Buyers {g.buyer_control}%</span><span>Sellers {g.seller_control}%</span></div>
                <div className="mt-1 flex h-3 overflow-hidden rounded-full bg-red-500/30">
                  <div className="h-full bg-emerald-400/70" style={{ width: `${g.buyer_control}%` }} />
                </div>
              </div>
              {g.invalidation_reason && <p className="text-[13px] text-white/60"><span className="font-semibold text-white/75">Invalidation:</span> {g.invalidation_reason}</p>}
              {g.risk_factors?.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Watch for</h3>
                  <ul className="mt-1.5 space-y-1 text-[13px] text-white/70">
                    {g.risk_factors.map((s, i) => <li key={i} className="flex gap-2"><span className="text-white/30">•</span>{s}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="mt-5 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/35">
            Every price, level and score is computed by GENX’s deterministic engine from live Gold data — the AI only writes the plain-English read. Educational only; not financial advice. You approve every action on your own account.
          </p>
        </>
      )}
    </div>
  );
}
