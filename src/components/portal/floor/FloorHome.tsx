"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Filter, Zap, Clock, ChevronRight, Maximize2, X, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { LIVE_URL, CALLS } from "@/lib/liveCalls";

/* ============================================================================
   THE FLOOR — live trading command center (desktop portal).
   Every number is real:
     • Stat strip     → /api/flow/stats (net pips, win rate, plays, today counts)
     • Setup Forming  → /api/floor/setup (current GENX gold setup + XAUUSD candles)
     • Market Intel   → /api/floor/intel (economic calendar) + live desk activity
     • GENX Results / FLOW Performance / Recent Trades → /api/flow/stats
   The bottom market ticker is provided by the FloorWorkspace shell.
   ========================================================================== */

const C = {
  base: "#0A0E13", panel: "#0E141C", raised: "#131A24", line: "rgba(255,255,255,0.07)",
  lineSoft: "rgba(255,255,255,0.045)", text: "#EAF1F8", mut: "rgba(234,241,248,0.60)",
  mut2: "rgba(234,241,248,0.40)", cyan: "#22D3EE", blue: "#3B82F6", violet: "#7C3AED",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", gold: "#FFC24B",
};

type GoldRec = { symbol: string; side: string; outcome: string; win: boolean; hitTp: number; pips: number | null; at: string };
type FlowRec = { symbol: string; side: string; outcome: string; win: boolean; pips: number | null; at: string };
type FlowStats = {
  pipsNet?: number; pips?: number; winRate?: number | null; wins?: number; trades?: number;
  liveOpen?: number; plays7d?: number;
  gold?: { wins: number; losses: number; pips: number; winRate: number | null; trades: number };
  forex?: { wins: number; stops: number; pips: number; winRate: number | null; trades: number; open: number };
  recent?: FlowRec[]; goldRecent?: GoldRec[]; forexRecent?: FlowRec[]; error?: string;
};
type Candle = { t: string; o: number; h: number; l: number; c: number };
/** The GENX read (buildGenx output) — same object the app's Market Flow renders. */
type GenxRead = {
  action?: string; directional_bias?: string; momentum?: string; session?: string;
  market_regime?: string; market_structure?: string; confidence_score?: number;
  entry?: number | null; entry_low?: number | null; entry_high?: number | null;
  stop_loss?: number | null; tp1?: number | null; tp2?: number | null; tp3?: number | null;
  tp1_pips?: number | null; tp2_pips?: number | null; stop_pips?: number | null;
  closest_support?: number | null; closest_resistance?: number | null; invalidation_price?: number | null;
  invalidation_reason?: string; trigger_condition?: string;
  buyer_control?: number; seller_control?: number;
  expected_hold_minutes?: [number, number]; projected_path?: { label: string; price: number | null; kind: string }[];
  trade_reasoning?: string[];
};
type SetupPayload = { g: GenxRead | null; candles: Candle[]; price: number | null; session: string; mode: string; asOf?: string; error?: string };
type IntelEvent = { time: string; ts: number; headline: string; impact: "HIGH" | "MED" | "LOW"; assets: string[]; when: string; ccy: string; forecast: string; previous: string };
type IntelPayload = { featured: IntelEvent | null; events: IntelEvent[] };

const genxLong = (d: string) => /bull|long|buy/i.test(String(d || ""));
const short = (s: string) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
function ago(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "now"; if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function clockTime(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  try { return new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true }); } catch { return ""; }
}

function useCountUp(target: number, duration = 850) {
  const [v, setV] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    let raf = 0; const from = prev.current; const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick); else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  return now;
}

/* session state (mirrors sessionNow in genxCompute, client-side) */
function hourIn(tz: string, d: Date) {
  try { const s = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return h === 24 ? 0 : h; } catch { return d.getUTCHours(); }
}
function sessions(d: Date | null) {
  if (!d) return { ny: false, london: false };
  const lh = hourIn("Europe/London", d), nh = hourIn("America/New_York", d);
  return { london: lh >= 7 && lh < 16, ny: nh >= 8 && nh < 17 };
}

/* ============================================================================ */

