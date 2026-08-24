"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Zap, Activity, Radio, ChevronRight, TrendingUp, TrendingDown, Ghost, Gem, Link2, Sparkles, Circle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LIVE_URL, CALLS } from "@/lib/liveCalls";

/* ============================================================================
   THE FLOOR — dark, results-first trading command center.
   All numbers come from real sources:
     • community_signal_stats RPC  → KPIs, OM AI Plays blotter, results ledger,
       intelligence feed (open / plays-7d / resolved / wins / losses / recent[])
     • /api/flow/stats             → FLOW results panel (pips won, win rate, curve)
   Nothing on this page is fabricated; a metric with no reliable source is hidden.
   ========================================================================== */

/* palette (mockup): #0B0F14 base · #111820 panel · #1A1F2B raised · cyan #22D3EE */
const C = {
  base: "#0B0F14", panel: "#111820", raised: "#161C26", line: "rgba(255,255,255,0.07)",
  lineSoft: "rgba(255,255,255,0.045)", text: "#F1F5F9", mut: "rgba(241,245,249,0.55)",
  mut2: "rgba(241,245,249,0.38)", cyan: "#22D3EE", blue: "#3B82F6", violet: "#7C3AED",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", gold: "#FFC24B",
};

type Recent = { engine: string; instrument: string; direction: string; status: string; hit_tp: number | null; realized_r: number | null; at: string };
type Stats = {
  live: { open: number; generated_7d: number; resolved: number; wins: number; losses: number; recent: Recent[] };
  launch: { resolved: number; wins: number; losses: number };
};
type FlowStats = {
  pipsWon?: number; pipsNet?: number; pips?: number; winRate?: number | null; wins?: number; trades?: number;
  gold?: { wins: number; losses: number; pips: number; winRate: number | null; trades: number };
  forex?: { wins: number; stops: number; pips: number; winRate: number | null; trades: number; open: number };
  recent?: { symbol: string; side: string; outcome: string; win: boolean; pips: number | null; at: string }[];
  error?: string;
};

