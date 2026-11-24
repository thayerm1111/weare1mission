"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDownRight, ArrowLeftRight, ArrowUpRight, ChevronRight, Crosshair, Mic, ShieldCheck, Sparkles, Target } from "lucide-react";
import { ProductIcon } from "@/components/om/ProductIcon";
import { OmChart } from "@/components/om/chart/OmChart";
import { floorMarketRead, marketPosition, TREND_WORD } from "@/lib/floor/marketIntelligence";
import { timedBars } from "@/lib/chart/candleTime";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { setupView } from "@/lib/floor/overview";
import { priceText, type ChartLevel } from "@/lib/floor/chart";
import { openAtlas, type AtlasContext } from "@/lib/atlas/open";
import type { FloorMode } from "@/lib/floor/setupInstruments";
import type { SetupAnswer } from "./Floor";
import "./atlas-live-desk.css";

type SymbolKey = "XAUUSD" | "EURUSD" | "GBPJPY" | "USDJPY";
type Tick = { symbol: string; price: number; receivedAt: string; providerAt: string | null };
type Watch = { bias: "bullish" | "bearish" | "neutral"; summary: string; momentum: string; high: number; low: number; evidence: string[] };
type Answer = SetupAnswer & { watch?: Watch };
const MARKETS: { key: SymbolKey; td: string; name: string; dp: number; engine: string }[] = [
  { key: "XAUUSD", td: "XAU/USD", name: "Gold", dp: 2, engine: "GENX" },
  { key: "EURUSD", td: "EUR/USD", name: "EUR/USD", dp: 5, engine: "GEN FX" },
  { key: "GBPJPY", td: "GBP/JPY", name: "GBP/JPY", dp: 3, engine: "GEN FX" },
  { key: "USDJPY", td: "USD/JPY", name: "USD/JPY", dp: 3, engine: "Market watch" },
];
const FRAMES: { id: FloorMode; label: string; ms: number }[] = [
  { id: "quick", label: "5m", ms: 300_000 },
  { id: "intraday", label: "15m", ms: 900_000 },
  { id: "swing", label: "1h", ms: 3_600_000 },
];
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
function age(when: unknown, now: number): string {
  const t = Date.parse(String(when ?? ""));
  if (!Number.isFinite(t) || !now) return "time unavailable";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec < 2 ? "just now" : sec < 60 ? sec + "s ago" : sec < 3600 ? Math.round(sec / 60) + "m ago" : Math.round(sec / 3600) + "h ago";
}
/** The Floor's new lead: real read and ticks, not a second AI or trading engine. */
export function AtlasLiveDesk({ goldSetup, goldFailed, atlasRead, sample, tf, onTf }: {
  goldSetup: SetupAnswer | null; goldFailed: boolean; atlasRead: { at: string; summary: string } | null;
  sample: boolean; tf: FloorMode; onTf: (mode: FloorMode) => void;
}) {
  const [symbol, setSymbol] = useState<SymbolKey>("XAUUSD");
  const [remote, setRemote] = useState<{ key: string; answer: Answer | null; failed: boolean } | null>(null);
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [now, setNow] = useState(0);
  const saved = useRef(new Map<string, Answer>());
  const market = MARKETS.find((m) => m.key === symbol)!;
  const requestKey = symbol + ":" + tf;

  useEffect(() => {
    if (sample || symbol === "XAUUSD") return;
    let active = true, busy = false;
    setRemote({ key: requestKey, answer: saved.current.get(requestKey) ?? null, failed: false });
    const load = async () => {
      if (!active || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const path = symbol === "USDJPY" ? "/api/floor/atlas-usdjpy?mode=" + tf : "/api/floor/setup?mode=" + tf + "&symbol=" + symbol;
        const response = await fetch(path, { cache: "no-store" });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || body.error) throw new Error("read unavailable");
        if (active) {
          saved.current.set(requestKey, body as Answer);
          setRemote({ key: requestKey, answer: body as Answer, failed: false });
        }
      } catch {
        if (active) setRemote((old) => ({ key: requestKey, answer: old?.key === requestKey ? old.answer : null, failed: true }));
      } finally { busy = false; }
    };
    void load();
    const interval = setInterval(() => void load(), 20_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [symbol, tf, requestKey, sample]);

  // The worker publishes actual ticks with receipt timestamps at most once a
  // second. Never interpolate, backfill an artificial candle, or label stale data live.
  useEffect(() => {
    if (sample) return;
    let active = true, busy = false;
    const load = async () => {
      if (!active || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch("/api/floor/atlas-ticks", { cache: "no-store" });
        const body = await response.json().catch(() => null);
        if (active && response.ok && Array.isArray(body?.ticks)) {
          setTicks((previous) => {
            const next = { ...previous };
            for (const tick of body.ticks as Tick[]) {
              if (!tick || !Number.isFinite(tick.price) || tick.price <= 0 ||
                !Number.isFinite(Date.parse(tick.receivedAt))) continue;
              if (!next[tick.symbol] || Date.parse(tick.receivedAt) >= Date.parse(next[tick.symbol].receivedAt))
                next[tick.symbol] = tick;
            }
            return next;
          });
        }
      } catch { /* freshness display exposes a delayed feed */ }
      finally { busy = false; }
    };
    void load();
    const interval = setInterval(() => void load(), 1500);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [sample]);

  useEffect(() => {
    if (sample) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [sample]);

  const record = remote?.key === requestKey ? remote : null;
  const answer: Answer | null = symbol === "XAUUSD" ? goldSetup : record?.answer ?? null;
  const error = symbol === "XAUUSD" ? goldFailed : !!record?.failed;
  const view = useMemo(() => setupView(answer), [answer]);
  const candleData = useMemo(() => timedBars(answer?.candles, answer?.candlesTz), [answer?.candles, answer?.candlesTz]);
  const g = answer?.g && typeof answer.g === "object" ? answer.g as Record<string, unknown> : null;
  const marketOpen = now ? isOpen(symbol === "XAUUSD" ? "metal" : "fx", now) : true;
  const tick = ticks[market.td];
  const tickAge = tick && now ? now - Date.parse(tick.receivedAt) : Infinity;
  const streaming = !sample && marketOpen && tickAge >= -3000 && tickAge <= 6000;
  const snapshotPrice = finite(answer?.price) ?? candleData.bars.at(-1)?.c ?? null;
  const price = streaming ? tick.price : snapshotPrice;
  const currentFrame = FRAMES.find((x) => x.id === tf)!;
  const analysis = useMemo(() => floorMarketRead(candleData.bars, currentFrame.ms, now, candleData.known), [candleData, currentFrame.ms, now]);
  const fmt = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "—" : priceText(v, market.dp);
  const eligibleRead = symbol === "XAUUSD" && atlasRead && now &&
    now - Date.parse(atlasRead.at) >= 0 && now - Date.parse(atlasRead.at) < 300_000 ? atlasRead : null;
  const readAge = candleData.known && analysis.candleAt != null && now > 0 ? Math.max(0, now - analysis.candleAt - currentFrame.ms) : null;
  const analysisDelayed = error || (readAge != null && readAge > currentFrame.ms * 2) || (!sample && typeof answer?.asOf === "string" && now > 0 && now - Date.parse(answer.asOf) > 120_000);
  const usable = sample || (marketOpen && !analysisDelayed && !!answer);
  const support = analysis.support?.price ?? null, resistance = analysis.resistance?.price ?? null;
  const mappedPrice = price ?? analysis.close;
  const position = marketPosition(analysis, mappedPrice);
  const trend = analysis.trend;
  const trendLabel = TREND_WORD[trend];
  const state = !marketOpen ? "Market closed" : error && !answer ? "Feed unavailable" : analysisDelayed ? "Last recorded read" : analysis.close == null ? "Loading structure" : "Market watch";
  // These public levels are derived from the same OHLC visible to everyone.
  // Never reveal the gated engine's entry, stop or targets unless setupView is open.
  const levels: ChartLevel[] = [
    ...(support != null ? [{ kind: "support" as const, price: support, label: "Support" }] : []),
    ...(resistance != null ? [{ kind: "resistance" as const, price: resistance, label: "Resistance" }] : []),
    ...(view.open && usable ? view.levels.filter(l => l.kind !== "support" && l.kind !== "resistance") : []),
  ];
  const inPlay = usable && view.open && (view.stage === "live" || view.stage === "forming");
  const entry = inPlay ? levels.find(x => x.kind === "entry")?.price ?? null : null;
  const stop = inPlay ? levels.find(x => x.kind === "stop")?.price ?? null : null;
  const tp1 = inPlay ? levels.find(x => x.kind === "target")?.price ?? null : null;
  const tp2 = inPlay ? finite(g?.tp2) : null;
  const tp3 = inPlay ? finite(g?.tp3) : null;
  const quoteLabel = sample ? "Illustrative quote" : !marketOpen ? "Last market quote" : streaming
    ? "Actual tick · " + age(tick.receivedAt, now) : tick ? "Stream delayed · " + age(tick.receivedAt, now)
      : answer?.asOf ? "Last analysed quote · " + age(answer.asOf, now) : "Awaiting price feed";
  const setupNote = !marketOpen ? "Market closed" : analysisDelayed ? "Awaiting a fresh read" :
    view.stage === "live" ? "Ready to review" : view.stage === "forming" ? "Waiting for entry" : "No confirmed setup";
  const distance = (level: number | null) => level == null || mappedPrice == null || mappedPrice <= 0 ? "—" :
    (Math.abs(level - mappedPrice) / mappedPrice * 100).toFixed(2) + "% from price";
  const rangePosition = support != null && resistance != null && mappedPrice != null && resistance > support ?
    Math.min(100, Math.max(0, (mappedPrice-support)/(resistance-support)*100)) : null;
  const insight = !marketOpen ? "Market closed. The levels below are from the last available candles." :
    analysisDelayed ? "The market read is delayed. Treat these as historical reference levels." :
    analysis.close == null ? "Waiting for enough real candles to map the market." :
    (trend === "bullish" ? "Higher highs and higher lows support an upward trend." :
      trend === "bearish" ? "Lower highs and lower lows support a downward trend." :
      trend === "range" ? "Price is moving sideways without a clear trend." :
      trend === "mixed" ? "Trend and structure are not aligned yet." : "More closed candles are needed to determine trend.") + " " + position;
  const DirectionIcon = trend === "bullish" ? ArrowUpRight : trend === "bearish" ? ArrowDownRight : ArrowLeftRight;
  const mapped = support != null || resistance != null;
  const canAsk = !sample;
  const context: AtlasContext = {
    source: "floor", label: market.td + " · Atlas Live",
    data: {
      td: market.td, symbol, mode: tf, price, marketClosed: !marketOpen, stage: view.stage ?? "watching",
      style: tf === "quick" ? "scalp" : tf === "swing" ? "swing" : "intraday",
      asOf: typeof answer?.asOf === "string" ? answer.asOf : null,
      marketRead: { timeframe: currentFrame.label, trend: analysis.trend, momentum: analysis.momentum, support, resistance, source: "Closed candle structure", stale: analysisDelayed, closed: !marketOpen },
      ...(view.open ? { levels: view.levels, entryZone: view.zone, waitingFor: view.waitingFor,
        invalidation: view.changesIf } : { levelsLocked: true }),
    },
  };
  const signal = () => { if (!sample) openAtlas({ tool: symbol === "XAUUSD" ? "genx" : "plays", context }); };
  return (
    <section className="om-live-desk om-panel om-market-terminal" aria-label="Atlas live market intelligence" data-market={symbol}>
      <header className="om-terminal-header">
        <div className="om-live-brand"><ProductIcon kind="atlas" size="md" /><div><b>Atlas <em>LIVE</em></b><small>Market intelligence</small></div></div>
        <div className="om-terminal-header-actions">
          <span className="om-live-state" data-live={streaming}><i />{sample ? "SAMPLE" : !marketOpen ? "MARKET CLOSED" : streaming ? "LIVE TICKS" : "FEED DELAYED"}</span>
          <a href="/command-center" className="om-terminal-center-link"><Crosshair size={16} aria-hidden="true"/><span>Gold Command Center</span><ArrowUpRight size={14} aria-hidden="true"/></a>
        </div>
      </header>
      <div className="om-terminal-markets" role="group" aria-label="Select market">
        {MARKETS.map(m => <button key={m.key} type="button" aria-pressed={m.key === symbol} disabled={sample && m.key !== "XAUUSD"} onClick={() => setSymbol(m.key)}>
          <span className="om-market-letter" data-symbol={m.key}>{m.key === "XAUUSD" ? "Au" : m.key === "EURUSD" ? "€" : m.key === "GBPJPY" ? "£" : "¥"}</span>
          <span><strong>{m.td}</strong><small>{m.key === "XAUUSD" ? "Gold" : m.key === "EURUSD" ? "Euro / Dollar" : m.key === "GBPJPY" ? "Pound / Yen" : "Dollar / Yen"}</small></span>
        </button>)}
      </div>
      <div className="om-terminal-overview">
        <div className="om-terminal-market-title">
          <span className="om-terminal-label">{market.td} · {currentFrame.label} MARKET READ</span>
          <h2>{market.name} <span>overview</span></h2>
          <div className="om-terminal-price" data-no-i18n translate="no"><strong>{fmt(price)}</strong>{analysis.movePct != null && <span data-trend={analysis.movePct >= 0 ? "bullish" : "bearish"}>{analysis.movePct >= 0 ? "+" : ""}{analysis.movePct.toFixed(2)}% <small>4 closed candles</small></span>}</div>
          <small className="om-terminal-muted">{quoteLabel}</small>
        </div>
        <div className="om-terminal-direction" data-trend={usable ? trend : "unknown"}>
          <div className="om-terminal-direction-icon"><DirectionIcon aria-hidden="true"/></div>
          <div><span className="om-terminal-label">{usable ? "Market trend" : "Last recorded trend"}</span><strong>{trendLabel}</strong><small>{analysis.momentum === "Unknown" ? "Momentum unavailable" : analysis.momentum + " momentum"}</small></div>
          <div className="om-terminal-setup-state"><span>SETUP STATUS</span><b>{setupNote}</b></div>
        </div>
      </div>
      <section className="om-terminal-read" aria-label="Atlas market briefing">
        <div><span className="om-terminal-label"><Sparkles size={14} aria-hidden="true"/> ATLAS MARKET BRIEF</span><p>{insight}</p>
          {eligibleRead && <details><summary>Atlas gold desk context</summary><p>{eligibleRead.summary}</p></details>}
        </div>
        <button type="button" disabled={!canAsk} onClick={() => openAtlas({ question: "Explain the current " + market.td + " market structure, mapped support and resistance, and conditional opportunities on the " + currentFrame.label + " timeframe. Distinguish confirmed entries from market observations.", context })}><Sparkles size={15} aria-hidden="true"/> Explain <ChevronRight size={15} aria-hidden="true"/></button>
      </section>
      <div className="om-terminal-layout">
        <section className="om-terminal-chart-card" aria-label="Market chart">
          <div className="om-live-chart-heading"><div><b>Price action</b><small>Real candles · drag, zoom or expand</small></div>
            <div className="om-live-frames" role="group" aria-label="Market timeframe">
              {FRAMES.map(f => <button key={f.id} type="button" aria-pressed={tf === f.id} onClick={() => onTf(f.id)}>{f.label}</button>)}
            </div>
          </div>
          {candleData.bars.length >= 2 ? <div className="om-terminal-chart">
            <OmChart bars={candleData.bars} timeKnown={candleData.known} tfMs={currentFrame.ms} tfLabel={currentFrame.label}
              price={price} priceLive={streaming} dec={market.dp} levels={levels} zone={inPlay ? view.zone : null}
              isOpenAt={t => isOpen(symbol === "XAUUSD" ? "metal" : "fx", t)}
              viewKey={"atlas-floor:" + symbol + ":" + tf} label={market.td + " real candles with mapped support and resistance"} />
          </div> : <div className="om-live-chart-empty" role="status">{error ? "Chart unavailable. Try another timeframe." : "Loading real market candles…"}</div>}
          <div className="om-terminal-chart-legend"><span><i data-kind="support"/>Support</span><span><i data-kind="resistance"/>Resistance</span><small>{analysis.barsUsed ? analysis.barsUsed + " closed candles analysed" : "Awaiting analysis"}</small></div>
        </section>
        <aside className="om-terminal-level-map" aria-label="Support and resistance">
          <div className="om-terminal-panel-heading"><Target size={17} aria-hidden="true"/><h3>Key market levels</h3><span>{currentFrame.label}</span></div>
          <div className="om-terminal-level" data-kind="resistance"><span>RESISTANCE <ArrowUpRight size={14} aria-hidden="true"/></span><strong>{fmt(resistance)}</strong><small>{analysis.resistance?.source ?? "Not established"} · {distance(resistance)}</small></div>
          {rangePosition != null && <div className="om-terminal-range" aria-label="Price location between mapped levels"><div><i style={{left: rangePosition + "%"}}/></div><span>Support</span><span>Resistance</span></div>}
          <div className="om-terminal-level" data-kind="support"><span>SUPPORT <ArrowDownRight size={14} aria-hidden="true"/></span><strong>{fmt(support)}</strong><small>{analysis.support?.source ?? "Not established"} · {distance(support)}</small></div>
          <div className="om-terminal-range-values"><div><span>Recent high</span><strong>{fmt(analysis.rangeHigh)}</strong></div><div><span>Recent low</span><strong>{fmt(analysis.rangeLow)}</strong></div></div>
          <small className="om-terminal-muted">Nearest confirmed swings or recent range extremes. Levels are reference areas, not guaranteed barriers.</small>
        </aside>
      </div>
      <section className="om-terminal-opportunities" aria-label="Conditional opportunities">
        <div className="om-terminal-panel-heading"><Activity size={18} aria-hidden="true"/><h3>What to watch next</h3><span>{usable && mapped ? "CONDITIONAL" : "REFERENCE ONLY"}</span></div>
        {mapped ? <div className="om-terminal-scenario-grid">
          <div className="om-terminal-scenario" data-trend="bullish"><div><ArrowUpRight size={20} aria-hidden="true"/><strong>Upside scenario</strong></div><b>{resistance != null ? fmt(resistance) : "Not established"}</b><p>{resistance != null ? "Watch for a closed candle above resistance followed by a successful retest. A rejection keeps the level in play." : "No resistance above the last closed price has been identified in this window."}</p></div>
          <div className="om-terminal-scenario" data-trend="bearish"><div><ArrowDownRight size={20} aria-hidden="true"/><strong>Downside scenario</strong></div><b>{support != null ? fmt(support) : "Not established"}</b><p>{support != null ? "Watch for a closed candle below support followed by a failed reclaim. A hold keeps support in play." : "No support below the last closed price has been identified in this window."}</p></div>
        </div> : <p className="om-terminal-muted">No reliable levels yet. The watchlist will populate when enough closed candles arrive.</p>}
        <div className="om-terminal-watch-note"><ShieldCheck size={16} aria-hidden="true"/><span>{usable ? "Market observations only. A break, retest or rejection must be confirmed before a setup is considered." : "Historical or unavailable data — not a current entry signal."}</span></div>
      </section>
      {inPlay && entry != null ? <section className="om-terminal-signal"><div className="om-live-plan-heading"><b>{market.engine} · {view.side?.toUpperCase() ?? "SETUP"}</b><span>{view.stage === "live" ? "Review entry and risk" : "Entry pending confirmation"}</span></div>
        <div className="om-live-levels" data-no-i18n translate="no">
          {([["ENTRY",entry],["STOP LOSS",stop],["TP 1",tp1],["TP 2",tp2],["TP 3",tp3]] as [string,number|null][]).map(([label,value]) => <div key={label}><span>{label}</span><strong>{fmt(value)}</strong></div>)}
        </div>{view.waitingFor && <p>{view.waitingFor}</p>}{view.changesIf && <p>Invalidation: {view.changesIf}</p>}
      </section> : <div className="om-terminal-no-signal"><div><strong>{view.stage === "live" || view.stage === "forming" ? "A setup is available to review" : "No confirmed trade shown"}</strong><small>{!usable ? state : view.open ? "Atlas continues to monitor price action." : "Open the signal tool for its full analysis."}</small></div><span>{market.engine}</span></div>}
      <div className="om-live-actions">
        <button className="om-live-talk" type="button" disabled={sample} onClick={() => openAtlas({ voice: true, context })}><Mic size={19} aria-hidden="true"/>Talk to Atlas</button>
        <button className="om-live-find" type="button" disabled={sample} onClick={signal}><Sparkles size={18} aria-hidden="true"/>{symbol === "XAUUSD" ? "Generate with GENX" : "Generate AI Play"}<ArrowUpRight size={15} aria-hidden="true"/></button>
      </div>
      <p className="om-live-footnote">Analysis: {answer?.asOf ? age(answer.asOf, now) : "not available"} · {readAge != null ? "Last closed candle " + age(new Date(analysis.candleAt! + currentFrame.ms).toISOString(), now) + " · " : ""}Live quotes do not confirm setups. Signal generation and trade execution remain separate.</p>
    </section>
  );
}
