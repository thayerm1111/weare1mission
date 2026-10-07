"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowLeftRight, Loader2, ChevronDown } from "lucide-react";
import { ConfirmHelp } from "./GenxFlow";
import { GenFxFlow } from "./GenFxFlow";
import { GENFX_OPEN_PAIR } from "@/lib/floor/setupInstruments";
import { SetupLock, SetupTimer } from "@/components/portal/SetupLock";
import { type SetupGate } from "@/lib/setupLock";
import { clearlyInView } from "@/lib/inView";

/**
 * GEN FX — the GENX decision engine on EUR/USD and GBP/JPY (owner 10-02: "an exact system, just like
 * Gen X … call it Gen FX. Make it its own tool on the floor").
 *
 * The same page as GENX, one question — "what should I do on this pair right now?" — answered by the
 * same deterministic engine through /api/genfx, with the AI writing only the market story. What is
 * added is what a second instrument needs: a pair picker, prices at the pair's own precision, and —
 * because GEN FX trades on its own switch, not on FLOW's — the auto-trade switches, what the scanner
 * is watching, and the record so far, all on this page.
 */
type PairKey = "EURUSD" | "GBPJPY";
type Candle = { t: string; o: number; h: number; l: number; c: number };
type PathPt = { label: string; price: number | null; kind: string };
type Genfx = {
  symbol: string; mode: string; market_regime: string;
  directional_bias: string; action: string; lifecycle: string;
  confidence_score: number;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop_loss: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  closest_support: number | null; closest_resistance: number | null; room_to_target_pips: number | null;
  market_structure: string; momentum: string; volatility: string;
  buyer_control: number; seller_control: number;
  expected_hold_minutes: [number, number];
  session: string; data_status: string; trigger_tf: string; context_tf: string;
  market_story: string[]; trade_reasoning: string[]; risk_factors: string[];
  invalidation_reason: string; trigger_condition: string; setup_type: string; engine_state: string;
  projected_path: PathPt[]; invalidation_price: number | null;
};
type AutoNote = { minStopPips: number; stopPips: number | null; stopOk: boolean; costPips: number };
type Resp = { ok?: boolean; pair?: PairKey; signal_id?: string | null; price?: number; data_status?: string; asOf?: string; genfx?: Genfx; candles?: Candle[]; auto?: AutoNote; error?: string; detail?: string; notConfigured?: string; balance?: number };

type DeskAccount = { accountId: string; connectionId: string; accNum: string | null; name: string | null; environment: string | null; server: string | null; connected: boolean; riskPct: number | null; killed: boolean; EURUSD: boolean; GBPJPY: boolean; inScope: boolean };
// A call whose play this member's window does not cover arrives `locked`: its pair, horizon and stage,
// and no side or levels (the server keeps them back — src/lib/setupLock.ts).
type DeskAlert = { id: string; pair: PairKey; mode: string; side: "buy" | "sell" | null; state: string; kind: "zone" | "scanner"; entry: number | null; entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; created_at: string; enter_price: number | null; enter_sent_at: string | null; outcome: string | null; result_pips: number | null; locked?: boolean };
type Rec = { calls: number; win: number; loss: number; flat: number; pips: number; open: number };
type Switches = { readable: boolean; scan: boolean; auto: boolean; scope: "owner" | "demo" | "all"; billing: boolean; telegram: boolean };
type Tally = { n: number; wins: number; losses: number; pips: number; r: number; avgStopPips: number; avgR: number; winRate: number; maxDrawdownR: number };
type Tallies = { all: Tally; byMode: Record<string, Tally>; byTrend?: Record<string, Tally>; byTouch?: Record<string, Tally>; byVia?: Record<string, Tally>; byShown?: Record<string, Tally>; byAfter?: Record<string, Tally> };
type Placement = { calls: number; placed: number; skipped: Record<string, number> };
type ReplayPair = { error?: string; from?: string; to?: string; costPips?: number; minStopPips?: number; placement?: Placement; placements?: { managed?: Placement; managedLow?: Placement; raw?: Placement }; managed?: Tallies; managedLow?: Tallies; raw?: Tallies; alerts?: Record<string, { entered: number; win: number; loss: number; expired: number }>; clock?: { zone: string; verified: boolean; forced?: boolean; note?: string } };
type ReplayState = { status?: string; startedAt?: string; heartbeatAt?: string; finishedAt?: string; error?: string; weeks?: number; progress?: { pair?: string; stage?: string; done?: number; total?: number }; pairs?: Record<string, ReplayPair> };
type Unsettled = { account_id: string; acc_num: string | null; pair: string; side: string; status: string; note: string | null; checks: number | null; created_at: string };
type Desk = {
  ok?: boolean; owner?: boolean; switches?: Switches;
  pairs?: { key: PairKey; name: string; minStopPips: number; costPips: number; dec: number }[];
  limits?: { maxMinLotRiskPct: number; maxLots: number };
  accounts?: DeskAccount[]; alerts?: DeskAlert[];
  /** This member's window on the live setups: open or not, until when, what opening it costs. */
  setups?: SetupGate | null;
  record?: Record<string, { d7: { win: number; loss: number }; d30: { win: number; loss: number; pips: number }; repeats?: number }>;
  real?: Record<string, { demo: Rec; live: Rec }>;
  activity?: { symbol: string; side: string | null; status: string; reason: string | null; created_at: string; account_id: string | null }[];
  lastScan?: { at: string | null; beat: string | null; quiet: boolean | null; decisions: Record<string, Record<string, unknown>> | null } | null;
  recordComplete?: boolean;
  ownerView?: { armed: { accounts: number; members: number; EURUSD: number; GBPJPY: number; inScope?: number | null; byScope?: Record<Switches["scope"], number> | null; complete?: boolean }; replayPending: boolean; replay: ReplayState | null; books?: { readable: boolean; unsettled: Unsettled[] } };
};

const PAIRS: { id: PairKey; name: string; sub: string; dec: number }[] = [
  { id: "EURUSD", name: "EUR/USD", sub: "Euro · US Dollar", dec: 5 },
  { id: "GBPJPY", name: "GBP/JPY", sub: "Pound · Yen", dec: 3 },
];
const MODES = [
  { id: "quick", label: "Quick", sub: "20–90 min" },
  { id: "intraday", label: "Intraday", sub: "2–6 hrs" },
  { id: "swing", label: "Swing", sub: "Hours–days" },
] as const;
const decOf = (p: string | null | undefined) => (p === "GBPJPY" ? 3 : 5);
const nameOf = (p: string | null | undefined) => (p === "GBPJPY" ? "GBP/JPY" : "EUR/USD");

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fx = (v: unknown, dec: number): string => (num(v) != null ? (v as number).toFixed(dec) : "—");

