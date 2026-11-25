"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowDownRight, ArrowLeftRight, ArrowUpRight, Check, ChevronRight, Crosshair, Info, Mic, RefreshCw, Sparkles, Target } from "lucide-react";
import { ProductIcon } from "@/components/om/ProductIcon";
import { OmChart } from "@/components/om/chart/OmChart";
import { AtlasCommandSignalPanel, useAtlasCommandSignal } from "@/components/om/atlas/AtlasCommandSignal";
import {
  ATLAS_FRAMES, atlasMarketView, buildAtlasMarketSnapshot, TREND_WORD,
  type AtlasFrameId, type AtlasMarketSnapshot, type AtlasMarketSymbol, type AtlasPositionedZone, type MarketDirection,
} from "@/lib/floor/marketIntelligence";
import { atlasQuote, type AtlasTick } from "@/lib/floor/atlasQuote";
import { timedBars } from "@/lib/chart/candleTime";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { priceText, type ChartLevel } from "@/lib/floor/chart";
import { openAtlas, updateAtlasContext, type AtlasContext } from "@/lib/atlas/open";
import type { FloorMode } from "@/lib/floor/setupInstruments";
import type { SetupAnswer } from "./Floor";
import { useExperienceMode } from "@/components/om/experience";
import "./atlas-live-desk.css";

const MARKETS: { key: AtlasMarketSymbol; td: string; name: string; dp: number }[] = [
  { key: "XAUUSD", td: "XAU/USD", name: "Gold / US Dollar", dp: 2 },
  { key: "EURUSD", td: "EUR/USD", name: "Euro / Dollar", dp: 5 },
  { key: "GBPJPY", td: "GBP/JPY", name: "Pound / Yen", dp: 3 },
  { key: "USDJPY", td: "USD/JPY", name: "Dollar / Yen", dp: 3 },
];
const FRAME_FOR_MODE: Record<FloorMode, AtlasFrameId> = { quick: "5m", intraday: "15m", swing: "1h" };
const MODE_FOR_FRAME: Partial<Record<AtlasFrameId, FloorMode>> = { "5m": "quick", "15m": "intraday", "1h": "swing" };
const CONTEXT_KEY = "atlas-market-snapshot";

function age(at: number | null | undefined, now: number): string {
  if (at == null || !Number.isFinite(at) || !now || at > now + 3000) return "time unavailable";
  const sec = Math.max(0, Math.round((now - at) / 1000));
  return sec < 2 ? "just now" : sec < 60 ? sec + "s ago" : sec < 3600 ? Math.round(sec / 60) + "m ago" : Math.round(sec / 3600) + "h ago";
}
function directionIcon(direction: MarketDirection) {
  return direction === "bullish" ? ArrowUpRight : direction === "bearish" ? ArrowDownRight : ArrowLeftRight;
}
function isSnapshot(raw: unknown, symbol: AtlasMarketSymbol): raw is AtlasMarketSnapshot {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as AtlasMarketSnapshot;
  return value.symbol === symbol && Number.isFinite(value.asOf) && !!value.frames &&
    ATLAS_FRAMES.every(({ id }) => {
      const f = value.frames[id];
      return f?.id === id && Array.isArray(f.bars) && Array.isArray(f.zones) && !!f.read && typeof f.status === "string";
    });
}

