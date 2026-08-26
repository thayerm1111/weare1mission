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
type Setup = {
  side: "buy" | "sell"; state: string; mode: string;
  entry: number | null; entryLow: number | null; entryHigh: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  breakLevel: number | null; readiness: number; createdAt: string;
};
type Metrics = { toEntry: number | null; risk: number | null; reward: number | null; rr: number | null };
type SetupPayload = { setup: Setup | null; candles: Candle[]; price: number | null; session: string; conditions: { label: string; met: boolean }[]; statusText: string; phase?: string; guidance?: string; metrics?: Metrics | null };
type IntelEvent = { time: string; ts: number; headline: string; impact: "HIGH" | "MED" | "LOW"; assets: string[]; when: string; ccy: string; forecast: string; previous: string };
type IntelPayload = { featured: IntelEvent | null; events: IntelEvent[] };

const genxLong = (d: string) => /bull|long|buy/i.test(String(d || ""));
const short = (s: string) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const fmt2 = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
  const now = useClock();
  const nowIso = now ? now.toISOString() : "";

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch("/api/flow/stats", { cache: "no-store" }); if (r.ok && alive) setFlow((await r.json()) as FlowStats); } catch { /* degrades */ }
      try { const r = await fetch("/api/floor/setup", { cache: "no-store" }); if (r.ok && alive) setSetup((await r.json()) as SetupPayload); } catch { /* degrades */ }
      try { const r = await fetch("/api/floor/intel", { cache: "no-store" }); if (r.ok && alive) setIntel((await r.json()) as IntelPayload); } catch { /* degrades */ }
    };
    void load();
    const iv = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

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
            <SetupForming data={setup} onExpand={() => onGo("plays")} />
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

