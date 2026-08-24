"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Zap, Activity, Radio, ChevronRight, TrendingUp, TrendingDown, Ghost, Gem, Link2, Sparkles } from "lucide-react";
import { LIVE_URL, CALLS } from "@/lib/liveCalls";

/* ============================================================================
   THE FLOOR — dark, results-first trading command center.
   Every number is real, all from /api/flow/stats:
     • KPI strip        → live desk (open positions, 7-day plays, win rate, net pips)
     • GENX Results     → the GENX gold record (deduped, price-derived)
     • FLOW Results     → the FLOW net-pips summary + curve
     • FLOW Trades      → the FLOW forex trade blotter
   ========================================================================== */

/* palette (mockup): #0B0F14 base · #111820 panel · #1A1F2B raised · cyan #22D3EE */
const C = {
  base: "#0B0F14", panel: "#111820", raised: "#161C26", line: "rgba(255,255,255,0.07)",
  lineSoft: "rgba(255,255,255,0.045)", text: "#F1F5F9", mut: "rgba(241,245,249,0.55)",
  mut2: "rgba(241,245,249,0.38)", cyan: "#22D3EE", blue: "#3B82F6", violet: "#7C3AED",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", gold: "#FFC24B",
};

type GoldRec = { symbol: string; side: string; outcome: string; win: boolean; hitTp: number; pips: number | null; at: string };
type FlowRec = { symbol: string; side: string; outcome: string; win: boolean; pips: number | null; at: string };
type FlowStats = {
  pipsWon?: number; pipsNet?: number; pips?: number; winRate?: number | null; wins?: number; trades?: number;
  liveOpen?: number; plays7d?: number;
  gold?: { wins: number; losses: number; pips: number; winRate: number | null; trades: number };
  forex?: { wins: number; stops: number; pips: number; winRate: number | null; trades: number; open: number };
  recent?: { symbol: string; side: string; outcome: string; win: boolean; pips: number | null; at: string }[];
  goldRecent?: GoldRec[];
  forexRecent?: FlowRec[];
  error?: string;
};

