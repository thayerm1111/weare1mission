"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { Loader2, Search, TrendingUp, TrendingDown, Zap, Link2, Gauge, ChevronDown, Lock } from "lucide-react";
import { FlowConnect } from "./FlowConnect";
import { FlowTrackRecord } from "./FlowTrackRecord";
import { SetupLock, SetupTimer, useSeeThePlay } from "@/components/portal/SetupLock";
import { STAGE_TEXT, SETUP_MINUTES, minutesLeft, type LockedSetup, type SetupGate, readFits } from "@/lib/setupLock";
import { CREDIT_COST } from "@/lib/creditConfig";
import { useNextShell } from "@/components/om/shell";
import { FlowHome } from "@/components/om/flow/FlowHome";
import { entryWords, lotsText, pairName, priceFor } from "@/lib/flow/display";
import { accountName, maskAccount, money as cash } from "@/lib/floor/overview";
import type { PlacementSize } from "@/lib/flow/ticketSizing";

/* FLOW trade desk (desktop portal). Pick a pair + horizon, read the live setup on
 * the shared engine, and take it on TradeLocker at your risk % with one button.
 * The broker-connect + auto-run controls live in <FlowConnect/> below. */

type Instrument = { canonical: string; label: string; assetClass?: string };
type Levels = { entry_low: number | null; entry_high: number | null; stop_loss: number | null; tp1: number | null };
type ReadResult = {
  ok?: boolean;
  /** The market and horizon this read was made for: it is drawn only under those. */
  symbol?: string; mode?: string;
  price?: number;
  data_status?: string;
  entry_engine?: { entryState?: string; actionable?: boolean; headline?: string };
  g?: ({ directional_bias?: string } & Levels) | null;
  // The setup takes credits to view (owner 10-05). With this member's window closed the server sends
  // the market, its price and how far along the setup is — `locked` — and no `g`, no entry engine.
  locked?: LockedSetup | null; setups?: SetupGate | null;
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
  const next = useNextShell();
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

  // The read that counts is the last one asked for: an older one that comes back later is dropped,
  // not drawn over it (switching market while a read is out used to be able to leave the old
  // market's levels under the new market's name).
  const seq = useRef(0);
  const run = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true); setErr("");
    fetch("/api/flow/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, mode }) })
      .then((r) => r.json())
      .then((d) => {
        if (mine !== seq.current) return;
        if (!d || d.error) {
          setErr(d?.detail || "Market data isn't available for this pair right now — try again shortly.");
          setRes(null);
        } else { setRes(d); }
      })
      .catch(() => { if (mine === seq.current) setErr("Something went wrong — try again."); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [symbol, mode]);
  // What to read once "See the play" has opened the window: the market on the screen NOW, which need
  // not be the one that was there when the button was tapped.
  const runNow = useRef(run);
  runNow.current = run;

  // The classic desk reads as soon as it opens and on every change of market or horizon. In the new shell a
  // reading is only made when the member asks for one (owner 11-20 brief §9: opening FLOW must not run an
  // analysis): Find my trade, or the play being opened.
  useEffect(() => { if (!next) run(); }, [run, next]);

  // A read is drawn — and can be traded — only under the market and horizon it was made for.
  const fits = readFits(res, symbol, mode);
  const g = fits ? res?.g : null;
  const locked = fits ? (res?.locked ?? null) : null;
  const side: "buy" | "sell" = g?.directional_bias === "bearish" ? "sell" : "buy";
  const state = (fits ? res?.entry_engine?.entryState : "") || (g ? "WAIT" : "");
  const hasLevels = !!g && g.entry_low != null && g.entry_high != null && g.stop_loss != null && g.tp1 != null;

  if (next) {
    const horizon = MODES.find((m) => m.k === mode) ?? MODES[0];
    const label = instruments.find((i) => i.canonical === symbol)?.label || pairName(symbol);
    const w = entryWords(state);
    const shown = !!res && (!!g || !!locked);
    const find = (
      <section id="flow-find" className="om-panel om-flow-find" aria-labelledby="flow-find-title">
        <div className="om-res-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="flow-find-title">Find a trade</h2>
            <p className="om-label">FLOW&rsquo;s live reading on one market, for you to take yourself. Nothing is read until you ask.</p>
          </div>
        </div>
        <div className="om-flow-find-form">
          <label className="om-field">
            <span className="om-label">Market</span>
            <span className="om-select">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} data-no-i18n translate="no">
                {instruments.map((it) => <option key={it.canonical} value={it.canonical}>{it.label || pairName(it.canonical)}</option>)}
              </select>
              <ChevronDown aria-hidden="true" />
            </span>
          </label>
          <div className="om-field">
            <span className="om-label">Horizon · <span className="om-faint">{horizon.sub}</span></span>
            <div className="om-seg" role="group" aria-label="Horizon">
              {MODES.map((mo) => <button key={mo.k} type="button" aria-pressed={mode === mo.k} onClick={() => setMode(mo.k)}>{mo.label}</button>)}
            </div>
          </div>
          <button type="button" className="om-btn" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
            {loading ? "Reading the setup…" : "Find my trade"}
          </button>
        </div>
        {err && <p className="om-flow-err" role="alert">{err}</p>}
        {res && locked && (
          <div className="om-flow-read">
            <div className="om-flow-read-top">
              <div><p className="om-label" data-no-i18n translate="no">{label} · {horizon.label}</p><p className="om-px om-num" data-no-i18n translate="no">{priceFor(symbol, res.price ?? null)}</p></div>
            </div>
            <FlowLock key={`${symbol}:${mode}`} what={`${pairName(symbol)} · ${horizon.label} — ${STAGE_TEXT[locked.stage] ?? STAGE_TEXT.watching}`} gate={res.setups} onOpened={() => runNow.current()} />
          </div>
        )}
        {res && g && !locked && (
          <div className={hasLevels ? "om-flow-read om-flow-read-ticket" : "om-flow-read"}>
            <div className="om-flow-read-top">
              <div><p className="om-label" data-no-i18n translate="no">{label} · {horizon.label}</p><p className="om-px om-num" data-no-i18n translate="no">{priceFor(symbol, res.price ?? null)}</p></div>
              <div className="om-flow-read-state">
                <span className="om-chip">{w.label}</span>
                {hasLevels && <span className="om-side" data-side={side}>{side === "sell" ? "Sell" : "Buy"}</span>}
                <OpenLeft gate={res.setups ?? null} />
              </div>
            </div>
            <p className="om-label">{w.line}</p>
            {hasLevels ? (
              <>
                <dl className="om-levels" data-no-i18n translate="no">
                  <div><dt>Entry zone</dt><dd className="om-num">{priceFor(symbol, g.entry_low)} – {priceFor(symbol, g.entry_high)}</dd></div>
                  <div><dt>Stop</dt><dd className="om-num om-neg">{priceFor(symbol, g.stop_loss)}</dd></div>
                  <div><dt>Target 1</dt><dd className="om-num om-pos">{priceFor(symbol, g.tp1)}</dd></div>
                </dl>
                <ExecuteFlow symbol={symbol} side={side} entry={(g.entry_low! + g.entry_high!) / 2} stop={g.stop_loss!} tp={g.tp1} actionable={!!res.entry_engine?.actionable} state={state} />
              </>
            ) : (
              <p className="om-empty">FLOW is standing aside on {pairName(symbol)} right now — no clean {horizon.label.toLowerCase()} setup. Try another market or horizon.</p>
            )}
          </div>
        )}
        {!shown && !loading && !err && (
          <p className="om-empty">{res ? `Find my trade reads ${pairName(symbol)} on the ${horizon.label.toLowerCase()} horizon.` : "Choose a market and a horizon, then Find my trade."}</p>
        )}
      </section>
    );
    return <FlowHome find={find} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <Zap className="h-5 w-5 text-primary" /> FLOW — AI Trade Desk
        </h2>
        <p className="text-sm text-charcoal/50">Read a live setup and take it on your connected account at your risk %. Educational — you approve every trade.</p>
      </div>

      {/*
        WHERE THE SETTINGS ARE, SAID AT THE TOP.

        A member asked where to set up their risk and concluded there was nowhere, because the account
        cards that hold risk, trade styles, break even and partials sit below the trade desk, the
        connect panel and the admin controls — three screens of scrolling from here. The settings were
        never missing; they were just never visible from the place people start.
      */}
      <a
        href="#flow-settings"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("flow-settings")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        className="flex items-center justify-between gap-3 rounded-xl border border-ice bg-offwhite/70 px-3.5 py-2.5 text-sm transition hover:border-navy/25 hover:bg-white"
      >
        <span className="text-charcoal/70">
          <span className="font-semibold text-charcoal">Your risk and trade settings</span>
          <span className="hidden sm:inline"> — risk %, trade styles, break even and partials, per account</span>
        </span>
        <span className="shrink-0 whitespace-nowrap font-semibold text-navy">Take me there ↓</span>
      </a>

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

      {res && locked && (
        <div className="rounded-2xl border border-ice bg-white p-5">
          {/* The market and its price, and nothing of the trade: no side, no entry-engine state (its
              verdict is half of which way), no levels. The lock below says how far along it is. */}
          <div>
            <p className="text-sm font-bold text-navy">{res.instrument?.label || symbol}</p>
            <p className="text-2xl font-black tabular-nums text-navy">{res.price ?? "—"}</p>
          </div>
          <SetupLock key={`${symbol}:${mode}`} tone="light" className="mt-4" gate={res.setups} onOpened={() => runNow.current()}
            what={`${symbol} · ${mode.toUpperCase()} — ${STAGE_TEXT[locked.stage] ?? STAGE_TEXT.watching}`} />
        </div>
      )}

      {res && g && !locked && (
        <div className="rounded-2xl border border-ice bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-navy">{res.instrument?.label || symbol}</p>
              <p className="text-2xl font-black tabular-nums text-navy">{res.price ?? "—"}</p>
            </div>
            <div className="flex items-center gap-2">
              <SetupTimer gate={res.setups} tone="light" />
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

      {/* How FLOW's trades have actually resolved */}
      <div className="pt-2">
        <FlowTrackRecord />
      </div>
    </div>
  );
}

/* ── the new shell's lock and window clock ── */

/** The setup with this member's window closed: how far along it is, and the one paid action that opens it. */
function FlowLock({ what, gate, onOpened }: { what: string; gate?: SetupGate | null; onOpened: () => void }) {
  const { open, phase, err } = useSeeThePlay(onOpened);
  const cost = gate?.cost ?? CREDIT_COST.genx, minutes = gate?.minutes ?? SETUP_MINUTES;
  return (
    <div className="om-flow-lock">
      <p className="om-flow-lock-what"><Lock aria-hidden="true" /> {what}</p>
      <p className="om-label">Which way, the entry, the stop and the target open with credits.</p>
      <button type="button" className="om-btn" onClick={() => void open()} disabled={phase !== "idle"} aria-busy={phase !== "idle"}>
        {phase !== "idle" && <Loader2 className="animate-spin" aria-hidden="true" />}
        {phase === "busy" ? "Opening…" : phase === "opened" ? "Open — loading the play…" : `See the play · ${cost} credits`}
      </button>
      <p className="om-faint om-flow-small">Opens every live setup on the site for {minutes} minutes.</p>
      {err && <p className="om-flow-err" role="alert">{err}</p>}
    </div>
  );
}

/** While a paid window is open: how long is left. */
function OpenLeft({ gate }: { gate: SetupGate | null }) {
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const left = now ? minutesLeft(gate, now) : null;
  return left == null ? null : <span className="om-chip om-num">Open · {left} min left</span>;
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
/** One account in the ticket's preview (/api/flow/execute), as the ticket service sized it. */
type TicketAcct = {
  accountId: string; accNum?: string | null; name?: string | null; environment?: string; equity?: number | null; currency?: string | null;
  lots?: number | null; estLossAtStop?: number | null; reason?: string; placement?: PlacementSize | null;
};
/** One account's result once the ticket was placed. */
type TicketFill = { accountId: string; status: "placed" | "error" | "skipped"; qty?: number; lots?: number; orderId?: string | null; reason?: string };

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
  // The new shell shows every account the ticket goes to, as the service sized it, and each account's result.
  const next = useNextShell();
  const [per, setPer] = useState<TicketAcct[] | null>(null);
  const [fills, setFills] = useState<TicketFill[] | null>(null);

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
        if (d && d.preview) { setLots(d.lots); setSizing(d.sizing ?? null); if (d.equity != null) setEquity(d.equity); setAcctCount(d.accountCount ?? 0); setErr(""); setPer(Array.isArray(d.accounts) ? d.accounts : null); }
        else if (d && d.detail) { setLots(null); setErr(d.detail); setPer(null); }
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
        if (d && Array.isArray(d.accounts) && d.accounts.some((x: { status?: string }) => typeof x?.status === "string")) setFills(d.accounts);
        if (d && d.ok && d.outcome && d.outcome.status === "placed") setDone({ ...d.outcome, placed: d.placed });
        else setErr((d && (d.detail || (d.outcome && d.outcome.reason))) || "Couldn't place the order.");
      }).catch(() => setErr("Network error — try again.")).finally(() => setBusy(false));
  }
  function saveAcct() {
    if (acct) fetch("/api/flow/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountSize: +acct, riskPct: risk }) }).catch(() => {});
  }

  const RISKS = [0.5, 1, 2, 3];
  const sym = symbol.replace("/", "");

  if (next) {
    const sideW = side === "sell" ? "Sell" : "Buy";
    const ready = actionable || state === "ENTER_NOW";
    const w = entryWords(state);
    const many = acctCount > 1;
    const env = (e?: string) => (String(e ?? "").toLowerCase() === "live" ? "live" : "demo");
    const nameFor = (p: TicketAcct) => accountName(p.name, env(p.environment), maskAccount(p.accountId, p.accNum));
    const fillFor = (id: string) => fills?.find((f) => String(f.accountId) === String(id)) ?? null;
    const why = (r?: string) => (!r ? "" : r === "no_equity" ? "no equity reading from the broker" : r.replace(/_/g, " "));
    return (
      <div className="om-ticket">
        <div className="om-ticket-head">
          <h3>Ticket</h3>
          <span className="om-label" data-no-i18n translate="no">{sideW} {pairName(symbol)} at market · stop {priceFor(symbol, stop)}{tp != null ? ` · target ${priceFor(symbol, tp)}` : ""}</span>
        </div>
        <div className="om-field">
          <span className="om-label">Risk for this ticket · an account with its own risk uses its own</span>
          <div className="om-toggles" role="group" aria-label="Risk for this ticket">
            {RISKS.map((rp) => <button key={rp} type="button" aria-pressed={risk === rp} onClick={() => setRisk(rp)}>{rp}%</button>)}
          </div>
        </div>
        {connected ? (
          per && per.length ? (
            <table className="om-table om-ticket-accts">
              <thead><tr><th scope="col">Account</th><th scope="col" className="om-r">Equity</th><th scope="col" className="om-r">Risk</th><th scope="col" className="om-r">Size</th><th scope="col" className="om-r">At the stop</th></tr></thead>
              <tbody>
                {per.map((p) => {
                  const pl = p.placement ?? null, f = fillFor(p.accountId);
                  return (
                    <tr key={p.accountId}>
                      <td className="om-lead" data-no-i18n translate="no"><b>{nameFor(p)}</b> <span className="om-faint">· {env(p.environment) === "live" ? "Live" : "Demo"}</span>
                        {f && <span className={`om-ticket-fill ${f.status === "placed" ? "om-pos" : "om-neg"}`}>{f.status === "placed" ? `Placed ${lotsText(f.qty ?? f.lots ?? null)}${f.orderId ? ` · #${f.orderId}` : ""}` : `Not placed · ${why(f.reason)}`}</span>}
                      </td>
                      <td data-label="Equity" className="om-r om-num" data-no-i18n translate="no">{cash(p.equity ?? null, p.currency ?? "USD")}</td>
                      <td data-label="Risk" className="om-r om-num">{pl ? `${pl.riskPct}%` : "—"}{pl && (pl.own || pl.capped) ? <small className="om-faint">{pl.capped ? " · capped" : " · its own"}</small> : null}</td>
                      <td data-label="Size" className="om-r om-num">{pl?.lots != null ? lotsText(pl.lots) : p.reason ? <span className="om-faint">{why(p.reason)}</span> : "—"}</td>
                      <td data-label="At the stop" className="om-r om-num" data-no-i18n translate="no">{pl?.estLossAtStop != null ? cash(-pl.estLossAtStop, p.currency ?? "USD") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="om-label">{err || "Sizing it for each account with Trading on…"}</p>
        ) : (
          <div className="om-field">
            <span className="om-label">No broker connected · an account size, to see the size</span>
            <input className="om-input om-num" type="number" inputMode="decimal" value={acct} placeholder="e.g. 5000" onChange={(e) => setAcct(e.target.value)} onBlur={saveAcct} />
            <span className="om-label">{lots != null ? `${lotsText(lots)} · about ${cash(-(sizing?.estLossAtStop ?? 0), "USD")} at the stop` : err || "Enter an account size."}</span>
          </div>
        )}
        <dl className="om-kv">
          <div><dt>FLOW&rsquo;s reading</dt><dd>{w.label}{ready ? "" : " — placing it now is a manual override"}</dd></div>
          <div><dt>After it is placed</dt><dd>FLOW does not look after it: the stop and target stay where they were placed.</dd></div>
        </dl>
        {done ? (
          <p className="om-flow-ok" role="status">Placed {sideW.toLowerCase()} {pairName(symbol)}{done.placed && done.placed > 1 ? ` on ${done.placed} accounts` : done.orderId ? ` · #${done.orderId}` : ""}.</p>
        ) : connected ? (
          <button type="button" className="om-btn om-ticket-go" onClick={execute} disabled={busy || lots == null}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? "Placing…" : `${ready ? `Place ${sideW.toLowerCase()}` : "Place anyway · manual override"}${many ? ` · ${acctCount} accounts` : ""}`}
          </button>
        ) : (
          <p className="om-label">Connect a broker account above to place it.</p>
        )}
        {err && !done && connected && per && per.length > 0 && <p className="om-flow-err" role="alert">{err}</p>}
        <p className="om-faint om-flow-small">
          {connected ? `Places a real order at market on ${many ? `each of the ${acctCount} accounts above` : "the account above"} when you tap. FLOW's checks still run as it is placed, so an account can be skipped — it says why.` : ""}
          {!ready ? " FLOW has not confirmed this entry." : ""}
        </p>
      </div>
    );
  }

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

      {/* Relative link — stays on the Floor wherever it's mounted (portal OR floor.weare1mission.com). */}
      {!connected && <a href="?view=flow" className="mt-2 inline-block text-xs font-semibold text-primary hover:underline">◆ Connect TradeLocker to execute →</a>}

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