export function FloorHome({ onGo }: { onGo: (view: string) => void }) {
  const [flow, setFlow] = useState<FlowStats | null>(null);
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [intel, setIntel] = useState<IntelPayload | null>(null);
  const [setupMode, setSetupMode] = useState<"quick" | "intraday" | "swing">("intraday");
  const now = useClock();
  const nowIso = now ? now.toISOString() : "";

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch("/api/flow/stats", { cache: "no-store" }); if (r.ok && alive) setFlow((await r.json()) as FlowStats); } catch { /* degrades */ }
      try { const r = await fetch("/api/floor/intel", { cache: "no-store" }); if (r.ok && alive) setIntel((await r.json()) as IntelPayload); } catch { /* degrades */ }
    };
    void load();
    const iv = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch(`/api/floor/setup?mode=${setupMode}`, { cache: "no-store" }); if (r.ok && alive) setSetup((await r.json()) as SetupPayload); } catch { /* degrades */ }
    };
    void load();
    // Live-ish: poll every 15s. The shared market-data cache (MD_CACHE_TTL 30s)
    // means faster polling costs no extra upstream calls — it just picks up new
    // price/candles as soon as they refresh.
    const iv = setInterval(() => void load(), 15000);
    return () => { alive = false; clearInterval(iv); };
  }, [setupMode]);

  const ss = sessions(now);

  // ── real series from the recent feeds (chronological) ──
  const allRecent = useMemo(() => {
    const g = (flow?.goldRecent ?? []).map((r) => ({ ...r, symbol: "XAUUSD", kind: "GENX" as const }));
    const f = (flow?.forexRecent ?? []).map((r) => ({ ...r, kind: "FLOW" as const }));
    return [...g, ...f].filter((r) => r.at).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [flow]);

  const netSeries = useMemo(() => { let c = 0; const s = allRecent.map((r) => { c += Number(r.pips) || 0; return c; }); return s.length ? s : [0, 0]; }, [allRecent]);
  const buckets = (n: number, pick: (r: (typeof allRecent)[number]) => number) => {
    if (!allRecent.length) return new Array(n).fill(0);
    const per = Math.max(1, Math.ceil(allRecent.length / n));
    const out: number[] = [];
    for (let i = 0; i < allRecent.length; i += per) out.push(allRecent.slice(i, i + per).reduce((a, r) => a + pick(r), 0));
    while (out.length < n) out.unshift(0);
    return out.slice(-n);
  };
  const tradeBars = useMemo(() => buckets(14, () => 1), [allRecent]);
  const winBars = useMemo(() => buckets(14, (r) => (r.win ? 1 : 0)), [allRecent]);
  const playsLine = useMemo(() => { let c = 0; const s = allRecent.map(() => (c += 1)); return s.length ? s : [0, 0]; }, [allRecent]);

  // "today" counts (CST) from the real feeds; fall back to all-time totals.
  const today = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const t0 = start.getTime();
    const isT = (iso: string) => new Date(iso).getTime() >= t0;
    const tCount = allRecent.filter((r) => isT(r.at)).length;
    const wCount = allRecent.filter((r) => isT(r.at) && r.win).length;
    return { trades: tCount || (flow?.trades ?? 0), wins: wCount || (flow?.wins ?? 0), isToday: tCount > 0 };
  }, [allRecent, flow]);

  const netPips = flow?.pipsNet ?? flow?.pips ?? 0;
  const winRate = flow?.winRate ?? null;
  const plays7d = flow?.plays7d ?? 0;

  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: C.base, color: C.text }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.045]" style={{ backgroundImage: `linear-gradient(${C.cyan}22 1px,transparent 1px),linear-gradient(90deg,${C.cyan}22 1px,transparent 1px)`, backgroundSize: "40px 40px" }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-60" style={{ background: `radial-gradient(1000px 280px at 85% -30%, ${C.violet}2e, transparent 70%), radial-gradient(760px 240px at 12% -20%, ${C.blue}22, transparent 70%)` }} />

      <div className="relative space-y-3 p-3 sm:p-4">
        {/* ── HEADER ── */}
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-3xl font-black leading-none tracking-tight sm:text-[2.5rem]" style={{ letterSpacing: "-0.02em" }}>THE FLOOR</h2>
              <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ background: "rgba(52,211,153,0.12)", color: C.green }}>
                <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full" style={{ background: C.green, opacity: 0.6 }} /><span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: C.green }} /></span>LIVE
              </span>
              <span className="font-mono text-[13px] tabular-nums" style={{ color: C.mut }}>{clockTime(nowIso) || "—"} CST</span>
            </div>
            <p className="mt-1.5 text-[13px]" style={{ color: C.mut }}>Live trading intelligence. Real results. Powered by OM AI.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SessionBadge label="New York" open={ss.ny} />
            <SessionBadge label="London" open={ss.london} />
            {(["MARKET FEED", "OM AI", "FLOW"] as const).map((f) => (
              <span key={f} className="hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider lg:inline-flex" style={{ borderColor: C.line, color: C.mut }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.cyan, boxShadow: `0 0 6px ${C.cyan}` }} />{f}
              </span>
            ))}
          </div>
        </header>

        {/* ── STAT STRIP ── */}
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
          <StatCard label="Net Pips" sub="All systems" value={netPips} signed accent={netPips >= 0 ? C.green : C.red} spark={<LineSpark values={netSeries} color={netPips >= 0 ? C.green : C.red} fill />} />
          <StatCard label="Win Rate" sub="All systems" value={winRate ?? 0} suffix="%" dash={winRate == null} accent={C.green} spark={<Donut pct={winRate ?? 0} color={C.green} />} />
          <StatCard label="Trades" sub={today.isToday ? "Today" : "All systems"} value={today.trades} accent={C.cyan} spark={<Bars values={tradeBars} color={C.cyan} />} />
          <StatCard label="Wins" sub={today.isToday ? "Today" : "All systems"} value={today.wins} accent={C.green} spark={<Bars values={winBars} color={C.green} />} />
          <StatCard label="Plays" sub="7 days" value={plays7d} accent={C.violet} spark={<LineSpark values={playsLine} color={C.violet} fill />} />
        </div>

        {/* ── MAIN: SETUP FORMING + MARKET INTELLIGENCE ── */}
        <div className="grid gap-3 xl:grid-cols-3">
          <section className="xl:col-span-2 overflow-hidden rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <SetupForming data={setup} mode={setupMode} onMode={setSetupMode} onExpand={() => onGo("plays")} />
          </section>
          <section className="overflow-hidden rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <MarketIntel intel={intel} flow={flow} />
          </section>
        </div>

        {/* ── BOTTOM: GENX RESULTS · FLOW PERFORMANCE · RECENT TRADES ── */}
        <div className="grid gap-3 xl:grid-cols-3">
          <section className="overflow-hidden rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <GenxResults rows={flow?.goldRecent ?? []} />
          </section>
          <section className="overflow-hidden rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <FlowPerformance flow={flow} series={netSeries} onConnect={() => onGo("flow")} />
          </section>
          <section className="overflow-hidden rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <RecentTrades rows={allRecent} />
          </section>
        </div>

        <div className="flex items-center justify-between gap-2 pb-1">
          <p className="text-[11px]" style={{ color: C.mut2 }}>Real results from the AI desk · educational analysis, not financial advice.</p>
          <LiveDeskLink />
        </div>
      </div>

      <style>{`@keyframes floorMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

/* ── session badge ── */
function SessionBadge({ label, open }: { label: string; open: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: open ? C.green : C.mut2 }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: open ? C.green : C.mut2, boxShadow: open ? `0 0 6px ${C.green}` : undefined }} />
      {label} {open ? "Open" : "Closed"}
    </span>
  );
}

/* ── stat card ── */
function StatCard({ label, sub, value, suffix = "", dash = false, signed = false, accent = C.text, spark }: { label: string; sub: string; value: number; suffix?: string; dash?: boolean; signed?: boolean; accent?: string; spark: React.ReactNode }) {
  const v = useCountUp(value);
  const r = Math.round(v);
  const pre = signed ? (r >= 0 ? "+" : "") : "";
  return (
    <div className="relative flex items-center justify-between overflow-hidden rounded-xl border px-3.5 py-3" style={{ borderColor: C.line, background: `linear-gradient(120% 120% at 0% 0%, ${accent}0c, transparent 55%), ${C.panel}` }}>
      <div className="min-w-0">
        <p className="font-mono text-[26px] font-black leading-none tabular-nums sm:text-[30px]" style={{ color: dash ? C.mut2 : accent }}>{dash ? "—" : `${pre}${r.toLocaleString()}${suffix}`}</p>
        <p className="mt-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: C.mut }}>{label}</p>
        <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>{sub}</p>
      </div>
      <div className="ml-2 h-10 w-16 flex-shrink-0 sm:w-20">{spark}</div>
    </div>
  );
}

/* ── sparklines ── */
function LineSpark({ values, color, fill = false }: { values: number[]; color: string; fill?: boolean }) {
  const w = 80, h = 40;
  if (values.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" />;
  const min = Math.min(...values), max = Math.max(...values);
  const sx = (i: number) => (i / (values.length - 1)) * w;
  const sy = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" style={{ overflow: "visible" }}>
      {fill && <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity={0.12} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
function Bars({ values, color }: { values: number[]; color: string }) {
  const w = 80, h = 40; const max = Math.max(1, ...values);
  const bw = w / values.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      {values.map((v, i) => {
        const bh = Math.max(1.5, (v / max) * (h - 3));
        return <rect key={i} x={i * bw + 0.6} y={h - bh} width={Math.max(1, bw - 1.2)} height={bh} rx="0.6" fill={color} opacity={0.55 + 0.45 * (v / max)} />;
      })}
    </svg>
  );
}
function Donut({ pct, color }: { pct: number; color: string }) {
  const p = Math.max(0, Math.min(100, pct)); const r = 15, cx = 20, cy = 20, circ = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 40 40" className="h-full w-full">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(p / 100) * circ} ${circ}`} transform={`rotate(-90 ${cx} ${cy})`} />
    </svg>
  );
}

