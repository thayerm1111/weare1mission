"use client";

import { useEffect, useMemo, useState } from "react";
import { Radio, Trophy, Lightbulb, Minus, Users, Target, ShieldCheck, TrendingUp, TrendingDown, Crosshair } from "lucide-react";

/* ============================================================================
   LIVE TRADE CARD (owner 09-17) — the first thing members see on the dashboard
   and The Floor: the GENX trade that is live right now (running pips, price
   between stop and target, how many accounts are riding it) and the last 3
   trades graded WIN / LESSON. Data: /api/floor/live-trade, polled every 10s.
   ========================================================================== */

type Grade = "WIN" | "LESSON" | "BREAKEVEN" | "CLOSED";
type Live = { side: "BUY" | "SELL"; openedAt: string; accountsIn: number; entry: number | null; stop: number | null; target: number | null; setup: string; confidence: number | null; price: number | null; pips: number | null };
type Recent = { at: string; side: string; pips: number | null; accounts: number; grade: Grade };
type Payload = { live: Live | null; recent: Recent[]; streak?: number; streakPips?: number; bestStreak?: number; bestStreakPips?: number };

const K = { panel: "#0B1017", raised: "#121A24", line: "rgba(255,255,255,0.08)", text: "#EEF4FA", mut: "rgba(238,244,250,0.62)", mut2: "rgba(238,244,250,0.40)", green: "#34D399", greenDeep: "#059669", rose: "#FB7185", amber: "#FBBF24", cyan: "#22D3EE", gold: "#FFC24B" };

function useNow(ms = 1000) {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setN(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return n;
}
function dur(fromIso: string, now: number) {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}
function ago(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const fmt = (n: number | null | undefined, dp = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }));

function useCountUp(target: number | null, ms = 700) {
  const [v, setV] = useState(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    const from = v, t0 = performance.now(); let raf = 0;
    const tick = (t: number) => { const k = Math.min(1, (t - t0) / ms); setV(Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3)))); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return v;
}

export function LiveTradeCard({ className = "" }: { className?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const now = useNow();
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const r = await fetch("/api/floor/live-trade", { cache: "no-store" }); if (r.ok && alive) setData((await r.json()) as Payload); } catch { /* keeps last */ } };
    void load(); const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!data) return <div className={`h-[168px] animate-pulse rounded-2xl ${className}`} style={{ background: K.panel }} />;
  return (
    <section className={`relative ${className}`} aria-label="GENX live trade">
      <style>{`@keyframes ltSweep{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}@keyframes ltRadar{to{transform:rotate(360deg)}}@keyframes ltGlow{0%,100%{opacity:.55}50%{opacity:1}}@keyframes ltPulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      {data.live
        ? <LiveState live={data.live} recent={data.recent} streak={data.streak ?? 0} streakPips={data.streakPips ?? 0} best={data.bestStreak ?? 0} bestPips={data.bestStreakPips ?? 0} now={now} />
        : <IdleState recent={data.recent} streak={data.streak ?? 0} streakPips={data.streakPips ?? 0} best={data.bestStreak ?? 0} bestPips={data.bestStreakPips ?? 0} now={now} />}
    </section>
  );
}

function Shell({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-2xl p-[1.5px]" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}33 40%, rgba(255,255,255,0.06) 60%, ${accent}88)` }}>
      <div className="pointer-events-none absolute -inset-1 rounded-3xl blur-xl" style={{ background: `radial-gradient(60% 80% at 20% 0%, ${accent}40, transparent 70%)`, animation: "ltGlow 3s ease-in-out infinite" }} />
      <div className="relative overflow-hidden rounded-2xl" style={{ background: `linear-gradient(160deg, ${K.raised}, ${K.panel} 55%)`, color: K.text }}>
        <div className="pointer-events-none absolute inset-0 opacity-[0.05]" style={{ backgroundImage: `linear-gradient(${accent} 1px,transparent 1px),linear-gradient(90deg,${accent} 1px,transparent 1px)`, backgroundSize: "34px 34px" }} />
        {children}
      </div>
    </div>
  );
}