/* ── SETUP FORMING (live GENX gold — guidance-first chart) ── */
const PHASE_META: Record<string, { label: string; color: string }> = {
  in_trade: { label: "In Trade", color: C.green },
  in_zone: { label: "At Zone · Arming", color: C.amber },
  await_pullback: { label: "Waiting for Pullback", color: C.cyan },
  reclaim: { label: "Needs Reclaim", color: C.amber },
  scanning: { label: "Scanning", color: C.mut2 },
};
function SetupForming({ data, onExpand }: { data: SetupPayload | null; onExpand: () => void }) {
  const setup = data?.setup ?? null;
  const candles = data?.candles ?? [];
  const price = data?.price ?? (candles.length ? candles[candles.length - 1].c : null);
  const buy = setup?.side !== "sell";
  const metrics = data?.metrics ?? null;
  const phase = data?.phase ?? "scanning";
  const pm = PHASE_META[phase] ?? PHASE_META.scanning;
  const TFS = ["1m", "5m", "15m", "1h", "4h", "1D"];

  return (
    <div>
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><Zap className="h-3.5 w-3.5" style={{ color: C.cyan }} /> Gold Setup · XAUUSD</p>
        <div className="flex items-center gap-1">
          {TFS.map((t) => (
            <span key={t} className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={t === "15m" ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: C.mut2 }}>{t}</span>
          ))}
          <button onClick={onExpand} className="ml-1 rounded p-1" style={{ color: C.mut2 }} aria-label="Expand"><Maximize2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* GUIDANCE BANNER — the plain-English "what has to happen to enter" */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3.5 py-2.5" style={{ borderColor: C.line, background: `linear-gradient(90deg, ${pm.color}12, transparent 60%)` }}>
        <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider" style={{ background: `${pm.color}22`, color: pm.color }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: pm.color, boxShadow: `0 0 6px ${pm.color}` }} />{pm.label}
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug" style={{ color: C.text }}>{data?.guidance ?? "Loading the live gold read…"}</p>
        {metrics && (
          <div className="flex flex-shrink-0 items-center gap-3">
            {metrics.toEntry != null && metrics.toEntry > 0 && <Metric label="To entry" value={`${metrics.toEntry}p`} color={C.cyan} />}
            {metrics.risk != null && <Metric label="Risk" value={`${metrics.risk}p`} color={C.red} />}
            {metrics.reward != null && <Metric label="Reward" value={`${metrics.reward}p`} color={C.green} />}
            {metrics.rr != null && <Metric label="R:R" value={`${metrics.rr}`} color={metrics.rr >= 1 ? C.green : C.amber} />}
          </div>
        )}
      </div>

      <div className="flex flex-col lg:flex-row">
        {/* left rail */}
        <div className="w-full flex-shrink-0 border-b p-3.5 lg:w-48 lg:border-b-0 lg:border-r" style={{ borderColor: C.line }}>
          {setup ? (
            <>
              <span className="inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={buy ? { background: "rgba(52,211,153,0.14)", color: C.green } : { background: "rgba(248,113,113,0.14)", color: C.red }}>{buy ? "Long" : "Short"} Bias</span>
              <div className="mt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Readiness</p>
                <p className="font-mono text-2xl font-black tabular-nums" style={{ color: C.cyan }}>{setup.readiness}%</p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, setup.readiness))}%`, background: `linear-gradient(90deg, ${C.blue}, ${C.cyan})` }} />
                </div>
              </div>
              <div className="mt-3.5">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Trigger checklist</p>
                {(data?.conditions ?? []).map((c, i) => (
                  <p key={i} className="flex items-center gap-2 py-1 text-[11.5px]">
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[9px]" style={{ background: c.met ? "rgba(52,211,153,0.16)" : "rgba(255,255,255,0.06)", color: c.met ? C.green : C.mut2 }}>{c.met ? "✓" : (i + 1)}</span>
                    <span style={{ color: c.met ? C.text : C.mut }}>{c.label}</span>
                  </p>
                ))}
                <p className="mt-2 text-[10px] leading-snug" style={{ color: C.mut2 }}>All three flip green → GENX takes the {buy ? "long" : "short"}.</p>
              </div>
              <LevelList setup={setup} />
            </>
          ) : (
            <p className="text-[12px]" style={{ color: C.mut }}>GENX is scanning gold. The next forming setup appears here with its entry zone, stop, targets, and the exact trigger to enter.</p>
          )}
        </div>
        {/* chart */}
        <div className="min-w-0 flex-1 p-2.5">
          <CandleChart candles={candles} setup={setup} price={price} />
        </div>
      </div>
    </div>
  );
}
function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="text-right">
      <p className="font-mono text-[13px] font-bold leading-none tabular-nums" style={{ color }}>{value}</p>
      <p className="text-[8px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>{label}</p>
    </div>
  );
}
function LevelList({ setup }: { setup: Setup }) {
  const rows: { label: string; v: number | null; color: string }[] = [
    { label: "TP3", v: setup.tp3, color: C.green }, { label: "TP2", v: setup.tp2, color: C.green }, { label: "TP1", v: setup.tp1, color: C.green },
    { label: "Entry", v: setup.entry, color: C.amber }, { label: "Stop", v: setup.stop, color: C.red }, { label: "Break", v: setup.breakLevel, color: C.blue },
  ].filter((r) => r.v != null);
  return (
    <div className="mt-3.5 border-t pt-3" style={{ borderColor: C.lineSoft }}>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Levels</p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between py-0.5 text-[11px]">
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-sm" style={{ background: r.color }} /><span style={{ color: C.mut }}>{r.label}</span></span>
          <span className="font-mono font-semibold tabular-nums">{fmt2(r.v)}</span>
        </div>
      ))}
    </div>
  );
}

function CandleChart({ candles, setup, price }: { candles: Candle[]; setup: Setup | null; price: number | null }) {
  const W = 1000, H = 460, padL = 6, padR = 152, padT = 14, padB = 26;
  const view = useMemo(() => {
    if (candles.length < 2) return null;
    const cs = candles.slice(-44);
    const levels = setup ? [setup.tp1, setup.tp2, setup.tp3, setup.stop, setup.entry, setup.entryLow, setup.entryHigh, setup.breakLevel] : [];
    const lows = cs.map((c) => c.l).concat(levels.filter((n): n is number => n != null));
    const highs = cs.map((c) => c.h).concat(levels.filter((n): n is number => n != null));
    if (price != null) { lows.push(price); highs.push(price); }
    let min = Math.min(...lows), max = Math.max(...highs);
    const pad = (max - min) * 0.08 || 1; min -= pad; max += pad;
    const plotW = W - padR - padL, plotH = H - padT - padB;
    const bw = plotW / cs.length;
    const sx = (i: number) => padL + i * bw + bw / 2;
    const sy = (v: number) => padT + (1 - (v - min) / (max - min || 1)) * plotH;
    return { cs, min, max, plotW, plotH, bw, sx, sy };
  }, [candles, setup, price]);

  if (!view) return <div className="flex h-[360px] items-center justify-center text-[12px]" style={{ color: C.mut2 }}>Loading live XAUUSD candles…</div>;
  const { cs, plotW, sx, sy, min, max } = view;
  const rightX = padL + plotW;
  const buy = setup?.side !== "sell";

  // level labels (right gutter) with simple collision avoidance
  type Lab = { v: number; text: string; color: string; strong?: boolean };
  const labs: Lab[] = [];
  if (setup) {
    const add = (v: number | null, text: string, color: string, strong = false) => { if (v != null) labs.push({ v, text, color, strong }); };
    add(setup.tp3, `TP3  ${fmt2(setup.tp3)}`, C.green);
    add(setup.tp2, `TP2  ${fmt2(setup.tp2)}`, C.green);
    add(setup.tp1, `TP1  ${fmt2(setup.tp1)}`, C.green, true);
    add(setup.entry, `ENTRY  ${fmt2(setup.entry)}`, C.amber, true);
    add(setup.stop, `STOP  ${fmt2(setup.stop)}`, C.red, true);
    add(setup.breakLevel, `BREAK  ${fmt2(setup.breakLevel)}`, C.blue);
  }
  // compute non-overlapping y positions for labels
  const labY = labs.map((l) => ({ ...l, y: sy(l.v) })).sort((a, b) => a.y - b.y);
  const MINGAP = 15;
  for (let i = 1; i < labY.length; i++) if (labY[i].y - labY[i - 1].y < MINGAP) labY[i].y = labY[i - 1].y + MINGAP;

  // y-axis price ticks
  const ticks = 5;
  const tickVals = Array.from({ length: ticks }, (_, i) => min + ((max - min) * i) / (ticks - 1));
  // sparse time labels
  const timeIdx = [0, Math.floor(cs.length / 3), Math.floor((2 * cs.length) / 3), cs.length - 1];
  const timeLbl = (t: string) => { try { return new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: false }); } catch { return ""; } };

  const eLo = setup?.entryLow ?? null, eHi = setup?.entryHigh ?? null, e = setup?.entry ?? null;
  const zLo = eLo != null && eHi != null ? Math.min(eLo, eHi) : e, zHi = eLo != null && eHi != null ? Math.max(eLo, eHi) : e;
  const furthestTp = setup ? [setup.tp1, setup.tp2, setup.tp3].filter((n): n is number => n != null).sort((a, b) => (buy ? b - a : a - b))[0] ?? null : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" style={{ maxHeight: 440 }} preserveAspectRatio="xMidYMid meet">
      {/* horizontal gridlines + price ticks */}
      {tickVals.map((tv, i) => (
        <g key={`t${i}`}>
          <line x1={padL} y1={sy(tv)} x2={rightX} y2={sy(tv)} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        </g>
      ))}

      {/* REWARD band (entry → furthest target) */}
      {setup && e != null && furthestTp != null && (
        <rect x={padL} y={sy(Math.max(e, furthestTp))} width={plotW} height={Math.abs(sy(e) - sy(furthestTp)) || 1} fill={C.green} opacity={0.06} />
      )}
      {/* RISK band (entry → stop) */}
      {setup && e != null && setup.stop != null && (
        <rect x={padL} y={sy(Math.max(e, setup.stop))} width={plotW} height={Math.abs(sy(e) - sy(setup.stop)) || 1} fill={C.red} opacity={0.06} />
      )}
      {/* ENTRY ZONE band */}
      {setup && zLo != null && zHi != null && (
        <g>
          <rect x={padL} y={sy(zHi)} width={plotW} height={Math.max(3, Math.abs(sy(zLo) - sy(zHi)))} fill={C.amber} opacity={0.16} />
          <line x1={padL} y1={sy(zHi)} x2={rightX} y2={sy(zHi)} stroke={C.amber} strokeWidth="1" strokeDasharray="4 3" opacity={0.7} />
          <line x1={padL} y1={sy(zLo)} x2={rightX} y2={sy(zLo)} stroke={C.amber} strokeWidth="1" strokeDasharray="4 3" opacity={0.7} />
          <text x={padL + 6} y={sy(zHi) - 4} fontSize="9.5" fontWeight="700" fontFamily="ui-monospace, monospace" fill={C.amber} opacity={0.9}>ENTRY ZONE</text>
        </g>
      )}
      {/* target / stop / break level lines */}
      {setup && [setup.tp1, setup.tp2, setup.tp3].map((v, i) => v != null && (
        <line key={`tp${i}`} x1={padL} y1={sy(v)} x2={rightX} y2={sy(v)} stroke={C.green} strokeWidth="1" strokeDasharray="6 4" opacity={0.45} />
      ))}
      {setup && setup.stop != null && <line x1={padL} y1={sy(setup.stop)} x2={rightX} y2={sy(setup.stop)} stroke={C.red} strokeWidth="1.2" strokeDasharray="6 4" opacity={0.7} />}
      {setup && setup.breakLevel != null && <line x1={padL} y1={sy(setup.breakLevel)} x2={rightX} y2={sy(setup.breakLevel)} stroke={C.blue} strokeWidth="1" strokeDasharray="2 3" opacity={0.6} />}

      {/* candles */}
      {cs.map((c, i) => {
        const x = sx(i);
        const up = c.c >= c.o; const col = up ? C.green : C.red;
        const bodyTop = sy(Math.max(c.o, c.c)); const bodyBot = sy(Math.min(c.o, c.c));
        const bh = Math.max(1.2, bodyBot - bodyTop);
        const cw = Math.max(2.5, view.bw * 0.66);
        return (
          <g key={i}>
            <line x1={x} y1={sy(c.h)} x2={x} y2={sy(c.l)} stroke={col} strokeWidth="1.1" opacity={0.9} />
            <rect x={x - cw / 2} y={bodyTop} width={cw} height={bh} fill={col} opacity={up ? 0.95 : 0.9} rx="0.6" />
          </g>
        );
      })}

      {/* live price line + tag */}
      {price != null && (
        <g>
          <line x1={padL} y1={sy(price)} x2={rightX} y2={sy(price)} stroke={C.cyan} strokeWidth="1" opacity={0.85} />
          <rect x={rightX + 2} y={sy(price) - 9} width={padR - 6} height={18} rx="3" fill={C.cyan} />
          <text x={rightX + 2 + (padR - 6) / 2} y={sy(price) + 4} fontSize="12" fontWeight="800" fontFamily="ui-monospace, monospace" fill="#04252b" textAnchor="middle">{fmt2(price)}</text>
        </g>
      )}

      {/* right-gutter level labels (collision-avoided) */}
      {labY.map((l, i) => (
        <g key={`lab${i}`}>
          <line x1={rightX} y1={sy(l.v)} x2={rightX + 5} y2={l.y} stroke={l.color} strokeWidth="0.8" opacity={0.5} />
          <circle cx={rightX + 8} cy={l.y} r="2" fill={l.color} />
          <text x={rightX + 13} y={l.y + 3.5} fontSize="10.5" fontWeight={l.strong ? 700 : 500} fontFamily="ui-monospace, monospace" fill={l.color} opacity={0.98}>{l.text}</text>
        </g>
      ))}

      {/* y-axis tick prices (faint, left of gutter labels not needed — put at far right top/bottom) */}
      {tickVals.filter((_, i) => i === 0 || i === ticks - 1).map((tv, i) => (
        <text key={`ty${i}`} x={rightX - 2} y={sy(tv) + (i === 0 ? -3 : 11)} fontSize="9" fontFamily="ui-monospace, monospace" fill={C.mut2} textAnchor="end">{fmt2(tv)}</text>
      ))}

      {/* time axis */}
      {timeIdx.map((ti, i) => (
        <text key={`tx${i}`} x={sx(ti)} y={H - 8} fontSize="9" fontFamily="ui-monospace, monospace" fill={C.mut2} textAnchor="middle">{timeLbl(cs[ti]?.t ?? "")}</text>
      ))}
    </svg>
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
