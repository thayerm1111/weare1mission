"use client";

/**
 * MFX GHOST — deep single-instrument desk. Renders the deterministic v3 engine
 * output (TRADE READY / DEVELOPING / WATCHLIST / NO TRADE + data states). Every
 * number comes from the server engine; this component only displays it.
 */
import { useEffect, useState } from "react";
import { Loader2, ShieldAlert, ArrowUp, ArrowDown, Ban, Clock, Eye, AlertTriangle } from "lucide-react";
import { TradeChat } from "./TradeChat";

const INSTRUMENTS: { td: string; label: string }[] = [
  { td: "XAU/USD", label: "Gold" }, { td: "EUR/USD", label: "EUR/USD" }, { td: "GBP/USD", label: "GBP/USD" },
  { td: "AUD/USD", label: "AUD/USD" }, { td: "USD/CAD", label: "USD/CAD" }, { td: "USD/JPY", label: "USD/JPY" },
];
const DEFAULT_SYM = "XAU/USD";

type TP = { label: string; price: number; structural?: boolean; risk_reward?: number };
type Read = Record<string, unknown> & {
  status: string; state?: string; instrument?: string; label?: string; headline?: string; reason?: string;
  direction?: string | null; dir_side?: string | null; current_bias?: string | null; strategy?: string; order_type?: string;
  market_regime?: string; session?: string; grade?: string; confidence?: string | number; confidence_label?: string | null; entry_status?: string;
  entry?: { price: number; zone_low?: number; zone_high?: number }; stop_loss?: { price: number; reason?: string };
  take_profits?: TP[]; scores?: Record<string, number>; confidence_breakdown?: Record<string, number>;
  what_next?: string[]; desk_read?: string[]; reasoning?: string[]; risk_warnings?: string[]; instrument_note?: string;
  levels?: Record<string, number> | null; educational_disclaimer?: string;
  news_status?: string; news_warning?: string; news_check_currencies?: string[]; news_check_note?: string;
  news?: { title: string; ccy: string; impact: string; when: string; forecast?: string; previous?: string; ts?: number }[];
  trigger?: { monitorTimeframe?: string; triggerType?: string; triggerLevel?: number | null; retestZoneLow?: number | null; retestZoneHigh?: number | null; invalidationLevel?: number | null; expirationCondition?: string; recheckInstruction?: string } | null;
  provisional_trade?: { direction?: string; entry?: { price: number; zone_low?: number; zone_high?: number }; stop_loss?: { price: number }; take_profits?: TP[]; risk_reward_tp1?: number; entry_status?: string } | null;
  setup_zone?: { direction?: string; setup_type?: string; zone_low?: number; zone_high?: number; zone_source?: string; setup_timeframe?: string; why?: string[]; what_price_must_do?: string[]; confirmation?: string; invalidation?: string; first_target?: number; second_target?: number | null; cancels?: string } | null;
  proximity?: { status?: string; distance_atr?: number; candles_away?: number; reachable_this_session?: boolean } | null;
  alternative_scenario?: { direction?: string; trigger?: string; invalidates_current?: string } | null;
};
type Result = { price: number; asOf: string; session?: string; symbol?: string; read: Read };

const READY = "qualified_setup";
const INFO = new Set(["no_trade", "developing_setup", "watchlist", "data_unavailable", "insufficient_data"]);
const STATE_STYLE: Record<string, { label: string; cls: string; Icon: typeof Ban }> = {
  developing_setup: { label: "DEVELOPING", cls: "bg-amber-400/15 text-amber-300 border-amber-400/40", Icon: Clock },
  watchlist: { label: "WATCHLIST", cls: "bg-sky-400/15 text-sky-300 border-sky-400/40", Icon: Eye },
  no_trade: { label: "NO TRADE", cls: "bg-white/10 text-white/70 border-white/20", Icon: Ban },
  data_unavailable: { label: "DATA ERROR", cls: "bg-red-500/15 text-red-300 border-red-400/40", Icon: AlertTriangle },
  insufficient_data: { label: "INSUFFICIENT DATA", cls: "bg-red-500/15 text-red-300 border-red-400/40", Icon: AlertTriangle },
};