const MIN_CONFIDENT = 20;
const isLong = (d: string) => /long|buy/i.test(String(d || ""));
const short = (s: string) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const ENGINE: Record<string, string> = { scanner: "Scanner", plays: "OM Plays", command: "Command", ghost: "MFXGHOST", signal: "Signal", charts: "Charts", pulse: "Pulse", weekly: "Plays of the Week" };
const engineLabel = (e: string) => ENGINE[String(e || "").toLowerCase()] || (e ? e.charAt(0).toUpperCase() + e.slice(1) : "Desk");
function ago(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function statusMeta(status: string): { word: string; tone: "win" | "loss" | "live" | "mute" } {
  const s = String(status || "").toLowerCase();
  if (s === "win") return { word: "TARGET", tone: "win" };
  if (s === "loss") return { word: "STOPPED", tone: "loss" };
  if (s === "expired") return { word: "EXPIRED", tone: "mute" };
  return { word: "LIVE", tone: "live" };
}
const toneColor = (t: string) => (t === "win" ? C.green : t === "loss" ? C.red : t === "live" ? C.cyan : C.mut2);

function useCountUp(target: number, duration = 900) {
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
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return "";
  try {
    return now.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  } catch { return now.toLocaleTimeString(); }
}

/* ============================================================================ */

export function FloorHome({ onGo }: { onGo: (view: string) => void }) {
  const [data, setData] = useState<Stats | null>(null);
  const [flow, setFlow] = useState<FlowStats | null>(null);
  const [filter, setFilter] = useState<"all" | "live" | "wins">("all");
  const clock = useClock();

  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    const load = async () => {
      if (supabase) {
        const { data: d, error } = await supabase.rpc("community_signal_stats");
        if (!error && d && alive) setData(d as Stats);
      }
      try {
        const r = await fetch("/api/flow/stats", { cache: "no-store" });
        if (r.ok && alive) setFlow((await r.json()) as FlowStats);
      } catch { /* FLOW panel degrades gracefully */ }
    };
    void load();
    const iv = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const live = data?.live;
  const resolved = (live?.resolved ?? 0) + (data?.launch.resolved ?? 0);
  const wins = (live?.wins ?? 0) + (data?.launch.wins ?? 0);
  const losses = (live?.losses ?? 0) + (data?.launch.losses ?? 0);
  const wr = resolved >= MIN_CONFIDENT && wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  const recent = useMemo(() => live?.recent ?? [], [live]);
  const openCount = live?.open ?? 0;
  const flowNet = flow?.pipsNet ?? flow?.pips ?? 0;

  const feed = useMemo(() => {
    const t = (x: Recent) => statusMeta(x.status).tone;
    const list = filter === "live" ? recent.filter((r) => t(r) === "live")
      : filter === "wins" ? recent.filter((r) => t(r) === "win")
      : recent;
    return list.slice(0, 12);
  }, [recent, filter]);

  // Intelligence feed — real headlines only (resolved OM AI plays + FLOW closes).
  const intel = useMemo(() => {
    const items: { kind: string; text: string; tone: string; at: string }[] = [];
    for (const r of recent) {
      const m = statusMeta(r.status);
      if (m.tone !== "win" && m.tone !== "loss") continue;
      items.push({ kind: engineLabel(r.engine), tone: m.tone, at: r.at,
        text: `${short(r.instrument)} ${isLong(r.direction) ? "LONG" : "SHORT"} · ${m.tone === "win" ? "target hit" : "stopped"}${r.hit_tp != null ? ` · TP${r.hit_tp}` : ""}${r.realized_r != null ? ` · ${r.realized_r > 0 ? "+" : ""}${r.realized_r}R` : ""}` });
    }
    for (const f of (flow?.recent ?? []).slice(0, 4)) {
      items.push({ kind: "FLOW", tone: f.win ? "win" : "loss", at: f.at,
        text: `${short(f.symbol)} ${String(f.side).toUpperCase()} · ${f.win ? "win" : "loss"}${f.pips != null ? ` · ${f.pips > 0 ? "+" : ""}${f.pips}p` : ""}` });
    }
    return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 8);
  }, [recent, flow]);

  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: C.base, color: C.text }}>
      {/* ambient: faint market grid + horizon glow (very low opacity, no perf cost) */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.05]" style={{ backgroundImage: `linear-gradient(${C.cyan}22 1px,transparent 1px),linear-gradient(90deg,${C.cyan}22 1px,transparent 1px)`, backgroundSize: "38px 38px" }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-60" style={{ background: `radial-gradient(900px 260px at 82% -30%, ${C.violet}33, transparent 70%), radial-gradient(700px 220px at 15% -20%, ${C.blue}22, transparent 70%)` }} />

      <div className="relative space-y-3 p-2.5 sm:p-3.5">
        {/* ── SECTION 1 · COMMAND HEADER ── */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <span className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ background: "rgba(52,211,153,0.12)", color: C.green }}>
              <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full" style={{ background: C.green, opacity: 0.6 }} /><span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: C.green }} /></span>
              LIVE
              <span className="font-mono tabular-nums" style={{ color: C.mut }}>· {clock || "—"} CST</span>
            </span>
            <h2 className="mt-1.5 text-3xl font-black leading-none tracking-tight sm:text-[2.6rem]" style={{ letterSpacing: "-0.02em" }}>THE FLOOR</h2>
            <p className="mt-1.5 text-[13px]" style={{ color: C.mut }}>Live trading intelligence. Real results. Powered by OM AI.</p>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            {(["MARKET FEED", "OM AI", "FLOW"] as const).map((f) => (
              <span key={f} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ borderColor: C.line, color: C.mut }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.cyan, boxShadow: `0 0 6px ${C.cyan}` }} />{f}
              </span>
            ))}
          </div>
        </header>

        {/* ── SECTION 2 · KPI STRIP ── */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Kpi label="Live now" value={openCount} accent={C.cyan} live={openCount > 0} />
          <Kpi label="Plays · 7D" value={live?.generated_7d ?? 0} />
          <Kpi label="Win rate" value={wr ?? 0} suffix="%" dash={wr == null} accent={C.green} />
          <Kpi label="FLOW net pips" value={flowNet} signed accent={flowNet >= 0 ? C.green : C.red} />
          <Kpi label="Wins resolved" value={wins} />
        </div>

        {/* ── SECTION 5 · LIVE INTELLIGENCE RAIL ── */}
        {intel.length > 0 && (
          <div className="flex items-stretch overflow-hidden rounded-lg border" style={{ borderColor: C.line, background: C.panel }}>
            <div className="flex flex-shrink-0 items-center gap-1.5 border-r px-3 text-[10px] font-bold uppercase tracking-wider" style={{ borderColor: C.line, color: C.amber }}>
              <Radio className="h-3.5 w-3.5" /> Live
            </div>
            <div className="relative flex-1 overflow-hidden">
              <div className="flex w-max gap-8 whitespace-nowrap py-2 pl-6" style={{ animation: "floorMarquee 40s linear infinite" }}>
                {[...intel, ...intel].map((it, i) => (
                  <span key={i} className="inline-flex items-center gap-2 text-[12px]">
                    <span className="font-bold uppercase tracking-wide" style={{ color: it.tone === "win" ? C.green : it.tone === "loss" ? C.red : C.cyan }}>{it.kind}</span>
                    <span style={{ color: C.mut }}>{it.text}</span>
                    <span className="font-mono" style={{ color: C.mut2 }}>· {ago(it.at)}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── SECTIONS 3 + 4 · OM AI PLAYS (≈60%) + FLOW RESULTS (≈40%) ── */}
        <div className="grid gap-3 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
              <p className="inline-flex items-center gap-2 text-[13px] font-bold"><Zap className="h-4 w-4" style={{ color: C.cyan }} /> Live OM AI Plays</p>
              <div className="flex gap-1">
                {(["all", "live", "wins"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} className="rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors"
                    style={filter === f ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: C.mut }}>{f}</button>
                ))}
              </div>
            </div>
            <PlaysBlotter rows={feed} />
          </section>

          <section className="lg:col-span-2 rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <FlowPanel flow={flow} onConnect={() => onGo("flow")} />
          </section>
        </div>

        {/* ── SECTION 6 · TOOL LAUNCHERS ── */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <ToolTile href="/portal/genx" icon={Gem} name="GENX" desc="Gold intelligence engine" flagship status="FLAGSHIP" />
          <ToolTile onClick={() => onGo("flow")} icon={Link2} name="FLOW" desc="AI trade desk · TradeLocker" accent={C.cyan} status={flow && (flow.trades ?? 0) > 0 ? "ACTIVE" : "CONNECT"} />
          <ToolTile href="/portal/om-ai" icon={Sparkles} name="OM AI" desc="Ask the desk anything" />
          <ToolTile href="/portal/signals" icon={Zap} name="OM AI Plays" desc="Live called setups" />
          <ToolTile onClick={() => onGo("pulse")} icon={Activity} name="Market Pulse" desc="AI market scanner" />
          <ToolTile onClick={() => onGo("plays")} icon={TrendingUp} name="Live Plays" desc="Plays of the week" />
          <ToolTile href="/portal/xaughost" icon={Ghost} name="xGhost" desc="5-pair AI scanner" />
          <LiveDeskTile />
        </div>

        {/* ── SECTION 7 · RESULTS LEDGER ── */}
        <section className="rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
          <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
            <p className="inline-flex items-center gap-2 text-[13px] font-bold"><Circle className="h-3.5 w-3.5" style={{ color: C.green }} /> Recent Results</p>
            <span className="text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>Desk blotter</span>
          </div>
          <Ledger rows={recent.slice(0, 8)} />
        </section>

        <p className="pb-1 text-center text-[11px]" style={{ color: C.mut2 }}>
          Real results from the AI desk · educational analysis, not financial advice.
        </p>
      </div>

      <style>{`@keyframes floorMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}@keyframes floorFlash{0%{background:rgba(34,211,238,0.18)}100%{background:transparent}}`}</style>
    </div>
  );
}

/* ── KPI tile ── */
function Kpi({ label, value, suffix = "", prefix = "", dash = false, accent = C.text, live = false, signed = false }: { label: string; value: number; suffix?: string; prefix?: string; dash?: boolean; accent?: string; live?: boolean; signed?: boolean }) {
  const v = useCountUp(value);
  const rounded = Math.round(v);
  const pre = signed ? (rounded >= 0 ? "+" : "") : prefix;
  return (
    <div className="relative overflow-hidden rounded-lg border px-3 py-2.5" style={{ borderColor: C.line, background: C.panel }}>
      {live && <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full" style={{ background: C.cyan, boxShadow: `0 0 6px ${C.cyan}` }} />}
      <p className="font-mono text-[22px] font-black leading-none tabular-nums sm:text-[26px]" style={{ color: dash ? C.mut2 : accent }}>
        {dash ? "—" : `${pre}${rounded.toLocaleString()}${suffix}`}
      </p>
      <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>{label}</p>
    </div>
  );
}

/* ── OM AI Plays blotter ── */
function tp(hit: number | null, n: number, live: boolean) {
  const h = Number(hit);
  if (Number.isFinite(h) && h >= n) return <span style={{ color: C.green }}>✓</span>;
  if (live) return <span style={{ color: C.mut2 }}>·</span>;
  return <span style={{ color: C.mut2 }}>—</span>;
}
function PlaysBlotter({ rows }: { rows: Recent[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-10 text-center"><p className="text-sm font-semibold" style={{ color: C.mut }}>Desk quiet</p><p className="mt-1 text-[12px]" style={{ color: C.mut2 }}>OM AI is scanning the market — no qualified setups active right now.</p></div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[12px]">
        <thead>
          <tr style={{ color: C.mut2 }} className="text-left text-[10px] uppercase tracking-wider">
            <th className="px-3.5 py-2 font-semibold">Pair</th>
            <th className="py-2 font-semibold">Dir</th>
            <th className="py-2 font-semibold">Engine</th>
            <th className="py-2 text-center font-semibold">TP1</th>
            <th className="py-2 text-center font-semibold">TP2</th>
            <th className="py-2 text-center font-semibold">TP3</th>
            <th className="py-2 font-semibold">Status</th>
            <th className="px-3.5 py-2 text-right font-semibold">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const m = statusMeta(r.status);
            const long = isLong(r.direction);
            const isLive = m.tone === "live";
            const rr = r.realized_r != null ? `${r.realized_r > 0 ? "+" : ""}${r.realized_r}R` : "";
            return (
              <tr key={`${r.instrument}-${r.at}-${i}`} className="border-t" style={{ borderColor: C.lineSoft }}>
                <td className="px-3.5 py-2 font-mono font-bold">{short(r.instrument).slice(0, 6)}</td>
                <td className="py-2"><span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={long ? { background: "rgba(52,211,153,0.12)", color: C.green } : { background: "rgba(248,113,113,0.12)", color: C.red }}>{long ? "LONG" : "SHORT"}</span></td>
                <td className="py-2" style={{ color: C.mut }}>{engineLabel(r.engine)}</td>
                <td className="py-2 text-center font-mono">{tp(r.hit_tp, 1, isLive)}</td>
                <td className="py-2 text-center font-mono">{tp(r.hit_tp, 2, isLive)}</td>
                <td className="py-2 text-center font-mono">{tp(r.hit_tp, 3, isLive)}</td>
                <td className="py-2">
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: toneColor(m.tone) }}>
                    {isLive && <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.cyan, boxShadow: `0 0 5px ${C.cyan}` }} />}{m.word}
                  </span>
                </td>
                <td className="px-3.5 py-2 text-right font-mono font-bold" style={{ color: m.tone === "win" ? C.green : m.tone === "loss" ? C.red : C.mut }}>{rr || <span style={{ color: C.mut2 }}>{ago(r.at)}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── FLOW results panel (real /api/flow/stats) ── */
function FlowPanel({ flow, onConnect }: { flow: FlowStats | null; onConnect: () => void }) {
  const rec = flow?.recent ?? [];
  const hasData = !!flow && !flow.error && (flow.trades ?? 0) > 0;
  const net = flow?.pipsNet ?? flow?.pips ?? 0;
  // cumulative pips curve (chronological)
  const curve = useMemo(() => {
    const chron = [...rec].reverse();
    let cum = 0; const pts = chron.map((r) => { cum += Number(r.pips) || 0; return cum; });
    return pts;
  }, [rec]);
  const path = useMemo(() => {
    if (curve.length < 2) return null;
    const w = 100, h = 40, min = Math.min(0, ...curve), max = Math.max(1, ...curve);
    const sx = (i: number) => (i / (curve.length - 1)) * w;
    const sy = (v: number) => h - ((v - min) / (max - min || 1)) * h;
    return { d: curve.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" "), sy0: sy(0).toFixed(1) };
  }, [curve]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-2 text-[13px] font-bold"><Link2 className="h-4 w-4" style={{ color: C.cyan }} /> FLOW Results</p>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>Auto desk</span>
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
            <div>
              <p className="font-mono text-[30px] font-black leading-none tabular-nums" style={{ color: net >= 0 ? C.green : C.red }}>{net >= 0 ? "+" : ""}{net.toLocaleString()}</p>
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut }}>Net pips</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-lg font-black tabular-nums">{flow?.winRate != null ? `${flow.winRate}%` : "—"}</p>
              <p className="text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>{flow?.trades ?? 0} trades</p>
            </div>
          </div>

          {path && (
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-3 h-16 w-full" style={{ overflow: "visible" }}>
              <line x1="0" y1={path.sy0} x2="100" y2={path.sy0} stroke={C.line} strokeWidth="0.5" strokeDasharray="2 2" />
              <path d={path.d} fill="none" stroke={C.cyan} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          )}

          <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
            <SplitStat label="Gold" wins={flow?.gold?.wins ?? 0} losses={flow?.gold?.losses ?? 0} pips={flow?.gold?.pips ?? 0} accent={C.gold} />
            <SplitStat label="Forex" wins={flow?.forex?.wins ?? 0} losses={flow?.forex?.stops ?? 0} pips={flow?.forex?.pips ?? 0} accent={C.blue} />
          </div>
        </div>
      )}
    </div>
  );
}
function SplitStat({ label, wins, losses, pips, accent }: { label: string; wins: number; losses: number; pips: number; accent: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: C.lineSoft, background: C.raised }}>
      <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: accent }}>{label}</p>
      <p className="mt-0.5 font-mono text-sm font-bold tabular-nums">{wins}<span style={{ color: C.mut2 }}>W</span> · {losses}<span style={{ color: C.mut2 }}>L</span></p>
      <p className="font-mono text-[11px]" style={{ color: C.green }}>+{pips.toLocaleString()}p</p>
    </div>
  );
}

