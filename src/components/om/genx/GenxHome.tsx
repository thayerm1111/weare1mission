"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, Loader2, Pin, X } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import { timedBars } from "@/lib/chart/candleTime";
import { GenxCard } from "@/components/om/floor/Floor";
import { buildSteps } from "@/components/portal/floor/GenxFlow";
import { realCandles, type ChartLevel } from "@/lib/floor/chart";
import { setupQuery, type FloorMode } from "@/lib/floor/setupInstruments";
import { STAGE_LABEL, ageText, periodOf, pipsText, setupView, stageSentence, type FloorOverview, type FloorPeriod } from "@/lib/floor/overview";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { CREDIT_COST } from "@/lib/creditConfig";
import { priceFor } from "@/lib/flow/display";
import { actionWords, convictionWords, holdWords, stepWords, streakOf } from "@/lib/genx/words";

/**
 * GENX, IN THE TRADING PLATFORM'S SHELL (owner 11-20 brief §8: "a focused gold workstation").
 *
 *   header        GENX, one sentence, the horizon, and Analyze gold with what it costs
 *   the chart     gold's own candles with the levels of what is shown, and the quote dated
 *   the decision  what GENX is doing, what it waits for, what would cancel it, the levels — for the main
 *                 setup or the right-now scalp, one at a time and never mixed
 *   your reads    every read kept, a saved one opened as itself; the setups being tracked, each checking
 *   results       the engine's record by period, with its history — not any account's
 *
 * Every number is the engine's. This page draws GenxDesk's state and calls GenxDesk's handlers: the paid read
 * is the same request it always was, made only when the member presses Analyze gold. Before that, the chart and
 * the state come from the shared, free read The Floor uses (/api/floor/setup) — opening GENX buys nothing, and
 * neither does going back from a saved read to the current one.
 */

type Num = number | null;
export type GenxRead = {
  mode: string; action: string; directional_bias: string; confidence_score: number;
  entry: Num; entry_low: Num; entry_high: Num; stop_loss: Num; tp1: Num; tp2: Num; tp3: Num;
  stop_pips: Num; tp1_pips: Num; tp2_pips: Num; tp3_pips: Num;
  closest_support: Num; closest_resistance: Num; invalidation_price: Num;
  market_structure: string; momentum: string; volatility: string; market_regime: string; session: string;
  buyer_control: number; seller_control: number; expected_hold_minutes: [number, number];
  market_story: string[]; trade_reasoning: string[]; risk_factors: string[];
  invalidation_reason: string; trigger_condition: string; trigger_tf: string; context_tf: string;
  projected_path: { label: string; price: number | null; kind: string }[];
  scalp?: { side: "buy" | "sell"; entry: Num; stop: Num; target: Num; target_pips: Num; risk_pips: Num; rr: Num; reason: string } | null;
};
export type GenxSetup = {
  side: "buy" | "sell"; action: string; mode: string; entry: Num; entryLow: Num; entryHigh: Num;
  watch: Num; invalidation: Num; stop: Num; tp1: Num; triggerTf?: string;
};
export type GenxPlay = { id: string; at: string; mode: string | null; action: string | null; direction: string | null; confidence: number | null; entry: Num; entryLow: Num; entryHigh: Num; stop: Num; tp1: Num };
export type GenxTracked = GenxSetup & { id: string; savedAt: number; tp2: Num; label: string };

export type GenxHomeProps = {
  mode: string; setMode: (m: string) => void;
  analyze: () => void; loading: boolean; err: string;
  read: GenxRead | null; readCandles: unknown; readPrice: Num; readLive: boolean; readAt: string | null;
  saved: { at: string; mode: string | null } | null; backToCurrent: () => void;
  plays: GenxPlay[]; openPlay: (id: string) => void;
  tracked: GenxTracked[]; isTracked: boolean; hasPlan: boolean; track: () => void; untrack: (id: string) => void;
  /** GenxDesk's live entry check — the same component, so it keeps its own free polling. */
  Confirm: (p: { setup: GenxSetup }) => JSX.Element | null;
  setupOf: (g: GenxRead) => GenxSetup;
};

type LiveAnswer = { g?: unknown; locked?: { stage?: string } | null; candles?: unknown; candlesTz?: unknown; price?: unknown; asOf?: unknown; error?: string };

