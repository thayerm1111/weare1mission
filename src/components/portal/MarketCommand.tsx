"use client";

/**
 * OM AI Market Command — front end for the deterministic qualification engine.
 * The card renders exactly what /api/market-command returns: a qualified setup,
 * or (just as importantly) a NO TRADE with an explicit reason. Every number is
 * computed server-side in code; this component only displays and journals them.
 */
import { useEffect, useState } from "react";
import {
  Crosshair, Loader2, ShieldAlert, ArrowUp, ArrowDown, Gauge, Clock,
  Ban, Check, Sparkles, TrendingUp, AlertTriangle, Trash2, X, Activity, Eye,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";
import { CopyAllBtn, buildTradeText } from "./copykit";
import { TradeChat } from "./TradeChat";
import { Ring, GradeRing, Sparkline, StatRow, StatTile, Checks, Levels, scoreTone } from "./quantUi";

const INSTRUMENTS: { td: string; label: string; cat: string }[] = [
  { td: "XAU/USD", label: "Gold", cat: "Commodity" },
  { td: "XAG/USD", label: "Silver", cat: "Commodity" },
  { td: "WTI/USD", label: "Crude Oil", cat: "Commodity" },
  { td: "EUR/USD", label: "Euro", cat: "Forex" },
  { td: "GBP/USD", label: "Pound", cat: "Forex" },
  { td: "USD/JPY", label: "Yen", cat: "Forex" },
  { td: "AUD/USD", label: "Aussie", cat: "Forex" },
  { td: "USD/CAD", label: "Loonie", cat: "Forex" },
  { td: "SPY", label: "S&P 500", cat: "Index" },
  { td: "NAS100", label: "Nasdaq 100", cat: "Index" },
  { td: "DIA", label: "Dow 30", cat: "Index" },
  { td: "BTC/USD", label: "Bitcoin", cat: "Crypto" },
  { td: "ETH/USD", label: "Ethereum", cat: "Crypto" },
];

type TP = { label: string; price: number; risk_reward: number; reason: string; suggested_close_percent: number };
type Setup = Record<string, unknown> & {
  status: string; instrument?: string; market_category?: string; timestamp?: string; headline?: string; reason?: string; recheck?: string;
  direction?: string; order_type?: string; market_regime?: string; strategy?: string; session?: string; setup_expiration?: string;
  invalidation?: string; confidence?: string; data_provider?: string; data_age_seconds?: number | null; market_status?: string;
  grade?: string; gate_score?: number; gate_reasons?: string[]; mode?: string; momentum_rating?: string; trend_rating?: string;
  entry?: { price: number; zone_low?: number; zone_high?: number }; stop_loss?: { price: number; reason: string };
  take_profits?: TP[]; scores?: Record<string, number>; news_risk?: { level: string; next_event?: string; event_time?: string; note?: string };
  position_sizing?: Record<string, number | string>; reasoning?: string[]; risk_warnings?: string[]; educational_disclaimer?: string; error?: string;
  spark?: number[];
  // v3 standardized states
  state?: string; what_next?: string[]; entry_status?: string;
  levels?: Record<string, number> | null;
  confidence_breakdown?: Record<string, number>;
  trigger?: {
    state?: string; direction?: string | null; strategy?: string; monitorTimeframe?: string; triggerType?: string;
    triggerLevel?: number | null; retestZoneLow?: number | null; retestZoneHigh?: number | null;
    confirmationRequired?: string; invalidationLevel?: number | null; expirationCondition?: string; recheckInstruction?: string;
  } | null;
  provisional_trade?: {
    direction?: string; strategy?: string; order_type?: string;
    entry?: { price: number; zone_low?: number; zone_high?: number }; stop_loss?: { price: number; reason?: string };
    take_profits?: { label: string; price: number; structural?: boolean; risk_reward?: number }[];
    risk_reward_tp1?: number; entry_status?: string;
  } | null;
  current_bias?: string | null;
  news_status?: string; news_warning?: string; news_check_currencies?: string[]; news_check_note?: string;
  setup_zone?: {
    direction?: string; setup_type?: string; zone_low?: number; zone_high?: number; zone_source?: string;
    setup_timeframe?: string; why?: string[]; what_price_must_do?: string[]; confirmation?: string;
    invalidation?: string; first_target?: number; second_target?: number | null; cancels?: string;
  } | null;
  proximity?: {
    status?: string; current_price?: number; zone_low?: number; zone_high?: number;
    distance?: number; distance_atr?: number; candles_away?: number; reachable_this_session?: boolean; note?: string;
  } | null;
  alternative_scenario?: { direction?: string; trigger?: string; activation_zone?: string; invalidates_current?: string } | null;
};
type JournalItem = Setup & { id: number };
// Live "Get update" snapshot for a qualified setup.
type TradeUpdate = {
  headline: string; thesis: "intact" | "weakening" | "invalidated"; price: number;
  pnl: { r: number; pips: number; side: string; percent: number };
  distance: { to_stop_pips: number; to_next_target_pips: number; next_target_label: string };
  market?: { flow_1h?: string; flow_4h?: string; rsi?: number | null };
  explanation: string[]; what_to_watch: string;
};

const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toFixed(6)) : "—");