function LiveState({ live, recent, streak, streakPips, best, bestPips, now }: { live: Live; recent: Recent[]; streak: number; streakPips: number; best: number; bestPips: number; now: number }) {
  const up = live.side === "BUY";
  const winning = (live.pips ?? 0) >= 0;
  const accent = winning ? K.green : K.rose;
  const pips = useCountUp(live.pips);
  // position of price on the stop → target rail (0..100)
  const rail = useMemo(() => {
    const { stop, target, entry, price } = live;
    if (stop == null || target == null || price == null) return null;
    const lo = Math.min(stop, target), hi = Math.max(stop, target), span = hi - lo || 1;
    const pos = (x: number) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));
    const toTarget = entry != null ? Math.max(0, Math.min(100, Math.round(((up ? price - entry : entry - price) / Math.abs(target - entry || 1)) * 100))) : null;
    return { price: pos(price), entry: entry != null ? pos(entry) : null, stopLeft: stop < target, toTarget };
  }, [live, up]);
  return (
    <Shell accent={accent}>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 opacity-[0.07]" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)`, animation: "ltSweep 2.8s linear infinite" }} />
      <div className="relative grid gap-4 p-4 sm:p-5 lg:grid-cols-[1.25fr_1fr]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em]" style={{ background: `${K.rose}22`, color: "#FDA4AF" }}>
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full" style={{ background: K.rose, opacity: 0.7 }} /><span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: K.rose }} /></span>
              Live trade
            </span>
            <span className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ background: "rgba(255,255,255,0.06)", color: K.mut }}>GENX · {live.setup}</span>
            <span className="font-mono text-[11px] tabular-nums" style={{ color: K.mut2 }}>in trade {dur(live.openedAt, now)}</span>
          </div>

          <div className="mt-3 flex items-end gap-4">
            <div className="flex items-center gap-2">
              <span className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: up ? `${K.green}1f` : `${K.rose}1f`, color: up ? K.green : K.rose }}>
                {up ? <TrendingUp className="h-6 w-6" /> : <TrendingDown className="h-6 w-6" />}
              </span>
              <div>
                <p className="text-[22px] font-black leading-none tracking-tight">{live.side} <span style={{ color: K.gold }}>GOLD</span></p>
                <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: K.mut2 }}>XAUUSD</p>
              </div>
            </div>
            <div className="ml-auto text-right">
              <p className="text-[42px] font-black leading-none tabular-nums sm:text-[52px]" style={{ color: accent, textShadow: `0 0 28px ${accent}55` }}>
                {live.pips == null ? "—" : `${pips > 0 ? "+" : ""}${pips}`}
              </p>
              <p className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: K.mut }}>pips {winning ? "in profit" : "open"}</p>
            </div>
          </div>

          {rail && (
            <div className="mt-4">
              <div className="relative h-2.5 rounded-full" style={{ background: `linear-gradient(90deg, ${rail.stopLeft ? K.rose : K.green}66, rgba(255,255,255,0.08) 45%, ${rail.stopLeft ? K.green : K.rose}66)` }}>
                {rail.entry != null && <span className="absolute top-1/2 h-4 w-[2px] -translate-y-1/2 rounded" style={{ left: `${rail.entry}%`, background: "rgba(255,255,255,0.55)" }} />}
                <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-[left] duration-700" style={{ left: `${rail.price}%`, background: accent, borderColor: K.panel, boxShadow: `0 0 14px ${accent}` }} />
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: K.mut2 }}>
                <span>{rail.stopLeft ? "Stop" : "Target"}</span>
                {rail.toTarget != null && <span style={{ color: accent }}>{rail.toTarget}% to target</span>}
                <span>{rail.stopLeft ? "Target" : "Stop"}</span>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat icon={<Crosshair className="h-3.5 w-3.5" />} label="Entry" value={fmt(live.entry)} />
            <Stat icon={<Radio className="h-3.5 w-3.5" />} label="Now" value={fmt(live.price)} color={accent} />
            <Stat icon={<Target className="h-3.5 w-3.5" />} label="Target" value={fmt(live.target)} color={K.green} />
            <Stat icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Stop" value={fmt(live.stop)} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 lg:border-l lg:pl-5" style={{ borderColor: K.line }}>
          <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: "rgba(255,255,255,0.04)" }}>
            <span className="grid h-10 w-10 place-items-center rounded-full" style={{ background: `${K.cyan}1a`, color: K.cyan }}><Users className="h-5 w-5" /></span>
            <div>
              <p className="text-2xl font-black leading-none tabular-nums">{live.accountsIn}</p>
              <p className="mt-1 text-[11px] font-semibold" style={{ color: K.mut }}>{live.accountsIn === 1 ? "of your accounts in this trade" : "of your accounts in this trade"}</p>
            </div>
          </div>
          <TradeControls />
          <LastThree recent={recent} streak={streak} streakPips={streakPips} best={best} bestPips={bestPips} now={now} />
          <GrowthLadder live={live} streakPips={streakPips} bestPips={bestPips} />
        </div>
      </div>
    </Shell>
  );
}