const MODES: { id: FloorMode; label: string; sub: string }[] = [
  { id: "quick", label: "Quick", sub: "30–80 pips" },
  { id: "intraday", label: "Intraday", sub: "2–6 hours" },
  { id: "swing", label: "Swing", sub: "hours to days" },
];
const LIVE_EVERY_MS = 20_000, RESULTS_EVERY_MS = 120_000;
const TF: Record<FloorMode, { label: string; ms: number }> = { quick: { label: "5m", ms: 5 * 60_000 }, intraday: { label: "15m", ms: 15 * 60_000 }, swing: { label: "1h", ms: 60 * 60_000 } };
const goldOpen = (t: number) => isOpen("metal", t);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const px = (v: Num | undefined) => priceFor("XAUUSD", v ?? null);
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* the choice lasts for the visit */ } },
};
const whenText = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};
const agoText = (ms: number, now: number) => ageText(new Date(ms).toISOString(), now);

/** The levels a read puts on the chart: the main setup's or the scalp's, never both. */
export function readLevels(g: GenxRead, subject: "main" | "scalp"): { levels: ChartLevel[]; zone: { low: number; high: number } | null } {
  if (subject === "scalp" && g.scalp) {
    const s = g.scalp, L: ChartLevel[] = [];
    if (fin(s.entry)) L.push({ kind: "entry", price: s.entry, label: "Scalp entry" });
    if (fin(s.stop)) L.push({ kind: "stop", price: s.stop, label: "Scalp stop" });
    if (fin(s.target)) L.push({ kind: "target", price: s.target, label: "Scalp target" });
    return { levels: L, zone: null };
  }
  const L: ChartLevel[] = [];
  const taken = (p: number) => L.some((l) => Math.abs(l.price - p) < 1e-9);
  if (fin(g.closest_resistance)) L.push({ kind: "resistance", price: g.closest_resistance, label: "Resistance" });
  if (fin(g.closest_support)) L.push({ kind: "support", price: g.closest_support, label: "Support" });
  if (fin(g.entry) && !taken(g.entry)) L.push({ kind: "entry", price: g.entry, label: "Entry" });
  if (fin(g.stop_loss) && !taken(g.stop_loss)) L.push({ kind: "stop", price: g.stop_loss, label: "Stop" });
  ([["tp1", "Target 1"], ["tp2", "Target 2"], ["tp3", "Target 3"]] as const).forEach(([k, label]) => { const v = g[k]; if (fin(v) && !taken(v)) L.push({ kind: "target", price: v, label }); });
  const zone = fin(g.entry_low) && fin(g.entry_high) && g.entry_high > g.entry_low ? { low: g.entry_low, high: g.entry_high } : null;
  return { levels: L, zone };
}