/** The main market workspace. Public observations are independent of paid Atlas signals. */
export function AtlasLiveDesk({ goldSetup, goldFailed, atlasRead, sample, sampleNow, tf, onTf }: {
  goldSetup: SetupAnswer | null; goldFailed: boolean; atlasRead: { at: string; summary: string } | null;
  sample: boolean; sampleNow?: number; tf: FloorMode; onTf: (mode: FloorMode) => void;
}) {
  const { isSimple, setMode: setExperienceMode } = useExperienceMode();
  const [symbol, setSymbol] = useState<AtlasMarketSymbol>("XAUUSD");
  const [selectedFrame, setSelectedFrame] = useState<AtlasFrameId>(FRAME_FOR_MODE[tf]);
  const [record, setRecord] = useState<{ symbol: AtlasMarketSymbol; snapshot: AtlasMarketSnapshot | null; failed: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [ticks, setTicks] = useState<Record<string, AtlasTick>>({});
  const [now, setNow] = useState(sampleNow ?? 0);
  const saved = useRef(new Map<AtlasMarketSymbol, AtlasMarketSnapshot>());
  const failedSymbols = useRef(new Set<AtlasMarketSymbol>());
  const market = MARKETS.find((m) => m.key === symbol)!;
  const frameSpec = ATLAS_FRAMES.find((f) => f.id === selectedFrame)!;
  const calendar = useMemo(() => (t: number) => isOpen(symbol === "XAUUSD" ? "metal" : "fx", t), [symbol]);
  const marketOpen = sample || !now || calendar(now);

  useEffect(() => {
    if (sample) { setNow(sampleNow ?? 0); return; }
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [sample, sampleNow]);

  useEffect(() => {
    if (sample) return;
    let active = true, busy = false;
    const controller = new AbortController();
    // A retry or market switch cannot make a failed read current again. Only success clears it.
    setRecord({ symbol, snapshot: saved.current.get(symbol) ?? null, failed: failedSymbols.current.has(symbol) });
    const load = async () => {
      if (!active || busy || document.visibilityState === "hidden") return;
      busy = true; setLoading(true);
      const request = new AbortController();
      const cancel = () => request.abort();
      controller.signal.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 25_000);
      try {
        const response = await fetch("/api/floor/market-intelligence?symbol=" + symbol, { cache: "no-store", signal: request.signal });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isSnapshot(body, symbol)) throw new Error("Market snapshot unavailable");
        if (active) {
          saved.current.set(symbol, body);
          failedSymbols.current.delete(symbol);
          setRecord({ symbol, snapshot: body, failed: false });
        }
      } catch {
        if (active) {
          failedSymbols.current.add(symbol);
          setRecord((old) => ({ symbol, snapshot: old?.symbol === symbol ? old.snapshot : null, failed: true }));
        }
      } finally {
        clearTimeout(timeout); controller.signal.removeEventListener("abort", cancel);
        busy = false; if (active) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 30_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [symbol, sample, revision]);

  // Real worker quotes only. A delayed tick stays visible with its actual timestamp.
  useEffect(() => {
    if (sample) return;
    let active = true, busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (!active || busy || document.visibilityState === "hidden") return;
      busy = true;
      const request = new AbortController();
      const cancel = () => request.abort();
      controller.signal.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 8_000);
      try {
        const response = await fetch("/api/floor/atlas-ticks", { cache: "no-store", signal: request.signal });
        const body = await response.json().catch(() => null);
        if (active && response.ok && Array.isArray(body?.ticks)) {
          setTicks((previous) => {
            const next = { ...previous };
            for (const tick of body.ticks as AtlasTick[]) {
              if (!tick || !Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(Date.parse(tick.receivedAt))) continue;
              if (!next[tick.symbol] || Date.parse(tick.receivedAt) >= Date.parse(next[tick.symbol].receivedAt)) next[tick.symbol] = tick;
            }
            return next;
          });
        }
      } catch { /* The quote's own timestamp exposes a delayed feed. */ }
      finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", cancel); busy = false; }
    };
    void load();
    const interval = setInterval(() => void load(), 1500);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [sample, revision]);

  const sampleSnapshot = useMemo(() => {
    if (!sample) return null;
    const candles = timedBars(goldSetup?.candles, goldSetup?.candlesTz);
    // The labelled preview has one genuine sample interval at a time. Do not clone it into daily/4h readings.
    return buildAtlasMarketSnapshot({ symbol: "XAUUSD", now: sampleNow ?? 0, marketOpen: true,
      frames: { [FRAME_FOR_MODE[tf]]: { bars: candles.bars, fetchedAt: sampleNow ?? 0, timeKnown: candles.known, error: goldFailed ? "Sample unavailable" : null } } });
  }, [sample, sampleNow, goldSetup, goldFailed, tf]);
  const snapshot = sample ? sampleSnapshot : record?.symbol === symbol ? record.snapshot : null;
  const failed = !sample && record?.symbol === symbol && record.failed;
  const quote = useMemo(() => atlasQuote(snapshot, symbol, ticks[market.td], now, marketOpen), [snapshot, symbol, market.td, ticks, now, marketOpen]);
  const empty = useMemo(() => buildAtlasMarketSnapshot({ symbol, frames: {}, now, marketOpen }), [symbol, now, marketOpen]);
  const view = useMemo(() => atlasMarketView({ ...(snapshot ?? empty), marketOpen }, selectedFrame, quote.price, now), [snapshot, empty, marketOpen, selectedFrame, quote.price, now]);
  const current = view.frame;
  const validRead = current.status === "ready" && marketOpen && !failed;
  const freshQuote = quote.price != null && quote.ageMs != null && quote.ageMs <= 60_000;
  const currentWatch = validRead && freshQuote;
  const atlasSignal = useAtlasCommandSignal({ symbol, disabled: sample });
  const fmt = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : priceText(value, market.dp);
  const zoneText = (zone: { low: number; high: number } | null | undefined) => !zone ? "Not mapped" : zone.low === zone.high ? fmt(zone.low) : fmt(zone.low) + " – " + fmt(zone.high);
  const priceGap = (value: number) => {
    const n = Math.abs(value);
    return symbol === "XAUUSD" ? "$" + n.toFixed(2) : (n / (symbol.endsWith("JPY") ? .01 : .0001)).toFixed(1) + " pips";
  };
  const zoneDistance = (zone: AtlasPositionedZone | null) => {
    if (!zone || quote.price == null) return "No mapped zone in this history";
    if (!freshQuote) return "Relative to the last observed price";
    if (quote.price >= zone.low && quote.price <= zone.high) return "Price is testing this zone";
    const edge = quote.price < zone.low ? zone.low : zone.high;
    return priceGap(edge - quote.price) + (edge > quote.price ? " above price" : " below price");
  };
  const primaryZone = view.activeZone ?? (view.trigger?.direction === "above" ? view.resistance : view.support);
  const DirectionIcon = directionIcon(view.direction);
  const BiasIcon = directionIcon(view.higherTimeframeBias);
  const quoteNote = sample ? "Illustrative sample" : quote.source === "none" ? "Awaiting a market quote" :
    !marketOpen ? "Last market quote · " + age(quote.at, now) :
    quote.live ? (quote.providerTimed ? "Live quote · " : "Received quote · ") + age(quote.at, now) :
    (quote.source === "tick" ? "Delayed quote · " : "Candle quote · ") + age(quote.at, now);
  const quoteState = sample ? "SAMPLE DATA" : !marketOpen ? "MARKET CLOSED" : quote.live ? "LIVE QUOTE" : quote.source === "none" ? "CONNECTING" : "LAST QUOTE";
  const stageLabel = !marketOpen ? "Market closed" : failed ? "Refresh needed" : current.status === "stale" ? "Analysis delayed" : current.status !== "ready" ? (loading ? "Reading the market" : "More data needed") : !freshQuote ? "Waiting for a fresh quote" : view.readiness.label;
  const watchSummary = failed ? "The latest market read could not be verified. Refresh before using a new entry; the chart retains its last recorded candles." : validRead && !freshQuote ? "The last candle structure is retained. A fresh quote is needed to judge the distance and whether this opportunity is still in range." : view.readiness.summary;
  const summary = !snapshot && loading ? "Reading price direction, six timeframes and the nearest structural zones." :
    failed ? "The last market read is retained. A successful refresh is needed to assess a current opportunity." : validRead && !freshQuote ? "Last recorded " + current.label + " structure: " + TREND_WORD[current.read.trend].toLowerCase() + ". Waiting for a fresh quote to assess the current opportunity." : view.summary;
  const knownFrames = view.flow.filter((f) => f.status === "ready").length;
  const chooseFrame = (id: AtlasFrameId) => { setSelectedFrame(id); const mode = MODE_FOR_FRAME[id]; if (mode) onTf(mode); };
  const chartZones = [view.support, view.resistance, view.activeZone].filter((z): z is AtlasPositionedZone => z != null)
    .filter((z, i, all) => all.findIndex((other) => other.id === z.id) === i);
  const levels: ChartLevel[] = chartZones.map((z) => ({
    kind: z.role === "testing" ? z.origin : z.role,
    price: z.price,
    label: z.role === "testing" ? "Testing " + current.label : (z.roleReversed ? "Former " + z.origin : z.role === "support" ? "Support" : "Resistance") + " · " + current.label,
  }));
  const structureZones = chartZones.map((z) => ({ low: z.low, high: z.high, kind: z.role === "testing" ? z.origin : z.role, label: z.label }));
  const context = useMemo<AtlasContext>(() => ({
    source: "floor", label: market.td + " · Atlas Live · " + current.label,
    data: {
      td: market.td, symbol, timeframe: current.label, mode: MODE_FOR_FRAME[selectedFrame] ?? "swing",
      price: quote.price, quoteAt: quote.at == null ? null : new Date(quote.at).toISOString(), quoteSource: quote.source,
      asOf: snapshot?.asOf ? new Date(snapshot.asOf).toISOString() : null, marketClosed: !marketOpen,
      marketRead: {
        timeframe: current.label, trend: current.read.trend, direction: view.direction, momentum: current.read.momentum,
        higherTimeframeBias: view.higherTimeframeBias, summary,
        support: view.support, resistance: view.resistance, activeZone: currentWatch ? view.activeZone : null, crossedLevel: currentWatch ? view.crossedLevel : null,
        flow: view.flow.map((f) => ({ tf: f.label, trend: f.trend, status: f.status, summary: f.summary, closedAt: f.closedAt })),
        readiness: currentWatch ? view.readiness : { state: marketOpen ? "unavailable" : "market_closed", label: stageLabel, summary: watchSummary, observational: true, steps: [] },
        trigger: currentWatch ? view.trigger : null, alternative: currentWatch ? view.alternative : null, invalidation: currentWatch ? view.invalidation : null,
        stale: !currentWatch, closed: !marketOpen, closedAt: current.closedAt, source: "Closed candle structure" + (current.closedDate ? " · Last daily session " + current.closedDate : ""),
      },
    },
  }), [market.td, symbol, current, selectedFrame, quote.price, quote.at, quote.source, snapshot?.asOf, marketOpen, view, currentWatch, summary, stageLabel, watchSummary]);
  useEffect(() => { if (!sample) updateAtlasContext(CONTEXT_KEY, context); }, [sample, context]);
  const explain = () => openAtlas({
    question: "Explain this selected market's current direction, its D/4h/1h/30m/15m/5m flow, the nearby structural zones and exactly what must happen next. Separate observed price action from an executable Atlas signal. Use the displayed data's timestamps and state when data is missing.",
    context, followContext: CONTEXT_KEY,
  });
  const eligibleDeskRead = symbol === "XAUUSD" && atlasRead && now - Date.parse(atlasRead.at) >= 0 && now - Date.parse(atlasRead.at) < 180_000 ? atlasRead : null;

  const opportunity = (
    <section className="om-snapshot-opportunity om-terminal-opportunities" aria-label="Current price action opportunity" data-state={currentWatch ? view.readiness.state : "unavailable"} data-trend={currentWatch && view.trigger?.direction === "above" ? "bullish" : currentWatch && view.trigger?.direction === "below" ? "bearish" : "unknown"}>
      <div className="om-terminal-panel-heading"><Crosshair size={18} aria-hidden="true"/><h3>Is there a setup now?</h3><span>{current.label}</span></div>
      <div className="om-snapshot-stage"><span className="om-snapshot-stage-mark"><Activity size={18} aria-hidden="true"/></span><strong>{stageLabel}</strong></div>
      <p className="om-snapshot-scenario-summary">{watchSummary}</p>
      {view.trigger && currentWatch && <div className="om-snapshot-trigger">
        <div><span>NEXT PRICE EVENT</span><b data-no-i18n translate="no">{fmt(view.trigger.price)}</b></div>
        <span>{view.distance ? priceGap(view.distance.price) + " away" : zoneText(primaryZone)}</span>
        <p>{view.trigger.condition}</p>
      </div>}
      {currentWatch && !!view.readiness.steps.length && <ol className="om-snapshot-steps" aria-label="Price action confirmation steps">
        {view.readiness.steps.map((step, index) => <li key={index} data-state={step.state}><i>{step.state === "complete" ? <Check size={12} aria-hidden="true"/> : index + 1}</i><span>{step.label}</span></li>)}
      </ol>}
      {view.invalidation && currentWatch && <p className="om-snapshot-invalidation"><span>Changes if</span> {view.invalidation.condition}</p>}
      <span className="om-snapshot-observation">Price action watch · Atlas checks trade eligibility</span>
    </section>
  );

  if (isSimple) {
    const plainDirection = !marketOpen ? "Market closed" : failed ? "Waiting for a fresh read" : !validRead ? "Reading the market" :
      view.direction === "bullish" ? "Price is moving up" : view.direction === "bearish" ? "Price is moving down" :
      view.direction === "range" ? "Price is moving sideways" : "No clear direction yet";
    const signalHasChart = !!atlasSignal.result?.idea.chart?.candles?.length;
    return <section className="om-simple-atlas om-panel" aria-label="Atlas simple market view" data-market={symbol} aria-busy={loading && !snapshot}>
      <header className="om-simple-atlas-header">
        <div className="om-live-brand"><ProductIcon kind="atlas" size="lg"/><div><span className="om-terminal-eyebrow">YOUR MARKET AT A GLANCE</span><h2>Atlas <em>Live</em></h2></div></div>
        <div className="om-simple-atlas-tools"><button type="button" onClick={explain} disabled={sample}>Explain</button><button type="button" aria-label="Refresh market snapshot" disabled={sample || loading} onClick={() => setRevision(v => v + 1)}><RefreshCw size={17} className={loading ? "is-loading" : undefined}/></button></div>
      </header>
      <div className="om-simple-markets" role="group" aria-label="Select market">
        {MARKETS.map(m => <button type="button" key={m.key} aria-pressed={m.key === symbol} disabled={sample && m.key !== "XAUUSD"} onClick={() => setSymbol(m.key)}>{m.key === "XAUUSD" ? "Gold" : m.td}</button>)}
      </div>
      <div className="om-simple-market-summary" data-trend={validRead ? view.direction : "unknown"}>
        <div><span>{market.td} · {current.label}</span><h3><DirectionIcon size={28} aria-hidden="true"/>{plainDirection}</h3><p>{stageLabel}</p></div>
        <div className="om-simple-market-price"><strong data-no-i18n translate="no">{fmt(quote.price)}</strong><small>{quoteNote}</small></div>
      </div>
      {failed && <p className="om-simple-next" role="status">{watchSummary}</p>}
      <div className="om-simple-atlas-actions">
        {symbol === "XAUUSD" ? <button type="button" className="om-simple-primary" disabled={sample || atlasSignal.busy || !marketOpen} onClick={() => void atlasSignal.generate()}><Sparkles size={18} aria-hidden="true"/>{atlasSignal.busy ? "Reading the market…" : "Generate Atlas signal"}</button>
          : symbol === "EURUSD" || symbol === "GBPJPY" ? <Link className="om-simple-primary" href={"/portal/genx?market=fx&pair=" + symbol}>Find a {market.td} setup in GenX FX</Link>
          : <Link className="om-simple-primary" href="/portal/signals">Find a forex setup in OM AI Plays</Link>}
        <button type="button" disabled={sample} onClick={() => openAtlas({ voice: true, context, followContext: CONTEXT_KEY })}><Mic size={18} aria-hidden="true"/>Talk to Atlas</button>
      </div>
      {!signalHasChart && <section className="om-simple-market-chart" aria-label="Market chart">
        <header><h3>{market.td} chart</h3><label>Timeframe<select aria-label="Chart timeframe" value={selectedFrame} onChange={event => chooseFrame(event.target.value as AtlasFrameId)}>{ATLAS_FRAMES.map(frame => <option value={frame.id} key={frame.id}>{frame.label}</option>)}</select></label></header>
        {current.bars.length >= 2 ? <div className="om-simple-chart-canvas"><OmChart bars={current.bars} timeKnown={current.timeKnown} tfMs={frameSpec.ms} tfLabel={current.label}
          price={quote.price} priceLive={quote.live} dec={market.dp} levels={levels} structureZones={structureZones} labelStyle="backed"
          levelColors={{ support: "var(--om-pos)", resistance: "var(--om-neg)" }} isOpenAt={calendar}
          viewKey={"atlas-floor:" + symbol + ":" + selectedFrame} label={market.td + " " + current.label + " candles and support and resistance"}/></div>
          : <div className="om-simple-chart-empty" role="status">{loading ? "Loading market candles…" : "Chart data is unavailable. Refresh to try again."}</div>}
        <div className="om-simple-market-levels"><div><span>Support</span><strong data-no-i18n translate="no">{zoneText(view.support)}</strong></div><div><span>Resistance</span><strong data-no-i18n translate="no">{zoneText(view.resistance)}</strong></div></div>
      </section>}
      {!atlasSignal.result && <div className="om-simple-next"><strong>What to watch next</strong><p>{currentWatch && view.trigger ? view.trigger.condition : watchSummary}</p>
        {currentWatch && view.trigger && <span className="om-simple-watch-price" data-no-i18n translate="no">Watch {fmt(view.trigger.price)}{view.distance ? " · " + priceGap(view.distance.price) + " away" : ""}</span>}
        {currentWatch && view.invalidation && <p><strong>Changes if:</strong> {view.invalidation.condition}</p>}
      </div>}
      <AtlasCommandSignalPanel controller={atlasSignal}/>
      <div className="om-simple-atlas-foot"><span>{sample ? "Illustrative sample data" : "Analysis updated " + age(snapshot?.asOf, now)} · Price-action watch</span><button type="button" className="om-simple-detail-link" onClick={() => setExperienceMode("advanced")}>See full analysis</button></div>
    </section>;
  }

  return (
    <section className="om-live-desk om-panel om-market-terminal om-market-snapshot" aria-label="Atlas live market intelligence" data-market={symbol} aria-busy={loading && !snapshot}>
      <header className="om-terminal-header">
        <div className="om-live-brand"><ProductIcon kind="atlas" size="lg"/><div><span className="om-terminal-eyebrow">YOUR MARKET COMMAND CENTER</span><h2>Atlas <em>Live</em></h2><p>Your direction. Your levels. Your next move.</p></div></div>
        <div className="om-terminal-header-actions">
          <a href="/command-center" className="om-terminal-center-link"><Crosshair size={16} aria-hidden="true"/><span>Gold Command Center</span><ArrowUpRight size={14} aria-hidden="true"/></a>
          <div className="om-terminal-live-tools"><span className="om-live-state" data-live={quote.live}><i/>{quoteState}</span><button type="button" className="om-terminal-explain" disabled={sample} onClick={explain}>Explain <ChevronRight size={13} aria-hidden="true"/></button>
            <button type="button" className="om-snapshot-refresh" aria-label="Refresh market snapshot" title="Refresh market snapshot" disabled={sample || loading} onClick={() => setRevision((v) => v + 1)}><RefreshCw size={13} className={loading ? "is-loading" : undefined}/></button>
          </div>
        </div>
      </header>
      <div className="om-terminal-markets" role="group" aria-label="Select market">
        {MARKETS.map((m) => <button key={m.key} type="button" aria-pressed={m.key === symbol} disabled={sample && m.key !== "XAUUSD"} onClick={() => setSymbol(m.key)}>
          <span className="om-market-letter" data-symbol={m.key}>{m.key === "XAUUSD" ? "Au" : m.key === "EURUSD" ? "€" : m.key === "GBPJPY" ? "£" : "¥"}</span><span><strong>{m.td}</strong><small>{m.name}</small></span>
        </button>)}
      </div>
      <div className="om-terminal-overview" aria-label="Selected market overview">
        <div className="om-terminal-market-title"><span className="om-terminal-label">{market.td} · {quote.live ? "LIVE PRICE" : "LAST OBSERVED PRICE"}</span><div className="om-terminal-price" data-no-i18n translate="no"><strong>{fmt(quote.price)}</strong>{current.read.movePct != null && <span data-trend={current.read.movePct >= 0 ? "bullish" : "bearish"}>{current.read.movePct >= 0 ? "+" : ""}{current.read.movePct.toFixed(2)}%<small>last 4 closed {current.label} candles</small></span>}</div></div>
        <div className="om-terminal-metric" data-trend={validRead ? view.direction : "unknown"}><span className="om-terminal-label">{current.label} PRICE DIRECTION</span><strong><DirectionIcon size={21} aria-hidden="true"/>{validRead ? view.directionLabel : current.status === "stale" ? "Last recorded move" : "Awaiting data"}</strong></div>
        <div className="om-terminal-metric" data-trend={validRead ? current.read.trend : "unknown"}><span className="om-terminal-label">{current.label} STRUCTURAL TREND</span><strong>{TREND_WORD[current.read.trend]}</strong></div>
        <div className="om-terminal-metric" data-trend={view.higherTimeframeBias} title={view.higherTimeframeLabel}><span className="om-terminal-label">D · 4h · 1h BIAS</span><strong><BiasIcon size={18} aria-hidden="true"/>{view.higherTimeframeBias === "bullish" ? "Bullish bias" : view.higherTimeframeBias === "bearish" ? "Bearish bias" : view.higherTimeframeBias === "range" ? "Ranging" : view.higherTimeframeBias === "mixed" ? "Mixed flow" : "Incomplete data"}</strong></div>
      </div>
      <div className="om-snapshot-brief" data-trend={validRead ? current.read.trend : "unknown"}><span className="om-snapshot-brief-icon"><DirectionIcon size={17} aria-hidden="true"/></span><p>{summary}</p><span>{quoteNote}</span></div>
      <div className="om-snapshot-flow" aria-label="Multi-timeframe market flow">
        <div className="om-snapshot-flow-heading"><h3>Market flow</h3><span>{knownFrames}/6 timeframes available · select to inspect</span></div>
        <div role="group" aria-label="Market timeframe">
          {view.flow.map((f) => {
            const Icon = directionIcon(f.trend);
            const label = f.status === "ready" ? TREND_WORD[f.trend] : f.status === "stale" ? "Delayed" : f.status === "insufficient" ? "Building history" : "Unavailable";
            return <button type="button" key={f.id} aria-pressed={selectedFrame === f.id} onClick={() => chooseFrame(f.id)} data-trend={f.status === "ready" ? f.trend : "unknown"} data-status={f.status} title={f.summary + (f.closedAt ? " · Candle closed " + age(f.closedAt, now) : "")}>
              <span>{f.label}</span><strong><Icon size={16} aria-hidden="true"/>{label}</strong><small>{f.status === "ready" ? f.momentum === "Rising" ? "Recent move up" : f.momentum === "Falling" ? "Recent move down" : "Recent move flat" : f.status === "stale" ? "Last reading only" : "No inferred reading"}</small>
            </button>;
          })}
        </div>
      </div>
      {failed && <div className="om-snapshot-feed-note" role="status"><Info size={15} aria-hidden="true"/>{snapshot ? "Refresh unavailable. Retaining the last timestamped market read." : "Market data is temporarily unavailable. Refresh to try again."}</div>}
      <div className="om-snapshot-workspace">
        {opportunity}
        <section className="om-terminal-chart-card" aria-label="Market chart">
          <div className="om-live-chart-heading"><div><h3>{current.label} price action</h3><small>Structural zones · drag, zoom or expand</small></div><span className="om-snapshot-chart-status" data-stale={current.status !== "ready"}>{current.read.barsUsed ? current.read.barsUsed + " closed candles" : "Awaiting candles"}</span></div>
          {current.bars.length >= 2 ? <div className="om-terminal-chart">
            <OmChart bars={current.bars} timeKnown={current.timeKnown} tfMs={frameSpec.ms} tfLabel={current.label} price={quote.price} priceLive={quote.live} dec={market.dp}
              levels={levels} levelColors={{ support: "var(--om-pos)", resistance: "var(--om-neg)" }} structureZones={structureZones} labelStyle="backed"
              isOpenAt={calendar} viewKey={"atlas-floor:" + symbol + ":" + selectedFrame} label={market.td + " " + current.label + " candles and market structure zones"}/>
          </div> : <div className="om-live-chart-empty" role="status">{loading ? "Loading real market candles…" : "No reliable " + current.label + " history is available yet."}</div>}
          <div className="om-terminal-chart-legend"><span><i data-kind="support"/>Support zone</span><span><i data-kind="resistance"/>Resistance zone</span><small>{quoteNote}</small></div>
        </section>
        <aside className="om-terminal-level-map" aria-label="Support and resistance">
          <div className="om-terminal-panel-heading"><Target size={17} aria-hidden="true"/><h3>Market structure</h3><span>{current.label}</span></div>
          {view.activeZone && <div className="om-snapshot-testing"><span>{freshQuote ? "PRICE IS TESTING" : "LAST QUOTE WITHIN ZONE"}</span><strong data-no-i18n translate="no">{zoneText(view.activeZone)}</strong><small>{view.activeZone.label}</small></div>}
          {(["resistance", "support"] as const).map((role) => {
            const zone = view[role], Icon = role === "support" ? ArrowDownRight : ArrowUpRight;
            return <div className="om-terminal-level" data-kind={role} key={role}><span>{role === "support" ? "SUPPORT BELOW" : "RESISTANCE ABOVE"}<Icon size={14} aria-hidden="true"/></span>
              <strong data-no-i18n translate="no">{zone ? zoneText(zone) : "Not mapped"}</strong><small>{zoneDistance(zone)}</small>
              {zone && <p className="om-snapshot-zone-evidence">{zone.label} · {zone.source} · {zone.touches} {zone.source === "Confirmed swing" ? zone.touches === 1 ? "pivot" : "pivots" : zone.touches === 1 ? "touch" : "touches"}{zone.roleReversed ? zone.confirmedRole ? " · closed break confirmed" : " · close pending" : ""}</p>}
            </div>;
          })}
          {view.crossedLevel && currentWatch && <p className="om-snapshot-crossed"><Info size={13} aria-hidden="true"/><span>Price {view.crossedLevel.direction} the former {view.crossedLevel.zone.origin} at <b>{fmt(view.crossedLevel.zone.price)}</b>. {view.crossedLevel.confirmation === "closed" ? "Closed-candle break; watch the retest." : "Live crossing only; waiting for a candle close."}</span></p>}
          <details className="om-snapshot-method"><summary>How these zones are mapped</summary><p>Confirmed swing pivots from this timeframe are grouped into price zones. Pivots require candles on both sides. Where no swing zone is available, the recent range is labelled separately. A live cross alone does not confirm a break; a retest requires a later closed candle.</p><p>{current.structure}</p></details>
        </aside>
        <div className="om-live-actions om-snapshot-actions">
          <button className="om-live-talk" type="button" disabled={sample} onClick={() => openAtlas({ voice: true, context, followContext: CONTEXT_KEY })}><Mic size={19} aria-hidden="true"/><span>Talk to Atlas<small>Live voice conversation</small></span></button>
          <button className="om-live-find" type="button" aria-label="Generate Atlas Command Center signal" disabled={sample || atlasSignal.busy || !atlasSignal.supported || !marketOpen} onClick={() => void atlasSignal.generate()}><Sparkles size={18} aria-hidden="true"/><span>{atlasSignal.busy ? "Atlas is reading the market…" : "Generate Atlas signal"}<small>{symbol === "XAUUSD" ? "Command Center engine" : "Command Center signals are Gold only"}</small></span></button>
          {symbol !== "XAUUSD" && <p className="om-snapshot-gold-note">Atlas can explain this market. Its signal engine trades Gold. <button type="button" onClick={() => setSymbol("XAUUSD")}>Switch to Gold</button></p>}
        </div>
      </div>
      <AtlasCommandSignalPanel controller={atlasSignal}/>
      {view.alternative && currentWatch && <details className="om-snapshot-alternative"><summary>Alternative scenario · {view.alternative.direction === "above" ? "upside" : "downside"} at {fmt(view.alternative.price)}</summary><p>{view.alternative.condition}</p></details>}
      <div className="om-live-footnote"><span>{sample ? "Illustrative sample data" : "Structure refreshed " + age(snapshot?.asOf, now)}{current.closedAt ? " · " + current.label + " candle closed " + age(current.closedAt, now) : current.closedDate ? " · Last daily session " + current.closedDate : ""}</span>
        {eligibleDeskRead && <details className="om-terminal-desk-context"><summary>Atlas gold desk context</summary><p>{eligibleDeskRead.summary}</p></details>}
        <span>Closed-candle analysis · Live crosses are provisional</span>
      </div>
    </section>
  );
}