function IdleState({ recent, streak, streakPips, best, bestPips, now }: { recent: Recent[]; streak: number; streakPips: number; best: number; bestPips: number; now: number }) {
  const wins = recent.filter((r) => r.grade === "WIN").length;
  return (
    <Shell accent={K.cyan}>
      <div className="relative grid items-center gap-4 p-4 sm:p-5 lg:grid-cols-[1.25fr_1fr]">
        <div className="flex items-center gap-4">
          <div className="relative grid h-16 w-16 flex-shrink-0 place-items-center rounded-full" style={{ background: `${K.cyan}12`, boxShadow: `inset 0 0 0 1px ${K.cyan}40` }}>
            <span className="absolute inset-1 rounded-full" style={{ background: `conic-gradient(from 0deg, ${K.cyan}66, transparent 30%)`, animation: "ltRadar 2.4s linear infinite" }} />
            <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: K.cyan, boxShadow: `0 0 12px ${K.cyan}` }} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: K.cyan }}>GENX · Gold</p>
            <p className="mt-1 text-xl font-black leading-tight tracking-tight sm:text-2xl">Hunting the next entry</p>
            <p className="mt-1 text-[12px]" style={{ color: K.mut }}>No trade open right now. The moment GENX enters, it shows up live right here.</p>
            {recent.length > 0 && <p className="mt-2 text-[12px] font-semibold" style={{ color: K.green }}>{wins} of the last {recent.length} {recent.length === 1 ? "trade" : "trades"} closed as wins for you</p>}
          </div>
        </div>
        <div className="lg:border-l lg:pl-5" style={{ borderColor: K.line }}><LastThree recent={recent} streak={streak} streakPips={streakPips} best={best} bestPips={bestPips} now={now} /><GrowthLadder live={null} streakPips={streakPips} bestPips={bestPips} /></div>
      </div>
    </Shell>
  );
}

/**
 * WIN STREAK (owner 09-23): consecutive wins across every closed trade, not just the three shown. One
 * Lesson — or a hand-close at a loss — and it reads "No current streak" again.
 */
/*
 * THE GROWTH LADDER (owner 09-24) — mirrors the phone app's card exactly. What a run of pips is worth
 * at each lot size, with the sizes the reference account cannot margin shown LOCKED rather than hidden.
 *
 * Two rules carried over from the app, both deliberate:
 *
 *  1. IT NEVER SHOWS A LOSS (owner: "when the trade is winning then show what you would be making.
 *     Never show what you could be losing"). A winning open trade drives it; anything else falls back
 *     to the closed streak. This is presentation, not concealment — the card prints the trade's real
 *     P&L in large type right beside this, so an underwater trade is impossible to miss; the ladder
 *     just declines to multiply that loss by a hundred lots. It never blinks out either, so a missing
 *     ladder can't become the tell that someone is down.
 *
 *  2. THE LOCK IS THE HONEST PART. Gold is $10 per pip per 1.0 lot, so the top of the ladder is a very
 *     large number — but 100 lots is ~$42M of notional and needs ~$427k of margin. A $3,000 account
 *     cannot hold 1.0 lot, let alone 100. Presenting those as reachable on $3,000 would be wrong by
 *     four orders of magnitude and would push members to over-leverage real money. So they are dimmed
 *     and labelled with the account they need: a goal, not a promise.
 */
const LAD_ACCOUNT = 3000;       // reference account (owner 09-24)
const LAD_LEVERAGE = 100;       // 1:100 retail gold leverage → margin = lots × price
const LAD_PER_PIP_PER_LOT = 10; // XAUUSD: 1.0 lot moves $10 per pip
const LAD_SIZES = [0.01, 0.1, 1, 10, 100];