function actionLabel(a: string): string {
  switch (a) {
    case "BUY_NOW": return "BUY NOW";
    case "SELL_NOW": return "SELL NOW";
    case "BUY_LIMIT": return "BUY · LIMIT";
    case "SELL_LIMIT": return "SELL · LIMIT";
    case "WAIT_FOR_BUY_TRIGGER": return "WAIT · BUY SETUP";
    case "WAIT_FOR_SELL_TRIGGER": return "WAIT · SELL SETUP";
    default: return "WAIT";
  }
}
const confLabel = (c: number) => (c >= 74 ? "Strong" : c >= 62 ? "Building" : c >= 50 ? "Forming" : "Weak");
const sideOf = (a: string): "buy" | "sell" | "wait" => (a.includes("BUY") ? "buy" : a.includes("SELL") ? "sell" : "wait");
const fmtHold = (m: [number, number]) => { const f = (x: number) => (x >= 60 ? `${Math.round(x / 60)}h` : `${x}m`); return `${f(m[0])}–${f(m[1])}`; };
function agoShort(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/* ---------- projection chart (phones) ---------- */
function declutterY(ys: number[], minGap: number, top: number, bottom: number): number[] {
  const out = ys.slice();
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
  let prev = -Infinity;
  for (const i of order) { const v = Math.max(ys[i], prev + minGap); out[i] = v; prev = v; }
  const over = out[order[order.length - 1]] - bottom;
  if (over > 0) for (const i of order) out[i] -= over;
  const under = top - out[order[0]];
  if (under > 0) for (const i of order) out[i] += under;
  return out;
}

function FxChart({ candles, g, dec }: { candles: Candle[]; g: Genfx; dec: number }) {
  const cs = (candles || []).filter((c) => num(c.o) != null && num(c.h) != null && num(c.l) != null && num(c.c) != null).slice(-40);
  const path = (g.projected_path || []).filter((p) => num(p.price) != null) as { label: string; price: number; kind: string }[];
  if (cs.length < 4 && path.length < 2) return null;
  const W = 480, H = 372, padY = 20, padL = 10, gutterW = 92;
  const plotR = W - gutterW;
  const splitX = Math.round(padL + (plotR - padL) * 0.58);
  const levels = [
    { label: "R", price: num(g.closest_resistance), color: "#ff8fa0" },
    { label: "TP2", price: num(g.tp2), color: "#34d99a" },
    { label: "TP1", price: num(g.tp1), color: "#2ee88f" },
    { label: "Entry", price: num(g.entry), color: "#5cc8ff" },
    { label: "S", price: num(g.closest_support), color: "#7fe6b5" },
    { label: "Stop", price: num(g.stop_loss), color: "#ff5d6c" },
  ].filter((l): l is { label: string; price: number; color: string } => l.price != null);
  const all = [...cs.flatMap((c) => [c.h, c.l]), ...path.map((p) => p.price), ...levels.map((l) => l.price)];
  const min = Math.min(...all), max = Math.max(...all);
  const pad = ((max - min) || 1) * 0.06;
  const lo = min - pad, sp = (max + pad - lo) || 1;
  const y = (p: number) => padY + (1 - (p - lo) / sp) * (H - padY * 2);
  const cw = cs.length ? (splitX - padL - 6) / cs.length : 8;
  const bodyW = Math.max(2, Math.min(9, cw * 0.62));
  const projX = (i: number) => splitX + (path.length > 1 ? (i / (path.length - 1)) * (plotR - splitX - 6) : 0);
  const projColor = g.directional_bias === "bullish" ? "#2ee88f" : g.directional_bias === "bearish" ? "#ff5d6c" : "#5cc8ff";
  const labelY = declutterY(levels.map((l) => y(l.price)), 13, padY + 4, H - padY);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" style={{ minHeight: 280, maxHeight: 380 }} preserveAspectRatio="xMidYMid meet" role="img" aria-label="GEN FX price chart with projected path">
      {levels.map((l, i) => (
        <g key={`lv${i}`}>
          <line x1={padL} x2={plotR} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeWidth={1} strokeDasharray="2 6" opacity={0.22} />
          <line x1={plotR} x2={plotR + 7} y1={y(l.price)} y2={labelY[i]} stroke={l.color} strokeWidth={1} opacity={0.32} />
          <circle cx={plotR + 9} cy={labelY[i]} r={2} fill={l.color} />
          <text x={plotR + 14} y={labelY[i] + 3.2} fill={l.color} fontSize={9.5} opacity={0.95}>{l.label} {l.price.toFixed(dec)}</text>
        </g>
      ))}
      {cs.map((c, i) => {
        const x = padL + 2 + i * cw + cw / 2;
        const col = c.c >= c.o ? "#2ee88f" : "#ff5d6c";
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} opacity={0.55} />
            <rect x={x - bodyW / 2} y={Math.min(y(c.o), y(c.c))} width={bodyW} height={Math.max(1, Math.abs(y(c.c) - y(c.o)))} rx={0.5} fill={col} opacity={0.9} />
          </g>
        );
      })}
      <line x1={splitX} x2={splitX} y1={padY} y2={H - padY} stroke="#ffffff" strokeWidth={1} strokeDasharray="2 6" opacity={0.1} />
      {path.length > 1 && <polyline points={path.map((p, i) => `${projX(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ")} fill="none" stroke={projColor} strokeWidth={2} strokeDasharray="5 4" opacity={0.9} />}
      {path.map((p, i) => (
        <g key={`p${i}`}>
          <circle cx={projX(i)} cy={y(p.price)} r={3} fill={projColor} />
          <text x={i === 0 ? projX(i) + 4 : i === path.length - 1 ? projX(i) - 2 : projX(i)} y={y(p.price) - 9} fill={projColor} fontSize={9} textAnchor={i === 0 ? "start" : i === path.length - 1 ? "end" : "middle"} opacity={0.95}>{p.label}</text>
        </g>
      ))}
      <text x={splitX + 4} y={H - 6} fill={projColor} fontSize={8.5} opacity={0.55}>Projected path →</text>
    </svg>
  );
}

/* ---------- live entry confirmation ---------- */
type ConfirmState = { state: string; detail?: string; enter?: number | null };
type SetupLevels = {
  pair: PairKey; side: "buy" | "sell"; action: string; mode: string;
  entry: number | null; entryLow: number | null; entryHigh: number | null;
  watch: number | null; invalidation: number | null; stop: number | null;
  tp1: number | null; triggerTf?: string;
};
function setupFrom(pair: PairKey, g: Genfx): SetupLevels {
  const side: "buy" | "sell" = g.action.includes("SELL") ? "sell" : "buy";
  return {
    pair, side, action: g.action, mode: g.mode,
    entry: g.entry, entryLow: g.entry_low, entryHigh: g.entry_high,
    watch: side === "sell" ? (g.closest_resistance ?? g.entry) : (g.closest_support ?? g.entry),
    invalidation: g.invalidation_price ?? g.stop_loss, stop: g.stop_loss, tp1: g.tp1, triggerTf: g.trigger_tf,
  };
}
type PlayRow = { id: string; at: string; pair: PairKey | null; mode: string | null; action: string | null; direction: string | null; confidence: number | null; entry: number | null; entryLow: number | null; entryHigh: number | null; stop: number | null; tp1: number | null; outcome: string | null };
type Tracked = SetupLevels & { id: string; savedAt: number; tp2: number | null; label: string };
const TRACK_KEY = "genfx-tracked-v1";

function LiveConfirm({ setup }: { setup: SetupLevels }) {
  const isWait = setup.action.includes("WAIT") || setup.action.includes("LIMIT");
  const side = setup.side;
  const dec = decOf(setup.pair);
  const [st, setSt] = useState<ConfirmState | null>(null);
  const [loading, setLoading] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/genfx/confirm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pair: setup.pair, side, entryLow: setup.entryLow ?? setup.entry, entryHigh: setup.entryHigh ?? setup.entry, watch: setup.watch ?? setup.entry, invalidation: setup.invalidation ?? setup.stop, mode: setup.mode }),
      });
      const d = await r.json();
      if (d && d.state) setSt(d as ConfirmState);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [setup, side]);

  useEffect(() => {
    if (!isWait) return;
    void check();
    const id = setInterval(() => {
      setSt((cur) => {
        if (cur && (cur.state === "CONFIRMED" || cur.state === "INVALIDATED")) return cur;   // decided: stop polling
        void check();
        return cur;
      });
    }, 30000);
    return () => clearInterval(id);
  }, [isWait, check]);

  if (!isWait) return null;
  const state = st?.state ?? "LOADING";
  const S: Record<string, { bg: string; bd: string; fg: string; title: string }> = {
    LOADING: { bg: "rgba(255,255,255,0.04)", bd: "rgba(255,255,255,0.12)", fg: "#8b94a7", title: "Checking the market…" },
    BUSY: { bg: "rgba(255,255,255,0.04)", bd: "rgba(255,255,255,0.12)", fg: "#8b94a7", title: "Feed busy — retrying…" },
    NO_DATA: { bg: "rgba(255,255,255,0.04)", bd: "rgba(255,255,255,0.12)", fg: "#8b94a7", title: "Waiting for data…" },
    WAIT: { bg: "rgba(255,194,75,0.08)", bd: "rgba(255,194,75,0.4)", fg: "#ffc24b", title: "WAIT — not time to enter yet" },
    AT_ZONE: { bg: "rgba(96,165,250,0.09)", bd: "rgba(96,165,250,0.45)", fg: "#7db6ff", title: "AT THE ZONE — hold for the close" },
    CONFIRMED: { bg: "rgba(46,232,143,0.13)", bd: "rgba(46,232,143,0.6)", fg: "#2ee88f", title: side === "sell" ? "CONFIRMED — SELL IS LIVE" : "CONFIRMED — BUY IS LIVE" },
    INVALIDATED: { bg: "rgba(255,93,108,0.1)", bd: "rgba(255,93,108,0.55)", fg: "#ff5d6c", title: "INVALID — do not take this setup" },
  };
  const s = S[state] ?? S.NO_DATA;
  return (
    <div className={`mt-3 rounded-xl border px-3.5 py-3 ${state === "CONFIRMED" ? "animate-pulse" : ""}`} style={{ background: s.bg, borderColor: s.bd }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-extrabold uppercase tracking-[0.06em]" style={{ color: s.fg }}>{s.title}</span>
        <button onClick={() => void check()} disabled={loading} className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-white/40 transition hover:text-white/70 disabled:opacity-50">
          {loading ? "…" : "↻ Check"}
        </button>
      </div>
      {st?.detail && <p className="mt-1 text-[12px] leading-relaxed text-white/70">{st.detail}</p>}
      {state === "CONFIRMED" && st?.enter != null && (
        <p className="mt-1.5 text-[12.5px] font-bold tabular-nums" style={{ color: s.fg }}>
          {side === "sell" ? "SELL" : "BUY"} now ≈ {fx(st.enter, dec)} · stop {fx(setup.stop, dec)} · TP1 {fx(setup.tp1, dec)}
        </p>
      )}
      <p className="mt-1 text-[10px] text-white/30">Reads closed {setup.triggerTf || "trigger"} candles · auto-updates every 30s · educational, not financial advice.</p>
    </div>
  );
}

function TrackedRow({ t, onRemove }: { t: Tracked; onRemove: () => void }) {
  const dec = decOf(t.pair);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-bold" style={{ color: t.side === "sell" ? "#ff5d6c" : "#2ee88f" }}>{t.label}</p>
          <p className="mt-0.5 text-[10px] tabular-nums text-white/40">
            {(t.mode || "").toUpperCase()} · stop {fx(t.stop, dec)} · TP1 {fx(t.tp1, dec)}{t.tp2 != null ? ` · TP2 ${fx(t.tp2, dec)}` : ""} · saved {agoShort(t.savedAt)}
          </p>
        </div>
        <button onClick={onRemove} aria-label="Stop tracking" className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[13px] text-white/35 transition hover:bg-white/5 hover:text-white/70">✕</button>
      </div>
      {/* Keyed on the setup: a new setup starts from "checking", never from the last one's answer. */}
      <LiveConfirm key={`${t.pair}:${t.mode}:${t.side}:${t.entry}:${t.stop}`} setup={t} />
    </div>
  );
}

function LTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <p className="text-[10px] uppercase tracking-wide text-white/40">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${tone || "text-white"}`}>{value}</p>
      {sub && <p className="text-[11px] text-white/45">{sub}</p>}
    </div>
  );
}