export function XauGhost() {
  const [symbol, setSymbol] = useState(DEFAULT_SYM);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const symLabel = INSTRUMENTS.find((i) => i.td === symbol)?.label ?? symbol;

  useEffect(() => {
    try { const raw = localStorage.getItem(`om_mfxghost:${symbol}`); setRes(raw ? JSON.parse(raw) : null); } catch { setRes(null); }
  }, [symbol]);

  async function analyze() {
    if (loading) return;
    setLoading(true); setError(""); setNeedCredits(false);
    try {
      const r = await fetch("/api/xaughost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol }) });
      const d = await r.json().catch(() => ({ error: "error" }));
      if (r.status === 402 || d.error === "insufficient_credits") { setNeedCredits(true); setError("You're out of credits. They reset weekly — or grab more."); return; }
      if (d.error === "ratelimit") { setError(d.detail || "Market data is busy — try again shortly."); return; }
      if (d.notConfigured) { setError("Live market data isn't connected yet."); return; }
      if (d.error) { setError(d.detail || "Couldn't run the analysis right now. Try again shortly."); return; }
      const result: Result = { price: d.price, asOf: d.asOf, session: d.session, symbol: d.symbol || symbol, read: d.read };
      setRes(result);
      try { localStorage.setItem(`om_mfxghost:${symbol}`, JSON.stringify(result)); } catch { /* ignore */ }
      try { window.dispatchEvent(new Event("credits-updated")); } catch { /* ignore */ }
    } catch { setError("Something interrupted the connection. Try again."); }
    finally { setLoading(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-xl font-bold text-white">MFX Ghost</h2>
        <p className="text-xs text-white/45">Deep institutional desk · one instrument · deterministic engine (numbers in code, AI explains)</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {INSTRUMENTS.map((it) => (
          <button key={it.td} onClick={() => { if (!loading) setSymbol(it.td); }} disabled={loading}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${it.td === symbol ? "border-gold-light/60 bg-gold-light/10 text-gold-light" : "border-white/12 bg-white/[0.03] text-white/60 hover:bg-white/[0.06]"}`}>
            {it.label}
          </button>
        ))}
      </div>

      <button onClick={() => void analyze()} disabled={loading}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gold-light/90 px-4 py-3 text-sm font-bold uppercase tracking-wide text-[#0a0b10] transition-colors hover:bg-gold-light disabled:opacity-50">
        {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Reading {symLabel}…</> : <>Analyze {symLabel}</>}
      </button>

      {error && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
          <p className="inline-flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> {error}</p>
          {needCredits && <a href="/portal/credits" className="mt-2 inline-flex rounded-lg bg-gold-light/90 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#0a0b10]">Get credits</a>}
        </div>
      )}

      {res && <GhostResult res={res} />}
    </div>
  );
}

function GhostResult({ res }: { res: Result }) {
  const s = res.read;
  if (s.status === READY) return <ReadyView res={res} />;
  if (INFO.has(s.status)) return <InfoView res={res} />;
  return null;
}

function ReadyView({ res }: { res: Result }) {
  const s = res.read;
  const buy = s.dir_side === "buy";
  const dirLabel = s.dir_side === "buy" ? "LONG" : s.dir_side === "sell" ? "SHORT" : (s.direction ?? "");
  return (
    <div className="rounded-2xl border border-white/12 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-serif text-xl font-bold">{s.label || s.instrument}</p>
          <p className="text-xs text-white/40">{s.strategy} · live {res.price}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${buy ? "text-emerald-400 bg-emerald-500/15" : "text-red-400 bg-red-500/15"}`}>{buy ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />} {dirLabel} · {s.order_type}</span>
          {s.grade && <span className="rounded-full border border-gold-light/35 bg-gold-light/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-gold-light">Grade {s.grade}</span>}
          <span className="rounded-full bg-sky-400/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-sky-300">Trade Ready · {s.confidence_label ?? s.confidence}</span>
        </div>
      </div>

      {s.entry && s.stop_loss && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Cell label="Entry" v={s.entry.zone_low != null && s.entry.zone_high != null ? `${s.entry.zone_low}–${s.entry.zone_high}` : String(s.entry.price)} tone="navy" />
          <Cell label="Stop" v={String(s.stop_loss.price)} tone="red" />
          {(s.take_profits || []).map((t) => <Cell key={t.label} label={`${t.label}${t.risk_reward ? ` · ${t.risk_reward}R` : ""}`} v={String(t.price)} tone="green" sub={t.structural === false ? "R-based" : undefined} />)}
        </div>
      )}
      {s.stop_loss?.reason && <p className="mt-3 text-xs text-white/50"><span className="text-white/60">Invalidation:</span> {s.stop_loss.reason}</p>}

      <GhostNews s={s} />
      <DeskRead s={s} />
      <SetupZone s={s} />
      <Proximity s={s} />
      <Alternative s={s} />
      <NewsWarning s={s} />

      {s.entry?.price != null && s.stop_loss?.price != null && (s.take_profits || []).length > 0 && (
        <div className="mt-3">
          <TradeChat trade={{ td: String(s.instrument), symbol: String(s.instrument), interval: "15min", direction: dirLabel, entry: s.entry.price, stopLoss: s.stop_loss.price, takeProfits: (s.take_profits || []).map((t) => t.price), since: res.asOf }} />
        </div>
      )}
      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/35">{s.educational_disclaimer}</p>
    </div>
  );
}

function InfoView({ res }: { res: Result }) {
  const s = res.read;
  const st = STATE_STYLE[s.status] ?? STATE_STYLE.no_trade;
  const Icon = st.Icon;
  const buy = (s.provisional_trade?.direction ?? s.dir_side) === "buy";
  const pt = s.provisional_trade || undefined;
  const isData = s.status === "data_unavailable" || s.status === "insufficient_data";
  return (
    <div className="rounded-2xl border border-white/12 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-9 w-9 place-items-center rounded-full border ${st.cls}`}><Icon className="h-4 w-4" /></span>
          <div>
            <p className="font-serif text-lg font-bold">{s.label || s.instrument} · {st.label}</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/45">{s.headline}</p>
          </div>
        </div>
        {!isData && (s.provisional_trade?.direction ?? s.dir_side) && (
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${buy ? "text-emerald-400 bg-emerald-500/15" : "text-red-400 bg-red-500/15"}`}>{buy ? "Bias · Long" : "Bias · Short"}</span>
        )}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-white/80">{s.reason}</p>

      {Array.isArray(s.what_next) && s.what_next.length > 0 && (
        <div className="mt-4 rounded-xl border border-white/12 bg-white/[0.04] p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/55">What needs to happen next</p>
          <ul className="mt-2 space-y-1.5">{s.what_next.map((w, i) => <li key={i} className="flex gap-2 text-sm text-white/80"><span className="text-gold-light">→</span><span>{w}</span></li>)}</ul>
        </div>
      )}

      {s.trigger && (s.trigger.triggerLevel != null || s.trigger.expirationCondition) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {s.trigger.monitorTimeframe && <Kv k="Monitor" v={s.trigger.monitorTimeframe} />}
          {s.trigger.triggerType && <Kv k="Trigger" v={String(s.trigger.triggerType).replace(/_/g, " ").toLowerCase()} />}
          {s.trigger.triggerLevel != null && <Kv k="Level" v={String(s.trigger.triggerLevel)} />}
          {s.trigger.invalidationLevel != null && <Kv k="Invalidation" v={String(s.trigger.invalidationLevel)} />}
        </div>
      )}

      {pt && pt.entry && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-white/45">Provisional {buy ? "long" : "short"} · pending trigger{pt.entry_status ? ` · entry ${pt.entry_status}` : ""}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/70">
            <span>Entry <b className="text-white/90">{pt.entry.zone_low != null && pt.entry.zone_high != null ? `${pt.entry.zone_low}–${pt.entry.zone_high}` : pt.entry.price}</b></span>
            {pt.stop_loss && <span>Stop <b className="text-red-300">{pt.stop_loss.price}</b></span>}
            {(pt.take_profits || []).map((tp) => <span key={tp.label}>{tp.label} <b className="text-emerald-300">{tp.price}</b></span>)}
            {pt.risk_reward_tp1 != null && <span>R:R <b className="text-white/90">{pt.risk_reward_tp1}</b></span>}
          </div>
        </div>
      )}

      <SetupZone s={s} />
      <Proximity s={s} />
      <Alternative s={s} />
      <GhostNews s={s} />
      <DeskRead s={s} />
      <NewsWarning s={s} />

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/45">
        {s.current_bias && <span>Bias: <span className="text-white/70">{s.current_bias}</span></span>}
        {s.market_regime && <span>Regime: <span className="text-white/70">{s.market_regime}</span></span>}
        {s.session && <span>Session: <span className="text-white/70">{s.session}</span></span>}
        {typeof s.scores?.overall === "number" && <span>Score: <span className="text-white/70">{s.scores.overall}/100</span></span>}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-white/35">{s.educational_disclaimer}</p>
    </div>
  );
}

function SetupZone({ s }: { s: Read }) {
  const z = s.setup_zone; if (!z || z.zone_low == null) return null;
  return (
    <div className="mt-3 rounded-xl border border-gold-light/25 bg-gold-light/[0.05] p-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-gold-light">Best potential setup{z.direction ? ` · ${z.direction}` : ""}</p>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-serif text-lg font-bold text-white">{z.zone_low}–{z.zone_high}</span>
        {z.setup_type && <span className="text-xs text-white/60">{z.setup_type}</span>}
        {z.setup_timeframe && <span className="text-[11px] text-white/40">{z.setup_timeframe}</span>}
      </div>
      {z.zone_source && <p className="mt-1 text-[11px] text-white/50">{z.zone_source}</p>}
      {Array.isArray(z.why) && z.why.length > 0 && <ul className="mt-2 space-y-1 text-xs text-white/70">{z.why.map((w, i) => <li key={i} className="flex gap-2"><span className="text-white/30">•</span>{w}</li>)}</ul>}
      {Array.isArray(z.what_price_must_do) && z.what_price_must_do.length > 0 && (
        <div className="mt-2"><p className="text-[10px] font-bold uppercase tracking-wide text-white/40">What price must do</p>
          <ol className="mt-1 space-y-0.5 text-xs text-white/70">{z.what_price_must_do.map((w, i) => <li key={i}>{i + 1}. {w}</li>)}</ol></div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
        {z.confirmation && <span>Confirm: <span className="text-white/75">{z.confirmation}</span></span>}
        {z.invalidation && <span>Invalidation: <span className="text-red-300">{z.invalidation}</span></span>}
        {z.first_target != null && <span>Target 1: <span className="text-emerald-300">{z.first_target}</span></span>}
        {z.second_target != null && <span>Target 2: <span className="text-emerald-300">{z.second_target}</span></span>}
      </div>
    </div>
  );
}
function Proximity({ s }: { s: Read }) {
  const p = s.proximity; if (!p?.status) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 font-bold uppercase tracking-wide text-white/75">Proximity · {p.status}</span>
      {p.distance_atr != null && <span className="text-white/45">{p.distance_atr}× ATR away{p.candles_away != null ? ` · ~${p.candles_away} candles` : ""}{p.reachable_this_session === false ? " · unlikely this session" : ""}</span>}
    </div>
  );
}
function Alternative({ s }: { s: Read }) {
  const a = s.alternative_scenario; if (!a?.trigger) return null;
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-white/65">
      <p className="text-[10px] font-bold uppercase tracking-wide text-white/40">Alternative scenario{a.direction ? ` · ${a.direction}` : ""}</p>
      <p className="mt-1">{a.trigger}</p>
      {a.invalidates_current && <p className="mt-0.5 text-white/45">{a.invalidates_current}</p>}
    </div>
  );
}
function DeskRead({ s }: { s: Read }) {
  const r = s.desk_read && s.desk_read.length ? s.desk_read : s.reasoning;
  if (!Array.isArray(r) || r.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-white/40">Desk read</p>
      <ul className="mt-1 space-y-1 text-sm text-white/75">{r.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </div>
  );
}
function GhostNews({ s }: { s: Read }) {
  const items = s.news;
  if (!Array.isArray(items) || items.length === 0) return null;
  const imminent = items.some((n) => String(n.impact) === "High" && /in \d+m$/.test(String(n.when)));
  return (
    <div className={`mt-3 rounded-xl border p-3 ${imminent ? "border-amber-400/30 bg-amber-400/[0.06]" : "border-white/10 bg-white/[0.02]"}`}>
      <p className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${imminent ? "text-amber-300" : "text-white/40"}`}>
        <AlertTriangle className="h-3.5 w-3.5" /> High-impact news {imminent ? "· imminent" : "· next 24h"}
      </p>
      <ul className="mt-1.5 space-y-1 text-xs text-white/75">
        {items.map((n, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span>
              <span className={`mr-1.5 rounded px-1 py-px text-[9px] font-bold uppercase ${String(n.impact) === "High" ? "bg-red-500/20 text-red-300" : "bg-amber-500/15 text-amber-200"}`}>{n.ccy}</span>
              {n.title}
              {n.forecast ? <span className="text-white/40"> · f/c {n.forecast}{n.previous ? `, prev ${n.previous}` : ""}</span> : null}
            </span>
            <span className={`whitespace-nowrap text-[11px] ${/in \d+m$/.test(String(n.when)) ? "font-semibold text-amber-300" : "text-white/45"}`}>{n.when}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function NewsWarning({ s }: { s: Read }) {
  if (!s.news_warning) return null;
  return (
    <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> News not checked</p>
      <p className="mt-1 text-xs text-amber-100/80">{s.news_warning}</p>
      {(!!s.news_check_currencies?.length || s.news_check_note) && <p className="mt-1 text-[11px] text-amber-100/60">Verify {(s.news_check_currencies || []).join(", ")}{s.news_check_note ? ` — ${s.news_check_note}` : ""}</p>}
    </div>
  );
}
function Kv({ k, v }: { k: string; v: string }) {
  return <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"><span className="text-white/40">{k}:</span> <span className="font-semibold text-white/85">{v}</span></div>;
}
function Cell({ label, v, tone, sub }: { label: string; v: string; tone: "navy" | "red" | "green"; sub?: string }) {
  const color = tone === "red" ? "text-red-400" : tone === "green" ? "text-emerald-400" : "text-white";
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-center">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-white/40">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{v}</div>
      {sub && <div className="text-[9px] text-white/30">{sub}</div>}
    </div>
  );
}
