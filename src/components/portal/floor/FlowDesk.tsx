"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, TrendingUp, TrendingDown, Zap, Link2, Gauge } from "lucide-react";
import { FlowConnect } from "./FlowConnect";

/* FLOW trade desk (desktop portal). Pick a pair + horizon, read the live setup on
 * the shared engine, and take it on TradeLocker at your risk % with one button.
 * The broker-connect + auto-run controls live in <FlowConnect/> below. */

type Instrument = { canonical: string; label: string; assetClass?: string };
type Levels = { entry_low: number | null; entry_high: number | null; stop_loss: number | null; tp1: number | null };
type ReadResult = {
  ok?: boolean;
  price?: number;
  data_status?: string;
  entry_engine?: { entryState?: string; actionable?: boolean; headline?: string };
  g?: { directional_bias?: string } & Levels;
  instrument?: { label?: string };
  detail?: string;
  error?: string;
};

const MODES = [
  { k: "quick", label: "Quick", sub: "30–80 pips" },
  { k: "intraday", label: "Intraday", sub: "2–6 hrs" },
  { k: "swing", label: "Swing", sub: "Hours–days" },
];

const STATE_TONE: Record<string, string> = {
  ENTER_NOW: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600",
  ARMED: "border-gold/50 bg-gold/10 text-gold-deep",
  APPROACHING: "border-sky-500/40 bg-sky-500/10 text-sky-600",
  WAIT: "border-charcoal/20 bg-offwhite text-charcoal/60",
  MISSED: "border-charcoal/20 bg-offwhite text-charcoal/50",
  NO_TRADE: "border-charcoal/20 bg-offwhite text-charcoal/50",
};

function money(n: number | null | undefined) {
  return typeof n === "number" ? "$" + Math.round(n).toLocaleString() : "—";
}

export function FlowDesk() {
  const [instruments, setInstruments] = useState<Instrument[]>([{ canonical: "XAUUSD", label: "Gold (XAU/USD)" }]);
  const [symbol, setSymbol] = useState("XAUUSD");
  const [mode, setMode] = useState("quick");
  const [res, setRes] = useState<ReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/flow/read", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d && Array.isArray(d.instruments) && d.instruments.length) setInstruments(d.instruments); })
      .catch(() => {});
  }, []);

  const run = useCallback(() => {
    setLoading(true); setErr("");
    fetch("/api/flow/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, mode }) })
      .then((r) => r.json())
      .then((d) => {
        if (!d || d.error) {
          setErr(d?.detail || "Market data isn't available for this pair right now — try again shortly.");
          setRes(null);
        } else { setRes(d); }
      })
      .catch(() => setErr("Something went wrong — try again."))
      .finally(() => setLoading(false));
  }, [symbol, mode]);

  useEffect(() => { run(); }, [run]);

  const g = res?.g;
  const side: "buy" | "sell" = g?.directional_bias === "bearish" ? "sell" : "buy";
  const state = res?.entry_engine?.entryState || (g ? "WAIT" : "");
  const hasLevels = !!g && g.entry_low != null && g.entry_high != null && g.stop_loss != null && g.tp1 != null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <Zap className="h-5 w-5 text-primary" /> FLOW — AI Trade Desk
        </h2>
        <p className="text-sm text-charcoal/50">Read a live setup and take it on your connected account at your risk %. Educational — you approve every trade.</p>
      </div>

      {/* Pair selector */}
      <div className="flex flex-wrap gap-1.5">
        {instruments.map((it) => (
          <button key={it.canonical} onClick={() => setSymbol(it.canonical)}
            className={`rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${symbol === it.canonical ? "bg-primary text-cream" : "border border-ice bg-white text-charcoal/60 hover:bg-offwhite"}`}>
            {it.canonical}
          </button>
        ))}
      </div>

      {/* Mode selector */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((mo) => (
          <button key={mo.k} onClick={() => setMode(mo.k)}
            className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${mode === mo.k ? "border-primary bg-primary/[0.06]" : "border-ice bg-white hover:bg-offwhite"}`}>
            <p className="text-sm font-bold text-navy">{mo.label}</p>
            <p className="text-[11px] text-charcoal/45">{mo.sub}</p>
          </button>
        ))}
      </div>

      <button onClick={run} disabled={loading}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-navy to-primary px-5 py-3 text-sm font-bold text-cream shadow-card transition hover:shadow-cardhover disabled:opacity-60">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        {loading ? "Reading the setup…" : "Find my trade"}
      </button>

      {err && <p className="rounded-xl border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs font-semibold text-red-500">{err}</p>}

      {res && g && (
        <div className="rounded-2xl border border-ice bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-navy">{res.instrument?.label || symbol}</p>
              <p className="text-2xl font-black tabular-nums text-navy">{res.price ?? "—"}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold ${side === "sell" ? "bg-gold/15 text-gold-deep" : "bg-navy/[0.06] text-navy"}`}>
                {side === "sell" ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />} {side.toUpperCase()}
              </span>
              <span className={`rounded-md border px-2 py-1 text-[11px] font-bold uppercase ${STATE_TONE[state] || STATE_TONE.WAIT}`}>{String(state).replace(/_/g, " ")}</span>
            </div>
          </div>

          {hasLevels ? (
            <>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <LevelCell label="Entry" value={`${g.entry_low} – ${g.entry_high}`} />
                <LevelCell label="Stop" value={String(g.stop_loss)} bad />
                <LevelCell label="TP1" value={String(g.tp1)} good />
                <LevelCell label="Bias" value={side.toUpperCase()} />
              </div>
              <ExecuteFlow
                symbol={symbol}
                side={side}
                entry={(g.entry_low! + g.entry_high!) / 2}
                stop={g.stop_loss!}
                tp={g.tp1}
                actionable={!!res.entry_engine?.actionable}
                state={state}
              />
            </>
          ) : (
            <p className="mt-4 rounded-xl border border-ice bg-offwhite/60 px-3 py-3 text-sm text-charcoal/55">
              FLOW is standing aside on {symbol} right now — no clean {mode} setup. Try another pair or horizon.
            </p>
          )}
        </div>
      )}

      {/* Broker connect + risk lock-in + auto-run all live here */}
      <div className="pt-2">
        <FlowConnect />
      </div>
    </div>
  );
}

