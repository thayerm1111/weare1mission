"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, Mic, Sparkles } from "lucide-react";
import { ProductIcon } from "@/components/om/ProductIcon";
import { SignalFocusChart } from "@/components/om/chart/SignalFocusChart";
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
const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
function age(when: unknown, now: number): string {
  const t = Date.parse(String(when ?? ""));
  if (!Number.isFinite(t) || !now) return "time unavailable";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec < 2 ? "just now" : sec < 60 ? sec + "s ago" : sec < 3600 ? Math.round(sec / 60) + "m ago" : Math.round(sec / 3600) + "h ago";
}
function lead(name: string, stage: string | null, structure: string | null, open: boolean): string {
  if (!open) return name + " is between sessions.";
  if (stage === "live") return "A " + name + " setup is ready for review.";
  if (stage === "forming") return name + " is approaching a possible entry.";
  if (structure && /range|chop|sideway/i.test(structure)) return name + " is ranging — a confirmed break is still needed.";
  if (structure && /bull/i.test(structure)) return name + " leans higher, with no confirmed entry.";
  if (structure && /bear/i.test(structure)) return name + " leans lower, with no confirmed entry.";
  return "Watching " + name + " for a qualified setup.";
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
  const watch = symbol === "USDJPY" ? answer?.watch ?? null : null;
  const marketOpen = now ? isOpen(symbol === "XAUUSD" ? "metal" : "fx", now) : true;
  const tick = ticks[market.td];
  const tickAge = tick && now ? now - Date.parse(tick.receivedAt) : Infinity;
  const streaming = !sample && marketOpen && tickAge >= -3000 && tickAge <= 6000;
  const snapshotPrice = finite(answer?.price) ?? candleData.bars.at(-1)?.c ?? null;
  const price = streaming ? tick.price : snapshotPrice;
  const structure = str(g?.market_structure);
  const momentum = str(g?.momentum) ?? watch?.momentum ?? null;
  const score = finite(g?.confidence_score);
  const eligibleRead = symbol === "XAUUSD" && atlasRead && now &&
    now - Date.parse(atlasRead.at) >= 0 && now - Date.parse(atlasRead.at) < 300_000 ? atlasRead : null;
  const atlasHeadline = eligibleRead?.summary.match(/^(.{1,150}?[.!?])(?:\s|$)/)?.[1];
  const headline = watch ? (marketOpen ? watch.summary : market.name + " is between sessions.")
    : marketOpen && atlasHeadline ? atlasHeadline : lead(market.name, view.stage, structure, marketOpen);
  const state = !marketOpen ? "MARKET CLOSED" : error && !answer ? "FEED UNAVAILABLE"
    : watch ? "MARKET WATCH" : view.stage === "live" ? "SETUP READY" : view.stage === "forming" ? "TRIGGER WATCH" : "WATCHING";
  const insights = watch ? watch.evidence : g && view.open
    ? [
        structure ? "Structure: " + structure : null,
        momentum ? "Momentum: " + momentum : null,
        str(g.trigger_condition) ? "Trigger: " + str(g.trigger_condition) : null,
        str(g.invalidation_reason) ? "Invalidation: " + str(g.invalidation_reason) : null,
      ].filter((x): x is string => !!x)
    : [view.stage ? "The engine is " + (view.stage === "live" ? "showing an entry." : view.stage === "forming" ? "watching a forming setup." : "waiting for a trigger.") : "Scanning recent market structure.",
       "Full setup levels appear only when access is open."];
  const levels: ChartLevel[] = view.open ? view.levels
    : watch && Number.isFinite(watch.low) && Number.isFinite(watch.high)
      ? [{ kind: "support", price: watch.low, label: "Range low" }, { kind: "resistance", price: watch.high, label: "Range high" }]
      : [];
  const inPlay = view.open && (view.stage === "live" || view.stage === "forming");
  const entry = inPlay ? levels.find((x) => x.kind === "entry")?.price ?? null : null;
  const stop = entry !== null ? levels.find((x) => x.kind === "stop")?.price ?? null : null;
  const tp1 = entry !== null ? levels.find((x) => x.kind === "target")?.price ?? null : null;
  const tp2 = entry !== null ? finite(g?.tp2) : null;
  const tp3 = entry !== null ? finite(g?.tp3) : null;
  const direction = inPlay ? view.side ?? "neutral" : "neutral";
  const fmt = (v: number | null) => v === null ? "—" : priceText(v, market.dp);
  const currentFrame = FRAMES.find((x) => x.id === tf)!;
  const quoteLabel = sample ? "Illustrative quote" : !marketOpen ? "Last market quote" : streaming
    ? "Actual tick · " + age(tick.receivedAt, now) : tick ? "Stream delayed · " + age(tick.receivedAt, now)
      : answer?.asOf ? "Last analysed quote · " + age(answer.asOf, now) : "Awaiting price feed";
  const setupNote = entry !== null ? view.stage === "live" ? "Review the setup and risk before acting." : "Wait for confirmation before considering entry."
    : watch ? "Market watch only · generate an OM AI Play for a full trade plan."
      : view.stage === "watching" ? "No qualified trade yet."
        : view.open ? "Entry unavailable for this read." : "Review the signal in its tool to access full levels.";
  const context: AtlasContext = {
    source: "floor", label: market.td + " · Atlas Live",
    data: {
      td: market.td, symbol, mode: tf, price, marketClosed: !marketOpen, stage: view.stage ?? "watching",
      style: tf === "quick" ? "scalp" : tf === "swing" ? "swing" : "intraday",
      asOf: typeof answer?.asOf === "string" ? answer.asOf : null,
      ...(view.open ? { levels: view.levels, entryZone: view.zone, waitingFor: view.waitingFor,
        invalidation: view.changesIf } : { levelsLocked: true }),
    },
  };
  const signal = () => { if (!sample) openAtlas({ tool: symbol === "XAUUSD" ? "genx" : "plays", context }); };
  return (
    <section className="om-live-desk om-panel" aria-label="Atlas live market command center" data-market={symbol}>
      <div className="om-live-top">
        <div className="om-live-brand"><ProductIcon kind="atlas" size="md" /><div><b>Atlas <em>LIVE</em></b><small>Market command center</small></div></div>
        <span className="om-live-state" data-live={streaming}><i />{sample ? "SAMPLE" : !marketOpen ? "MARKET CLOSED" : streaming ? "LIVE TICKS" : "FEED DELAYED"}</span>
      </div>
      <div className="om-live-pairs" role="group" aria-label="Choose market">
        {MARKETS.map((m) => <button key={m.key} type="button" aria-pressed={m.key === symbol}
          disabled={sample && m.key !== "XAUUSD"} onClick={() => setSymbol(m.key)}>{m.td}</button>)}
      </div>
      <div className="om-live-intro">
        <div><span className="om-live-kicker">{market.engine} · {state}</span><h2>{headline}</h2>
          <p>{watch ? "Price-action watch only · a full signal is generated separately."
            : view.stage === "live" && view.open ? "The engine has a qualifying setup to review."
              : "Watching for confirmed trade opportunities, not guessing an entry."}</p></div>
        <div className="om-live-quote" data-live={streaming} data-no-i18n translate="no">
          <span>CURRENT PRICE</span><strong key={streaming ? tick.receivedAt : symbol + String(price)}>{fmt(price)}</strong>
          <small>{quoteLabel}</small></div>
      </div>
      <div className="om-live-stats">
        <div><span>BIAS</span><b data-direction={view.open ? view.side ?? "neutral" : watch?.bias ?? "neutral"}>{view.open && view.side ? view.side.toUpperCase() : watch ? watch.bias.toUpperCase() : "UNCONFIRMED"}</b></div>
        <div><span>SETUP</span><b>{state === "SETUP READY" ? "Ready" : state === "TRIGGER WATCH" ? "Forming" : state === "MARKET CLOSED" ? "Closed" : "Watching"}</b></div>
        <div><span>{score !== null && view.open ? "ENGINE SCORE" : "MOMENTUM"}</span><b>{score !== null && view.open ? Math.round(score) + "/100" : momentum ?? "—"}</b></div>
      </div>
      <div className="om-live-chart-heading"><div><b>Live price action</b><small>Five latest recorded candles · conditional path, where qualified</small></div>
        <div className="om-live-frames" role="group" aria-label="Market timeframe">
          {FRAMES.map((f) => <button key={f.id} type="button" aria-pressed={tf === f.id} onClick={() => onTf(f.id)}>{f.label}</button>)}
        </div></div>
      {candleData.bars.length >= 2
        ? <SignalFocusChart bars={candleData.bars} timeKnown={candleData.known} tfMs={currentFrame.ms} tfLabel={currentFrame.label}
            price={price} priceLive={streaming} dec={market.dp} levels={levels} zone={view.open ? view.zone : null}
            direction={direction} reference={view.stage !== "live"} viewKey={"atlas-floor:" + symbol + ":" + tf}
            label={market.td + " recorded candles and conditional setup levels"} />
        : <div className="om-live-chart-empty" role="status">{error ? "Chart unavailable · last quote shown when available." : "Loading real market candles…"}</div>}
      <div className="om-live-plan-heading"><b>Potential trade</b><span>{setupNote}</span></div>
      <div className="om-live-levels" data-no-i18n translate="no">
        {[["ENTRY",entry],["STOP LOSS",stop],["TP 1",tp1],["TP 2",tp2],["TP 3",tp3]].map(([label,value]) =>
          <div key={String(label)}><span>{label}</span><strong>{fmt(value as number | null)}</strong></div>)}
      </div>
      <div className="om-live-why"><h3><Activity size={16} aria-hidden="true" />Why Atlas is watching</h3>
        {insights.slice(0,2).map((line,i) => <p key={i}>{line}</p>)}
        {insights.length > 2 && <details><summary>Full reasoning</summary>{insights.slice(2).map((line,i) => <p key={i}>{line}</p>)}</details>}
        <small>Analysis: {answer?.asOf ? age(answer.asOf, now) : "not available"} · Live ticks do not automatically requalify a setup.</small>
      </div>
      <div className="om-live-actions">
        <button className="om-live-talk" type="button" disabled={sample} onClick={() => openAtlas({ voice: true, context })}><Mic size={19} aria-hidden="true" />Talk to Atlas</button>
        <button className="om-live-find" type="button" disabled={sample} onClick={signal}><Sparkles size={17} aria-hidden="true" />{symbol === "XAUUSD" ? "Run GENX" : "Generate AI Play"}<ArrowUpRight size={14} aria-hidden="true"/></button>
      </div>
      <p className="om-live-footnote">No simulated prices. A projected chart path is conditional, not a guaranteed future result. Trade actions require your own review.</p>
    </section>
  );
}