export function MarketCommand() {
  const [td, setTd] = useState("XAU/USD");
  const [balance, setBalance] = useState("10000");
  const [riskPct, setRiskPct] = useState("1");
  const [mode, setMode] = useState<"institutional" | "accelerator">("institutional");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [journal, setJournal] = useState<JournalItem[]>([]);
  const [updating, setUpdating] = useState<number | null>(null);
  const [updates, setUpdates] = useState<Record<number, TradeUpdate>>({});

  useEffect(() => { try { const raw = localStorage.getItem("om_command"); if (raw) setJournal(JSON.parse(raw)); } catch { /* ignore */ } }, []);
  function persist(next: JournalItem[]) { setJournal(next); try { localStorage.setItem("om_command", JSON.stringify(next.slice(0, 15))); } catch { /* ignore */ } }

  async function analyze() {
    if (loading) return;
    setLoading(true); setError(""); setNeedCredits(false); setResult(null);
    try {
      const res = await fetch("/api/market-command", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td, balance: Number(balance) || undefined, riskPct: Number(riskPct) || undefined, mode }),
      });
      const d: Setup = await res.json().catch(() => ({ status: "error" }));
      if (res.status === 403) { setError(d.reason || "OM AI Market Command is in admin-only beta."); return; }
      if (res.status === 402 || d.error === "insufficient_credits") { setNeedCredits(true); setError("You're out of credits. They reset weekly — or grab more."); try { window.dispatchEvent(new Event("open-credits-flyer")); } catch { /* ignore */ } return; }
      if (d.error === "ratelimit" || d.error === "system_busy" || d.error === "notConfigured") { setError(d.reason || "Market data is busy — try again shortly."); return; }
      if (d.status === "error") { setError(d.reason || "Couldn't run the analysis right now. Try again shortly."); return; }
      const item: JournalItem = { ...d, id: Date.now() };
      setResult(item);
      persist([item, ...journal].slice(0, 15));
      try { window.dispatchEvent(new Event("credits-updated")); } catch { /* ignore */ }
    } catch { setError("Something interrupted the connection. Try again."); }
    finally { setLoading(false); }
  }

  // "Get update" — re-read the live market and explain what's happening to this
  // qualified setup now (profit/drawdown, stop-run vs real break, flow flip). Free.
  async function getUpdate(s: Setup) {
    const rid = (s as JournalItem).id;
    if (updating != null || rid == null || s.status !== "qualified_setup") return;
    setUpdating(rid);
    try {
      const ageMs = Date.now() - rid;
      const res = await fetch("/api/om-signal-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          td: s.instrument, symbol: s.instrument, style: "intraday",
          direction: s.direction === "buy" ? "LONG" : "SHORT",
          entry: s.entry?.price, stopLoss: s.stop_loss?.price,
          takeProfits: (s.take_profits || []).map((t) => t.price),
          since: ageMs > 20 * 60 * 1000 ? new Date(rid).toISOString() : "",
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (d && d.status === "update") setUpdates((u) => ({ ...u, [rid]: d as TradeUpdate }));
    } catch { /* ignore */ } finally { setUpdating(null); }
  }

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(120,160,210,0.16),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sky-300 to-sky-600"><Crosshair className="h-4 w-4 text-[#0a0b10]" /></span>
          <div>
            <p className="font-serif text-base font-semibold uppercase tracking-[0.14em]">OM AI Market Command</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Quantitative setup qualification · admin beta</p>
          </div>
        </div>
        <span className="rounded-full border border-white/15 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-white/50">NO&nbsp;TRADE is a feature</span>
      </div>

      <div className="relative z-10 px-6 py-6 sm:px-8">
        {/* Controls */}
        <p className="text-[11px] uppercase tracking-[0.12em] text-white/45">Instrument</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {INSTRUMENTS.map((i) => (
            <button key={i.td} onClick={() => setTd(i.td)} title={`${i.label} · ${i.cat}`}
              className={`rounded-xl border px-3 py-1.5 text-xs transition-colors ${td === i.td ? "border-sky-400/60 bg-sky-400/10 text-white" : "border-white/12 bg-white/[0.03] text-white/60 hover:text-white/90"}`}>
              {i.td}
            </button>
          ))}
        </div>

        {/* Trading mode */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setMode("institutional")}
            className={`rounded-xl border px-3 py-2 text-left transition-colors ${mode === "institutional" ? "border-sky-400/60 bg-sky-400/10" : "border-white/12 bg-white/[0.03] hover:border-white/25"}`}>
            <span className="block text-sm font-semibold text-white">Institutional</span><span className="mt-0.5 block text-[10px] text-white/40">Strict · A+/A · ≥2.5R</span>
          </button>
          <button onClick={() => setMode("accelerator")}
            className={`rounded-xl border px-3 py-2 text-left transition-colors ${mode === "accelerator" ? "border-amber-400/60 bg-amber-400/10" : "border-white/12 bg-white/[0.03] hover:border-white/25"}`}>
            <span className="block text-sm font-semibold text-white">Accelerator</span><span className="mt-0.5 block text-[10px] text-white/40">Aggressive · momentum · ≥1.8R</span>
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-white/45">Account balance (USD)</span>
            <input value={balance} onChange={(e) => setBalance(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal"
              className="mt-1 w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-sm font-semibold tabular-nums text-white outline-none focus:border-sky-400/60" />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-white/45">Risk per trade (%)</span>
            <input value={riskPct} onChange={(e) => setRiskPct(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal"
              className="mt-1 w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-sm font-semibold tabular-nums text-white outline-none focus:border-sky-400/60" />
          </label>
          <button onClick={analyze} disabled={loading}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-sky-300 to-sky-600 px-6 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#0a0b10] transition-opacity hover:opacity-90 disabled:opacity-40">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {loading ? "Qualifying…" : "Analyze"}
            <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.command}</span>
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
            <p className="inline-flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> {error}</p>
            {needCredits && <a href="/portal/credits" className="mt-2 inline-flex rounded-lg bg-sky-400/90 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#0a0b10]">Get credits</a>}
          </div>
        )}

        {result && <SetupView s={result} onUpdate={() => getUpdate(result)} updating={updating === (result as JournalItem).id} update={updates[(result as JournalItem).id ?? -1]} />}

        {/* Recent runs */}
        {journal.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
              <span>Recent runs</span>
              <button onClick={() => persist([])} className="inline-flex items-center gap-1 text-white/40 hover:text-white/70"><Trash2 className="h-3 w-3" /> clear</button>
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {journal.map((j) => (
                <button key={j.id} onClick={() => setResult(j)} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:border-white/25">
                  <span className="flex items-center gap-2 text-sm font-semibold">{j.instrument}
                    {j.status === "qualified_setup"
                      ? <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${j.direction === "buy" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>Ready · {j.direction}</span>
                      : <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${(STATE_STYLE[j.status] ?? STATE_STYLE.no_trade).cls}`}>{(STATE_STYLE[j.status] ?? STATE_STYLE.no_trade).label}</span>}
                  </span>
                  <span className="text-[10px] text-white/35">{j.scores?.overall != null ? `${j.scores.overall}/100` : ""}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-5 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-white/35">
          Educational market-analysis & paper-trading decision support — not financial advice, and not a prediction. Trading CFDs, forex, indices and commodities involves substantial risk; you may lose some or all of your capital. Past performance does not guarantee future results. No target is guaranteed to be reached before a stop. Automatic broker execution is disabled.
        </p>
      </div>
    </div>
  );
}

const INFO_STATES = new Set(["no_trade", "developing_setup", "watchlist", "data_unavailable", "insufficient_data"]);
const STATE_STYLE: Record<string, { label: string; cls: string; Icon: typeof Ban }> = {
  developing_setup: { label: "DEVELOPING", cls: "bg-amber-400/15 text-amber-300 border-amber-400/40", Icon: Clock },
  watchlist: { label: "WATCHLIST", cls: "bg-sky-400/15 text-sky-300 border-sky-400/40", Icon: Eye },
  no_trade: { label: "NO TRADE", cls: "bg-white/10 text-white/70 border-white/20", Icon: Ban },
  data_unavailable: { label: "DATA ERROR", cls: "bg-red-500/15 text-red-300 border-red-400/40", Icon: AlertTriangle },
  insufficient_data: { label: "INSUFFICIENT DATA", cls: "bg-red-500/15 text-red-300 border-red-400/40", Icon: AlertTriangle },
};

function InfoStateView({ s }: { s: Setup }) {
  const st = STATE_STYLE[s.status] ?? STATE_STYLE.no_trade;
  const Icon = st.Icon;
  const t = s.trigger || undefined;
  const pt = s.provisional_trade || undefined;
  const lv = s.levels || undefined;
  const buy = (pt?.direction ?? s.direction) === "buy";
  return (
    <div className="mt-5 rounded-2xl border border-white/12 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-9 w-9 place-items-center rounded-full border ${st.cls}`}><Icon className="h-4 w-4" /></span>
          <div>
            <p className="font-serif text-lg font-bold">{s.instrument} · {st.label}</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/45">{s.headline}</p>
          </div>
        </div>
        {(pt?.direction ?? s.direction) && s.status !== "data_unavailable" && s.status !== "insufficient_data" && (
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${buy ? "text-emerald-400 bg-emerald-500/15" : "text-red-400 bg-red-500/15"}`}>{buy ? "Bias · Long" : "Bias · Short"}</span>
        )}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-white/80">{s.reason}</p>

      {/* WHAT NEEDS TO HAPPEN NEXT — measurable, prominent */}
      {Array.isArray(s.what_next) && s.what_next.length > 0 && (
        <div className="mt-4 rounded-xl border border-white/12 bg-white/[0.04] p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/55">What needs to happen next</p>
          <ul className="mt-2 space-y-1.5">
            {s.what_next.map((w, i) => (
              <li key={i} className="flex gap-2 text-sm text-white/80"><span className="text-gold-light">→</span><span>{w}</span></li>
            ))}
          </ul>
        </div>
      )}

      {/* Trigger detail */}
      {t && (t.triggerLevel != null || t.confirmationRequired) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {t.monitorTimeframe && <Kv k="Monitor" v={t.monitorTimeframe} />}
          {t.triggerType && <Kv k="Trigger" v={String(t.triggerType).replace(/_/g, " ").toLowerCase()} />}
          {t.triggerLevel != null && <Kv k="Level" v={String(t.triggerLevel)} />}
          {t.retestZoneLow != null && t.retestZoneHigh != null && <Kv k="Retest zone" v={`${t.retestZoneLow}–${t.retestZoneHigh}`} />}
          {t.invalidationLevel != null && <Kv k="Invalidation" v={String(t.invalidationLevel)} />}
          {t.expirationCondition && <Kv k="Expires" v={t.expirationCondition} />}
        </div>
      )}

      {/* Provisional trade (developing / watchlist) */}
      {pt && pt.entry && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-white/45">Provisional {buy ? "long" : "short"} · pending trigger{pt.entry_status ? ` · entry ${pt.entry_status}` : ""}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/70">
            <span>Entry <b className="text-white/90">{pt.entry.zone_low != null && pt.entry.zone_high != null ? `${pt.entry.zone_low}–${pt.entry.zone_high}` : pt.entry.price}</b></span>
            {pt.stop_loss && <span>Stop <b className="text-red-300">{pt.stop_loss.price}</b></span>}
            {(pt.take_profits || []).map((tp) => <span key={tp.label}>{tp.label} <b className="text-emerald-300">{tp.price}</b>{tp.structural === false ? <i className="text-white/35"> (R-based)</i> : null}</span>)}
            {pt.risk_reward_tp1 != null && <span>R:R <b className="text-white/90">{pt.risk_reward_tp1}</b></span>}
          </div>
        </div>
      )}

      {/* Setup proximity */}
      {s.proximity?.status && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 font-bold uppercase tracking-wide text-white/75">Proximity · {s.proximity.status}</span>
          {s.proximity.distance_atr != null && <span className="text-white/45">{s.proximity.distance_atr}× ATR away{s.proximity.candles_away != null ? ` · ~${s.proximity.candles_away} candles` : ""}{s.proximity.reachable_this_session === false ? " · unlikely this session" : ""}</span>}
        </div>
      )}

      {/* Best potential setup zone */}
      {s.setup_zone && s.setup_zone.zone_low != null && (
        <div className="mt-3 rounded-xl border border-gold-light/25 bg-gold-light/[0.05] p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-gold-light">Best potential setup{s.setup_zone.direction ? ` · ${s.setup_zone.direction}` : ""}</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-serif text-lg font-bold text-white">{s.setup_zone.zone_low}–{s.setup_zone.zone_high}</span>
            {s.setup_zone.setup_type && <span className="text-xs text-white/60">{s.setup_zone.setup_type}</span>}
            {s.setup_zone.setup_timeframe && <span className="text-[11px] text-white/40">{s.setup_zone.setup_timeframe}</span>}
          </div>
          {s.setup_zone.zone_source && <p className="mt-1 text-[11px] text-white/50">{s.setup_zone.zone_source}</p>}
          {Array.isArray(s.setup_zone.why) && s.setup_zone.why.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-white/70">{s.setup_zone.why.map((w, i) => <li key={i} className="flex gap-2"><span className="text-white/30">•</span>{w}</li>)}</ul>
          )}
          {Array.isArray(s.setup_zone.what_price_must_do) && s.setup_zone.what_price_must_do.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] font-bold uppercase tracking-wide text-white/40">What price must do</p>
              <ol className="mt-1 space-y-0.5 text-xs text-white/70">{s.setup_zone.what_price_must_do.map((w, i) => <li key={i}>{i + 1}. {w}</li>)}</ol>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
            {s.setup_zone.confirmation && <span>Confirm: <span className="text-white/75">{s.setup_zone.confirmation}</span></span>}
            {s.setup_zone.invalidation && <span>Invalidation: <span className="text-red-300">{s.setup_zone.invalidation}</span></span>}
            {s.setup_zone.first_target != null && <span>Target 1: <span className="text-emerald-300">{s.setup_zone.first_target}</span></span>}
            {s.setup_zone.second_target != null && <span>Target 2: <span className="text-emerald-300">{s.setup_zone.second_target}</span></span>}
          </div>
        </div>
      )}

      {/* Alternative scenario */}
      {s.alternative_scenario?.trigger && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-white/65">
          <p className="text-[10px] font-bold uppercase tracking-wide text-white/40">Alternative scenario{s.alternative_scenario.direction ? ` · ${s.alternative_scenario.direction}` : ""}</p>
          <p className="mt-1">{s.alternative_scenario.trigger}</p>
          {s.alternative_scenario.invalidates_current && <p className="mt-0.5 text-white/45">{s.alternative_scenario.invalidates_current}</p>}
        </div>
      )}

      <NewsWarning s={s} />

      {/* Directional levels */}
      {lv && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/45">
          {lv.support != null && <span>Support: <span className="text-white/70">{lv.support}</span></span>}
          {lv.resistance != null && <span>Resistance: <span className="text-white/70">{lv.resistance}</span></span>}
          {lv.liquidity_below != null && <span>Liquidity below: <span className="text-white/70">{lv.liquidity_below}</span></span>}
          {lv.liquidity_above != null && <span>Liquidity above: <span className="text-white/70">{lv.liquidity_above}</span></span>}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/45">
        {s.current_bias && <span>Bias: <span className="text-white/70">{s.current_bias}</span></span>}
        {s.market_regime && s.market_regime !== "unavailable" && <span>Regime: <span className="text-white/70">{s.market_regime}</span></span>}
        {s.session && <span>Session: <span className="text-white/70">{s.session}</span></span>}
        {typeof s.scores?.overall === "number" && <span>Score: <span className="text-white/70">{s.scores.overall}/100</span></span>}
        {s.scores?.data_quality != null && <span>Data quality: <span className="text-white/70">{s.scores.data_quality}/100</span></span>}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-white/35">{s.educational_disclaimer}</p>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"><span className="text-white/40">{k}:</span> <span className="font-semibold text-white/85">{v}</span></div>;
}

function NewsWarning({ s }: { s: Setup }) {
  if (!s.news_warning) return null;
  return (
    <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> News not checked</p>
      <p className="mt-1 text-xs text-amber-100/80">{s.news_warning}</p>
      {(!!s.news_check_currencies?.length || s.news_check_note) && (
        <p className="mt-1 text-[11px] text-amber-100/60">Verify {(s.news_check_currencies || []).join(", ")}{s.news_check_note ? ` — ${s.news_check_note}` : ""}</p>
      )}
    </div>
  );
}

function SetupView({ s, onUpdate, updating, update }: { s: Setup; onUpdate?: () => void; updating?: boolean; update?: TradeUpdate }) {
  if (INFO_STATES.has(s.status)) return <InfoStateView s={s} />;

  const buy = s.direction === "buy";
  const dirCol = buy ? "text-emerald-400 bg-emerald-500/15" : "text-red-400 bg-red-500/15";
  const DirIcon = buy ? ArrowUp : ArrowDown;
  const sc = s.scores || {};
  const ps = s.position_sizing || {};

  // Derived, purely from the engine's own numbers.
  const overall = typeof sc.overall === "number" ? sc.overall : 0;
  const confLabel = overall >= 78 ? "Strong" : overall >= 62 ? "Solid" : "Building";
  const regimeUp = /bull|up/i.test(String(s.market_regime)) || /bull|up/i.test(String(s.trend_rating)) ? true : /bear|down/i.test(String(s.market_regime)) || /bear|down/i.test(String(s.trend_rating)) ? false : undefined;
  const tps = (s.take_profits || []);
  const entryP = s.entry?.price, stopP = s.stop_loss?.price;
  const pip = ps.stop_pips && entryP != null && stopP != null ? Math.abs(entryP - stopP) / Number(ps.stop_pips) : undefined;
  const rrMax = tps.reduce((m, t) => Math.max(m, t.risk_reward || 0), 0);
  const checks = [
    { label: "Trend / Regime", ok: (sc.regime ?? 0) >= 55 },
    { label: "Structure", ok: (sc.structure ?? 0) >= 55 },
    { label: "Entry", ok: (sc.entry ?? 0) >= 55 },
    { label: "R : R", ok: (sc.risk_reward ?? 0) >= 55 },
    { label: "Momentum", ok: (sc.momentum ?? 0) >= 55 },
    { label: "Data", ok: (sc.data_quality ?? 0) >= 70 },
  ];

  return (
    <div className="mt-5 rounded-2xl border border-white/12 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-serif text-xl font-bold">{s.instrument}</p>
          <p className="text-xs text-white/40">
            {s.market_category} · {s.strategy}
            {s.mode && <span className={`ml-2 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${s.mode === "accelerator" ? "bg-amber-400/15 text-amber-300" : "bg-sky-400/15 text-sky-300"}`}>{s.mode === "accelerator" ? "Accelerator" : "Institutional"}</span>}
          </p>
          {(s.trend_rating || s.momentum_rating) && (
            <p className="mt-0.5 text-[11px] text-white/45">
              {s.trend_rating && <>Trend <span className="text-white/70">{s.trend_rating}</span></>}
              {s.trend_rating && s.momentum_rating && " · "}
              {s.momentum_rating && <>Momentum <span className="text-white/70">{s.momentum_rating}</span></>}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${dirCol}`}><DirIcon className="h-4 w-4" /> {s.direction} · {s.order_type}</span>
          {s.grade && (
            <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.grade === "A+" ? "bg-amber-400/20 text-amber-300 border border-amber-400/40" : "bg-gold-light/15 text-gold-light border border-gold-light/35"}`}>Grade {s.grade}{typeof s.gate_score === "number" ? ` · ${s.gate_score}/100` : ""}</span>
          )}
          <span className="rounded-full bg-sky-400/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-sky-300">Trade Ready · {s.confidence}</span>
        </div>
      </div>

      {onUpdate && (
        <button onClick={onUpdate} disabled={updating}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 px-3.5 py-1.5 text-[12px] font-semibold text-sky-300 transition-colors hover:bg-sky-400/20 disabled:opacity-40">
          {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />} Get update — what happened since
        </button>
      )}
      {update && <UpdatePanel u={update} />}

      {/* Stat row — the "market read" at a glance */}
      <div className="mt-4">
        <StatRow cols={5}>
          <StatTile label="Regime Read">
            <div className="font-serif text-base font-bold leading-tight text-white">{String(s.market_regime).split(" ")[0] || "—"}</div>
            <div className={`text-[10px] font-semibold uppercase tracking-wide ${regimeUp ? "text-emerald-400" : regimeUp === false ? "text-red-400" : "text-white/50"}`}>{s.trend_rating || (regimeUp ? "Bullish" : regimeUp === false ? "Bearish" : "Ranging")}</div>
            <Sparkline data={s.spark} up={regimeUp} w={110} h={30} />
          </StatTile>
          <StatTile label="Confluence">
            <Ring value={overall} size={78} stroke={6} tone={scoreTone(overall)} sub="/100" label={confLabel} />
          </StatTile>
          <StatTile label="Strategy">
            <div className="font-serif text-sm font-bold leading-tight text-white">{s.strategy || "—"}</div>
            <div className="text-[10px] text-white/45">{buy ? "Long setup" : "Short setup"}</div>
          </StatTile>
          <StatTile label="Grade">
            {s.grade ? <GradeRing grade={s.grade} size={54} /> : <span className="text-white/40">—</span>}
            <div className="text-[10px] text-white/45">{typeof s.gate_score === "number" ? `${s.gate_score}/100` : "High quality"}</div>
          </StatTile>
          <StatTile label="Qualification">
            <div className="font-serif text-base font-bold text-emerald-400">QUALIFIED</div>
            <div className="text-[10px] text-white/45">Meets all criteria</div>
          </StatTile>
        </StatRow>
      </div>

      {/* Qualification checks */}
      <div className="mt-2.5"><Checks items={checks} /></div>

      {/* Levels */}
      {typeof entryP === "number" && typeof stopP === "number" && (
        <div className="mt-3">
          <Levels direction={s.direction} entry={entryP} stop={stopP} rr={rrMax || undefined} pip={pip}
            targets={tps.map((t) => ({ label: t.label, price: t.price, rr: t.risk_reward }))} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopyAllBtn text={buildTradeText({ direction: s.direction, entry: s.entry?.price, stopLoss: s.stop_loss?.price, takeProfits: (s.take_profits || []).map((t) => t.price), fmt })} />
      </div>

      {/* Score bar */}
      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
          <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" /> Setup score</span>
          <span className="font-serif text-lg font-bold text-white">{sc.overall}/100</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className={`h-full rounded-full ${(sc.overall ?? 0) >= 80 ? "bg-emerald-400" : (sc.overall ?? 0) >= 70 ? "bg-sky-400" : "bg-amber-400"}`} style={{ width: `${Math.min(100, sc.overall ?? 0)}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-white/55 sm:grid-cols-3">
          {[["Regime", sc.regime], ["Structure", sc.structure], ["Entry", sc.entry], ["R:R", sc.risk_reward], ["Momentum", sc.momentum], ["Volatility", sc.volatility], ["Session", sc.session], ["News", sc.news], ["Data", sc.data_quality]].map(([k, v]) => (
            <span key={String(k)} className="flex justify-between"><span className="text-white/40">{k}</span><span className="tabular-nums">{v ?? "—"}</span></span>
          ))}
        </div>
      </div>

      {/* Position sizing */}
      <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-white/45">Position size</p>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="font-serif text-lg font-bold text-white">{fmt(ps.position_size)} <span className="text-xs font-normal text-white/50">{String(ps.unit)}</span></span>
          <span className="text-xs text-white/55">risking {fmt(ps.risk_amount)} ({String(ps.risk_percent)}% of {fmt(ps.account_balance)})</span>
          <span className="text-xs text-white/40">· {fmt(ps.stop_pips)} pip stop</span>
        </div>
      </div>

      {/* News + meta */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/50">
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> expires {s.setup_expiration ? new Date(s.setup_expiration).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
        <span>Session: <span className="text-white/70">{s.session}</span></span>
        <span className="inline-flex items-center gap-1"><TrendingUp className="h-3 w-3" /> {s.data_provider} · {s.data_age_seconds != null ? `${s.data_age_seconds}s old` : "live"}</span>
      </div>

      {s.news_risk?.note && (
        <p className="mt-2 inline-flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] text-amber-200/90"><AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" /> {s.news_risk.note}</p>
      )}

      {/* Reasoning */}
      {Array.isArray(s.reasoning) && s.reasoning.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {s.reasoning.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-white/80"><Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-sky-300" /> {r}</li>
          ))}
        </ul>
      )}

      {s.stop_loss?.reason && <p className="mt-3 text-xs text-white/50"><span className="text-white/60">Invalidation:</span> {s.stop_loss.reason}</p>}

      {Array.isArray(s.risk_warnings) && s.risk_warnings.length > 0 && (
        <div className="mt-3 space-y-1">
          {s.risk_warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-white/45"><X className="mt-0.5 h-3 w-3 flex-shrink-0 text-white/30" /> {w}</p>
          ))}
        </div>
      )}

      <NewsWarning s={s} />

      {typeof s.entry?.price === "number" && typeof s.stop_loss?.price === "number" && (s.take_profits || []).length > 0 && (
        <TradeChat trade={{ td: String(s.instrument), symbol: String(s.instrument), interval: "15min", direction: String(s.direction), entry: s.entry.price, stopLoss: s.stop_loss.price, takeProfits: (s.take_profits || []).map((t) => t.price).filter((n) => typeof n === "number"), since: s.timestamp }} />
      )}

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/35">{s.educational_disclaimer}</p>
    </div>
  );
}

function UpdatePanel({ u }: { u: TradeUpdate }) {
  const side = u.pnl?.side;
  const tone = side === "profit" ? "emerald" : side === "drawdown" ? "amber" : "sky";
  const border = tone === "emerald" ? "border-emerald-400/30 bg-emerald-500/[0.06]" : tone === "amber" ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-sky-400/30 bg-sky-400/[0.06]";
  const chip = u.thesis === "intact" ? "bg-emerald-500/15 text-emerald-300" : u.thesis === "weakening" ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300";
  const rStr = `${u.pnl.r >= 0 ? "+" : ""}${u.pnl.r}R`;
  return (
    <div className={`mt-4 rounded-2xl border px-4 py-3.5 ${border}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70"><Activity className="h-3.5 w-3.5 text-sky-300" /> Live update</p>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${chip}`}>Idea {u.thesis}</span>
      </div>
      <p className="mt-2 text-sm font-semibold text-white">{u.headline}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
        <span>Now: <span className="font-semibold tabular-nums text-white/85">{fmt(u.price)}</span></span>
        <span>P/L: <span className={`font-semibold tabular-nums ${side === "profit" ? "text-emerald-400" : side === "drawdown" ? "text-amber-300" : "text-white/70"}`}>{rStr} · {u.pnl.pips >= 0 ? "+" : ""}{u.pnl.pips} pips</span></span>
        <span>To stop: <span className="tabular-nums text-white/75">{u.distance.to_stop_pips} pips</span></span>
        <span>To {u.distance.next_target_label}: <span className="tabular-nums text-white/75">{u.distance.to_next_target_pips} pips</span></span>
      </div>
      {Array.isArray(u.explanation) && u.explanation.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {u.explanation.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-white/80"><span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-sky-300/70" /> {e}</li>
          ))}
        </ul>
      )}
      {u.what_to_watch && (
        <p className="mt-3 inline-flex items-start gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/70"><Eye className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-white/50" /> <span><span className="text-white/50">What to watch:</span> {u.what_to_watch}</span></p>
      )}
      <p className="mt-2 text-[10px] text-white/35">Educational market-management context, not financial advice. Live data via Twelve Data.</p>
    </div>
  );
}
