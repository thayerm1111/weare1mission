"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, Pin, X } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import { VisionDirection, VisionLevels, type VisionFact } from "@/components/om/vision/VisionDirection";
import { ProductIcon } from "@/components/om/ProductIcon";
import { useExperienceMode } from "@/components/om/experience";
import { genxChartView } from "@/lib/genx/chartView";
import { actionWords } from "@/lib/genx/words";
import { PAIRS, pipsBetween, type PairKey } from "@/lib/genfx/pairs";
import { setupQuery, type FloorMode } from "@/lib/floor/setupInstruments";
import { setupView } from "@/lib/floor/overview";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { CREDIT_COST } from "@/lib/creditConfig";
import type { ChartLevel } from "@/lib/floor/chart";
import type { Resp, PlayRow, Tracked, SetupLevels } from "@/components/portal/floor/GenFxDesk";
import { MarketStory } from "../simple/MarketStory";
import { genxMarketStory, SimpleGenxLevels } from "./SimpleGenxRead";
import "./genx-workspace.css";

type Live = { symbol?: string; g?: unknown; locked?: { stage?: string } | null; candles?: unknown; candlesTz?: unknown; price?: unknown; asOf?: string; error?: string };
const MODES: { id: FloorMode; label: string; simple: string; sub: string }[] = [
  { id: "quick", label: "Quick", simple: "Short term", sub: "20–90 minutes" },
  { id: "intraday", label: "Intraday", simple: "Today", sub: "2–6 hours" },
  { id: "swing", label: "Swing", simple: "Longer term", sub: "Hours to days" },
];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fxOpen = (now: number) => isOpen("fx", now);
const when = (value: string | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Time unavailable";

export type GenFxHomeProps = {
  pair: PairKey; setPair: (pair: PairKey) => void; mode: string; setMode: (mode: string) => void;
  analyze: () => void; loading: boolean; error: string; response: Resp | null;
  saved: { at: string; mode?: string | null } | null; backToCurrent: () => void;
  plays: PlayRow[]; openPlay: (id: string) => void;
  tracked: Tracked[]; isTracked: boolean; track: () => void; untrack: (id: string) => void;
  setup: SetupLevels | null; Confirm: (props: { setup: SetupLevels }) => JSX.Element | null;
  billing: boolean | null; advancedTools: ReactNode;
};

/** Presentation only: GenFxDesk retains the real FX generation, billing and account handlers. */
export function GenFxHome(p: GenFxHomeProps) {
  const { isSimple, setMode: setExperience } = useExperienceMode();
  const instrument = PAIRS[p.pair], read = p.response?.pair === p.pair ? p.response.genfx ?? null : null;
  const mode: FloorMode = p.mode === "intraday" || p.mode === "swing" ? p.mode : "quick";
  const [live, setLive] = useState<{ pair: PairKey; mode: FloorMode; value: Live } | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let active = true;
    let pending: { controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null = null;
    setFailed(false);
    const load = async (fresh: boolean) => {
      if (!active || pending || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        if (!active || pending?.controller !== controller) return;
        controller.abort(); pending = null; setFailed(true);
      }, 25_000);
      pending = { controller, timeout };
      try {
        const response = await fetch(`/api/floor/setup?${setupQuery(mode, p.pair, fresh ? "&fresh=1" : "")}`, { cache: "no-store", signal: controller.signal });
        const value: Live | null = await response.json().catch(() => null);
        if (!active || controller.signal.aborted || pending?.controller !== controller) return;
        if (!response.ok || !value || value.symbol !== p.pair || !Array.isArray(value.candles)) throw new Error("Market read unavailable");
        setLive({ pair: p.pair, mode, value }); setFailed(!!value.error); setNow(Date.now());
      } catch { if (active && pending?.controller === controller) setFailed(true); }
      finally {
        clearTimeout(timeout);
        if (pending?.controller === controller) pending = null;
      }
    };
    void load(true);
    const interval = setInterval(() => void load(false), 20_000);
    return () => {
      active = false; clearInterval(interval);
      if (pending) { clearTimeout(pending.timeout); pending.controller.abort(); pending = null; }
    };
  }, [p.pair, mode]);
  const current = live?.pair === p.pair && live.mode === mode ? live.value : null;
  const shared = useMemo(() => setupView(current as never), [current]);
  const chart = useMemo(() => genxChartView({ mode, hasRead: !!read, saved: !!p.saved,
    readMode: read?.mode, savedMode: p.saved?.mode, readCandles: p.response?.candles, readPrice: p.response?.price,
    readInterval: p.response?.candles_tf,
    liveCandles: current?.candles, liveTimezone: current?.candlesTz, livePrice: current?.price,
  }), [mode, read, p.saved, p.response, current]);
  const action = read ? actionWords(read.action) : null;
  const reference = !read || !action?.side || !!action.waiting || !!p.saved;
  const levels: ChartLevel[] = [];
  if (read) {
    const add = (kind: ChartLevel["kind"], value: unknown, label: string) => { if (finite(value)) levels.push({ kind, price: value, label }); };
    add("support", read.closest_support, "Support"); add("resistance", read.closest_resistance, "Resistance");
    if (action?.side) {
      add("entry", read.entry, reference ? "Reference entry" : "Entry"); add("stop", read.stop_loss, "Protection stop");
      [read.tp1, read.tp2, read.tp3].forEach((target, index) => add("target", target, "Target " + (index + 1)));
    }
  } else levels.push(...shared.levels);
  const displayLevels = isSimple && read && action?.side
    ? levels.filter((level) => level.kind === "entry" || level.kind === "stop" || level.kind === "target" && level.price === read.tp1) : levels;
  const zone = read && finite(read.entry_low) && finite(read.entry_high) && read.entry_high > read.entry_low
    ? { low: read.entry_low, high: read.entry_high } : read ? null : shared.zone;
  const seen = read ?? (current?.g && typeof current.g === "object" ? current.g as Partial<NonNullable<typeof read>> : null);
  const bias = /bull|buy/i.test(seen?.directional_bias ?? "") ? "buy" : /bear|sell/i.test(seen?.directional_bias ?? "") ? "sell"
    : /range|sideway/i.test(seen?.market_regime ?? "") ? "range" : "mixed";
  const tone = (value: unknown): VisionFact["tone"] => /bull|rising|higher|up/i.test(String(value)) ? "up" : /bear|falling|lower|down/i.test(String(value)) ? "down" : "watch";
  const facts: VisionFact[] = [
    { label: "STRUCTURE", value: seen?.market_structure || "Awaiting", tone: tone(seen?.market_structure) },
    { label: "MOMENTUM", value: seen?.momentum || "Awaiting", tone: tone(seen?.momentum) },
    { label: "VOLATILITY", value: seen?.volatility || "Awaiting", tone: "watch" },
    { label: "ENTRY CONDITION", value: read ? action?.waiting || !action?.side ? "Waiting" : "Review setup" : "Analyze this pair", tone: "watch" },
  ];
  const readAt = p.response?.asOf ?? p.saved?.at;
  const px = (value: number | null | undefined) => finite(value) ? value.toFixed(instrument.dec) : "—";
  const closed = now > 0 && !fxOpen(now);
  const simpleStory = isSimple ? genxMarketStory({
    market: instrument.name, action: read?.action, bias: seen?.directional_bias, entry: read?.entry,
    dec: instrument.dec, snapshot: chart.snapshot, closed, failed, loaded: !!current, stage: shared.stage,
    bars: chart.bars, tfMs: chart.tf.ms, timeKnown: chart.timeKnown, asOf: current?.asOf, now, quote: chart.price, stop: read?.stop_loss,
    distancePips: finite(chart.price) && finite(read?.entry) ? pipsBetween(instrument, chart.price, read.entry) : null,
  }) : null;
  const controls = <div className="om-genx-go">
        {isSimple ? <label className="om-simple-horizon"><span>Timeframe</span>
          <select aria-label="Analysis timeframe" value={mode} onChange={event => p.setMode(event.target.value)}>
            {MODES.map(option => <option key={option.id} value={option.id}>{option.simple}</option>)}
          </select></label> : <div className="om-seg" role="group" aria-label="FX trade horizon">{MODES.map((option) => <button type="button" key={option.id} aria-pressed={mode === option.id} onClick={() => p.setMode(option.id)} title={option.sub}>{option.label}</button>)}</div>}
        <button type="button" className="om-btn" disabled={p.loading} onClick={p.analyze}>{p.loading && <Loader2 className="animate-spin" aria-hidden="true"/>}{p.loading ? "Analyzing " + instrument.name + "…" : "Analyze " + instrument.name}</button>
        <p className="om-label">{p.billing === false ? "FX reads currently have no credit charge" : p.billing === true ? `${CREDIT_COST.genx} credits for a plan · included with the FLOW Pass` : `Up to ${CREDIT_COST.genx} credits for a plan · included with the FLOW Pass`}</p>
      </div>;
  return <div className="om-ws om-genx om-genfx om-os-product om-tool-mobile" data-pair={p.pair}>
    <header className="om-ws-head om-product-header">
      <div className="om-product-heading"><ProductIcon kind="genx" size="lg"/><div className="om-product-copy">
        {!isSimple && <p className="om-product-kicker">Currency intelligence</p>}<h1 className="om-title">GenX FX</h1>
        <p className="om-sub">{isSimple ? "Currency setup finder" : "Currency markets, mapped into direction, levels and entry conditions."}</p>
      </div></div>
      {!isSimple && controls}
    </header>
    <div className="om-genfx-pairs" role="group" aria-label="Forex pair">{Object.values(PAIRS).map((pair) => <button type="button" key={pair.key} aria-pressed={p.pair === pair.key} onClick={() => p.setPair(pair.key)}>
      <strong>{pair.name}</strong><small>{pair.key === "EURUSD" ? "Euro / US dollar" : "British pound / Japanese yen"}</small>
    </button>)}</div>
    {p.error && <p className="om-flow-err" role="alert">{p.error}</p>}
    {simpleStory ? <MarketStory compact {...simpleStory}/> :
      <VisionDirection product="GenX FX" quoteSymbol={instrument.name} dec={instrument.dec} quote={chart.price} quoteLabel={chart.priceLabel.toUpperCase()}
        bias={bias} status={p.saved ? "SAVED READ" : read ? "ANALYSIS SNAPSHOT" : failed ? "REFRESH NEEDED" : closed ? "MARKET CLOSED" : "MARKET CONTEXT"}
        tagline={read ? action?.waiting ? "ENTRY CONDITION STILL REQUIRED" : "REVIEW THE ENGINE’S LEVELS" : "CHOOSE A PAIR AND ANALYZE"}
        score={seen?.confidence_score} facts={facts}/>
    }
    {p.saved && <div className="om-genx-saved" role="status"><p><b>Saved {instrument.name} read · {when(p.saved.at)}</b><span className="om-label"> Prices and levels remain exactly as recorded.</span></p><button type="button" className="om-btn-quiet" onClick={p.backToCurrent}>Back to current market</button></div>}
    <section className="om-panel om-genfx-chart" aria-label={instrument.name + " chart and entry levels"}>
      <div className="om-genfx-chart-head"><h2>{instrument.name} · {chart.tf.label} price action</h2><span>{chart.snapshot ? "Recorded " + when(readAt) : failed ? current ? "Refresh unavailable · last market read " + when(current.asOf) : "Market read unavailable" : "Last market read " + when(current?.asOf)}</span></div>
      {chart.bars.length >= 2 ? <div className="om-genfx-chart-canvas"><OmChart bars={chart.bars} timeKnown={chart.timeKnown} tfMs={chart.tf.ms} tfLabel={chart.tf.label}
        framing={isSimple ? "setup" : "context"} priceLabel={chart.priceLabel}
        simpleView={isSimple} watchPrice={simpleStory?.watchPrice} price={chart.price} priceLive={false} snapshot={chart.snapshot} fitLevels={!!read} dec={instrument.dec} levels={displayLevels} zone={zone}
        labelStyle="backed" isOpenAt={fxOpen} viewKey={`${p.pair}:${chart.snapshot ? "read:" + readAt : "current"}:${chart.tf.interval}`}
        label={`${instrument.name} actual candles and ${reference ? "conditional reference" : "engine"} levels`}/></div> :
        <p className="om-empty">{p.saved ? "The original candles were not stored with this saved read. Its recorded prices and levels are shown below." : read ? "The original candle snapshot is unavailable for this read. Current candles are not substituted." : failed ? "Current candles are unavailable. The market read will refresh automatically." : "Loading this pair’s actual candles…"}</p>}
      {isSimple && controls}
      {read && (isSimple ? <SimpleGenxLevels entry={action?.side ? read.entry : null} stop={action?.side ? read.stop_loss : null} target={action?.side ? read.tp1 : null} dec={instrument.dec} reference={reference}/> :
        <VisionLevels symbol={p.pair} dec={instrument.dec} entry={action?.side ? read.entry : null} stop={action?.side ? read.stop_loss : null} targets={action?.side ? [read.tp1, read.tp2, read.tp3] : []} reference={reference}/>)}
      <div className="om-genfx-decision">
        <details className="om-simple-fold" open={!isSimple}><summary>Entry rules</summary>
        {read ? <>
          {isSimple && chart.snapshot && chart.price != null && <p className="om-label">{chart.priceFrom === "candle" ? "Last saved candle" : "Price at analysis"} <b data-no-i18n translate="no">{px(chart.price)}</b></p>}
          <p className="om-simple-next"><strong>{action?.waiting || !action?.side ? "Wait for: " : "Entry condition: "}</strong>{read.trigger_condition || "No confirmed entry condition was returned. Wait for a new engine read."}</p>
          {read.invalidation_reason && <p className="om-genfx-read-note"><b>Setup fails if: </b>{read.invalidation_reason}</p>}
        </> : <p className="om-simple-next">{shared.waitingFor || "Analyze " + instrument.name + " to request the FX engine’s entry, stop, targets and reason to wait."}</p>}
        </details>
        {/* This confirmation component remains in one place across Simple/Advanced changes. */}
        {read && !p.saved && p.setup && <p.Confirm key={`${p.setup.pair}:${p.setup.mode}:${p.setup.entry}:${p.setup.stop}:${readAt}`} setup={p.setup}/>}
        {read && !p.saved && action?.waiting && action.side && finite(read.entry) && finite(read.stop_loss) && <button type="button" className="om-btn-quiet" onClick={p.track} disabled={p.isTracked}><Pin size={14} aria-hidden="true"/>{p.isTracked ? "Tracking this setup" : "Track this setup"}</button>}
        {p.response?.auto && !p.response.auto.stopOk && <p className="om-genfx-read-note">Automatic trading does not accept this stop. {instrument.name} needs at least {p.response.auto.minStopPips} pips of stop distance.</p>}
      </div>
    </section>
    {isSimple && <button type="button" className="om-simple-detail-link" onClick={() => setExperience("advanced")}>Advanced analysis</button>}
    <section className="om-panel om-genx-why" hidden={isSimple || !read}>
      {read && <div className="om-genx-why-body">
        <div><h3>What GenX FX sees</h3>{read.market_story?.map((line, i) => <p key={i}>{line}</p>)}</div>
        <div><h3>Why this setup</h3><ul>{read.trade_reasoning?.map((line, i) => <li key={i}>{line}</li>)}</ul></div>
        <div><h3>Risk factors</h3><ul>{read.risk_factors?.map((line, i) => <li key={i}>{line}</li>)}</ul></div>
        <div><h3>Market details</h3><dl className="om-kv"><div><dt>Support</dt><dd>{px(read.closest_support)}</dd></div><div><dt>Resistance</dt><dd>{px(read.closest_resistance)}</dd></div><div><dt>Session</dt><dd>{read.session}</dd></div><div><dt>Trigger candles</dt><dd>{read.trigger_tf}</dd></div></dl></div>
      </div>}
    </section>
    <details className="om-genfx-saved-block" open={!isSimple}>
      <summary className="om-simple-detail-link">Your FX reads and tracked setups</summary>
      <div className="om-genfx-lists">
        <section className="om-panel om-genfx-list"><h2>Your FX reads</h2>{p.plays.length ? <ul>{p.plays.map((play) => {
          const pair = play.pair && PAIRS[play.pair];
          return pair && <li key={play.id}><button type="button" className="om-row-main" onClick={() => p.openPlay(play.id)}><span>{pair.name} · {actionWords(play.action).label}<small>{play.mode} · {when(play.at)}</small></span><span className="om-num">{finite(play.entry) ? play.entry.toFixed(pair.dec) : "—"}</span></button></li>;
        })}</ul> : <p className="om-empty">Your generated FX reads are kept here. Opening one does not run or charge for another analysis.</p>}</section>
        <section className="om-panel om-genfx-list"><h2>Tracked setups</h2>{p.tracked.length ? <ul>{p.tracked.map((tracked) => <li key={tracked.id}><div className="om-genfx-tracked-head"><p>{tracked.label}</p><button type="button" className="om-icon-btn" aria-label={"Stop tracking " + tracked.label} onClick={() => p.untrack(tracked.id)}><X size={14}/></button></div><p.Confirm setup={tracked}/></li>)}</ul> : <p className="om-empty">Track a waiting setup to keep its entry condition in view.</p>}</section>
      </div>
    </details>
    <details className="om-genfx-advanced-tools" open={!isSimple}><summary className="om-simple-detail-link">Account controls, scanner and trading record</summary>{p.advancedTools}</details>
    {!isSimple && <p className="om-faint om-flow-small om-genx-legal">Each pair uses its own FX prices, precision and risk checks. An analysis does not turn on automatic trading; existing account switches and permissions still apply.</p>}
  </div>;
}