/* ── tool launcher tile ── */
function ToolTile({ href, onClick, icon: Icon, name, desc, status, accent = C.text, flagship = false }: { href?: string; onClick?: () => void; icon: typeof Radio; name: string; desc: string; status?: string; accent?: string; flagship?: boolean }) {
  const inner = (
    <>
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition group-hover:scale-105" style={{ background: flagship ? "rgba(255,194,75,0.12)" : "rgba(255,255,255,0.05)", color: flagship ? C.gold : accent }}>
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] font-bold" style={flagship ? { color: C.gold } : undefined}>{name}
          {status && <span className="rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider" style={flagship ? { background: "rgba(255,194,75,0.14)", color: C.gold } : { background: "rgba(34,211,238,0.12)", color: C.cyan }}>{status}</span>}
        </p>
        <p className="truncate text-[11px]" style={{ color: C.mut2 }}>{desc}</p>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 transition group-hover:translate-x-0.5" style={{ color: C.mut2 }} />
    </>
  );
  const cls = "group flex items-center gap-2.5 rounded-xl border px-3 py-3 text-left transition hover:border-[rgba(34,211,238,0.4)]";
  const style = { borderColor: flagship ? "rgba(255,194,75,0.3)" : C.line, background: flagship ? "linear-gradient(120% 120% at 0% 0%, rgba(255,194,75,0.08), transparent 55%), #111820" : C.panel };
  if (href) return <Link href={href} className={cls} style={style}>{inner}</Link>;
  return <button onClick={onClick} className={cls} style={style}>{inner}</button>;
}

