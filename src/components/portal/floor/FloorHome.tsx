"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Filter, Zap, Clock, ChevronRight, Maximize2 } from "lucide-react";
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
type SetupPayload = { setup: Setup | null; candles: Candle[]; price: number | null; session: string; conditions: { label: string; met: boolean }[]; statusText: string };
type IntelEvent = { time: string; ts: number; headline: string; impact: "HIGH" | "MED" | "LOW"; assets: string[]; when: string };
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

/* ── SETUP FORMING (live GENX gold + candlestick chart) ── */
function SetupForming({ data, onExpand }: { data: SetupPayload | null; onExpand: () => void }) {
  const setup = data?.setup ?? null;
  const candles = data?.candles ?? [];
  const price = data?.price ?? (candles.length ? candles[candles.length - 1].c : null);
  const buy = setup?.side !== "sell";
  const TFS = ["1m", "5m", "15m", "1h", "4h", "1D"];

  return (
    <div>
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider"><Zap className="h-3.5 w-3.5" style={{ color: C.cyan }} /> Setup Forming</p>
        <div className="flex items-center gap-1">
          {TFS.map((t) => (
            <span key={t} className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={t === "15m" ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: C.mut2 }}>{t}</span>
          ))}
          <button onClick={onExpand} className="ml-1 rounded p-1" style={{ color: C.mut2 }} aria-label="Expand"><Maximize2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="flex flex-col md:flex-row">
        {/* left rail */}
        <div className="w-full flex-shrink-0 border-b p-3.5 md:w-52 md:border-b-0 md:border-r" style={{ borderColor: C.line }}>
          <p className="text-2xl font-black tracking-tight">XAUUSD</p>
          <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>Gold / US Dollar</p>
          {setup ? (
            <>
              <span className="mt-2.5 inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={buy ? { background: "rgba(52,211,153,0.14)", color: C.green } : { background: "rgba(248,113,113,0.14)", color: C.red }}>{buy ? "Long" : "Short"} Bias</span>
              <div className="mt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Readiness</p>
                <p className="font-mono text-xl font-black tabular-nums" style={{ color: C.cyan }}>{setup.readiness}%</p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, setup.readiness))}%`, background: `linear-gradient(90deg, ${C.blue}, ${C.cyan})` }} />
                </div>
              </div>
              <div className="mt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Status</p>
                <p className="text-[12px] font-bold" style={{ color: C.amber }}>{(data?.statusText ?? "").toUpperCase()}</p>
              </div>
              <div className="mt-3">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Conditions</p>
                {(data?.conditions ?? []).map((c, i) => (
                  <p key={i} className="flex items-center gap-1.5 py-0.5 text-[11px]">
                    <span style={{ color: c.met ? C.green : C.mut2 }}>{c.met ? "✓" : "○"}</span>
                    <span style={{ color: c.met ? C.text : C.mut }}>{c.label}</span>
                  </p>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-3 text-[12px]" style={{ color: C.mut }}>GENX is scanning gold. The next forming setup appears here with its entry, stop, targets, and live readiness.</p>
          )}
        </div>
        {/* chart */}
        <div className="min-w-0 flex-1 p-2">
          <CandleChart candles={candles} setup={setup} price={price} />
        </div>
      </div>
    </div>
  );
}

function CandleChart({ candles, setup, price }: { candles: Candle[]; setup: Setup | null; price: number | null }) {
  const W = 1000, H = 380, padR = 86, padT = 12, padB = 20;
  const view = useMemo(() => {
    if (candles.length < 2) return null;
    const cs = candles.slice(-60);
    const levels = setup ? [setup.tp1, setup.tp2, setup.tp3, setup.stop, setup.entry, setup.entryLow, setup.entryHigh, setup.breakLevel] : [];
    const lows = cs.map((c) => c.l).concat(levels.filter((n): n is number => n != null));
    const highs = cs.map((c) => c.h).concat(levels.filter((n): n is number => n != null));
    if (price != null) { lows.push(price); highs.push(price); }
    let min = Math.min(...lows), max = Math.max(...highs);
    const pad = (max - min) * 0.06 || 1; min -= pad; max += pad;
    const plotW = W - padR, plotH = H - padT - padB;
    const bw = plotW / cs.length;
    const sy = (v: number) => padT + (1 - (v - min) / (max - min || 1)) * plotH;
    return { cs, min, max, plotW, plotH, bw, sy };
  }, [candles, setup, price]);

  if (!view) return <div className="flex h-[300px] items-center justify-center text-[12px]" style={{ color: C.mut2 }}>Loading XAUUSD candles…</div>;
  const { cs, plotW, bw, sy } = view;

  const lines: { v: number; label: string; color: string; dash?: boolean }[] = [];
  if (setup) {
    const push = (v: number | null, label: string, color: string, dash = true) => { if (v != null) lines.push({ v, label, color, dash }); };
    push(setup.tp3, `TARGET 3  ${fmt2(setup.tp3)}`, C.green);
    push(setup.tp2, `TARGET 2  ${fmt2(setup.tp2)}`, C.green);
    push(setup.tp1, `TARGET 1  ${fmt2(setup.tp1)}`, C.green);
    push(setup.breakLevel, `BREAK  ${fmt2(setup.breakLevel)}`, C.blue);
    push(setup.entry, `ENTRY  ${fmt2(setup.entry)}`, C.amber);
    push(setup.stop, `STOP  ${fmt2(setup.stop)}`, C.red);
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" style={{ maxHeight: 360 }} preserveAspectRatio="xMidYMid meet">
      {/* entry zone band */}
      {setup && setup.entryLow != null && setup.entryHigh != null && (
        <rect x={0} y={sy(Math.max(setup.entryLow, setup.entryHigh))} width={plotW} height={Math.abs(sy(setup.entryLow) - sy(setup.entryHigh)) || 2} fill={C.amber} opacity={0.07} />
      )}
      {/* target zones (shaded above entry to targets) */}
      {lines.filter((l) => l.color === C.green).map((l, i) => (
        <line key={`gl${i}`} x1={0} y1={sy(l.v)} x2={plotW} y2={sy(l.v)} stroke={l.color} strokeWidth="1" strokeDasharray="5 4" opacity={0.5} />
      ))}
      {lines.filter((l) => l.color !== C.green).map((l, i) => (
        <line key={`ll${i}`} x1={0} y1={sy(l.v)} x2={plotW} y2={sy(l.v)} stroke={l.color} strokeWidth="1" strokeDasharray={l.color === C.blue ? "2 3" : "5 4"} opacity={0.6} />
      ))}
      {/* right-edge labels */}
      {lines.map((l, i) => (
        <text key={`lb${i}`} x={plotW + 6} y={sy(l.v) + 3} fontSize="10" fontFamily="ui-monospace, monospace" fill={l.color} opacity={0.95}>{l.label}</text>
      ))}
      {/* candles */}
      {cs.map((c, i) => {
        const x = i * bw + bw / 2;
        const up = c.c >= c.o; const col = up ? C.green : C.red;
        const bodyTop = sy(Math.max(c.o, c.c)); const bodyBot = sy(Math.min(c.o, c.c));
        const bh = Math.max(1, bodyBot - bodyTop);
        const cw = Math.max(1.5, bw * 0.62);
        return (
          <g key={i}>
            <line x1={x} y1={sy(c.h)} x2={x} y2={sy(c.l)} stroke={col} strokeWidth="1" opacity={0.85} />
            <rect x={x - cw / 2} y={bodyTop} width={cw} height={bh} fill={col} opacity={up ? 0.9 : 0.85} rx="0.5" />
          </g>
        );
      })}
      {/* live price tag */}
      {price != null && (
        <g>
          <line x1={0} y1={sy(price)} x2={plotW} y2={sy(price)} stroke={C.cyan} strokeWidth="0.8" opacity={0.5} />
          <rect x={plotW} y={sy(price) - 9} width={padR} height={18} rx="2" fill={C.cyan} />
          <text x={plotW + padR / 2} y={sy(price) + 3.5} fontSize="11" fontWeight="700" fontFamily="ui-monospace, monospace" fill="#04252b" textAnchor="middle">{fmt2(price)}</text>
        </g>
      )}
    </svg>
  );
}

/* ── MARKET INTELLIGENCE (calendar + desk activity) ── */
function MarketIntel({ intel, flow }: { intel: IntelPayload | null; flow: FlowStats | null }) {
  type Item = { time: string; ts: number; headline: string; impact: string; tone: "high" | "med" | "low" | "win" | "loss"; assets: string[] };
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const e of intel?.events ?? []) {
      out.push({ time: e.time, ts: e.ts, headline: e.headline, impact: e.impact, tone: e.impact === "HIGH" ? "high" : e.impact === "MED" ? "med" : "low", assets: e.assets });
    }
    for (const g of flow?.goldRecent ?? []) {
      const ts = new Date(g.at).getTime(); if (!Number.isFinite(ts)) continue;
      out.push({ time: clockTime(g.at), ts, headline: `GENX gold ${genxLong(g.side) ? "LONG" : "SHORT"} ${g.win ? "hit target" : "stopped"}${g.pips != null ? ` (${g.pips > 0 ? "+" : ""}${g.pips}p)` : ""}`, impact: g.win ? "WIN" : "LOSS", tone: g.win ? "win" : "loss", assets: ["XAUUSD"] });
    }
    for (const f of flow?.forexRecent ?? []) {
      const ts = new Date(f.at).getTime(); if (!Number.isFinite(ts)) continue;
      out.push({ time: clockTime(f.at), ts, headline: `FLOW ${short(f.symbol)} ${String(f.side).toUpperCase()} ${f.win ? "win" : "loss"}${f.pips != null ? ` (${f.pips > 0 ? "+" : ""}${f.pips}p)` : ""}`, impact: f.win ? "WIN" : "LOSS", tone: f.win ? "win" : "loss", assets: [short(f.symbol)] });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 12);
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
        <div className="flex items-center gap-2 border-b px-3.5 py-2" style={{ borderColor: C.line, background: "rgba(251,191,36,0.06)" }}>
          <Zap className="h-3.5 w-3.5 flex-shrink-0" style={{ color: C.amber }} />
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: C.amber }}>Featured Alert</p>
            <p className="truncate text-[12px] font-semibold">{feat.headline} <span style={{ color: C.mut }}>expected {feat.when}</span></p>
          </div>
          <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "rgba(248,113,113,0.16)", color: C.red }}>{feat.impact} IMPACT</span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto" style={{ maxHeight: 360 }}>
        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12px]" style={{ color: C.mut2 }}>Intelligence feed syncing…</p>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0" style={{ background: C.panel }}>
              <tr style={{ color: C.mut2 }} className="text-left text-[9px] uppercase tracking-wider">
                <th className="px-3.5 py-2 font-semibold">Time</th>
                <th className="py-2 font-semibold">Headline</th>
                <th className="py-2 font-semibold">Impact</th>
                <th className="px-3.5 py-2 text-right font-semibold">Assets</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t align-top" style={{ borderColor: C.lineSoft }}>
                  <td className="whitespace-nowrap px-3.5 py-2 font-mono" style={{ color: C.mut }}>{it.time}</td>
                  <td className="py-2 pr-2" style={{ color: C.text }}>{it.headline}</td>
                  <td className="py-2"><span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: toneBg(it.tone), color: toneColor(it.tone) }}>{it.impact}</span></td>
                  <td className="px-3.5 py-2 text-right font-mono text-[10px]" style={{ color: C.mut }}>{it.assets.slice(0, 2).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