export function GenxHome(p: GenxHomeProps) {
  const { read, saved } = p;
  const mode: FloorMode = p.mode === "intraday" || p.mode === "swing" ? p.mode : "quick";
  const [now, setNow] = useState(0);
  const [subject, setSubject] = useState<"main" | "scalp">("main");
  const [why, setWhy] = useState(false);

  // A new read, or a saved one, starts on its main setup.
  useEffect(() => { setSubject("main"); setWhy(false); }, [read]);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  // ── gold now, and GENX's shared state for this horizon: free, the same answer The Floor reads ──
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const liveSeq = useRef(0);
  const loadLive = useCallback(async (fresh: boolean) => {
    const mine = ++liveSeq.current;
    try {
      const r = await fetch(`/api/floor/setup?${setupQuery(mode, "XAUUSD", fresh ? "&fresh=1" : "")}`, { cache: "no-store" });
      const d = (await r.json().catch(() => null)) as LiveAnswer | null;
      if (mine !== liveSeq.current) return;
      if (!r.ok || !d) { setLiveFailed(true); return; }
      setLive(d); setLiveFailed(!!d.error && realCandles(d.candles).length < 2); setNow(Date.now());
    } catch { if (mine === liveSeq.current) setLiveFailed(true); }
  }, [mode]);
  useEffect(() => {
    setLive(null); setLiveFailed(false);                    // another horizon's candles do not linger under this one
    void loadLive(true);
    const t = setInterval(() => { if (document.visibilityState === "visible") void loadLive(false); }, LIVE_EVERY_MS);
    return () => clearInterval(t);
  }, [loadLive]);

  // ── the engine's record, by period (the desk record only: no account is read for this) ──
  const [ov, setOv] = useState<FloorOverview | null>(null);
  const [ovState, setOvState] = useState<"loading" | "ready" | "error">("loading");
  const [ovFailed, setOvFailed] = useState(false);
  const [gp, setGp] = useState<FloorPeriod>("7d");
  const [gpReady, setGpReady] = useState(false);
  useEffect(() => { setGp(periodOf(store.get("om:floor:genx"), "7d")); setGpReady(true); }, []);
  const ovSeq = useRef(0);
  const loadResults = useCallback(async () => {
    const mine = ++ovSeq.current;
    try {
      const r = await fetch(`/api/floor/overview?only=genx&gp=${gp}&tz=${new Date().getTimezoneOffset()}`, { cache: "no-store" });
      const d = (await r.json().catch(() => null)) as (FloorOverview & { error?: string }) | null;
      if (mine !== ovSeq.current) return;
      if (!r.ok || !d || d.error) { setOvState((s) => (s === "ready" ? s : "error")); setOvFailed(true); return; }
      setOv(d); setOvState("ready"); setOvFailed(false);
    } catch { if (mine === ovSeq.current) { setOvState((s) => (s === "ready" ? s : "error")); setOvFailed(true); } }
  }, [gp]);
  useEffect(() => {
    if (!gpReady) return;
    void loadResults();
    const t = setInterval(() => { if (document.visibilityState === "visible") void loadResults(); }, RESULTS_EVERY_MS);
    return () => clearInterval(t);
  }, [gpReady, loadResults]);
  const pickPeriod = (x: FloorPeriod) => { setOvFailed(false); setGp(x); store.set("om:floor:genx", x); };

  // ── what the chart shows ──
  const liveView = useMemo(() => setupView(live as never), [live]);
  // The chart is gold's own candles (UTC, from the shared free read) whenever they have loaded; the read's
  // candles (stamped in the feed's own clock) stand in only until then.
  const liveTb = useMemo(() => timedBars(live?.candles, live?.candlesTz), [live]);
  const ownTb = useMemo(() => timedBars(p.readCandles, null), [p.readCandles]);
  const tb = liveTb.bars.length >= 2 || !read || saved ? liveTb : ownTb;
  const livePrice = fin(live?.price) ? live!.price as number : liveTb.bars.length ? liveTb.bars[liveTb.bars.length - 1].c : null;
  // The quote is always gold now. A read keeps its own price, shown with the read.
  const price = livePrice ?? (read && !saved && fin(p.readPrice) ? p.readPrice : null);
  const marks = read ? readLevels(read, subject) : { levels: liveView.levels, zone: liveView.zone };
  const shut = now > 0 && !isOpen("metal", now);
  const horizon = MODES.find((m) => m.id === mode)!;
  const tf = TF[mode];
  const liveAt = typeof live?.asOf === "string" ? live.asOf : null;
  const liveAtMs = liveAt ? Date.parse(liveAt) : NaN;
  const fresh = shut ? "Gold is closed · this is the last price before the close"
    : liveAt ? `Gold now · updated ${ageText(liveAt, now)}` : liveFailed ? "Gold's price could not be read just now" : "";
  // When the levels on the chart were made. A read older than two candles is drawn from its own candle on,
  // and labelled — its levels are never passed off as today's.
  const readIso = saved?.at ?? (read ? p.readAt : null);
  const readMs = readIso ? Date.parse(readIso) : NaN;
  const older = read != null && Number.isFinite(readMs) && now > 0 && now - readMs > 2 * tf.ms;
  const analysis = older ? { at: readMs, label: `${saved ? "Saved read" : "This read"} · ${whenText(readIso)}` } : null;

  return (
    <div className="om-ws om-genx">
      <header className="om-ws-head">
        <div>
          <h1 className="om-title">GENX</h1>
          <p className="om-sub">Gold intelligence: GENX&rsquo;s read of XAU/USD, the plan behind it, and its record.</p>
        </div>
        <div className="om-genx-go">
          <div className="om-seg" role="group" aria-label="Horizon">
            {MODES.map((m) => <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => p.setMode(m.id)} title={m.sub}>{m.label}</button>)}
          </div>
          <button type="button" className="om-btn" onClick={p.analyze} disabled={p.loading}>
            {p.loading && <Loader2 className="animate-spin" aria-hidden="true" />}
            {p.loading ? "Analyzing gold…" : read && !saved ? "Analyze again" : "Analyze gold"}
          </button>
          <p className="om-label">{CREDIT_COST.genx} credits a read · included with the FLOW Pass · {horizon.label}: {horizon.sub}</p>
        </div>
      </header>

      {p.err && <p className="om-flow-err" role="alert">{p.err}</p>}

      {saved && (
        <div className="om-genx-saved" role="status">
          <p><b>Saved read · {whenText(saved.at)}</b><span className="om-label"> Frozen as it was written{saved.mode ? `, ${saved.mode}` : ""}{fin(p.readPrice) ? `, with gold at ${px(p.readPrice)}` : ""}. Its levels start at the candle it was made on; the candles and the quote are gold now.</span></p>
          <button type="button" className="om-btn-quiet" onClick={p.backToCurrent}>Back to current analysis</button>
        </div>
      )}

      <div className="om-genx-grid">
        <section className="om-panel om-genx-chart" aria-label="Gold">
          <div className="om-genx-top">
            <div className="om-quote" data-no-i18n translate="no">
              <span className="om-sym">XAU / USD</span>
              <span className="om-px om-num">{price != null ? px(price) : "—"}</span>
              <span className="om-fresh om-faint">{fresh}</span>
            </div>
            {read?.scalp && (
              <div className="om-seg om-genx-subject" role="group" aria-label="Setup shown">
                <button type="button" aria-pressed={subject === "main"} onClick={() => setSubject("main")}>Main setup</button>
                <button type="button" aria-pressed={subject === "scalp"} onClick={() => setSubject("scalp")}>Right-now scalp</button>
              </div>
            )}
          </div>
          <div className="om-genx-plot">
            {tb.bars.length >= 2
              ? <OmChart bars={tb.bars} timeKnown={tb.known} tfMs={tf.ms} tfLabel={tf.label} price={price}
                  priceLive={!shut && Number.isFinite(liveAtMs) && now - liveAtMs < 120_000} dec={2}
                  levels={marks.levels} zone={marks.zone} analysis={analysis} isOpenAt={goldOpen} viewKey={`XAUUSD:${mode}`}
                  label={`Gold, ${tf.label} candles, ${horizon.label.toLowerCase()} horizon${price != null ? `, ${px(price)}` : ""}`} />
              : <p className="om-empty">{liveFailed ? "Gold's candles could not be read just now. This tries again on its own." : "Reading gold…"}</p>}
          </div>
          {read && subject === "main" && <Steps g={read} price={older ? p.readPrice : price} older={older} />}
        </section>

        <aside className="om-panel om-genx-panel" aria-label="What GENX is doing">
          {read ? <Decision p={p} g={read} subject={subject} /> : <Waiting view={liveView} failed={liveFailed} loaded={!!live} />}
          <p className="om-label om-genx-flow">Which of your accounts take GENX trades is set in FLOW. <Link href="/portal/trading?view=flow" className="om-go">Open FLOW<ArrowUpRight aria-hidden="true" /></Link></p>
        </aside>
      </div>

      {read && (
        <section className="om-panel om-genx-why">
          <button type="button" className="om-disclose" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
            <span><b>How GENX reads it</b><span className="om-label">What it sees in the market, why it likes the setup, and what to watch.</span></span>
            <ChevronDown aria-hidden="true" />
          </button>
          {why && <Why g={read} />}
        </section>
      )}

      <div className="om-genx-mine">
        <Reads plays={p.plays} open={p.openPlay} current={saved?.at ?? null} now={now} />
        <TrackedList tracked={p.tracked} untrack={p.untrack} Confirm={p.Confirm} now={now} />
      </div>

      <div className="om-genx-results">
        <GenxCard ov={ov} state={ovState} failed={ovFailed} period={gp} onPeriod={pickPeriod} />
        <History ov={ov} period={gp} />
      </div>

      <p className="om-faint om-flow-small om-genx-legal">Every price, level and score comes from GENX&rsquo;s engine on live gold data; the AI writes only the plain-English read. Educational only, not financial advice. You approve every action on your own account.</p>
    </div>
  );
}

