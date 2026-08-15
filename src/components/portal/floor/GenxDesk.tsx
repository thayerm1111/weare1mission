"use client";

import { useState } from "react";
import { Gem, Loader2, ChevronDown } from "lucide-react";

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
function GenxChart({ candles, g }: { candles: Candle[]; g: Genx }) {
  const cs = (candles || []).filter((c) => num(c.o) != null && num(c.h) != null && num(c.l) != null && num(c.c) != null).slice(-40);
  const path = (g.projected_path || []).filter((p) => num(p.price) != null) as { label: string; price: number; kind: string }[];
  if (cs.length < 4 && path.length < 2) return null;

  const W = 680, H = 240, padY = 16, splitX = Math.round(W * 0.56);
  const levels = [g.closest_support, g.closest_resistance, g.entry, g.stop_loss, g.tp1, g.tp2, g.tp3].map(num).filter((n): n is number => n != null);
  const allPrices = [...cs.flatMap((c) => [c.h, c.l]), ...path.map((p) => p.price), ...levels];
  const min = Math.min(...allPrices), max = Math.max(...allPrices);
  const span = max - min || 1;
  const y = (p: number) => padY + (1 - (p - min) / span) * (H - padY * 2);

  const n = cs.length;
  const cw = n ? (splitX - 8) / n : 8;
  const bodyW = Math.max(2, cw * 0.6);

  // projection polyline: start at split from last close, out to right edge
  const pxs = path.length;
  const projX = (i: number) => splitX + (pxs > 1 ? (i / (pxs - 1)) * (W - splitX - 14) : 0);
  const projColor = g.directional_bias === "bullish" ? "#2ee88f" : g.directional_bias === "bearish" ? "#ff5d6c" : "#ffc24b";
  const poly = path.map((p, i) => `${projX(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");

  const lvlLine = (p: number | null, color: string, label: string, key: string) =>
    p == null ? null : (
      <g key={key}>
        <line x1={0} x2={W} y1={y(p)} y2={y(p)} stroke={color} strokeWidth={1} strokeDasharray="3 4" opacity={0.5} />
        <text x={4} y={y(p) - 3} fill={color} fontSize={9} opacity={0.9}>{label} {p}</text>
      </g>
    );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" style={{ maxHeight: 260 }} preserveAspectRatio="xMidYMid meet">
      {lvlLine(g.closest_resistance, "#ff8fa0", "R", "r")}
      {lvlLine(g.closest_support, "#7fe6b5", "S", "s")}
      {lvlLine(g.entry, "#ffc24b", "Entry", "e")}
      {lvlLine(g.stop_loss, "#ff5d6c", "Stop", "sl")}
      {lvlLine(g.tp1, "#2ee88f", "TP1", "t1")}
      {/* candles */}
      {cs.map((c, i) => {
        const x = 4 + i * cw + cw / 2;
        const up = c.c >= c.o;
        const col = up ? "#2ee88f" : "#ff5d6c";
        const yo = y(c.o), yc = y(c.c);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} opacity={0.7} />
            <rect x={x - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(1, Math.abs(yc - yo))} fill={col} opacity={0.85} />
          </g>
        );
      })}
      {/* split line */}
      <line x1={splitX} x2={splitX} y1={padY} y2={H - padY} stroke="#ffffff" strokeWidth={1} strokeDasharray="2 4" opacity={0.15} />
      {/* projection */}
      {path.length > 1 && <polyline points={poly} fill="none" stroke={projColor} strokeWidth={2} strokeDasharray="5 4" />}
      {path.map((p, i) => (
        <g key={`p${i}`}>
          <circle cx={projX(i)} cy={y(p.price)} r={3} fill={projColor} />
          <text x={projX(i)} y={y(p.price) - 7} fill={projColor} fontSize={9} textAnchor="middle">{p.label}</text>
        </g>
      ))}
      <text x={splitX + 6} y={H - 6} fill={projColor} fontSize={9} opacity={0.8}>GENX projected path</text>
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
      else if (d.error === "insufficient_credits") { setErr(`Not enough credits to run GENX${typeof d.balance === "number" ? ` (balance ${d.balance})` : ""}.`); setRes(null); }
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

          <GenxChart candles={res?.candles || []} g={g} />

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