/* ── compact live-desk (Zoom) tile ── */
function LiveDeskTile() {
  const next = CALLS.find((c) => c.hot) ?? CALLS[CALLS.length - 1];
  return (
    <a href={LIVE_URL} target="_blank" rel="noreferrer" className="group flex items-center gap-2.5 rounded-xl border px-3 py-3 text-left transition hover:border-[rgba(248,113,113,0.5)]" style={{ borderColor: "rgba(248,113,113,0.28)", background: "linear-gradient(120% 120% at 0% 0%, rgba(248,113,113,0.07), transparent 55%), #111820" }}>
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(248,113,113,0.12)", color: C.red }}>
        <Radio className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] font-bold">Live Desk
          <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full" style={{ background: C.red, opacity: 0.6 }} /><span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: C.red }} /></span>
        </p>
        <p className="truncate text-[11px]" style={{ color: C.mut2 }}>Next {next?.t} CST · join</p>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 transition group-hover:translate-x-0.5" style={{ color: C.mut2 }} />
    </a>
  );
}

/* ── results ledger (compact blotter) ── */
function Ledger({ rows }: { rows: Recent[] }) {
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-[12px]" style={{ color: C.mut2 }}>No resolved results yet — they post here as the desk closes trades.</p>;
  return (
    <div className="divide-y" style={{ borderColor: C.lineSoft }}>
      {rows.map((r, i) => {
        const m = statusMeta(r.status);
        const long = isLong(r.direction);
        const rr = r.realized_r != null ? `${r.realized_r > 0 ? "+" : ""}${r.realized_r}R` : m.word;
        return (
          <div key={`${r.instrument}-${r.at}-${i}`} className="flex items-center gap-3 px-3.5 py-2" style={{ borderColor: C.lineSoft }}>
            <span className="font-mono text-[12px] font-bold" style={{ width: 62 }}>{short(r.instrument).slice(0, 6)}</span>
            <span className="text-[11px]" style={{ color: C.mut, width: 74 }}>{engineLabel(r.engine)}</span>
            <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={long ? { background: "rgba(52,211,153,0.12)", color: C.green } : { background: "rgba(248,113,113,0.12)", color: C.red }}>{long ? "LONG" : "SHORT"}</span>
            <span className="ml-auto inline-flex items-center gap-1 font-mono text-[12px] font-bold" style={{ color: toneColor(m.tone) }}>
              {m.tone === "win" ? <TrendingUp className="h-3.5 w-3.5" /> : m.tone === "loss" ? <TrendingDown className="h-3.5 w-3.5" /> : null}{rr}
            </span>
            <span className="font-mono text-[11px]" style={{ color: C.mut2, width: 38, textAlign: "right" }}>{ago(r.at)}</span>
          </div>
        );
      })}
    </div>
  );
}