// `waiting`: this switch has been tapped and its question is open — it is ringed, so the tap is seen to have landed.
function Switch({ on, onChange, disabled, label, waiting }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; waiting?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${waiting ? "ring-2 ring-sky-300 ring-offset-2 ring-offset-[#0b0d12]" : ""}`}
      style={{ background: on ? "#38bdf8" : "rgba(255,255,255,0.16)" }}>
      <span className="absolute top-0.5 h-5 w-5 rounded-full transition-all" style={{ left: on ? 22 : 2, background: "#ffffff" }} />
    </button>
  );
}

const SCOPE_TEXT: Record<Switches["scope"], string> = {
  owner: "the owner's accounts only",
  demo: "demo accounts",
  all: "every account that switches it on",
};

/* ---------- auto-trade: the member's accounts and their per-pair switches ---------- */
/*
 * EVERYTHING A SWITCH SAYS, IT SAYS WHERE THE MEMBER IS LOOKING (owner 10-07: "I'm getting reports
 * that people can't set up the auto feature for Gen FX"). Nothing was failing: every switch anyone
 * reached had saved. But turning a pair ON asks a question first, and the question opened under the
 * account's row — on a phone, 210 pixels below the switch and usually under the bottom of the screen.
 * The member tapped, the switch did not move, and nothing else they could see changed. So:
 *   • the question is brought into view when it opens, and the switch it belongs to is ringed;
 *   • while a change is being saved the switch already shows where it is going, with a line saying so;
 *   • what happened — on, off, or not saved and why — is said in that account's own card, not under
 *     the whole list where it could be a screen away.
 */
// What became of the last change: the server said yes, said no (and why), or did not answer at all.
type RowSaid = { key: string; pair: PairKey; wanted: boolean; outcome: "saved" | "refused" | "lost"; detail?: string };
export function AutoTrade({ desk, reload }: { desk: Desk; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<RowSaid | null>(null);
  // Turning a pair ON hands GEN FX the right to place orders on that account, so it is asked twice.
  const [asking, setAsking] = useState<{ key: string; accountId: string; connectionId: string; pair: PairKey } | null>(null);
  // A change on its way to the server: the switch shows the state it was asked for until the answer is in.
  const [going, setGoing] = useState<{ key: string; pair: PairKey; enabled: boolean } | null>(null);
  const question = useRef<HTMLDivElement | null>(null);
  const sw = desk.switches;
  const accounts = desk.accounts ?? [];
  const pairs = desk.pairs ?? [];
  const rowKey = (a: { accountId: string; connectionId: string }) => `${a.connectionId}:${a.accountId}`;
  const pairName = (k: PairKey) => pairs.find((p) => p.key === k)?.name ?? k;

  useEffect(() => {
    if (!asking) return;
    const box = question.current;
    if (!box || clearlyInView(box.getBoundingClientRect(), window.innerHeight)) return;
    try { box.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { box.scrollIntoView(); }
  }, [asking]);

  async function arm(a: { accountId: string; connectionId: string }, pair: PairKey, enabled: boolean) {
    const key = rowKey(a);
    setBusy(`${key}:${pair}`); setSaid(null); setAsking(null); setGoing({ key, pair, enabled });
    let outcome: RowSaid["outcome"] = "lost", detail: string | undefined;
    try {
      const r = await fetch("/api/genfx/desk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "arm", accountId: a.accountId, connectionId: a.connectionId, pair, enabled }) });
      const d = await r.json();
      outcome = d?.ok ? "saved" : "refused";
      if (typeof d?.detail === "string") detail = d.detail;
    } catch { /* no answer. The switch may or may not have moved: the reload below shows which. */ }
    try { await reload(); } catch { /* the page keeps what it had */ }
    setSaid({ key, pair, wanted: enabled, outcome, detail });
    setBusy(null); setGoing(null);
  }
  /**
   * The line under an account's switches about its last change. It never says a switch is somewhere the
   * switch itself is not: "on"/"off" is read off the switch as it now stands — so a change whose answer
   * was lost but which went through is said to have gone through, and a line about a switch that has
   * since been moved (another tab, another device) is dropped rather than left standing.
   */
  function saidOf(t: RowSaid, a: DeskAccount): { tone: "ok" | "warn"; text: string } | null {
    if (t.outcome === "refused") return { tone: "warn", text: t.detail || "Couldn't save that switch — try again." };
    if (a[t.pair] === t.wanted) return { tone: "ok", text: `${pairName(t.pair)} auto-trade is ${t.wanted ? "ON" : "OFF"} for #${a.accNum ?? a.accountId}.` };
    return t.outcome === "lost" ? { tone: "warn", text: "Couldn't reach the server, so that switch may not have changed. Check it, and try again." } : null;
  }

  const placing = !!sw?.auto;
  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300/80">Auto-trade</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${placing ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/50"}`}>
          {placing ? `ON · ${SCOPE_TEXT[sw!.scope]}` : "Not placing trades yet"}
        </span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-white/60">
        Switch a pair on for an account and GEN FX places its calls there: sized to that account&apos;s risk %, one trade per pair in each direction, stop and target attached, then managed to break-even and trailed like every FLOW trade. It is separate from GENX gold — nothing here is on until you turn it on.
      </p>
      {sw && sw.scope !== "all" && (
        <p className="mt-2 rounded-lg border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2 text-[12px] leading-relaxed text-sky-100/80">
          GEN FX is new. It is running on {SCOPE_TEXT[sw.scope]} first, so its first record costs nobody real money. Live accounts open once it has one.
        </p>
      )}

      {accounts.length === 0 ? (
        <p className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-[12.5px] text-white/55">No broker account connected yet. <a href="/portal/trading?view=flow" className="font-semibold text-sky-300 underline underline-offset-2">Connect one under FLOW</a>, then come back and switch a pair on.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {accounts.map((a) => {
            const ask = asking && asking.key === rowKey(a) ? asking : null;
            const askName = ask ? pairName(ask.pair) : "";
            const moving = going && going.key === rowKey(a) ? going : null;
            const told = said && said.key === rowKey(a) ? saidOf(said, a) : null;
            return (
              <div key={rowKey(a)} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-bold text-white/90">
                      {a.server || "Account"} · #{a.accNum ?? a.accountId}
                      <span className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${a.environment === "live" ? "bg-amber-400/15 text-amber-300" : "bg-white/10 text-white/50"}`}>{a.environment === "live" ? "Live" : "Demo"}</span>
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-white/40">
                      Risk per trade: {a.riskPct != null ? `${a.riskPct}%` : "your FLOW default (1% if none)"}
                      {a.killed ? " · kill switch is ON — no new trades" : ""}{!a.connected ? " · broker needs reconnecting" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    {pairs.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-[11.5px] font-semibold text-white/70">
                        {p.name}
                        <Switch label={`${p.name} auto-trade on account ${a.accNum ?? a.accountId}`} on={moving && moving.pair === p.key ? moving.enabled : a[p.key]} waiting={!!ask && ask.pair === p.key}
                          disabled={busy != null || (!a.inScope && !a[p.key])}
                          onChange={(v) => { if (v) { setSaid(null); setAsking({ key: rowKey(a), accountId: a.accountId, connectionId: a.connectionId, pair: p.key }); } else void arm(a, p.key, false); }} />
                      </label>
                    ))}
                  </div>
                </div>
                {ask && (
                  <div ref={question} className="mt-2 rounded-lg border border-sky-400/30 bg-sky-400/[0.07] px-3 py-2.5">
                    <p className="text-[12.5px] leading-relaxed text-sky-50/90">
                      Turn on <b>{askName}</b> for #{a.accNum ?? a.accountId} ({a.environment === "live" ? "live" : "demo"})? GEN FX will then place {askName} trades on this account by itself — {a.riskPct != null ? `${a.riskPct}%` : "your FLOW default"} of the account at risk on each, a stop and a target on every one. You can switch it off here at any time; a trade already open stays managed until it closes.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button disabled={busy != null} onClick={() => void arm(ask, ask.pair, true)} className="rounded-lg bg-sky-400 px-4 py-2 text-[13px] font-bold text-[#04121c] disabled:opacity-50">Turn it on</button>
                      <button disabled={busy != null} onClick={() => setAsking(null)} className="rounded-lg border border-white/15 px-4 py-2 text-[13px] font-semibold text-white/70 disabled:opacity-50">Not now</button>
                    </div>
                  </div>
                )}
                {moving && <p role="status" className="mt-2 text-[12px] font-semibold text-sky-200/90">Turning {pairName(moving.pair)} {moving.enabled ? "on" : "off"}…</p>}
                {told && !moving && <p role="status" className={`mt-2 text-[12px] font-semibold leading-relaxed ${told.tone === "ok" ? "text-emerald-300" : "text-amber-300"}`}>{told.tone === "ok" ? "✓ " : ""}{told.text}</p>}
                {!a.inScope && <p className="mt-1.5 text-[10.5px] text-white/35">Not open for this account yet{sw?.scope === "demo" ? " — GEN FX is on demo accounts first." : "."}</p>}
              </div>
            );
          })}
        </div>
      )}

      <ul className="mt-3 space-y-1 text-[11.5px] leading-relaxed text-white/45">
        {pairs.length > 0 && <li>• A setup whose stop is tighter than {pairs.map((p) => `${p.minStopPips} pips on ${p.name}`).join(" or ")} is shown here but not auto-traded — on a stop that tight the spread is too much of the risk.</li>}
        <li>• If the smallest order your broker allows would risk more than {desk.limits?.maxMinLotRiskPct ?? 5}% of an account on a stop, that account sits the trade out.</li>
        <li>• With both pairs on, both can be open at once — and a buy and a sell on the same pair can be too — each at your risk %.</li>
        <li>• The risk %, the kill switch and the trade-management setting are the same ones your gold trades use on that account. Only the on/off switch is GEN FX&apos;s own.</li>
        {/* What switching on costs, said where it is switched on. Only while the owner's GEN FX billing is on. */}
        {sw?.billing && <li>• Credits: 1 when a setup you are switched on for starts forming, 5 when a trade is placed — once per call, however many of your accounts take it. Nothing on the FLOW Pass. With fewer than 5 credits the trade is skipped.</li>}
      </ul>

      {(desk.activity?.length ?? 0) > 0 && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">Your last GEN FX activity</p>
          <ul className="mt-1.5 space-y-1">
            {desk.activity!.slice(0, 6).map((e, i) => (
              <li key={i} className="flex gap-2 text-[11.5px] text-white/55">
                <span className={`flex-shrink-0 font-bold ${e.status === "placed" ? "text-emerald-300" : e.status === "error" || e.status === "uncertain" ? "text-red-300" : "text-white/40"}`}>{e.status === "placed" ? "PLACED" : e.status === "uncertain" ? "CHECKING" : e.status === "cancelled" ? "WITHDRAWN" : e.status.toUpperCase()}</span>
                <span className="min-w-0">{nameOf(e.symbol)}{e.side ? ` ${e.side.toUpperCase()}` : ""} — {String(e.reason ?? "").replace(/^genfx:?\s*/, "") || "order placed"} <span className="text-white/30">· {agoShort(Date.parse(e.created_at))}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---------- what the scanner is watching, and the record ---------- */
// Exported for its tests (tests/setup-lock-pages.test.ts draw it locked and open); used only here.
export function Watching({ desk, reload }: { desk: Desk; reload: () => void }) {
  const alerts = desk.alerts ?? [];
  const live = alerts.filter((a) => a.state === "zone" || a.state === "forming");
  const called = alerts.filter((a) => a.state === "entered").slice(0, 8);
  // The play takes credits to view (owner 10-05): with the window closed, an open call is its pair,
  // its horizon and how far along it is. One button for the whole list.
  const anyLocked = [...live, ...called].some((a) => a.locked);
  const row = (a: DeskAlert) => {
    const dec = decOf(a.pair);
    const zone = a.kind === "zone" ? fx(a.entry, dec) : `${fx(a.entry_low, dec)}–${fx(a.entry_high, dec)}`;
    return (
      <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
        <span className="text-[12px] font-bold" style={{ color: a.locked || !a.side ? "#ffd47a" : a.side === "sell" ? "#ff5d6c" : "#2ee88f" }}>
          {nameOf(a.pair)}{a.locked || !a.side ? "" : ` ${a.side.toUpperCase()}`} <span className="font-semibold text-white/40">· {a.mode}</span>
        </span>
        {a.locked
          ? <span className="text-[11px] text-white/40">side, entry, stop and target open with credits</span>
          : <span className="text-[11px] tabular-nums text-white/55">{a.state === "entered" ? `in @ ${fx(a.enter_price, dec)}` : `entry ${zone}`} · stop {fx(a.stop, dec)} · TP1 {fx(a.tp1, dec)}</span>}
        <span className="text-[10px] text-white/35">
          {a.state === "zone" ? "enters on touch" : a.state === "forming" ? (a.enter_sent_at ? "armed — waiting for a pullback" : "waiting to confirm") : a.outcome === "win" ? `WIN ${a.result_pips != null ? `+${a.result_pips}p` : ""}` : a.outcome === "loss" ? `LOSS ${a.result_pips ?? ""}p` : a.outcome === "expired" ? "expired" : "running"}
          {" · "}{agoShort(Date.parse(a.enter_sent_at ?? a.created_at))}
        </span>
      </li>
    );
  };
  const scanAt = desk.lastScan?.at ? Date.parse(desk.lastScan.at) : null;
  return (
    <section className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300/80">What GEN FX is watching <SetupTimer gate={desk.setups} /></h2>
        <span className="text-[10px] text-white/35">{desk.switches?.scan === false ? "Scanner is off" : scanAt ? `Scanned ${agoShort(scanAt)}${desk.lastScan?.quiet ? " · market quiet window" : ""}` : "Scanner has not run yet"}</span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-white/50">The scanner runs this same engine on both pairs and all three horizons every five minutes. A setup at a level is entered when price touches it; a developing one waits for its candle to close right.</p>
      {anyLocked && <SetupLock what={`GEN FX — ${live.some((a) => a.locked) ? "setups lined up" : called.some((a) => a.locked && !a.outcome) ? "calls running" : "earlier calls"}`} gate={desk.setups} onOpened={reload} className="mt-3" />}
      {live.length === 0 ? <p className="mt-3 text-[12px] text-white/35">Nothing lined up right now.</p> : <ul className="mt-3 space-y-1.5">{live.map(row)}</ul>}
      {called.length > 0 && (
        <>
          <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">Latest calls</p>
          <ul className="mt-1.5 space-y-1.5">{called.map(row)}</ul>
        </>
      )}
    </section>
  );
}

function Record({ desk }: { desk: Desk }) {
  const pairs = desk.pairs ?? [];
  const pct = (w: number, l: number) => (w + l > 0 ? `${Math.round((w / (w + l)) * 100)}%` : "—");
  const anyReal = pairs.some((p) => { const r = desk.real?.[p.key]; return r && (r.demo.calls + r.demo.open + r.live.calls + r.live.open) > 0; });
  return (
    <section className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-sky-300/80">The record so far</h2>
      <p className="mt-2 text-[12px] leading-relaxed text-white/50">GEN FX is new: the engine&apos;s track record is on gold, not on these pairs. Two separate counts, both starting from zero — GEN FX&apos;s calls graded on paper, and trades actually placed on accounts.</p>
      {desk.recordComplete === false && <p className="mt-1.5 text-[11.5px] text-amber-200/80">Some of the record could not be loaded just now — the numbers below are from part of it. Reload to try again.</p>}

      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {pairs.map((p) => {
          const rec = desk.record?.[p.key];
          const r = desk.real?.[p.key];
          return (
            <div key={p.key} className="rounded-xl border border-white/10 bg-black/20 px-3.5 py-3">
              <p className="text-[13px] font-bold text-white/90">{p.name}</p>
              <p className="mt-2 text-[10px] uppercase tracking-wide text-white/40">Calls, on paper</p>
              <p className="text-[12.5px] tabular-nums text-white/70">
                7 days: <b className="text-emerald-300">{rec?.d7.win ?? 0}W</b> · <b className="text-red-300">{rec?.d7.loss ?? 0}L</b>
                <span className="text-white/35"> · </span>30 days: <b className="text-emerald-300">{rec?.d30.win ?? 0}W</b> · <b className="text-red-300">{rec?.d30.loss ?? 0}L</b> ({pct(rec?.d30.win ?? 0, rec?.d30.loss ?? 0)}) · {rec && rec.d30.pips > 0 ? "+" : ""}{Math.round(rec?.d30.pips ?? 0)} pips
              </p>
              {!!rec?.repeats && <p className="text-[10.5px] text-white/35">{rec.repeats} more call{rec.repeats === 1 ? "" : "s"} repeated an idea that was already running, and {rec.repeats === 1 ? "is" : "are"} not counted twice.</p>}
              <p className="mt-2 text-[10px] uppercase tracking-wide text-white/40">Trades on accounts · last 30 days</p>
              {(["demo", "live"] as const).map((env) => {
                const x = r?.[env];
                return (
                  <p key={env} className="text-[12.5px] tabular-nums text-white/70">
                    {env === "demo" ? "Demo" : "Live"}: {x && x.calls > 0 ? <><b className="text-emerald-300">{x.win}W</b> · <b className="text-red-300">{x.loss}L</b>{x.flat ? ` · ${x.flat} flat` : ""} · {x.pips > 0 ? "+" : ""}{x.pips} pips</> : <span className="text-white/35">none closed yet</span>}{x && x.open > 0 ? <span className="text-white/45"> · {x.open} open</span> : null}
                  </p>
                );
              })}
            </div>
          );
        })}
      </div>
      {!anyReal && <p className="mt-2 text-[11px] text-white/35">No GEN FX trade has been placed on an account yet.</p>}
      <p className="mt-2 text-[10.5px] leading-relaxed text-white/30">A paper call — a page setup touched, or a scanner setup confirmed — counts a win when price reached its first target before its stop: nobody had to be in it, and it pays no spread. One idea is counted once, however it was called. A trade on an account is a real order, graded by the broker&apos;s own close, after break-even and trailing.</p>
    </section>
  );
}

/* ---------- owner: the master switches and the history replay ---------- */
function OwnerPanel({ desk, reload }: { desk: Desk; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ask, setAsk] = useState<"auto" | "billing" | "telegram" | "scan" | null>(null);
  const [askScope, setAskScope] = useState<Switches["scope"] | null>(null);
  const sw = desk.switches;
  const ov = desk.ownerView;
  if (!desk.owner || !sw || !ov) return null;

  async function post(body: Record<string, unknown>, okMsg: string) {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/genfx/desk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      setMsg(d.ok ? okMsg : d.detail || d.error || "That didn't save.");
      await reload();
    } catch { setMsg("Couldn't reach the server."); }
    finally { setBusy(false); }
  }
  const scopes: { id: Switches["scope"]; label: string }[] = [{ id: "owner", label: "My accounts" }, { id: "demo", label: "Demo accounts" }, { id: "all", label: "All members" }];
  const SCOPE_RANK: Record<Switches["scope"], number> = { owner: 0, demo: 1, all: 2 };
  // The three switches that cost or risk something are asked twice when they are turned ON.
  const CONFIRM: Partial<Record<"auto" | "billing" | "telegram" | "scan", string>> = {
    auto: `GEN FX will place real orders, by itself, on every account in scope that has a pair switched on (${ov.armed.inScope ?? "?"} in scope right now, of ${ov.armed.accounts} armed).`,
    billing: "Members will be charged credits for GEN FX reads, forming setups and placed trades, exactly as GENX charges.",
    telegram: "GEN FX calls will be posted to the Telegram channel.",
  };
  const row = (label: string, desc: string, on: boolean, key: "auto" | "billing" | "telegram" | "scan") => (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="text-[12.5px] font-bold text-white/85">{label}</p><p className="text-[11px] leading-snug text-white/45">{desc}</p></div>
        <Switch label={label} on={on} disabled={busy} onChange={(v) => { if (v && CONFIRM[key]) { setMsg(""); setAsk(key); } else void post({ action: "control", [key]: v }, `${label}: ${v ? "on" : "off"}`); }} />
      </div>
      {ask === key && (
        <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2">
          <p className="text-[12px] leading-relaxed text-amber-50/90">Turn <b>{label}</b> on? {CONFIRM[key]}</p>
          <div className="mt-2 flex gap-2">
            <button disabled={busy} onClick={() => { setAsk(null); void post({ action: "control", [key]: true }, `${label}: on`); }} className="rounded-lg bg-amber-300 px-3 py-1.5 text-[12px] font-bold text-[#1c1404] disabled:opacity-50">Turn it on</button>
            <button disabled={busy} onClick={() => setAsk(null)} className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 disabled:opacity-50">Not now</button>
          </div>
        </div>
      )}
    </div>
  );
  const rp = ov.replay;
  // A replay runs in a process of its own on the worker and reports in every few seconds. One that
  // says "running" but has not reported for three minutes is one that died (a deploy restarts the worker).
  const beatMs = rp?.heartbeatAt ? Date.parse(rp.heartbeatAt) : rp?.startedAt ? Date.parse(rp.startedAt) : NaN;
  const startedMs = rp?.startedAt ? Date.parse(rp.startedAt) : NaN;
  const running = rp?.status === "running" && Number.isFinite(beatMs) && Date.now() - beatMs < 3 * 60_000;
  const stalled = rp?.status === "running" && !running;
  const pg = rp?.progress;
  const pct = pg?.done != null && pg?.total ? Math.round((pg.done / pg.total) * 100) : null;
  const decisions = desk.lastScan?.decisions ?? null;
  const unsettled = ov.books?.unsettled ?? [];
  const trendLine = (t: Tallies | undefined) => {
    const b = t?.byTrend; if (!b) return null;
    const part = (k: string, label: string) => (b[k] ? `${label} ${b[k].n} trades ${b[k].r}R (${b[k].avgR}R each)` : null);
    const parts = [part("with", "with the 1-hour trend"), part("against", "against it"), part("mixed", "no clear trend")].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  };
  return (
    <section className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-400/[0.04] p-4">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-amber-300/90">Owner controls · only you see this</h2>
      {!sw.readable && <p className="mt-2 text-[12px] text-red-300">The control row could not be read — GEN FX is doing nothing until it can.</p>}
      <div className="mt-3 space-y-2">
        {row("Auto-trade", "Master switch. Off = no GEN FX order leaves for anyone.", sw.auto, "auto")}
        <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
          <p className="text-[12.5px] font-bold text-white/85">Who auto-trade reaches</p>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {scopes.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => {
                // Narrowing who it reaches is done at once. Widening it is asked twice, like the switches.
                const widens = SCOPE_RANK[s.id] > SCOPE_RANK[sw.scope];
                if (widens) { setMsg(""); setAskScope(s.id); } else { setAskScope(null); if (s.id !== sw.scope) void post({ action: "control", scope: s.id }, `Reaches: ${s.label}`); }
              }}
                className={`rounded-lg border px-2 py-1.5 text-[11.5px] font-bold transition disabled:opacity-50 ${sw.scope === s.id ? "border-amber-400/60 bg-amber-400/15 text-amber-200" : "border-white/10 text-white/55 hover:border-white/25"}`}>{s.label}</button>
            ))}
          </div>
          {askScope && (
            <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2">
              <p className="text-[12px] leading-relaxed text-amber-50/90">
                Open auto-trade to <b>{scopes.find((x) => x.id === askScope)?.label}</b>? It would reach {ov.armed.byScope?.[askScope] ?? "?"} armed account{ov.armed.byScope?.[askScope] === 1 ? "" : "s"} (now {ov.armed.inScope ?? "?"}){askScope === "all" ? " — live accounts included" : ""}.{sw.auto ? " Auto-trade is ON: the next call goes to them." : " Auto-trade is off, so nothing is placed until that is switched on too."}
              </p>
              <div className="mt-2 flex gap-2">
                <button disabled={busy} onClick={() => { const to = askScope; setAskScope(null); void post({ action: "control", scope: to }, `Reaches: ${scopes.find((x) => x.id === to)?.label ?? to}`); }} className="rounded-lg bg-amber-300 px-3 py-1.5 text-[12px] font-bold text-[#1c1404] disabled:opacity-50">Open it</button>
                <button disabled={busy} onClick={() => setAskScope(null)} className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 disabled:opacity-50">Not now</button>
              </div>
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-white/45">Armed now: {ov.armed.accounts} account{ov.armed.accounts === 1 ? "" : "s"} across {ov.armed.members} member{ov.armed.members === 1 ? "" : "s"} · EUR/USD {ov.armed.EURUSD} · GBP/JPY {ov.armed.GBPJPY}{ov.armed.inScope != null ? ` · ${ov.armed.inScope} of them in scope` : ""}. A member still has to switch a pair on for each account.{ov.armed.complete === false ? " (The list could not be read in full just now — these counts are of part of it.)" : ""}</p>
        </div>
        {row("Bill it like GENX", "5 credits a read (free on the Pass), 1 when a setup forms, 5 when a trade is placed. Off = GEN FX costs nothing.", sw.billing, "billing")}
        {row("Post to Telegram", "GEN FX heads-ups, ENTER NOW calls and wins go to the channel, labelled GEN FX.", sw.telegram, "telegram")}
        {row("Scanner", "Reads both pairs every five minutes, records what it finds and grades it. Risks nothing.", sw.scan, "scan")}
      </div>

      <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
        <p className="text-[12.5px] font-bold text-white/85">Orders being confirmed</p>
        {ov.books && !ov.books.readable ? <p className="mt-1 text-[11px] text-red-300">Could not read the order book.</p>
          : unsettled.length === 0 ? <p className="mt-1 text-[11px] text-white/45">None. Every GEN FX order is either a managed position or written off.</p>
          : (
            <>
              <p className="mt-1 text-[11px] leading-snug text-white/45">Each of these keeps its account from taking another trade the same way on that pair until the broker settles what happened to it. They normally clear inside a minute.</p>
              <ul className="mt-1.5 space-y-0.5 text-[11px] tabular-nums text-white/60">
                {unsettled.slice(0, 8).map((u, i) => (
                  <li key={i}><b className="text-white/75">#{u.acc_num ?? u.account_id}</b> · {nameOf(u.pair)} {String(u.side).toUpperCase()} · {u.status} · {agoShort(Date.parse(u.created_at))}{u.note ? ` — ${u.note}` : ""}</li>
                ))}
              </ul>
              {unsettled.length > 8 && <p className="mt-1 text-[10.5px] text-white/35">and {unsettled.length - 8} more</p>}
            </>
          )}
      </div>

      <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12.5px] font-bold text-white/85">History replay</p>
          <button disabled={busy || ov.replayPending || running} onClick={() => void post({ action: "replay", weeks: 52 }, "Replay asked for — the worker picks it up within a minute.")}
            className="rounded-lg border border-amber-400/40 px-2.5 py-1 text-[11.5px] font-bold text-amber-200 disabled:opacity-40">
            {ov.replayPending ? "Queued…" : running ? "Running…" : "Run a year"}
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-white/45">Runs the whole GEN FX pipeline over real 5-minute history — engine, setups, guards, break-even and trail — with the spread charged on every trade. Places nothing.</p>
        {running && <p className="mt-1.5 text-[11px] text-amber-200/80">Running since {agoShort(startedMs)}{pg?.pair ? ` — ${nameOf(pg.pair)}: ${pg.stage ?? "working"}${pct != null ? ` ${pct}%` : ""}` : ""}. Each pair appears below as it finishes.</p>}
        {stalled && <p className="mt-1.5 text-[11px] text-red-300">The last replay did not finish (the worker restarted while it was running). Run it again.</p>}
        {rp?.status === "failed" && <p className="mt-1.5 text-[11px] text-red-300">The last replay failed{rp.error ? `: ${rp.error}` : ""}. Run it again.</p>}
        {rp?.pairs && Object.keys(rp.pairs).length > 0 && (
          <div className="mt-2 space-y-2">
            {Object.entries(rp.pairs).map(([k, v]) => {
              const hi = v.managed?.all, lo = v.managedLow?.all ?? v.managed?.all;
              // Two estimates, shown low-to-high whichever run produced which (neither is a guaranteed bound).
              // An older result with only one run shows the one number.
              const two = !!v.managedLow;
              const span = (pick: (t: Tally) => number): [number, number] => { const a = lo ? pick(lo) : 0, b = hi ? pick(hi) : 0; return [Math.min(a, b), Math.max(a, b)]; };
              const [rA, rB] = span((t) => t.r), [eA, eB] = span((t) => t.avgR), [wA, wB] = span((t) => t.winRate);
              const trend = trendLine(v.managedLow ?? v.managed);
              const lowRun = v.managedLow ?? v.managed;
              const touch = lowRun?.byTouch;
              const each = (t: Record<string, Tally> | undefined, labels: [string, string][]) => labels.map(([k, label]) => (t?.[k] ? `${label} ${t[k].n} trades, ${t[k].r}R (${t[k].avgR}R each)` : null)).filter(Boolean).join(" · ");
              const via = each(lowRun?.byVia, [["touch", "a page setup touched"], ["ready", "the engine said trade-ready"], ["confirm", "a candle confirmed it"], ["pullback", "an armed setup pulled back"]]);
              const shown = each(lowRun?.byShown, [["fresh", "the page was still showing the level"], ["stale", "it had stopped showing it"]]);
              const after = each(lowRun?.byAfter, [["first", "first go at the level"], ["win", "within an hour of a win there"], ["loss", "within an hour of a loss there"]]);
              const placedBy = v.placements ? (["managed", "managedLow", "raw"] as const).map((k) => v.placements?.[k]?.placed).filter((n) => n != null) : [];
              return (
                <div key={k} className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11.5px] tabular-nums text-white/70">
                  <p className="font-bold text-white/85">{nameOf(k)} <span className="font-normal text-white/40">{v.from ? `${v.from.slice(0, 10)} → ${(v.to ?? "").slice(0, 10)}` : ""}</span></p>
                  {v.error ? <p className="text-red-300">{v.error}</p> : (
                    <>
                      {two
                        ? <p>Managed like live: {hi?.n ?? 0} trades · between <b className="text-white/90">{rA}R</b> and <b className="text-white/90">{rB}R</b> in total ({eA}R to {eB}R a trade) · {wA}–{wB}% wins · worst run −{Math.max(lo?.maxDrawdownR ?? 0, hi?.maxDrawdownR ?? 0)}R</p>
                        : <p>Managed like live: {hi?.n ?? 0} trades · <b className="text-white/90">{hi?.r ?? 0}R</b> in total ({hi?.avgR ?? 0}R a trade) · {hi?.winRate ?? 0}% wins · worst run −{hi?.maxDrawdownR ?? 0}R</p>}
                      <p>Left on stop and target: {v.raw?.all.n ?? 0} trades · {v.raw?.all.winRate ?? 0}% wins · {v.raw?.all.r ?? 0}R total ({v.raw?.all.avgR ?? 0}R a trade) · {v.raw?.all.pips ?? 0} pips</p>
                      {(v.managedLow ?? v.managed)?.byMode && <p className="text-white/50">By horizon (the lower figure): {Object.entries((v.managedLow ?? v.managed)!.byMode).map(([m, t]) => `${m} ${t.n} trades ${t.r}R`).join(" · ")}</p>}
                      {trend && <p className="text-white/50">By trend (reported, not applied): {trend}</p>}
                      {via && <p className="text-white/50">What made it a trade (the lower figure): {via}.</p>}
                      {touch && (touch.through || touch.bare) && <p className="text-white/50">Entries on a touch (the lower figure): {touch.bare?.n ?? 0} on a bare touch, {touch.bare?.r ?? 0}R · {touch.through?.n ?? 0} where the candle went on through the level, {touch.through?.r ?? 0}R. Live needs to see a touch twice, a second apart, so it takes fewer of the bare ones. (&ldquo;Went on through&rdquo; trades start a full unit against them by definition — that split says how many rest on a bare touch, not which kind is better.)</p>}
                      {shown && <p className="text-white/50">Page setups, by whether the page still showed the level (the lower figure): {shown}. A level stays watched for up to twelve hours after the page last showed it — GENX&apos;s rule.</p>}
                      {after && <p className="text-white/50">Page setups, by what had just happened at the level (the lower figure): {after}. A level can be entered again straight after a call on it ends — GENX&apos;s rule.</p>}
                      {v.placement && <p className="text-white/50">{v.placement.calls} calls → {v.placement.placed} placed{placedBy.length === 3 && new Set(placedBy).size > 1 ? ` (${placedBy[1]} in the lower run, ${placedBy[2]} left on stop and target — a trade that ends sooner frees its side sooner)` : ""}. Not placed: {Object.entries(v.placement.skipped).map(([c, n]) => `${c.replace(/_/g, " ")} ${n}`).join(", ") || "none"}.</p>}
                      <p className="text-white/40">Cost charged: {v.costPips} pip{v.costPips === 1 ? "" : "s"} a trade · minimum stop {v.minStopPips} pips{v.clock ? ` · 4-hour, daily and weekly candles cut on ${v.clock.zone === "NY17" ? "the 5pm New York day" : v.clock.zone.replace(/^Etc\/GMT([+-])(\d+)$/, (_m, sg: string, h: string) => `a fixed UTC${sg === "-" ? "+" : "−"}${h}`)} time (${v.clock.note ?? (v.clock.verified ? "matches the feed" : v.clock.forced ? "set by hand" : "closest fit — not an exact match")})` : ""}.{v.clock && !v.clock.verified && !v.clock.forced ? " The Intraday and Swing numbers depend on this clock (both read daily candles; Quick does not) — treat them as rough until it is confirmed." : ""}</p>
                    </>
                  )}
                </div>
              );
            })}
            <p className="text-[10.5px] leading-snug text-white/35">Two figures, because a 5-minute candle cannot say whether its low came before or after its high: the higher gives a stop the manager moved inside a candle the benefit of the doubt; the lower takes the worst order of events the candle allows, in every candle. The lower one is a floor for the manager&apos;s rules, not a forecast: run tick by tick on a random walk, the same rules land a little under the higher figure (0.01–0.03R a trade) and well above the lower. Neither is a promise. A replay also fills at the price of the moment, and enters on any touch; live fills are worse and live wants the touch seen twice.{rp.finishedAt ? ` Finished ${agoShort(Date.parse(rp.finishedAt))}.` : ""}</p>
          </div>
        )}
      </div>

      {decisions && (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
          <p className="text-[12.5px] font-bold text-white/85">Last scan, read by read</p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-white/55">
            {Object.entries(decisions).map(([k, d]) => (
              <li key={k}><b className="text-white/70">{k.replace(":", " · ")}</b> — {String(d.action ?? d.skip ?? "—").replace(/_/g, " ")}{d.conf != null ? ` (${String(d.conf)}/100)` : ""}{d.zone ? ` · page setup: ${String(d.zone).replace(/_/g, " ")}` : ""}{d.result ? ` · ${String(d.result)}` : d.skip && d.action ? ` · ${String(d.skip).replace(/_/g, " ")}` : ""}{d.error ? ` · error: ${String(d.error)}` : ""}</li>
            ))}
          </ul>
        </div>
      )}
      {msg && <p className="mt-2 text-[12px] text-amber-200">{msg}</p>}
    </section>
  );
}