const ladMoney = (v: number) => (v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`);
const ladShort = (v: number) => (v >= 10000 ? `$${Math.round(v / 1000)}k` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`);

function GrowthLadder({ live, streakPips, bestPips }: { live: Live | null; streakPips: number; bestPips: number }) {
  const livePips = live && typeof live.pips === "number" ? live.pips : null;
  const isLive = livePips != null && livePips > 0;
  const pips = isLive ? (livePips as number) : streakPips > 0 ? streakPips : bestPips;
  const isRecord = !isLive && streakPips <= 0 && bestPips > 0;
  const px = live && live.price != null && live.price > 0 ? live.price : 4300;
  const rows = useMemo(() => LAD_SIZES.map((lots) => {
    const usd = pips * lots * LAD_PER_PIP_PER_LOT;
    const need = lots * px * (100 / LAD_LEVERAGE);
    return { lots, usd, need, ok: need <= LAD_ACCOUNT };
  }), [pips, px]);
  if (!(pips > 0)) return null;
  /*
   * LOG WIDTHS. Four decades of range: linearly, 0.01 is a single pixel next to 100, which would make
   * the only two sizes a $3,000 account can actually trade look worthless beside the locked ones —
   * exactly the wrong message. On a log scale every 10x is an equal step and it reads as a climb.
   */
  const lo = Math.log10(Math.max(1e-6, rows[0].usd));
  const hi = Math.log10(Math.max(1e-6, rows[rows.length - 1].usd));
  const span = Math.max(0.0001, hi - lo);
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: K.line }}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: isLive ? K.green : K.mut2 }}>
          {isLive ? "This trade right now" : isRecord ? "Your record streak was worth" : "This streak is worth"}
          {isLive && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: K.green, boxShadow: `0 0 8px ${K.green}`, animation: "ltPulse 1.6s ease-in-out infinite" }} />}
        </p>
        <p className="text-[10px] font-semibold" style={{ color: K.mut2 }}>+{pips.toLocaleString("en-US")} pips · ${LAD_ACCOUNT.toLocaleString("en-US")} account</p>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r) => {
          const w = Math.round(10 + ((Math.log10(Math.max(1e-6, r.usd)) - lo) / span) * 90);
          return (
            <div key={r.lots} className="grid items-center gap-2" style={{ gridTemplateColumns: "44px 1fr auto" }}>
              <span className="text-[11px] font-black tabular-nums" style={{ color: r.ok ? K.text : K.mut2 }}>{r.lots < 1 ? r.lots.toFixed(2) : r.lots.toFixed(1)}</span>
              <span className="relative h-[7px] min-w-0 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${w}%`, background: r.ok ? `linear-gradient(90deg, ${K.greenDeep}, ${K.green})` : "rgba(255,255,255,0.20)", boxShadow: r.ok ? `0 0 8px ${K.green}66` : "none" }} />
              </span>
              <span className="text-right">
                <span className="block text-[12px] font-black tabular-nums" style={{ color: r.ok ? K.green : K.mut2 }}>{r.ok ? `+${ladMoney(r.usd)}` : ladMoney(r.usd)}</span>
                {!r.ok && <span className="block text-[9px] font-bold" style={{ color: `${K.amber}BB` }}>needs {ladShort(r.need)}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[9.5px] leading-snug" style={{ color: K.mut2 }}>
        Dimmed sizes need a bigger account to hold the margin. {isLive ? "This trade is still open — the number moves until it closes." : "Past results, not a forecast."}
      </p>
    </div>
  );
}

function LastThree({ recent, streak, streakPips, best, bestPips, now }: { recent: Recent[]; streak: number; streakPips: number; best: number; bestPips: number; now: number }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: K.mut2 }}>Your last 3 trades</p>
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]"
            style={streak > 0
              ? { color: K.gold, background: `${K.gold}1F`, boxShadow: `inset 0 0 0 1px ${K.gold}55` }
              : { color: K.mut2, background: "rgba(255,255,255,0.04)", boxShadow: `inset 0 0 0 1px ${K.line}` }}>
            {streak > 0 ? `\u{1F525} Streak ${streak}${streakPips > 0 ? ` \u00B7 +${streakPips.toLocaleString("en-US")}p` : ""}` : "No current streak"}
          </span>
          {best > 0 && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]"
              style={{ color: K.cyan, background: `${K.cyan}14`, boxShadow: `inset 0 0 0 1px ${K.cyan}40` }}
              title="Your longest run of wins, and what it made">
              {`Record ${best}${bestPips > 0 ? ` \u00B7 +${bestPips.toLocaleString("en-US")}p` : ""}`}
            </span>
          )}
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="text-[12px]" style={{ color: K.mut }}>Results appear here as trades close.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {recent.map((r) => {
            const c = r.grade === "WIN" ? K.green : r.grade === "LESSON" ? K.amber : K.mut;
            const Icon = r.grade === "WIN" ? Trophy : r.grade === "LESSON" ? Lightbulb : Minus;
            return (
              <div key={r.at} className="rounded-xl p-2.5 text-center" style={{ background: `${c}14`, boxShadow: `inset 0 0 0 1px ${c}33` }}>
                <Icon className="mx-auto h-4 w-4" style={{ color: c }} />
                <p className="mt-1 text-[12px] font-black uppercase tracking-[0.1em]" style={{ color: c }}>{r.grade === "WIN" ? "Win" : r.grade === "LESSON" ? "Lesson" : r.grade === "CLOSED" ? "Closed" : "Even"}</p>
                <p className="text-[13px] font-bold tabular-nums">{r.pips == null ? "—" : `${r.pips > 0 ? "+" : ""}${r.pips}`}<span className="ml-0.5 text-[10px] font-semibold" style={{ color: K.mut2 }}>p</span></p>
                <p className="mt-0.5 text-[10px]" style={{ color: K.mut2 }}>{r.side} · {ago(r.at, now)}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: "rgba(255,255,255,0.04)" }}>
      <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: K.mut2 }}>{icon}{label}</p>
      <p className="mt-0.5 font-mono text-[14px] font-bold tabular-nums" style={{ color: color ?? K.text }}>{value}</p>
    </div>
  );
}