/* ── the decision: what GENX is doing, for the setup shown ─────────────────────────────────────── */

function Decision({ p, g, subject }: { p: GenxHomeProps; g: GenxRead; subject: "main" | "scalp" }) {
  if (subject === "scalp" && g.scalp) {
    const s = g.scalp;
    return (
      <div className="om-genx-decision">
        <p className="om-label">Right-now scalp · separate from the main setup</p>
        <p className="om-genx-state">{s.side === "sell" ? "Sell now" : "Buy now"} <span className="om-faint">· about {s.target_pips ?? "—"} pips</span></p>
        <p className="om-label">{s.reason}</p>
        <dl className="om-kv" data-no-i18n translate="no">
          <div><dt>Enter now</dt><dd className="om-num">{px(s.entry)}</dd></div>
          <div><dt>Stop</dt><dd className="om-num om-neg">{px(s.stop)}{fin(s.risk_pips) ? <small> · {s.risk_pips} pips</small> : null}</dd></div>
          <div><dt>Target</dt><dd className="om-num om-pos">{px(s.target)}{fin(s.rr) ? <small> · {s.rr}R</small> : null}</dd></div>
        </dl>
        <p className="om-faint om-flow-small">The scalp is a short trade on the move toward the main entry. The main setup is unchanged.</p>
      </div>
    );
  }
  const w = actionWords(g.action);
  const conv = convictionWords(g.confidence_score);
  const hold = holdWords(g.expected_hold_minutes);
  const plan = fin(g.entry) && fin(g.stop_loss);
  return (
    <div className="om-genx-decision">
      <p className="om-label">{p.saved ? "Saved read" : "GENX now"} · {w.side === "sell" ? "Sell" : w.side === "buy" ? "Buy" : "No side"}{conv ? ` · ${conv}` : ""}</p>
      <p className="om-genx-state">{w.label}</p>
      {!p.saved && <p.Confirm setup={p.setupOf(g)} />}
      <dl className="om-kv">
        {g.trigger_condition && <div className="om-kv-wide"><dt>Waiting for</dt><dd>{g.trigger_condition}</dd></div>}
        {g.invalidation_reason && <div className="om-kv-wide"><dt>Cancelled if</dt><dd>{g.invalidation_reason}</dd></div>}
      </dl>
      {plan ? (
        <dl className="om-kv" data-no-i18n translate="no">
          <div><dt>Entry</dt><dd className="om-num">{fin(g.entry_low) && fin(g.entry_high) ? `${px(g.entry_low)} – ${px(g.entry_high)}` : px(g.entry)}</dd></div>
          <div><dt>Stop</dt><dd className="om-num om-neg">{px(g.stop_loss)}{fin(g.stop_pips) ? <small> · {g.stop_pips} pips</small> : null}</dd></div>
          {fin(g.tp1) && <div><dt>Target 1</dt><dd className="om-num om-pos">{px(g.tp1)}{fin(g.tp1_pips) ? <small> · +{g.tp1_pips}</small> : null}</dd></div>}
          {fin(g.tp2) && <div><dt>Target 2</dt><dd className="om-num om-pos">{px(g.tp2)}{fin(g.tp2_pips) ? <small> · +{g.tp2_pips}</small> : null}</dd></div>}
          {fin(g.tp3) && <div><dt>Target 3</dt><dd className="om-num om-pos">{px(g.tp3)}{fin(g.tp3_pips) ? <small> · +{g.tp3_pips}</small> : null}</dd></div>}
          {hold && <div><dt>Expected hold</dt><dd>{hold}</dd></div>}
        </dl>
      ) : (
        <dl className="om-kv" data-no-i18n translate="no">
          <div><dt>Leaning</dt><dd>{g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral"}</dd></div>
          <div><dt>Support</dt><dd className="om-num">{px(g.closest_support)}</dd></div>
          <div><dt>Resistance</dt><dd className="om-num">{px(g.closest_resistance)}</dd></div>
        </dl>
      )}
      {plan && w.waiting && !p.saved && (
        <button type="button" className="om-btn-quiet om-genx-track" onClick={p.track} disabled={p.isTracked}>
          <Pin aria-hidden="true" width={14} height={14} />{p.isTracked ? "Tracking this setup" : "Track this setup"}
        </button>
      )}
    </div>
  );
}

/** Before a read: GENX's shared state for this horizon, and nothing it has not said. */
function Waiting({ view, failed, loaded }: { view: ReturnType<typeof setupView>; failed: boolean; loaded: boolean }) {
  if (!loaded) return <div className="om-genx-decision" aria-busy="true"><span className="om-skel" style={{ width: 160, height: 22 }} /><span className="om-skel" style={{ width: "100%", height: 64 }} /></div>;
  if (!view.stage) return <div className="om-genx-decision"><p className="om-genx-state">No read yet</p><p className="om-label">{failed ? "GENX's state could not be read just now." : "Analyze gold for GENX's full read: the plan, its levels and why."}</p></div>;
  return (
    <div className="om-genx-decision">
      <p className="om-label">GENX now · shared read, refreshed on its own</p>
      <p className="om-genx-state">{STAGE_LABEL[view.stage]}</p>
      <p className="om-label">{stageSentence(view.stage, "GENX", "gold")}</p>
      {(view.waitingFor || view.changesIf) && (
        <dl className="om-kv">
          {view.waitingFor && <div className="om-kv-wide"><dt>Waiting for</dt><dd>{view.waitingFor}</dd></div>}
          {view.changesIf && <div className="om-kv-wide"><dt>Cancelled if</dt><dd>{view.changesIf}</dd></div>}
        </dl>
      )}
      <p className="om-label">Analyze gold, above, for the full plan: entry, stop, targets and why.</p>
    </div>
  );
}

/** The path GENX expects, as a strip — every step only if the one before it happens. */
function Steps({ g, price, older }: { g: GenxRead; price: number | null; older: boolean }) {
  // An earlier read starts from the price it was made at, never from gold now: its steps are its own.
  const steps = buildSteps(g as never, price).map((s, i) => (i === 0 && older && s.t === "NOW" ? { ...s, t: "At the read" } : s));
  if (steps.length < 2) return null;
  return (
    <div className="om-genx-steps">
      <p className="om-label">{older ? "As this read planned it — from the price it was made at" : "If it plays out — each step only after the one before"}</p>
      <ol data-no-i18n translate="no">
        {steps.map((s, i) => <li key={i} data-tone={s.tone}><b>{stepWords(s.t)}</b>{s.s ? <span className="om-num">{s.s.replace(/^\$/, "")}</span> : null}</li>)}
      </ol>
    </div>
  );
}

function Why({ g }: { g: GenxRead }) {
  return (
    <div className="om-genx-why-body">
      {g.market_story?.length > 0 && <div><h3>What GENX sees</h3>{g.market_story.map((s, i) => <p key={i}>{s}</p>)}</div>}
      {g.trade_reasoning?.length > 0 && <div><h3>Why this setup</h3><ul>{g.trade_reasoning.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      {g.risk_factors?.length > 0 && <div><h3>Watch for</h3><ul>{g.risk_factors.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      <div>
        <h3>The market</h3>
        <dl className="om-kv">
          <div><dt>Structure</dt><dd>{g.market_structure || "—"}</dd></div>
          <div><dt>Momentum</dt><dd>{g.momentum || "—"}</dd></div>
          <div><dt>Volatility</dt><dd>{g.volatility || "—"}</dd></div>
          <div><dt>Session</dt><dd>{g.session || "—"}</dd></div>
          <div><dt>Buyers · sellers</dt><dd className="om-num">{g.buyer_control}% · {g.seller_control}%</dd></div>
        </dl>
      </div>
    </div>
  );
}

/* ── your reads and the setups you track ───────────────────────────────────────────────────────── */

function Reads({ plays, open, current, now }: { plays: GenxPlay[]; open: (id: string) => void; current: string | null; now: number }) {
  return (
    <section className="om-panel om-genx-list" aria-labelledby="om-genx-reads">
      <div className="om-saved-head"><h2 id="om-genx-reads">Your reads</h2><span className="om-label">{plays.length ? `${plays.length} kept` : ""}</span></div>
      {plays.length === 0 ? <p className="om-empty">Every read you run is kept here, exactly as it was written.</p> : (
        <ul className="om-rows">
          {plays.slice(0, 12).map((r) => {
            const w = actionWords(r.action);
            return (
              <li key={r.id} data-current={current === r.at ? "" : undefined}>
                <button type="button" className="om-row-main" onClick={() => open(r.id)}>
                  <span className="om-row-sym">{w.label}<small data-no-i18n translate="no">{(r.mode || "").replace(/^./, (c) => c.toUpperCase())} · {fin(r.entryLow) && fin(r.entryHigh) ? `${px(r.entryLow)} – ${px(r.entryHigh)}` : px(r.entry)} · stop {px(r.stop)}</small></span>
                  <span className="om-num">{fin(r.confidence) ? `${r.confidence}/100` : ""}</span>
                  <span>{now ? agoText(Date.parse(r.at), now) : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {plays.length > 0 && <p className="om-faint om-flow-small">Opening one shows it as it was written: its levels are not moved to today&rsquo;s market, and nothing is charged.</p>}
    </section>
  );
}

function TrackedList({ tracked, untrack, Confirm, now }: { tracked: GenxTracked[]; untrack: (id: string) => void; Confirm: GenxHomeProps["Confirm"]; now: number }) {
  return (
    <section className="om-panel om-genx-list" aria-labelledby="om-genx-tracked">
      <div className="om-saved-head"><h2 id="om-genx-tracked">Tracked setups</h2><span className="om-label">{tracked.length ? `${tracked.length}` : ""}</span></div>
      {tracked.length === 0 ? <p className="om-empty">Track a setup GENX is waiting on, and it keeps checking for its own entry here — even after you analyze again.</p> : (
        <ul className="om-genx-tracked">
          {tracked.map((t) => (
            <li key={t.id}>
              <div className="om-genx-tracked-head">
                <span className="om-row-sym" data-no-i18n translate="no">{t.side === "sell" ? "Sell" : "Buy"} {fin(t.entryLow) && fin(t.entryHigh) ? `${px(t.entryLow)} – ${px(t.entryHigh)}` : px(t.entry)}<small>{(t.mode || "").replace(/^./, (c) => c.toUpperCase())} · stop {px(t.stop)} · target {px(t.tp1)} · saved {now ? agoText(t.savedAt, now) : ""}</small></span>
                <button type="button" className="om-icon-btn" aria-label="Stop tracking this setup" onClick={() => untrack(t.id)}><X aria-hidden="true" /></button>
              </div>
              <Confirm setup={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── the record's history ──────────────────────────────────────────────────────────────────────── */

function History({ ov, period }: { ov: FloorOverview | null; period: FloorPeriod }) {
  const r = ov?.genx && ov.genx.period === period ? ov.genx.results : null;
  const rows = r?.history ?? [];
  const run = streakOf(rows);
  return (
    <section className="om-panel om-genx-history" aria-labelledby="om-genx-history">
      <div className="om-res-head">
        <div style={{ minWidth: 0 }}>
          <h2 id="om-genx-history">GENX history</h2>
          <p className="om-label">The engine&rsquo;s trades, each counted once at the average result of the accounts that took it — not any one account. Your own account is in <Link href="/portal/trading?view=flow" className="om-go">FLOW<ArrowUpRight aria-hidden="true" /></Link></p>
        </div>
        {run && run.n > 1 && <span className="om-chip">{run.n} {run.win ? "wins" : "losses"} in a row</span>}
      </div>
      {!r ? <p className="om-empty">Loading the record…</p> : rows.length === 0 ? <p className="om-empty">No GENX trade closed in this period.</p> : (
        <>
          <table className="om-table">
            <thead><tr><th scope="col">Opened</th><th scope="col">Side</th><th scope="col" className="om-r">Result</th></tr></thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={h.at + i}>
                  <td className="om-lead">{whenText(h.at)}</td>
                  <td data-label="Side"><span className="om-side">{h.side === "sell" ? "Sell" : "Buy"}</span></td>
                  <td data-label="Result" className={`om-r om-num ${h.pips > 0 ? "om-pos" : h.pips < 0 ? "om-neg" : ""}`} data-no-i18n translate="no">{pipsText(h.pips)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(r.historyMore ?? 0) > 0 && <p className="om-label om-flow-foot">The latest {rows.length} are listed; {r.historyMore} more in this period are counted in the figures.</p>}
        </>
      )}
    </section>
  );
}