/* ── GOLD SETUP · Market Flow (ported from the app's live GENX view) ── */
const gnum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const garr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const gfmt = (n: number | null | undefined) => { const v = gnum(n); return v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const gxShort = (s: string) => (s && s.length > 40 ? s.slice(0, 38).replace(/\s+$/, "") + "…" : s);
function sideOf(action?: string): "buy" | "sell" | null { const a = String(action || ""); if (/SELL/.test(a)) return "sell"; if (/BUY/.test(a)) return "buy"; return null; }
const toneCol = (t: string) => (t === "now" ? "#fff" : t === "buy" ? "#7be8b4" : t === "sell" ? "#ff8a94" : t === "wait" ? "#ffc24b" : "rgba(255,255,255,.45)");
function declutter(ys: number[], gap: number, top: number, bottom: number): number[] {
  const out = ys.slice();
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
  let prev = -Infinity;
  for (const k of order) { const v = Math.max(ys[k], prev + gap); out[k] = v; prev = v; }
  if (order.length) {
    const over = out[order[order.length - 1]] - bottom;
    if (over > 0) for (const k of order) out[k] -= over;
    const under = top - out[order[0]];
    if (under > 0) for (const k of order) out[k] += under;
  }
  return out;
}
type Step = { t: string; s?: string | null; tone: string };
function gxSteps(g: GenxRead, price: number | null): Step[] {
  const side = sideOf(g.action);
  const pd = (v: number | null | undefined) => { const n = gnum(v); return n != null ? "$" + gfmt(n) : null; };
  const now: Step = { t: "NOW", s: price != null ? "$" + gfmt(price) : null, tone: "now" };
  const t1: Step | null = gnum(g.tp1) != null ? { t: "TP1", s: pd(g.tp1), tone: side === "sell" ? "sell" : "buy" } : null;
  const t2: Step | null = gnum(g.tp2) != null ? { t: "TP2", s: pd(g.tp2), tone: side === "sell" ? "sell" : "buy" } : null;
  const watch = gnum(g.closest_support) != null ? gnum(g.closest_support) : gnum(g.entry);
  const watchR = gnum(g.closest_resistance) != null ? gnum(g.closest_resistance) : gnum(g.entry);
  const enter: Step = { t: "ENTER", s: gnum(g.entry_low) != null && gnum(g.entry_high) != null ? "$" + gfmt(g.entry_low) : pd(g.entry), tone: side === "sell" ? "sell" : "buy" };
  const tail = [t1, t2].filter((x): x is Step => !!x);
  if (g.action === "WAIT_FOR_BUY_TRIGGER") return [now, { t: "PULLBACK", tone: "muted" }, { t: "WATCH", s: pd(watch), tone: "wait" }, { t: "CONFIRM BUYERS", s: "price bounces ↑", tone: "wait" }, enter, ...tail];
  if (g.action === "WAIT_FOR_SELL_TRIGGER") return [now, { t: "RALLY", tone: "muted" }, { t: "WATCH", s: pd(watchR), tone: "wait" }, { t: "CONFIRM SELLERS", s: "price drops ↓", tone: "wait" }, enter, ...tail];
  if (side) return [now, enter, ...tail, ...(gnum(g.tp3) != null ? [{ t: "TP3", s: pd(g.tp3), tone: side === "sell" ? "sell" : "buy" } as Step] : [])];
  return [now, { t: g.market_regime ? String(g.market_regime).toUpperCase() : "RANGE", tone: "muted" }, { t: "WAIT FOR BREAK", tone: "wait" }];
}

function SetupForming({ data, mode, onMode, onExpand }: { data: SetupPayload | null; mode: "quick" | "intraday" | "swing"; onMode: (m: "quick" | "intraday" | "swing") => void; onExpand: () => void }) {
  const g = data?.g ?? null;
  const candles = data?.candles ?? [];
  const price = data?.price ?? (candles.length ? candles[candles.length - 1].c : null);
  const side = g ? sideOf(g.action) : null;
  const isWait = g ? String(g.action || "").includes("WAIT") : false;
  const rr = (() => { const e = gnum(g?.entry), s = gnum(g?.stop_loss), t = gnum(g?.tp2) ?? gnum(g?.tp1); if (e == null || s == null || t == null) return null; const risk = Math.abs(e - s), rew = Math.abs(t - e); return risk > 0 ? (rew / risk).toFixed(1) : null; })();
  const hold = g?.expected_hold_minutes;
  const TABS: { label: string; m?: "quick" | "intraday" | "swing" }[] = [
    { label: "1m" }, { label: "5m", m: "quick" }, { label: "15m", m: "intraday" }, { label: "1h", m: "swing" }, { label: "4h" }, { label: "1D" },
  ];
  const activeLabel = mode === "quick" ? "5m" : mode === "swing" ? "1h" : "15m";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><Zap className="h-3.5 w-3.5" style={{ color: C.cyan }} /> Gold Setup · XAUUSD</p>
        <div className="flex items-center gap-1.5">
          {rr && <span className="rounded-full border px-2 py-0.5 text-[11px] font-bold" style={{ borderColor: "rgba(255,194,75,0.3)", background: "rgba(255,194,75,0.1)", color: "#ffd47a" }}>R:R 1:{rr}</span>}
          <div className="flex items-center gap-0.5">
            {TABS.map((t) => (
              <button key={t.label} onClick={t.m ? () => onMode(t.m!) : undefined} className="rounded px-1.5 py-0.5 text-[10px] font-semibold transition"
                style={t.label === activeLabel ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: t.m ? C.mut : C.mut2, cursor: t.m ? "pointer" : "default" }}>{t.label}</button>
            ))}
          </div>
          <button onClick={onExpand} className="rounded p-1" style={{ color: C.mut2 }} aria-label="Expand"><Maximize2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {!g ? (
        <div className="flex h-[360px] items-center justify-center px-6 text-center text-[12px]" style={{ color: C.mut2 }}>{data?.error ? "Live gold read unavailable for a moment — retrying." : "Loading the live gold read…"}</div>
      ) : (
        <div className="p-3.5">
          {hold && hold.length === 2 && <p className="mb-2 text-[11px]" style={{ color: C.mut2 }}>Expected hold ≈ {hold[0]}–{hold[1]} min · {mode} mode</p>}
          <StageStepper g={g} price={price} />
          {isWait && <ConfirmHelp g={g} side={side} />}
          <div className="mt-3 flex flex-col gap-3 lg:flex-row">
            <div className="min-w-0 flex-1"><FlowChart g={g} candles={candles} price={price} /></div>
            <div className="w-full flex-shrink-0 lg:w-64">
              <Pressure g={g} />
              <InfoTiles g={g} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StageStepper({ g, price }: { g: GenxRead; price: number | null }) {
  const steps = gxSteps(g, price);
  return (
    <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
      {steps.map((s, i) => (
        <div key={i} className="flex flex-shrink-0 items-center gap-1.5">
          <div className="rounded-lg border px-2.5 py-1.5 text-center" style={{ borderColor: C.line, background: "rgba(255,255,255,0.03)", whiteSpace: "nowrap" }}>
            <p className="text-[11px] font-bold leading-tight" style={{ color: toneCol(s.tone) }}>{s.t}</p>
            {s.s && <p className="text-[10px] leading-tight" style={{ color: C.mut2 }}>{s.s}</p>}
          </div>
          {i < steps.length - 1 && <span style={{ color: "rgba(255,255,255,0.25)" }}>→</span>}
        </div>
      ))}
    </div>
  );
}

function ConfirmHelp({ g, side }: { g: GenxRead; side: "buy" | "sell" | null }) {
  const sell = side === "sell";
  const level = gnum(g.entry_low) != null ? gfmt(g.entry_low) : gnum(g.entry) != null ? gfmt(g.entry) : null;
  const c = sell ? "#ff5d6c" : "#2ee88f";
  const soft = sell ? "rgba(255,93,108,0.3)" : "rgba(46,232,143,0.3)";
  const tint = sell ? "rgba(255,93,108,0.06)" : "rgba(46,232,143,0.06)";
  return (
    <div className="mt-3 flex items-start gap-3 rounded-xl border p-3" style={{ borderColor: soft, background: tint }}>
      <svg width="64" height="34" viewBox="0 0 64 34" className="mt-0.5 flex-shrink-0">
        <line x1="0" x2="64" y1={sell ? 9 : 25} y2={sell ? 9 : 25} stroke="#fff" strokeOpacity="0.28" strokeDasharray="2 2" />
        {[0, 1, 2].map((i) => { const x = 5 + i * 9, top = sell ? 22 - i * 4 : 5 + i * 4; return <rect key={i} x={x} y={top} width="5" height="5" rx="1" fill={sell ? "#2ee88f" : "#ff5d6c"} opacity="0.5" />; })}
        <rect x="40" y={sell ? 11 : 7} width="6" height="16" rx="1" fill={c} />
        <path d={sell ? "M43 30 l-4 -5 h8 z" : "M43 4 l-4 5 h8 z"} fill={c} />
      </svg>
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold" style={{ color: "#fff" }}>{sell ? "“Confirm sellers” = wait to SEE price get pushed back down." : "“Confirm buyers” = wait to SEE price bounce back up."}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: C.mut }}>
          {sell ? (
            <>Don&rsquo;t sell while price is still rising. Wait until it reaches <b style={{ color: "rgba(255,255,255,.85)" }}>{level}</b>, stalls, and prints a <span style={{ color: c }}>red candle dropping away</span> &mdash; that&rsquo;s proof sellers stepped in. <b style={{ color: "rgba(255,255,255,.85)" }}>Then</b> sell.</>
          ) : (
            <>Don&rsquo;t buy while price is still falling. Wait until it reaches <b style={{ color: "rgba(255,255,255,.85)" }}>{level}</b>, stops, and prints a <span style={{ color: c }}>green candle pushing up</span> &mdash; that&rsquo;s proof buyers stepped in. <b style={{ color: "rgba(255,255,255,.85)" }}>Then</b> buy.</>
          )}
        </p>
      </div>
    </div>
  );
}

function FlowChart({ g, candles, price }: { g: GenxRead; candles: Candle[]; price: number | null }) {
  const [why, setWhy] = useState(false);
  const reasons = garr<string>(g.trade_reasoning).slice(0, 5);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-md px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ background: "rgba(255,255,255,0.06)", color: C.mut }}>GENX projected path</span>
        {reasons.length > 0 && <button onClick={() => setWhy((w) => !w)} className="rounded-md border px-2 py-0.5 text-[9.5px] font-bold" style={{ borderColor: "rgba(255,194,75,0.28)", background: "rgba(255,194,75,0.1)", color: "#ffd47a" }}>? WHY</button>}
      </div>
      {why && reasons.length > 0 && (
        <div className="mb-2 rounded-xl border p-3" style={{ borderColor: "rgba(255,194,75,0.25)", background: "rgba(255,194,75,0.06)" }}>
          <ul className="ml-4 list-disc text-[12px] leading-relaxed" style={{ color: "rgba(255,255,255,.8)" }}>{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      <FlowMap g={g} candles={candles} price={price} />
    </div>
  );
}

function FlowMap({ g, candles, price }: { g: GenxRead; candles: Candle[]; price: number | null }) {
  const cs = candles.slice(-44);
  if (cs.length < 4) return <div className="flex h-[340px] items-center justify-center text-[12px]" style={{ color: C.mut2 }}>Loading live candles…</div>;
  const side = sideOf(g.action);
  const isWait = String(g.action || "").includes("WAIT");
  const dir = isWait ? "#ffc24b" : side === "sell" ? "#ff5d6c" : "#2ee88f";
  const px = gnum(price);
  const rawPath = garr<{ label: string; price: number | null }>(g.projected_path).filter((p) => gnum(p.price) != null).map((p) => ({ label: p.label, price: gnum(p.price)! }));
  const nowPrice = px != null ? px : cs[cs.length - 1].c;
  const seq = rawPath.length && /now/i.test(rawPath[0].label) ? rawPath : [{ label: "Now", price: nowPrice }, ...rawPath];

  const W = 720, H = 420, padT = 22, padB = 22, padL = 8, gutterW = 100;
  const plotR = W - gutterW, splitX = Math.round(padL + (plotR - padL) * 0.56);
  const levels = [g.entry, g.entry_low, g.entry_high, g.stop_loss, g.tp1, g.tp2, g.tp3, g.closest_support, g.closest_resistance, g.invalidation_price, price].map(gnum).filter((n): n is number => n != null);
  const pricesArr = ([] as number[]).concat(...cs.map((c) => [c.h, c.l])).concat(seq.map((s) => s.price)).concat(levels);
  const lo0 = Math.min(...pricesArr), hi0 = Math.max(...pricesArr);
  const pdv = ((hi0 - lo0) || 1) * 0.07, lo = lo0 - pdv, hi = hi0 + pdv, sp = (hi - lo) || 1;
  const y = (p: number) => padT + (1 - (p - lo) / sp) * (H - padT - padB);
  const n = cs.length, cw = n ? (splitX - padL - 6) / n : 6, bodyW = Math.max(1.6, Math.min(9, cw * 0.6));
  const projStart = splitX, projEnd = plotR - 6, pn = seq.length;
  const spx = (i: number) => projStart + (pn > 1 ? (i / (pn - 1)) * (projEnd - projStart) : 0);
  const traj = seq.map((s, i) => `${spx(i)},${y(s.price)}`).join(" ");

  type Git = { y: number; t: string; c: string };
  const gitems: Git[] = [];
  if (px != null) gitems.push({ y: y(px), t: "$" + gfmt(px), c: "#ffc24b" });
  const eMid = gnum(g.entry), eLow = gnum(g.entry_low), eHigh = gnum(g.entry_high);
  const entryShow = eMid != null ? eMid : eLow != null && eHigh != null ? (eLow + eHigh) / 2 : null;
  if (entryShow != null) gitems.push({ y: y(entryShow), t: "ENT " + gfmt(entryShow), c: dir });
  const stop = gnum(g.stop_loss) != null ? gnum(g.stop_loss) : gnum(g.invalidation_price);
  if (stop != null) gitems.push({ y: y(stop), t: "SL " + gfmt(stop), c: "#ff5d6c" });
  ([["TP1", gnum(g.tp1)], ["TP2", gnum(g.tp2)], ["TP3", gnum(g.tp3)]] as [string, number | null][]).forEach(([lab, v]) => { if (v != null) gitems.push({ y: y(v), t: lab + " " + gfmt(v), c: "#2ee88f" }); });
  const railY = declutter(gitems.map((it) => it.y), 15, padT + 8, H - padB - 8);

  const entryTop = eHigh != null ? eHigh : eMid != null ? eMid + (hi - lo) * 0.01 : null;
  const entryBot = eLow != null ? eLow : eMid != null ? eMid - (hi - lo) * 0.01 : null;
  const zLabel = isWait ? (side === "sell" ? "SELL" : "BUY") + " REACTION ZONE" : "ENTRY ZONE";

  const GCn = Math.min(11, Math.max(6, pn * 2));
  const interp = (f: number) => { const t = f * (pn - 1), i = Math.min(pn - 2, Math.max(0, Math.floor(t))), fr = t - i; return pn > 1 ? seq[i].price + (seq[i + 1].price - seq[i].price) * fr : seq[0].price; };
  const ghost: { x: number; open: number; close: number; up: boolean; hi: number; lo: number }[] = [];
  let prev0 = interp(0);
  for (let gk = 1; gk <= GCn; gk++) { const gf = gk / GCn, gp = interp(gf), gup = gp >= prev0, gwig = Math.abs(Math.sin(gk * 1.7)) * (hi - lo) * 0.012, gx = projStart + gf * (projEnd - projStart); ghost.push({ x: gx, open: prev0, close: gp, up: gup, hi: Math.max(gp, prev0) + gwig + (hi - lo) * 0.008, lo: Math.min(gp, prev0) - gwig * 0.6 - (hi - lo) * 0.004 }); prev0 = gp; }
  const gcw = Math.max(2.4, ((projEnd - projStart) / GCn) * 0.55);

  const pivots: { x: number; y: number; tag: string }[] = [];
  { const win = 2; let lastHigh: number | null = null, lastLow: number | null = null; const picks: { x: number; y: number; tag: string }[] = [];
    for (let i = win; i < cs.length - win; i++) { const c = cs[i]; let isHigh = true, isLow = true; for (let j = i - win; j <= i + win; j++) { if (cs[j].h > c.h) isHigh = false; if (cs[j].l < c.l) isLow = false; } const xx = padL + 2 + i * cw + cw / 2; if (isHigh) { const tag = lastHigh != null ? (c.h >= lastHigh ? "HH" : "LH") : "HH"; lastHigh = c.h; picks.push({ x: xx, y: y(c.h) - 6, tag }); } else if (isLow) { const tg = lastLow != null ? (c.l >= lastLow ? "HL" : "LL") : "HL"; lastLow = c.l; picks.push({ x: xx, y: y(c.l) + 11, tag: tg }); } }
    pivots.push(...picks.slice(-5)); }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block", maxHeight: 420 }}>
      <rect x={splitX} y={padT} width={plotR - splitX} height={H - padT - padB} fill={dir} opacity="0.05" />
      {gitems.map((it, i) => <line key={`l${i}`} x1={padL} x2={plotR} y1={it.y} y2={it.y} stroke={it.c} strokeWidth="1" strokeDasharray="1 6" opacity="0.22" />)}
      {stop != null && <g><rect x={splitX} y={Math.min(y(stop), H - padB - 14)} width={plotR - splitX} height="14" fill="#ff5d6c" opacity="0.12" /><text x={splitX + 4} y={y(stop) + 10} fill="#ff5d6c" fontSize="7.5" fontWeight="700">INVALIDATION {gfmt(stop)}</text></g>}
      {entryTop != null && entryBot != null && (
        <g>
          <rect x={splitX} y={y(entryTop)} width={plotR - splitX} height={Math.max(5, y(entryBot) - y(entryTop))} fill={dir} opacity={isWait ? 0.1 : 0.16} />
          <rect x={splitX} y={y(entryTop)} width={plotR - splitX} height={Math.max(5, y(entryBot) - y(entryTop))} fill="none" stroke={dir} strokeOpacity="0.45" strokeDasharray="3 3" />
          <text x={splitX + 4} y={y(entryTop) - 3} fill={dir} fontSize="7.5" fontWeight="700">{zLabel}</text>
          {isWait && <text x={splitX + 4} y={y(entryBot) + 9} fill={dir} fontSize="7" opacity="0.85">{side === "sell" ? "BEARISH CONFIRMATION REQUIRED" : "WAIT FOR CONFIRMATION"}</text>}
        </g>
      )}
      {cs.map((c, i) => { const x = padL + 2 + i * cw + cw / 2; const up = c.c >= c.o; const col = up ? "#2ee88f" : "#ff5d6c"; const yo = y(c.o), yc = y(c.c); return <g key={`c${i}`}><line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" opacity="0.6" /><rect x={x - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(1, Math.abs(yc - yo))} rx="0.6" fill={col} opacity="0.92" /></g>; })}
      {pivots.map((p, i) => <text key={`p${i}`} x={p.x} y={p.y} fill="#8b94a7" fontSize="7.5" fontWeight="700" textAnchor="middle" opacity="0.7">{p.tag}</text>)}
      {ghost.map((c, i) => { const col = c.up ? "#2ee88f" : "#ff5d6c"; const yo = y(c.open), yc = y(c.close); return <g key={`gh${i}`}><line x1={c.x} x2={c.x} y1={y(c.hi)} y2={y(c.lo)} stroke={col} strokeWidth="1" opacity="0.3" /><rect x={c.x - gcw / 2} y={Math.min(yo, yc)} width={gcw} height={Math.max(1.4, Math.abs(yc - yo))} rx="0.6" fill={col} opacity="0.25" stroke={col} strokeOpacity="0.4" /></g>; })}
      {seq.length > 1 && <polyline points={traj} fill="none" stroke={dir} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />}
      {seq.map((s, i) => { if (i === 0) return null; const last = i === seq.length - 1; const lbl = String(s.label || ""); const showLabel = !/^(now|entry)$/i.test(lbl); return <g key={`pj${i}`}><circle cx={spx(i)} cy={y(s.price)} r="3" fill={dir} />{showLabel && <text x={last ? spx(i) - 3 : spx(i)} y={y(s.price) - 7} fill={dir} fontSize="9" fontWeight="700" textAnchor={last ? "end" : "middle"}>{lbl}</text>}</g>; })}
      <line x1={splitX} x2={splitX} y1={padT - 2} y2={H - padB} stroke="#fff" strokeWidth="1" strokeDasharray="2 5" opacity="0.16" />
      <rect x={splitX - 19} y={padT - 18} width="38" height="14" rx="3" fill="#ffc24b" />
      <text x={splitX} y={padT - 8} fill="#1a1204" fontSize="9" fontWeight="800" textAnchor="middle">NOW</text>
      {gitems.map((it, i) => { const by = railY[i]; return <g key={`b${i}`}><line x1={plotR} x2={plotR + 6} y1={it.y} y2={by} stroke={it.c} strokeWidth="1" opacity="0.4" /><rect x={plotR + 7} y={by - 8.5} width={gutterW - 9} height="17" rx="4" fill="#0c0f17" stroke={it.c} strokeOpacity="0.55" /><text x={plotR + 11} y={by + 3.5} fill={it.c} fontSize="9" fontWeight="700">{it.t}</text></g>; })}
    </svg>
  );
}

function Pressure({ g }: { g: GenxRead }) {
  const b = gnum(g.buyer_control) || 0, s = gnum(g.seller_control) || 0, tot = b + s, pct = tot > 0 ? (b / tot) * 100 : 50;
  const biasTxt = g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral";
  const biasCol = g.directional_bias === "bullish" ? "#7be8b4" : g.directional_bias === "bearish" ? "#ff8a94" : "#ffc24b";
  const tile = { borderColor: C.line, background: "rgba(255,255,255,0.02)" };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-xl border p-3" style={tile}>
        <div className="flex justify-between text-[9.5px] uppercase tracking-wider" style={{ color: C.mut2 }}><span>Selling pressure</span><span>Buying pressure</span></div>
        <div className="relative mt-1.5 h-2 rounded-full" style={{ background: "linear-gradient(90deg,#ff5d6c33,#ffc24b33,#2ee88f33)" }}>
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#ff5d6c66,#2ee88f88)" }} />
          <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ borderColor: "#0b0d14", background: "#fff", left: `${pct}%` }} />
        </div>
        {tot > 0 && <p className="mt-1.5 text-[10px]" style={{ color: C.mut2 }}>Buyers {Math.round(pct)}% · Sellers {Math.round(100 - pct)}%</p>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl border py-2" style={tile}><p className="text-[9px] uppercase tracking-wider" style={{ color: C.mut2 }}>Bias</p><p className="mt-0.5 text-[13px] font-bold" style={{ color: biasCol }}>{biasTxt}</p></div>
        <div className="rounded-xl border py-2" style={tile}><p className="text-[9px] uppercase tracking-wider" style={{ color: C.mut2 }}>Momentum</p><p className="mt-0.5 text-[13px] font-bold capitalize" style={{ color: "rgba(255,255,255,.85)" }}>{g.momentum || "—"}</p></div>
        <div className="rounded-xl border py-2" style={tile}><p className="text-[9px] uppercase tracking-wider" style={{ color: C.mut2 }}>Session</p><p className="mt-0.5 text-[13px] font-bold" style={{ color: "rgba(255,255,255,.85)" }}>{g.session || "—"}</p></div>
      </div>
    </div>
  );
}

function InfoTiles({ g }: { g: GenxRead }) {
  const side = sideOf(g.action);
  const tiles = [
    { k: "GENX wants", v: g.trigger_condition ? gxShort(g.trigger_condition) : side === "buy" ? "Enter now" : "Setup forming", sub: "Trigger", col: "#ffc24b" },
    { k: "Invalidation", v: gnum(g.stop_loss) != null ? gfmt(g.stop_loss) : "—", sub: g.invalidation_reason ? gxShort(g.invalidation_reason) : "Setup is off", col: "#ff8a94" },
    { k: "Targets", v: [gnum(g.tp1), gnum(g.tp2)].filter((x) => x != null).map((x) => gfmt(x)).join(" · ") || "—", sub: [gnum(g.tp1_pips), gnum(g.tp2_pips)].filter((x) => x != null).map((x) => "+" + x + "p").join(" · "), col: "#7be8b4" },
  ];
  return (
    <div className="mt-2.5 grid grid-cols-1 gap-2">
      {tiles.map((t) => (
        <div key={t.k} className="rounded-xl border px-3 py-2" style={{ borderColor: C.line, background: "rgba(255,255,255,0.02)" }}>
          <p className="text-[9.5px] uppercase tracking-wider" style={{ color: C.mut2 }}>{t.k}</p>
          <p className="mt-0.5 text-[13px] font-bold leading-tight" style={{ color: t.col }}>{t.v}</p>
          {t.sub && <p className="mt-0.5 text-[10px] leading-tight" style={{ color: C.mut2 }}>{t.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/* ── MARKET INTELLIGENCE (calendar + desk activity, clickable news) ── */
function MarketIntel({ intel, flow }: { intel: IntelPayload | null; flow: FlowStats | null }) {
  type Item = { time: string; ts: number; headline: string; impact: string; tone: "high" | "med" | "low" | "win" | "loss"; assets: string[]; ev?: IntelEvent };
  const [sel, setSel] = useState<IntelEvent | null>(null);
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const e of intel?.events ?? []) {
      out.push({ time: e.time, ts: e.ts, headline: e.headline, impact: e.impact, tone: e.impact === "HIGH" ? "high" : e.impact === "MED" ? "med" : "low", assets: e.assets, ev: e });
    }
    for (const g of flow?.goldRecent ?? []) {
      const ts = new Date(g.at).getTime(); if (!Number.isFinite(ts)) continue;
      out.push({ time: clockTime(g.at), ts, headline: `GENX gold ${genxLong(g.side) ? "LONG" : "SHORT"} ${g.win ? "hit target" : "stopped"}${g.pips != null ? ` (${g.pips > 0 ? "+" : ""}${g.pips}p)` : ""}`, impact: g.win ? "WIN" : "LOSS", tone: g.win ? "win" : "loss", assets: ["XAUUSD"] });
    }
    for (const f of flow?.forexRecent ?? []) {
      const ts = new Date(f.at).getTime(); if (!Number.isFinite(ts)) continue;
      out.push({ time: clockTime(f.at), ts, headline: `FLOW ${short(f.symbol)} ${String(f.side).toUpperCase()} ${f.win ? "win" : "loss"}${f.pips != null ? ` (${f.pips > 0 ? "+" : ""}${f.pips}p)` : ""}`, impact: f.win ? "WIN" : "LOSS", tone: f.win ? "win" : "loss", assets: [short(f.symbol)] });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 14);
  }, [intel, flow]);

  const feat = intel?.featured ?? null;
  const toneColor = (t: Item["tone"]) => t === "high" || t === "loss" ? C.red : t === "med" ? C.amber : t === "win" ? C.green : C.mut2;
  const toneBg = (t: Item["tone"]) => t === "high" || t === "loss" ? "rgba(248,113,113,0.14)" : t === "med" ? "rgba(251,191,36,0.14)" : t === "win" ? "rgba(52,211,153,0.14)" : "rgba(255,255,255,0.06)";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><Radio className="h-3.5 w-3.5" style={{ color: C.cyan }} /> Market Intelligence</p>
        <Filter className="h-3.5 w-3.5" style={{ color: C.mut2 }} />
      </div>
      {feat && (
        <button onClick={() => setSel(feat)} className="flex w-full items-center gap-2 border-b px-3.5 py-2 text-left transition hover:brightness-125" style={{ borderColor: C.line, background: "rgba(251,191,36,0.06)" }}>
          <Zap className="h-3.5 w-3.5 flex-shrink-0" style={{ color: C.amber }} />
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: C.amber }}>Featured Alert · tap for breakdown</p>
            <p className="truncate text-[12px] font-semibold">{feat.headline} <span style={{ color: C.mut }}>expected {feat.when}</span></p>
          </div>
          <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "rgba(248,113,113,0.16)", color: C.red }}>{feat.impact} IMPACT</span>
        </button>
      )}
      <div className="flex-1 overflow-y-auto" style={{ maxHeight: 360 }}>
        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12px]" style={{ color: C.mut2 }}>Intelligence feed syncing…</p>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 z-[1]" style={{ background: C.panel }}>
              <tr style={{ color: C.mut2 }} className="text-left text-[9px] uppercase tracking-wider">
                <th className="px-3.5 py-2 font-semibold">Time</th>
                <th className="py-2 font-semibold">Headline</th>
                <th className="py-2 font-semibold">Impact</th>
                <th className="px-3.5 py-2 text-right font-semibold">Assets</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const clickable = !!it.ev;
                return (
                  <tr key={i} onClick={clickable ? () => setSel(it.ev!) : undefined} className="border-t align-top transition" style={{ borderColor: C.lineSoft, cursor: clickable ? "pointer" : "default", ...(clickable ? {} : {}) }}
                    onMouseEnter={clickable ? (e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)") : undefined}
                    onMouseLeave={clickable ? (e) => (e.currentTarget.style.background = "transparent") : undefined}>
                    <td className="whitespace-nowrap px-3.5 py-2 font-mono" style={{ color: C.mut }}>{it.time}</td>
                    <td className="py-2 pr-2" style={{ color: C.text }}>
                      <span className="inline-flex items-center gap-1">{it.headline}{clickable && <ChevronRight className="h-3 w-3 flex-shrink-0" style={{ color: C.mut2 }} />}</span>
                    </td>
                    <td className="py-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: toneBg(it.tone), color: toneColor(it.tone) }}>{it.impact}</span></td>
                    <td className="px-3.5 py-2 text-right font-mono text-[10px]" style={{ color: C.mut }}>{it.assets.slice(0, 2).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {sel && <NewsDetail ev={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

/* Event analysis — deterministic, educational (no fabricated price predictions). */
type Dir = 1 | -1 | 0;
function analyzeEvent(ev: IntelEvent): { category: string; what: string; inverted: boolean; ccyHot: Dir; goldRelevant: boolean } {
  const h = ev.headline.toLowerCase();
  const isUSD = ev.ccy === "USD";
  let category = "Economic data";
  let what = `A scheduled ${ev.ccy} release. Readings that beat or miss the forecast drive the near-term move; the bigger the surprise, the bigger the swing.`;
  let inverted = false;
  if (/unemployment/.test(h)) { category = "Employment"; what = "The share of the labor force out of work. A HIGHER-than-forecast reading is currency-negative (a softer labor market points to easier policy)."; inverted = true; }
  else if (/payroll|non-?farm|employment change|\bnfp\b|\bjobs\b/.test(h)) { category = "Employment"; what = "Net new jobs. More jobs than forecast signals a strong economy and a firmer central bank — currency-positive."; }
  else if (/cpi|pce|inflation|ppi|price index/.test(h)) { category = "Inflation"; what = "An inflation gauge. A hotter print pushes the central bank toward higher-for-longer rates — currency-positive, and a headwind for gold."; }
  else if (/gdp|growth/.test(h)) { category = "Growth"; what = "Economic output. Stronger growth supports the currency and lifts rate expectations."; }
  else if (/rate|fomc|interest|fed funds|cash rate|monetary|policy/.test(h)) { category = "Central bank"; what = "A policy / rate signal. A hawkish surprise (higher or held-high rates) lifts the currency and weighs on gold."; }
  else if (/retail|consumer|spending|\bsales\b/.test(h)) { category = "Consumption"; what = "Consumer demand. Stronger spending is currency-supportive and mildly inflationary."; }
  else if (/pmi|ism|manufactur|services|business|sentiment|confidence/.test(h)) { category = "Activity / sentiment"; what = "A business-activity survey. Above forecast signals expansion and currency strength."; }
  const ccyHot: Dir = inverted ? -1 : 1; // currency direction on an ABOVE-forecast reading
  return { category, what, inverted, ccyHot, goldRelevant: isUSD };
}

function DirArrow({ d }: { d: Dir }) {
  if (d === 1) return <TrendingUp className="inline h-3.5 w-3.5" style={{ color: C.green }} />;
  if (d === -1) return <TrendingDown className="inline h-3.5 w-3.5" style={{ color: C.red }} />;
  return <Minus className="inline h-3.5 w-3.5" style={{ color: C.mut2 }} />;
}

function NewsDetail({ ev, onClose }: { ev: IntelEvent; onClose: () => void }) {
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(id); }, []);
  const a = analyzeEvent(ev);
  const future = ev.ts > nowMs;
  const diffMin = Math.round(Math.abs(ev.ts - nowMs) / 60000);
  const cd = diffMin >= 60 ? `${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `${diffMin}m`;
  const countdown = future ? `in ${cd}` : `${cd} ago`;
  const fullDate = (() => { try { return new Date(ev.ts).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " CST"; } catch { return ev.time; } })();
  const impColor = ev.impact === "HIGH" ? C.red : ev.impact === "MED" ? C.amber : C.mut2;
  const pair = ev.assets.find((x) => /USD|EUR|GBP|JPY/.test(x) && x !== "USD") ?? ev.assets[0] ?? ev.ccy;

  // scenario directions
  const goldHot: Dir = a.goldRelevant ? ((a.ccyHot * -1) as Dir) : 0;
  const flip = (d: Dir): Dir => ((d * -1) as Dir);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: "rgba(4,7,11,0.72)" }} onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl border shadow-2xl" style={{ borderColor: C.line, background: C.panel, color: C.text }} onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b p-4" style={{ borderColor: C.line }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ background: `${impColor}22`, color: impColor }}>{ev.impact} impact</span>
              <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ background: "rgba(255,255,255,0.06)", color: C.mut }}>{ev.ccy}</span>
              <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>{a.category}</span>
            </div>
            <h3 className="mt-1.5 text-lg font-black leading-tight">{ev.headline}</h3>
          </div>
          <button onClick={onClose} className="flex-shrink-0 rounded-lg p-1.5" style={{ color: C.mut }} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 p-4">
          {/* when */}
          <div className="flex items-center gap-3 rounded-xl border p-3" style={{ borderColor: C.lineSoft, background: C.raised }}>
            <Clock className="h-5 w-5 flex-shrink-0" style={{ color: future ? C.cyan : C.mut2 }} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold">{fullDate}</p>
              <p className="text-[11px]" style={{ color: C.mut }}>{ev.headline} · {ev.ccy}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-base font-black tabular-nums" style={{ color: future ? C.cyan : C.mut2 }}>{countdown}</p>
              <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>{future ? "until release" : "since release"}</p>
            </div>
          </div>

          {/* forecast / previous */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border p-3" style={{ borderColor: C.lineSoft, background: C.raised }}>
              <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: C.mut }}>Forecast</p>
              <p className="font-mono text-lg font-black tabular-nums">{ev.forecast || "—"}</p>
            </div>
            <div className="rounded-xl border p-3" style={{ borderColor: C.lineSoft, background: C.raised }}>
              <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: C.mut }}>Previous</p>
              <p className="font-mono text-lg font-black tabular-nums">{ev.previous || "—"}</p>
            </div>
          </div>

          {/* what it is */}
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: C.mut }}>What it is</p>
            <p className="text-[13px] leading-relaxed" style={{ color: C.text }}>{a.what}</p>
          </div>

          {/* how it moves price */}
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider" style={{ color: C.mut }}>How it moves price</p>
            <div className="overflow-hidden rounded-xl border" style={{ borderColor: C.lineSoft }}>
              <div className="grid grid-cols-3 px-3 py-2 text-[9px] font-bold uppercase tracking-wider" style={{ background: C.raised, color: C.mut2 }}>
                <span>Scenario</span><span className="text-center">{ev.ccy}</span><span className="text-right">Gold (XAUUSD)</span>
              </div>
              <div className="grid grid-cols-3 items-center border-t px-3 py-2.5 text-[12px]" style={{ borderColor: C.lineSoft }}>
                <span className="font-semibold" style={{ color: C.green }}>Above forecast</span>
                <span className="text-center"><DirArrow d={a.ccyHot} /></span>
                <span className="text-right"><DirArrow d={goldHot} /> <span style={{ color: C.mut2 }}>{a.goldRelevant ? "" : "indirect"}</span></span>
              </div>
              <div className="grid grid-cols-3 items-center border-t px-3 py-2.5 text-[12px]" style={{ borderColor: C.lineSoft }}>
                <span className="font-semibold" style={{ color: C.red }}>Below forecast</span>
                <span className="text-center"><DirArrow d={flip(a.ccyHot)} /></span>
                <span className="text-right"><DirArrow d={flip(goldHot)} /> <span style={{ color: C.mut2 }}>{a.goldRelevant ? "" : "indirect"}</span></span>
              </div>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: C.mut }}>
              {a.goldRelevant
                ? `Gold trades inverse to the dollar: a stronger-than-forecast ${ev.ccy} print typically pressures XAUUSD lower, a weaker print supports it.`
                : `This is a ${ev.ccy} release, so the direct move is in ${pair}. Gold reacts mainly to USD data — expect limited direct effect on XAUUSD here.`}
            </p>
          </div>

          {/* GENX behavior */}
          {ev.impact === "HIGH" && a.goldRelevant && (
            <div className="flex items-start gap-2 rounded-xl border p-3" style={{ borderColor: "rgba(34,211,238,0.25)", background: "rgba(34,211,238,0.06)" }}>
              <Zap className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: C.cyan }} />
              <p className="text-[12px] leading-relaxed" style={{ color: C.text }}>
                <span className="font-bold" style={{ color: C.cyan }}>GENX around this release:</span> the desk holds new gold entries for ~15 minutes before and after this event to avoid the volatility spike (the falling-knife guard), then resumes once price settles.
              </p>
            </div>
          )}

          <p className="text-[10px] leading-relaxed" style={{ color: C.mut2 }}>Typical market reactions shown for education — actual moves depend on the surprise vs. forecast, positioning, and the wider tape. Not financial advice.</p>
        </div>
      </div>
    </div>
  );
}

/* ── GENX GOLD RESULTS ── */
function GenxResults({ rows }: { rows: GoldRec[] }) {
  const [filter, setFilter] = useState<"all" | "wins" | "losses">("all");
  const list = useMemo(() => {
    const f = filter === "wins" ? rows.filter((r) => r.win) : filter === "losses" ? rows.filter((r) => !r.win) : rows;
    return f.slice(0, 8);
  }, [rows, filter]);
  return (
    <div>
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><span className="h-2 w-2 rounded-sm" style={{ background: C.gold }} /> GENX · Gold Results</p>
        <div className="flex gap-1">
          {(["all", "wins", "losses"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize" style={filter === f ? { background: "rgba(255,194,75,0.16)", color: C.gold } : { color: C.mut2 }}>{f}</button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-10 text-center text-[12px]" style={{ color: C.mut2 }}>No graded GENX gold results in this view yet.</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr style={{ color: C.mut2 }} className="text-left text-[9px] uppercase tracking-wider">
              <th className="px-3.5 py-2 font-semibold">Time</th><th className="py-2 font-semibold">Pair</th><th className="py-2 font-semibold">Direction</th><th className="py-2 font-semibold">Status</th><th className="px-3.5 py-2 text-right font-semibold">Result</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const long = genxLong(r.side); const pips = r.pips ?? 0;
              const tp = r.hitTp >= 3 ? "Target 3" : r.hitTp === 2 ? "Target 2" : r.hitTp === 1 ? "Target 1" : r.win ? "Target" : "Stopped";
              return (
                <tr key={i} className="border-t" style={{ borderColor: C.lineSoft }}>
                  <td className="whitespace-nowrap px-3.5 py-2 font-mono" style={{ color: C.mut }}>{clockTime(r.at)}</td>
                  <td className="py-2 font-mono font-bold">XAUUSD</td>
                  <td className="py-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={long ? { background: "rgba(52,211,153,0.12)", color: C.green } : { background: "rgba(248,113,113,0.12)", color: C.red }}>{long ? "LONG" : "SHORT"}</span></td>
                  <td className="py-2 text-[10px] font-semibold" style={{ color: r.win ? C.green : C.red }}>{tp}</td>
                  <td className="px-3.5 py-2 text-right font-mono font-bold" style={{ color: r.win ? C.green : C.red }}>{pips > 0 ? "+" : ""}{pips.toLocaleString()}p</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── FLOW PERFORMANCE ── */
function FlowPerformance({ flow, series, onConnect }: { flow: FlowStats | null; series: number[]; onConnect: () => void }) {
  const net = flow?.pipsNet ?? flow?.pips ?? 0;
  const hasData = !!flow && !flow.error && (flow.trades ?? 0) > 0;
  const path = useMemo(() => {
    if (series.length < 2) return null;
    const w = 100, h = 42, min = Math.min(0, ...series), max = Math.max(1, ...series);
    const sx = (i: number) => (i / (series.length - 1)) * w;
    const sy = (v: number) => h - ((v - min) / (max - min || 1)) * h;
    return { d: series.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" "), sy0: sy(0).toFixed(1) };
  }, [series]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><span className="h-2 w-2 rounded-sm" style={{ background: C.cyan }} /> FLOW · Performance</p>
        <div className="flex gap-1">{["1D", "7D", "30D", "ALL"].map((t) => (<span key={t} className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={t === "ALL" ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: C.mut2 }}>{t}</span>))}</div>
      </div>
      {!hasData ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <p className="text-sm font-semibold" style={{ color: C.mut }}>{flow ? "No FLOW results yet" : "Syncing FLOW…"}</p>
          <p className="text-[12px]" style={{ color: C.mut2 }}>Connect your broker — FLOW prepares every trade, you approve it.</p>
          <button onClick={onConnect} className="mt-1 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] font-bold" style={{ background: C.cyan, color: "#04252b" }}>Connect broker <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col p-3.5">
          <div className="flex items-end justify-between">
            <div><p className="font-mono text-[28px] font-black leading-none tabular-nums" style={{ color: net >= 0 ? C.green : C.red }}>{net >= 0 ? "+" : ""}{net.toLocaleString()}</p><p className="mt-1 text-[9px] font-bold uppercase tracking-wider" style={{ color: C.mut }}>Net pips</p></div>
            <div className="text-center"><p className="font-mono text-lg font-black tabular-nums">{flow?.winRate != null ? `${flow.winRate}%` : "—"}</p><p className="text-[9px] uppercase tracking-wider" style={{ color: C.mut2 }}>Win rate</p></div>
            <div className="text-right"><p className="font-mono text-lg font-black tabular-nums">{flow?.trades ?? 0}</p><p className="text-[9px] uppercase tracking-wider" style={{ color: C.mut2 }}>Trades</p></div>
          </div>
          {path && (
            <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="mt-3 h-16 w-full" style={{ overflow: "visible" }}>
              <line x1="0" y1={path.sy0} x2="100" y2={path.sy0} stroke={C.line} strokeWidth="0.5" strokeDasharray="2 2" />
              <path d={`${path.d} L100,42 L0,42 Z`} fill={C.cyan} opacity={0.1} />
              <path d={path.d} fill="none" stroke={C.cyan} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          )}
          <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
            <Split label="Gold" pips={flow?.gold?.pips ?? 0} trades={flow?.gold?.trades ?? 0} wr={flow?.gold?.winRate ?? null} accent={C.gold} />
            <Split label="Forex" pips={flow?.forex?.pips ?? 0} trades={flow?.forex?.trades ?? 0} wr={flow?.forex?.winRate ?? null} accent={C.blue} />
          </div>
        </div>
      )}
    </div>
  );
}
function Split({ label, pips, trades, wr, accent }: { label: string; pips: number; trades: number; wr: number | null; accent: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: C.lineSoft, background: C.raised }}>
      <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: accent }}>{label}</p>
      <p className="mt-0.5 font-mono text-sm font-bold tabular-nums" style={{ color: C.green }}>+{pips.toLocaleString()}p</p>
      <p className="font-mono text-[10px]" style={{ color: C.mut2 }}>{trades} trades · {wr != null ? `${wr}% wr` : "—"}</p>
    </div>
  );
}

/* ── RECENT TRADES ── */
function RecentTrades({ rows }: { rows: (FlowRec & { kind?: string })[] }) {
  const [filter, setFilter] = useState<"all" | "wins" | "losses">("all");
  const list = useMemo(() => {
    const desc = [...rows].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const f = filter === "wins" ? desc.filter((r) => r.win) : filter === "losses" ? desc.filter((r) => !r.win) : desc;
    return f.slice(0, 9);
  }, [rows, filter]);
  return (
    <div>
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><Clock className="h-3.5 w-3.5" style={{ color: C.mut }} /> Recent Trades</p>
        <div className="flex gap-1">
          {(["all", "wins", "losses"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize" style={filter === f ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: C.mut2 }}>{f}</button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-10 text-center text-[12px]" style={{ color: C.mut2 }}>Trades post here as the desk closes them.</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr style={{ color: C.mut2 }} className="text-left text-[9px] uppercase tracking-wider">
              <th className="px-3.5 py-2 font-semibold">Time</th><th className="py-2 font-semibold">Pair</th><th className="py-2 font-semibold">Direction</th><th className="py-2 font-semibold">Outcome</th><th className="px-3.5 py-2 text-right font-semibold">Pips</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const long = genxLong(r.side); const pips = r.pips;
              return (
                <tr key={i} className="border-t" style={{ borderColor: C.lineSoft }}>
                  <td className="whitespace-nowrap px-3.5 py-2 font-mono" style={{ color: C.mut }}>{clockTime(r.at)}</td>
                  <td className="py-2 font-mono font-bold">{short(r.symbol)}</td>
                  <td className="py-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={long ? { background: "rgba(52,211,153,0.12)", color: C.green } : { background: "rgba(248,113,113,0.12)", color: C.red }}>{long ? "LONG" : "SHORT"}</span></td>
                  <td className="py-2 text-[10px] font-bold uppercase" style={{ color: r.win ? C.green : C.red }}>{r.win ? "Win" : "Loss"}</td>
                  <td className="px-3.5 py-2 text-right font-mono font-bold" style={{ color: r.win ? C.green : C.red }}>{pips != null ? `${pips > 0 ? "+" : ""}${pips}p` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── small Live Desk link (kept — the Zoom link isn't in the top nav) ── */
function LiveDeskLink() {
  const next = CALLS.find((c) => c.hot) ?? CALLS[CALLS.length - 1];
  return (
    <a href={LIVE_URL} target="_blank" rel="noreferrer" className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition hover:border-[rgba(248,113,113,0.5)]" style={{ borderColor: "rgba(248,113,113,0.28)", color: C.text }}>
      <Radio className="h-3.5 w-3.5" style={{ color: C.red }} /> Live Desk<span style={{ color: C.mut2 }}>· next {next?.t} CST</span>
    </a>
  );
}