/* Member controls (owner 09-17): close / take a partial / stop to break-even on the member's own accounts.
   Two taps: the first arms the button, the second sends it to TradeLocker. */
type ActRes = { account: string; ok: boolean; message: string };
const ACTS: { id: "breakeven" | "partial" | "close"; label: string; confirm: string; color: string }[] = [
  { id: "breakeven", label: "Stop to BE +5", confirm: "Tap to move stop", color: K.cyan },
  { id: "partial", label: "Take partial", confirm: "Tap to close half", color: K.amber },
  { id: "close", label: "Close trade", confirm: "Tap to close all", color: K.rose },
];
function TradeControls() {
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  const send = async (id: string) => {
    if (busy) return;
    if (armed !== id) { setArmed(id); setOut(null); return; }
    setArmed(null); setBusy(id);
    try {
      const r = await fetch("/api/floor/live-trade/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: id }) });
      const j = (await r.json()) as { ok?: boolean; results?: ActRes[]; error?: string };
      const res = j.results ?? [];
      const text = res.length ? res.map((x) => `${x.account}: ${x.message}`).join(" · ") : j.error === "no_open_trade" ? "No open trade on your accounts" : "Couldn't send — try again";
      setOut({ ok: !!j.ok, text });
    } catch { setOut({ ok: false, text: "Couldn't send — try again" }); }
    setBusy(null);
  };
  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {ACTS.map((a) => {
          const on = armed === a.id;
          return (
            <button key={a.id} type="button" onClick={() => void send(a.id)} disabled={!!busy}
              className="rounded-xl px-2 py-2.5 text-[12px] font-extrabold transition active:scale-95 disabled:opacity-60"
              style={{ background: on ? a.color : `${a.color}1f`, color: on ? "#061018" : a.color, border: `1px solid ${a.color}66` }}>
              {busy === a.id ? "Sending…" : on ? a.confirm : a.label}
            </button>
          );
        })}
      </div>
      {out && <p className="mt-2 text-[11px] font-semibold leading-snug" style={{ color: out.ok ? K.green : K.amber }}>{out.text}</p>}
    </div>
  );
}