export function GenFxDesk() {
  const [pair, setPair] = useState<PairKey>("EURUSD");
  const [mode, setMode] = useState<string>("quick");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const [plays, setPlays] = useState<PlayRow[]>([]);
  const [showPlays, setShowPlays] = useState(false);
  const [replay, setReplay] = useState<{ at: string } | null>(null);
  const [desk, setDesk] = useState<Desk | null>(null);

  // Opened from a pair's card on The Floor: start on that pair. The note is read once and removed.
  useEffect(() => {
    try {
      const v = window.sessionStorage.getItem(GENFX_OPEN_PAIR);
      if (!v) return;
      window.sessionStorage.removeItem(GENFX_OPEN_PAIR);
      if (v === "EURUSD" || v === "GBPJPY") setPair(v);
    } catch { /* no session storage: the default pair */ }
  }, []);

  const loadDesk = useCallback(async () => {
    try { const r = await fetch("/api/genfx/desk?v=2", { cache: "no-store" }); const d = await r.json(); if (d?.ok) setDesk(d as Desk); } catch { /* the read still works without it */ }
  }, []);
  const loadPlays = useCallback(async () => {
    try { const r = await fetch("/api/genfx/history", { cache: "no-store" }); const d = await r.json(); if (Array.isArray(d.plays)) setPlays(d.plays as PlayRow[]); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void loadDesk(); void loadPlays();
    const id = setInterval(() => { if (document.visibilityState === "visible") void loadDesk(); }, 60_000);
    return () => clearInterval(id);
  }, [loadDesk, loadPlays]);

  async function openPlay(id: string) {
    try {
      const r = await fetch(`/api/genfx/history?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = await r.json();
      if (d?.play?.genfx) {
        const p: PairKey = d.play.pair === "GBPJPY" ? "GBPJPY" : "EURUSD";
        setPair(p);
        setRes({ ok: true, pair: p, genfx: d.play.genfx as Genfx, price: d.play.price ?? undefined, data_status: d.play.data_status ?? undefined, asOf: d.play.asOf, candles: [] });
        setReplay({ at: d.play.at });
        setErr(""); setShowPlays(false);
        try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Tracked setups: this device first for an instant render, then the account as the source of truth.
  useEffect(() => {
    try { const raw = localStorage.getItem(TRACK_KEY); if (raw) setTracked(JSON.parse(raw)); } catch { /* ignore */ }
    (async () => {
      try {
        const r = await fetch("/api/genfx/tracked", { cache: "no-store" });
        const d = await r.json();
        if (Array.isArray(d.tracked)) {
          setTracked(d.tracked as Tracked[]);
          try { localStorage.setItem(TRACK_KEY, JSON.stringify(d.tracked)); } catch { /* ignore */ }
        }
      } catch { /* offline — keep the local copy */ }
    })();
  }, []);
  const persist = useCallback((next: Tracked[]) => {
    setTracked(next);
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const pairName = nameOf(pair);
  async function analyze() {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/genfx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pair, mode }) });
      const d: Resp = await r.json();
      if (d.notConfigured) { setErr("Market data isn’t configured on the server yet."); setRes(null); }
      else if (d.error === "insufficient_credits") { setErr(`Not enough credits to run GEN FX${typeof d.balance === "number" ? ` (balance ${d.balance})` : ""}.`); setRes(null); try { window.dispatchEvent(new Event("open-credits-flyer")); } catch { /* ignore */ } }
      else if (!r.ok || !d.ok) { setErr(d.detail || d.error || `GEN FX couldn’t read ${pairName} right now — try again shortly.`); setRes(null); }
      else { setRes(d); setReplay(null); void loadPlays(); void loadDesk(); }   // a read opens the lists below, too
    } catch { setErr("Couldn’t reach the server."); }
    finally { setLoading(false); }
  }

  const g = res?.genfx;
  const shown: PairKey = res?.pair ?? pair;             // the pair the read on screen is for
  // One object per read, not one per render. The live confirmation re-checks whenever the setup it is
  // handed changes; a fresh object on every render (the desk reloads once a minute) made it re-check
  // then too, and a banner that had said CONFIRMED could be overwritten by the next look.
  const shownSetup = useMemo(() => (g ? setupFrom(shown, g) : null), [shown, g]);
  const dec = decOf(shown);
  const side = g ? sideOf(g.action) : "wait";
  const hasPlan = g ? num(g.entry) != null && num(g.stop_loss) != null : false;
  const cardTone = side === "buy" ? "border-emerald-400/30" : side === "sell" ? "border-red-400/30" : "border-sky-400/30";
  const actTone = side === "buy" ? "text-emerald-400" : side === "sell" ? "text-red-400" : "text-sky-300";

  const trackKey = (s: { pair: string; side: string; entryLow: number | null; entryHigh: number | null }) => `${s.pair}|${s.side}|${s.entryLow}|${s.entryHigh}`;
  const isTracked = !!shownSetup && tracked.some((t) => trackKey(t) === trackKey(shownSetup));
  function trackCurrent() {
    if (!g) return;
    const base = setupFrom(shown, g);
    const label = `${nameOf(shown)} ${base.side === "sell" ? "SELL" : "BUY"} ${g.entry_low != null && g.entry_high != null ? `${fx(g.entry_low, dec)}–${fx(g.entry_high, dec)}` : fx(g.entry, dec)}`;
    const t: Tracked = { ...base, id: String(Date.now()), savedAt: Date.now(), tp2: g.tp2, label };
    persist([t, ...tracked.filter((x) => trackKey(x) !== trackKey(t))].slice(0, 8));
    fetch("/api/genfx/tracked", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tracked: t }) }).catch(() => { /* offline; the local copy holds it */ });
  }
  function untrack(id: string) {
    persist(tracked.filter((x) => x.id !== id));
    fetch(`/api/genfx/tracked?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => { /* ignore */ });
  }
  const billing = !!desk?.switches?.billing;
  const auto = res?.auto;

  return (
    <div className="rounded-2xl border border-sky-400/20 bg-[#0b0d14] p-5 text-white sm:p-6" style={{ backgroundImage: "radial-gradient(120% 80% at 0% 0%, rgba(56,189,248,0.07), transparent 60%)" }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-300/80"><ArrowLeftRight className="h-3.5 w-3.5" /> The GENX engine · on currencies</p>
          <h1 className="mt-1 bg-gradient-to-r from-sky-200 via-sky-400 to-indigo-300 bg-clip-text font-serif text-4xl font-black tracking-tight text-transparent">GEN FX</h1>
          <p className="mt-1 text-sm text-white/50">Ask one question — “what should I do on {pairName} right now?” — and get a straight answer with the plan behind it.</p>
        </div>
        {res?.price != null && (
          <div className="ml-auto text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-white/40">{nameOf(shown)}</p>
            <p className="text-2xl font-bold tabular-nums">{fx(res.price, dec)}</p>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${res.data_status === "live" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-white/50"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${res.data_status === "live" ? "bg-emerald-400" : "bg-white/40"}`} /> {res.data_status === "live" ? "LIVE" : "REFERENCE"}
            </span>
          </div>
        )}
      </div>

      {/* pair */}
      <div className="mt-5 grid grid-cols-2 gap-2">
        {PAIRS.map((p) => (
          <button key={p.id} onClick={() => setPair(p.id)} aria-pressed={pair === p.id} className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${pair === p.id ? "border-sky-400/60 bg-sky-400/[0.12]" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}>
            <p className="text-base font-black tracking-tight text-white">{p.name}</p>
            <p className="text-[11px] text-white/45">{p.sub}</p>
          </button>
        ))}
      </div>
      {/* horizon */}
      <div className="mt-2 grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button key={m.id} onClick={() => setMode(m.id)} aria-pressed={mode === m.id} className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${mode === m.id ? "border-sky-400/50 bg-sky-400/[0.1]" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}>
            <p className="text-sm font-bold text-white">{m.label}</p>
            <p className="text-[11px] text-white/45">{m.sub}</p>
          </button>
        ))}
      </div>

      <button onClick={analyze} disabled={loading} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-300 to-sky-500 px-4 py-3 text-sm font-bold text-[#04121c] transition hover:from-sky-200 hover:to-sky-400 disabled:opacity-60">
        {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing {pairName}…</> : res && shown === pair ? `Re-analyze ${pairName}` : `Analyze ${pairName} now`}
      </button>
      <p className="mt-1.5 text-center text-[11px] text-white/40">{billing ? "5 credits per read · free on the FLOW Pass" : "Free right now — GEN FX reads cost no credits while it is new"}</p>
      {loading && <p className="mt-2 text-center text-xs text-white/40">◆ Reading live {pairName} — structure, momentum, levels, liquidity…</p>}
      {err && <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300">{err}</div>}

      <div className="mt-3">
        <button onClick={() => { setShowPlays((v) => !v); if (!plays.length) void loadPlays(); }} className="w-full rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-[12px] font-bold text-white/60 transition hover:border-white/25">
          Your past plays{plays.length ? ` (${plays.length})` : ""} {showPlays ? "▴" : "▾"}
        </button>
        {showPlays && (
          <div className="mt-2 space-y-1.5 rounded-2xl border border-white/10 bg-white/[0.02] p-2.5">
            {plays.length === 0 && <p className="px-1 py-2 text-[11px] text-white/35">No reads yet — every GEN FX analysis you run is kept here.</p>}
            {plays.map((p) => {
              const d = decOf(p.pair);
              return (
                <button key={p.id} onClick={() => void openPlay(p.id)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition hover:border-sky-400/40">
                  <span className="min-w-0">
                    <span className="block text-[12px] font-bold" style={{ color: p.direction === "bearish" ? "#ff5d6c" : p.direction === "bullish" ? "#2ee88f" : "#5cc8ff" }}>{nameOf(p.pair)} · {p.action ? actionLabel(p.action) : "READ"}</span>
                    <span className="block text-[10px] tabular-nums text-white/40">{(p.mode || "").toUpperCase()} · {p.entryLow != null && p.entryHigh != null ? `${fx(p.entryLow, d)}–${fx(p.entryHigh, d)}` : fx(p.entry, d)} · stop {fx(p.stop, d)} · TP1 {fx(p.tp1, d)}</span>
                  </span>
                  <span className="flex-shrink-0 text-right text-[10px] text-white/35">{p.confidence != null ? `${p.confidence}/100` : ""}<br />{agoShort(Date.parse(p.at))}</span>
                </button>
              );
            })}
            <p className="px-1 pt-1 text-[10px] leading-relaxed text-white/30">Opening one shows that analysis exactly as it was written — the levels are frozen at the time of the read, not updated to the current market.</p>
          </div>
        )}
      </div>

      {replay && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-sky-400/30 bg-sky-400/[0.07] px-3 py-2">
          <p className="text-[11px] font-semibold text-sky-200">Saved play from {new Date(replay.at).toLocaleString()} — frozen as it was written.</p>
          <button onClick={() => { setRes(null); setReplay(null); }} className="flex-shrink-0 rounded-lg border border-sky-400/40 px-2 py-1 text-[11px] font-bold text-sky-200">Back to live</button>
        </div>
      )}

      {tracked.length > 0 && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
          <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white/45">Tracked setups <span className="text-white/25">({tracked.length})</span></p>
          <div className="space-y-2.5">{tracked.map((t) => <TrackedRow key={t.id} t={t} onRemove={() => untrack(t.id)} />)}</div>
          <p className="mt-2.5 text-[10px] leading-relaxed text-white/30">Each keeps checking live for its own confirmation — so re-analyzing never loses the setup you were waiting on.</p>
        </div>
      )}

      {g && (
        <>
          <div className={`mt-5 rounded-2xl border ${cardTone} bg-white/[0.02] p-5`}>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/40">{nameOf(shown)} · {g.mode}</p>
            <p className={`text-3xl font-black tracking-tight ${actTone}`}>{actionLabel(g.action)}</p>
            <p className="mt-1 text-sm text-white/60">
              <span className="text-lg font-bold text-white">{g.confidence_score}</span><span className="text-white/40">/100</span> · {confLabel(g.confidence_score)}
            </p>
            <p className="mt-1 text-[13px] text-white/50">
              Bias: {g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral"} · {g.market_structure} · {g.session}
            </p>

            {shownSetup && <LiveConfirm key={`${shownSetup.pair}:${shownSetup.mode}:${shownSetup.side}:${shownSetup.entry}:${shownSetup.stop}`} setup={shownSetup} />}

            {hasPlan && (g.action.includes("WAIT") || g.action.includes("LIMIT")) && (
              <button onClick={() => trackCurrent()} className="mt-2 w-full rounded-lg border border-white/15 bg-white/[0.03] px-3 py-2 text-[12px] font-semibold text-white/70 transition hover:bg-white/[0.07]">
                {isTracked ? "✓ Tracking this setup — you'll find it up top" : "Track this setup — come back to it later"}
              </button>
            )}

            {hasPlan ? (
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <LTile label="Entry" value={g.entry_low != null && g.entry_high != null ? `${fx(g.entry_low, dec)}–${fx(g.entry_high, dec)}` : fx(g.entry, dec)} />
                <LTile label="Stop loss" value={fx(g.stop_loss, dec)} sub={g.stop_pips != null ? `${g.stop_pips} pips` : undefined} tone="text-red-300" />
                {g.tp1 != null && <LTile label="TP1" value={fx(g.tp1, dec)} sub={g.tp1_pips != null ? `+${g.tp1_pips} pips` : undefined} tone="text-emerald-300" />}
                {g.tp2 != null && <LTile label="TP2" value={fx(g.tp2, dec)} sub={g.tp2_pips != null ? `+${g.tp2_pips} pips` : undefined} tone="text-emerald-300" />}
                {g.tp3 != null && <LTile label="TP3" value={fx(g.tp3, dec)} sub={g.tp3_pips != null ? `+${g.tp3_pips} pips` : undefined} tone="text-emerald-300" />}
                <LTile label="Expected hold" value={fmtHold(g.expected_hold_minutes)} />
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <LTile label="Preferred" value={g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral"} />
                <LTile label="Support" value={fx(g.closest_support, dec)} tone="text-emerald-300" />
                <LTile label="Resistance" value={fx(g.closest_resistance, dec)} tone="text-red-300" />
                <LTile label="Room" value={g.room_to_target_pips != null ? `${g.room_to_target_pips} pips` : "—"} />
              </div>
            )}
            {g.trigger_condition && <p className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white/60">{g.trigger_condition}</p>}

            {/* The one thing GEN FX adds to the card: whether auto-trade would take this stop. */}
            {hasPlan && auto && !auto.stopOk && auto.stopPips != null && (
              <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-amber-100/90">
                <b>Not auto-traded.</b> This stop is {auto.stopPips} pips — under the {auto.minStopPips}-pip minimum for {nameOf(shown)}. With a spread around {auto.costPips} pip{auto.costPips === 1 ? "" : "s"}, a stop that tight gives up too much of the trade before it starts. The read is still the engine&apos;s; taking it by hand is your call.
              </p>
            )}
          </div>

          <div className="sm:hidden">
            {(g.action === "WAIT_FOR_BUY_TRIGGER" || g.action === "WAIT_FOR_SELL_TRIGGER") && (
              <ConfirmHelp sell={g.action === "WAIT_FOR_SELL_TRIGGER"} level={g.action === "WAIT_FOR_SELL_TRIGGER" ? (g.closest_resistance ?? g.entry) : (g.closest_support ?? g.entry)} />
            )}
            <FxChart candles={res?.candles || []} g={g} dec={dec} />
          </div>
          <div className="hidden sm:block">
            <GenFxFlow candles={res?.candles || []} g={g} price={res?.price ?? null} live={res?.data_status === "live"} dec={dec} />
          </div>

          {g.market_story?.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">What GEN FX sees</h3>
              <div className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-white/75">{g.market_story.map((s, i) => <p key={i}>{s}</p>)}</div>
            </section>
          )}
          {g.trade_reasoning?.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-300/80">Why GEN FX likes it</h3>
              <ul className="mt-2 space-y-1 text-[13px] text-white/75">{g.trade_reasoning.map((s, i) => <li key={i} className="flex gap-2"><span className="text-sky-400">›</span>{s}</li>)}</ul>
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
                <div className="mt-1 flex h-3 overflow-hidden rounded-full bg-red-500/30"><div className="h-full bg-emerald-400/70" style={{ width: `${g.buyer_control}%` }} /></div>
              </div>
              {g.invalidation_reason && <p className="text-[13px] text-white/60"><span className="font-semibold text-white/75">Invalidation:</span> {g.invalidation_reason}</p>}
              {g.risk_factors?.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Watch for</h3>
                  <ul className="mt-1.5 space-y-1 text-[13px] text-white/70">{g.risk_factors.map((s, i) => <li key={i} className="flex gap-2"><span className="text-white/30">•</span>{s}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {desk && (
        <>
          <AutoTrade desk={desk} reload={loadDesk} />
          <Watching desk={desk} reload={loadDesk} />
          <Record desk={desk} />
          <OwnerPanel desk={desk} reload={loadDesk} />
        </>
      )}

      <p className="mt-5 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/35">
        Every price, level and score is computed by the same deterministic engine GENX uses, from live {pairName} data — the AI only writes the plain-English read. News is not checked: look at the calendar for both currencies before a trade. Educational only; not financial advice. You approve every action on your own account.
      </p>
    </div>
  );
}