function LevelCell({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-ice bg-offwhite/60 px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-charcoal/40">{label}</p>
      <p className={`mt-0.5 text-sm font-bold ${good ? "text-emerald-600" : bad ? "text-red-500" : "text-navy"}`}>{value}</p>
    </div>
  );
}

/* ---------- risk-sized execute for a FLOW setup ---------- */
type SizingInfo = { estLossAtStop?: number } | null;

function ExecuteFlow({ symbol, side, entry, stop, tp, actionable, state }: { symbol: string; side: "buy" | "sell"; entry: number; stop: number; tp: number | null; actionable: boolean; state: string }) {
  const [risk, setRisk] = useState(1);
  const [acct, setAcct] = useState("");
  const [connected, setConnected] = useState(false);
  const [equity, setEquity] = useState<number | null>(null);
  const [lots, setLots] = useState<number | null>(null);
  const [sizing, setSizing] = useState<SizingInfo>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ orderId?: string | null; placed?: number } | null>(null);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [acctCount, setAcctCount] = useState(0);

  useEffect(() => {
    fetch("/api/flow/prefs", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (d) {
        if (d.riskPct) setRisk(d.riskPct);
        if (d.connected) { setConnected(true); setEquity(d.liveEquity ?? null); }
        else if (d.accountSize) setAcct(String(d.accountSize));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const bodyFor = (extra?: Record<string, unknown>) => {
    const b: Record<string, unknown> = { source: "play", symbol, side, entry, stop, tp, riskPct: risk };
    if (!connected && acct) b.accountSize = +acct;
    return { ...b, ...(extra || {}) };
  };

  const preview = useCallback(() => {
    fetch("/api/flow/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyFor({ preview: true })) })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.preview) { setLots(d.lots); setSizing(d.sizing ?? null); if (d.equity != null) setEquity(d.equity); setAcctCount(d.accountCount ?? 0); setErr(""); }
        else if (d && d.detail) { setLots(null); setErr(d.detail); }
      }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [risk, acct, connected, entry, stop]);

  useEffect(() => { if (loaded) preview(); }, [loaded, risk, acct, preview]);

  function execute() {
    if (busy || lots == null) return;
    setBusy(true); setErr("");
    fetch("/api/flow/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyFor()) })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok && d.outcome && d.outcome.status === "placed") setDone({ ...d.outcome, placed: d.placed });
        else setErr((d && (d.detail || (d.outcome && d.outcome.reason))) || "Couldn't place the order.");
      }).catch(() => setErr("Network error — try again.")).finally(() => setBusy(false));
  }
  function saveAcct() {
    if (acct) fetch("/api/flow/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountSize: +acct, riskPct: risk }) }).catch(() => {});
  }

  const RISKS = [0.5, 1, 2, 3];
  const sym = symbol.replace("/", "");
  return (
    <div className="mt-4 rounded-2xl border border-primary/25 bg-primary/[0.04] p-4">
      <p className="text-[11px] font-bold uppercase tracking-wide text-primary">Execute · risk-sized</p>

      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-charcoal/50"><Gauge className="h-3.5 w-3.5" /> Risk</span>
        <div className="flex gap-1.5">
          {RISKS.map((rp) => (
            <button key={rp} onClick={() => setRisk(rp)}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${risk === rp ? "bg-primary text-cream" : "border border-ice text-charcoal/70 hover:bg-offwhite"}`}>{rp}%</button>
          ))}
        </div>
      </div>

      {connected ? (
        <p className="mt-2 text-xs text-charcoal/55">Equity <b className="text-navy">{money(equity)}</b> · live from TradeLocker</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-charcoal/50">Account $</span>
          <input type="number" inputMode="decimal" value={acct} placeholder="e.g. 5000" onChange={(e) => setAcct(e.target.value)} onBlur={saveAcct}
            className="w-28 rounded-lg border border-ice bg-offwhite px-2 py-1 text-sm text-navy placeholder:text-charcoal/30 focus:border-charcoal/30 focus:outline-none" />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        {lots != null ? (
          <>
            <span className="text-charcoal/80">Size <b className="text-navy">{lots} lots</b></span>
            <span className="text-xs text-charcoal/45">risking ~${sizing?.estLossAtStop ?? "—"} at stop</span>
          </>
        ) : (
          <span className="text-xs text-charcoal/45">{err || "Calculating size…"}</span>
        )}
      </div>

      {!connected && <a href="/portal/trading?view=flow" className="mt-2 inline-block text-xs font-semibold text-primary hover:underline">◆ Connect TradeLocker to execute →</a>}

      {!actionable && state !== "ENTER_NOW" && (
        <p className="mt-2 text-[11px] text-charcoal/45">FLOW isn&apos;t calling an entry right now ({String(state).replace(/_/g, " ").toLowerCase()}). You can still execute manually below at your own discretion.</p>
      )}

      {done ? (
        <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-600">
          ✓ Placed {side === "sell" ? "SELL" : "BUY"} {sym}{done.placed && done.placed > 1 ? ` on ${done.placed} accounts` : (done.orderId ? " · #" + done.orderId : "")}
        </p>
      ) : (
        <button onClick={execute} disabled={busy || lots == null}
          className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${side === "sell" ? "bg-red-500 text-white hover:bg-red-400" : "bg-emerald-500 text-[#04140b] hover:bg-emerald-400"}`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          {busy ? "Placing…" : acctCount > 1 ? `Execute ${side === "sell" ? "SELL" : "BUY"} · ${acctCount} accounts` : `Execute ${side === "sell" ? "SELL" : "BUY"}${lots != null ? " · " + lots + " lots" : ""}`}
        </button>
      )}
      {err && !done && <p className="mt-2 text-xs text-red-500">{err}</p>}
      <p className="mt-2 text-[11px] text-charcoal/35">Places a real order on your connected account when you tap Execute. Stop + TP1 attached automatically.</p>
    </div>
  );
}