const isLong = (d: string) => /long|buy/i.test(String(d || ""));
const genxLong = (d: string) => /bull|long|buy/i.test(String(d || ""));
const short = (s: string) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
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
  const [flow, setFlow] = useState<FlowStats | null>(null);
  const [filter, setFilter] = useState<"all" | "wins" | "losses">("all");
  const clock = useClock();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/flow/stats", { cache: "no-store" });
        if (r.ok && alive) setFlow((await r.json()) as FlowStats);
      } catch { /* degrades gracefully */ }
    };
    void load();
    const iv = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const liveOpen = flow?.liveOpen ?? 0;
  const deskWr = flow?.winRate ?? null;
  const deskWins = flow?.wins ?? 0;
  const plays7d = flow?.plays7d ?? 0;
  const flowNet = flow?.pipsNet ?? flow?.pips ?? 0;

  // GENX gold results, filtered for the blotter.
  const goldRows = useMemo(() => {
    const all = flow?.goldRecent ?? [];
    const list = filter === "wins" ? all.filter((g) => g.win) : filter === "losses" ? all.filter((g) => !g.win) : all;
    return list.slice(0, 12);
  }, [flow, filter]);
  const forexRows = useMemo(() => (flow?.forexRecent ?? []).slice(0, 8), [flow]);

  // Intelligence rail — real desk headlines (GENX gold + FLOW forex closes).
  const intel = useMemo(() => {
    const items: { kind: string; text: string; tone: string; at: string }[] = [];
    for (const g of flow?.goldRecent ?? []) {
      items.push({ kind: "GENX", tone: g.win ? "win" : "loss", at: g.at,
        text: `XAUUSD ${genxLong(g.side) ? "LONG" : "SHORT"} · ${g.win ? "target" : "stopped"}${g.pips != null ? ` · ${g.pips > 0 ? "+" : ""}${g.pips}p` : ""}` });
    }
    for (const f of flow?.forexRecent ?? []) {
      items.push({ kind: "FLOW", tone: f.win ? "win" : "loss", at: f.at,
        text: `${short(f.symbol)} ${String(f.side).toUpperCase()} · ${f.win ? "win" : "loss"}${f.pips != null ? ` · ${f.pips > 0 ? "+" : ""}${f.pips}p` : ""}` });
    }
    return items.filter((x) => x.at).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 8);
  }, [flow]);

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
          <Kpi label="Live now" value={liveOpen} accent={C.cyan} live={liveOpen > 0} />
          <Kpi label="Plays · 7D" value={plays7d} />
          <Kpi label="Win rate" value={deskWr ?? 0} suffix="%" dash={deskWr == null} accent={C.green} />
          <Kpi label="FLOW net pips" value={flowNet} signed accent={flowNet >= 0 ? C.green : C.red} />
          <Kpi label="Wins resolved" value={deskWins} />
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
                    <span className="font-bold uppercase tracking-wide" style={{ color: it.kind === "GENX" ? C.gold : C.cyan }}>{it.kind}</span>
                    <span style={{ color: it.tone === "win" ? C.green : C.red }}>{it.text}</span>
                    <span className="font-mono" style={{ color: C.mut2 }}>· {ago(it.at)}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── SECTIONS 3 + 4 · GENX RESULTS (≈60%) + FLOW RESULTS (≈40%) ── */}
        <div className="grid gap-3 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
              <p className="inline-flex items-center gap-2 text-[13px] font-bold"><Gem className="h-4 w-4" style={{ color: C.gold }} /> GENX Results <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>· Gold</span></p>
              <div className="flex gap-1">
                {(["all", "wins", "losses"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} className="rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors"
                    style={filter === f ? { background: "rgba(255,194,75,0.16)", color: C.gold } : { color: C.mut }}>{f}</button>
                ))}
              </div>
            </div>
            <GenxBlotter rows={goldRows} />
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

        {/* ── SECTION 7 · FLOW TRADES LEDGER ── */}
        <section className="rounded-xl border" style={{ borderColor: C.line, background: C.panel }}>
          <div className="flex items-center justify-between border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
            <p className="inline-flex items-center gap-2 text-[13px] font-bold"><Link2 className="h-3.5 w-3.5" style={{ color: C.cyan }} /> FLOW Trades <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mut2 }}>· Forex</span></p>
            <span className="text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>Auto desk blotter</span>
          </div>
          <FlowLedger rows={forexRows} />
        </section>

        <p className="pb-1 text-center text-[11px]" style={{ color: C.mut2 }}>
          Real results from the AI desk · educational analysis, not financial advice.
        </p>
      </div>

      <style>{`@keyframes floorMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
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

/* ── GENX gold results blotter ── */
function tpMark(hit: number, n: number) {
  if (hit >= n) return <span style={{ color: C.green }}>✓</span>;
  return <span style={{ color: C.mut2 }}>—</span>;
}
function GenxBlotter({ rows }: { rows: GoldRec[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-10 text-center"><p className="text-sm font-semibold" style={{ color: C.mut }}>Desk quiet</p><p className="mt-1 text-[12px]" style={{ color: C.mut2 }}>No graded GENX gold results in this view yet.</p></div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[500px] text-[12px]">
        <thead>
          <tr style={{ color: C.mut2 }} className="text-left text-[10px] uppercase tracking-wider">
            <th className="px-3.5 py-2 font-semibold">Pair</th>
            <th className="py-2 font-semibold">Dir</th>
            <th className="py-2 text-center font-semibold">TP1</th>
            <th className="py-2 text-center font-semibold">TP2</th>
            <th className="py-2 text-center font-semibold">TP3</th>
            <th className="py-2 font-semibold">Status</th>
            <th className="px-3.5 py-2 text-right font-semibold">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const long = genxLong(r.side);
            const pips = r.pips ?? 0;
            return (
              <tr key={`${r.at}-${i}`} className="border-t" style={{ borderColor: C.lineSoft }}>
                <td className="px-3.5 py-2 font-mono font-bold">XAUUSD</td>
                <td className="py-2"><span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={long ? { background: "rgba(52,211,153,0.12)", color: C.green } : { background: "rgba(248,113,113,0.12)", color: C.red }}>{long ? "LONG" : "SHORT"}</span></td>
                <td className="py-2 text-center font-mono">{tpMark(r.hitTp, 1)}</td>
                <td className="py-2 text-center font-mono">{tpMark(r.hitTp, 2)}</td>
                <td className="py-2 text-center font-mono">{tpMark(r.hitTp, 3)}</td>
                <td className="py-2"><span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: r.win ? C.green : C.red }}>{r.win ? "TARGET" : "STOPPED"}</span></td>
                <td className="px-3.5 py-2 text-right font-mono font-bold" style={{ color: r.win ? C.green : C.red }}>{pips > 0 ? "+" : ""}{pips.toLocaleString()}p</td>
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

/* ── FLOW forex trades ledger ── */
function FlowLedger({ rows }: { rows: FlowRec[] }) {
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-[12px]" style={{ color: C.mut2 }}>No FLOW forex trades yet — they post here as the desk closes trades.</p>;
  return (
    <div className="divide-y" style={{ borderColor: C.lineSoft }}>
      {rows.map((r, i) => {
        const long = isLong(r.side);
        const pips = r.pips;
        return (
          <div key={`${r.symbol}-${r.at}-${i}`} className="flex items-center gap-3 px-3.5 py-2" style={{ borderColor: C.lineSoft }}>
            <span className="font-mono text-[12px] font-bold" style={{ width: 62 }}>{short(r.symbol).slice(0, 6)}</span>
            <span className="text-[11px]" style={{ color: C.mut, width: 52 }}>FLOW</span>
            <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={long ? { background: "rgba(52,211,153,0.12)", color: C.green } : { background: "rgba(248,113,113,0.12)", color: C.red }}>{long ? "LONG" : "SHORT"}</span>
            <span className="ml-auto inline-flex items-center gap-1 font-mono text-[12px] font-bold" style={{ color: r.win ? C.green : C.red }}>
              {r.win ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{pips != null ? `${pips > 0 ? "+" : ""}${pips}p` : (r.win ? "WIN" : "LOSS")}
            </span>
            <span className="font-mono text-[11px]" style={{ color: C.mut2, width: 38, textAlign: "right" }}>{ago(r.at)}</span>
          </div>
        );
      })}
    </div>
  );
}
