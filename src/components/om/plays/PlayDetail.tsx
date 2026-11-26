"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Loader2, RefreshCw, Activity, X } from "lucide-react";
import { VisionChart } from "@/components/om/vision/VisionChart";
import { VisionDirection, VisionLevels, type VisionFact } from "@/components/om/vision/VisionDirection";
import { atlasPlayChart } from "@/lib/atlas/chart";
import { priceFor } from "@/lib/flow/display";
import { analysisOf, trackingOf, targetsWithR, pipsBetween, type PlayDirection } from "@/lib/plays/lifecycle";
import type { ChartLevel } from "@/lib/floor/chart";
import { sanitizePlaySignal, type PlayDiagnostics } from "@/lib/plays/diagnostics";
import { PlayBreakdown } from "./PlayBreakdown";
import { MarketStory, storyDirection } from "../simple/MarketStory";
import { useExperienceMode } from "@/components/om/experience";
import "./plays-experience.css";

/**
 * ONE OM AI PLAY, READ TOP TO BOTTOM (owner 11-21 brief §9):
 *   1  the market, the style, when it was analysed, and what the engine concluded
 *   2  its recorded price, entry, stop and targets
 *   3  its actual candles and a clearly conditional projected direction
 *   4  the decision, a visible Execute review, and the supporting evidence
 *   5  what price has done since (tracking: price only, never an order), plus the full reasoning
 * Every word and number is the play's own, as it was saved. This component fetches nothing and charges
 * nothing: the result check, the update, the deep dive and the ticket are the generator's existing
 * handlers and components, passed in.
 */
export type PlayView = {
  id: number; symbol: string; name: string; market: string; td: string; interval: string; orderType: string;
  style?: string; method?: string; price: number; asOf: string; as_of?: string; live_price?: number; marketClosed?: boolean;
  status: "open" | "win" | "loss"; hitTp?: number; hitAt?: string;
  candles?: { t: string; o: number; h: number; l: number; c: number }[];
  signal: {
    direction: PlayDirection; entry: number; stopLoss: number; takeProfits: number[];
    confidence: string; riskReward: string; timeframe: string; rationale: string; invalidation: string;
    setup?: string; bias?: string; poi?: string; liquidityTarget?: string;
    checklist?: { label: string; ok: boolean }[]; confirmed?: number; total?: number;
    flow?: { h4: string; h1: string; dir: string; aligned: boolean };
    timeframes?: { tf: string; trend: string; confirmed: number; total: number; checklist: { label: string; ok: boolean }[]; unavailable?: boolean }[];
    timeframeConfirmations?: PlayDiagnostics["timeframeConfirmations"];
    verdict?: string; status?: "setup" | "no_trade"; grade?: string | null; gate_score?: number; no_trade_reason?: string;
    mode?: "institutional" | "accelerator"; momentum_rating?: string; trend_rating?: string; chased?: boolean; chase_note?: string;
  };
};

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const STYLE_WORD: Record<string, string> = { scalp: "Scalp", intraday: "Intraday", swing: "Swing" };
const METHOD_WORD: Record<string, string> = { best: "Best", smc: "Smart Money", structure: "Structure" };

export function PlayDetail({ r, madeMs, checking, onCheck, updating, onUpdate, update, onDive, onAsk, onClose, live, ticket, copy, chat }: {
  r: PlayView;
  /** When the play was made (the generator's own rule). */
  madeMs: number;
  checking: boolean; onCheck: () => void;
  updating: boolean; onUpdate: () => void;
  /** The "Get update" answer, drawn by the generator's own panel. */
  update: React.ReactNode | null;
  onDive: () => void; onAsk: () => void; onClose: () => void;
  /** The live price beside the play's entry (the generator's own component). */
  live: React.ReactNode | null;
  /** The ticket: the generator's own Execute component, or nothing for a play without a side and levels. */
  ticket: React.ReactNode | null;
  copy: React.ReactNode | null;
  chat: React.ReactNode | null;
}) {
  const { isSimple } = useExperienceMode();
  const s = sanitizePlaySignal(r.signal);
  const hasFrameEvidence = (s.timeframeConfirmations?.length ?? 0) > 0;
  const a = analysisOf(s);
  const t = trackingOf(r);
  const [why, setWhy] = useState(false);
  const px = (v: number | null | undefined) => priceFor(r.symbol, v ?? null);
  const targets = targetsWithR(s);
  const hasLevels = a.kind !== "none" && fin(s.entry) && fin(s.stopLoss);
  const limit = String(r.orderType).toLowerCase() === "limit";
  const best = targets.reduce<number | null>((m, x) => (x.r != null && (m == null || x.r > m) ? x.r : m), null);
  const when = Number.isFinite(madeMs) ? new Date(madeMs).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : r.asOf;

  // The play's own candles, with its own levels. Their stamps are the feed's clock: distances only, never a clock time.
  const chart = useMemo(() => atlasPlayChart(r), [r]);
  const generationPrice = fin(r.price) ? r.price : chart.bars.at(-1)?.c ?? null;
  const priceLabel = fin(r.price) ? "Price at signal" : "Last saved candle";
  const levels: ChartLevel[] = useMemo(() => {
    if (!hasLevels) return [];
    const label = (value: string) => a.kind === "idea" ? `Reference ${value.toLowerCase()}` : value;
    const L: ChartLevel[] = [{ kind: "entry", price: s.entry, label: label(limit ? "Limit entry" : "Entry") }, { kind: "stop", price: s.stopLoss, label: label("Stop") }];
    for (const x of targets) L.push({ kind: "target", price: x.price, label: label(`Target ${x.n}`) });
    return L;
  }, [hasLevels, s.entry, s.stopLoss, limit, targets, a.kind]);

  // One sentence: what is valid, what is missing, or what to wait for — the engine's own words where it gave them.
  const decision = a.kind === "none"
    ? "No confirmed setup. Wait for a clearer opportunity."
    : a.kind === "idea"
      ? `Waiting for confirmation. ${s.no_trade_reason || "The market has not confirmed this idea."} Levels are for reference.`
      : `${a.side} ${limit ? "at the limit entry" : "around the entry"}${best != null ? ` · up to ${best}R` : ""}.`;

  const quality = fin(s.gate_score) ? s.gate_score : null;
  const visionBias = a.side === "Buy" ? "buy" as const : a.side === "Sell" ? "sell" as const :
    /bull|buy|long/i.test(s.bias ?? "") ? "buy" as const :
    /bear|sell|short/i.test(s.bias ?? "") ? "sell" as const : "mixed" as const;
  const toneOf = (v:unknown):VisionFact["tone"] => {
    const value=String(v??"");
    return /bull|up|higher|long|buy|rising/i.test(value)?"up":
      /bear|down|lower|short|sell|falling/i.test(value)?"down":
      /range|flat|sideway/i.test(value)?"neutral":"watch";
  };
  const side = a.side === "Buy" ? "buy" : a.side === "Sell" ? "sell" : null;
  const firstTarget = targets[0]?.price;
  const coherentPlan = side && hasLevels && fin(firstTarget) && (side === "buy"
    ? s.stopLoss < s.entry && s.entry < firstTarget
    : s.stopLoss > s.entry && s.entry > firstTarget);
  const stopDistance = coherentPlan ? Math.abs(s.entry - s.stopLoss) : 0;
  const targetDistance = coherentPlan ? Math.abs(firstTarget! - s.entry) : 0;
  let chartHeadline = "Waiting for a clearer setup.";
  if (t.resolved) chartHeadline = t.label;
  else if (r.marketClosed) chartHeadline = "Saved while the market was closed.";
  else if (hasLevels && side) {
    if (limit && fin(generationPrice) && side === "sell" && generationPrice < s.entry) chartHeadline = "Waiting for a bounce to sell.";
    else if (limit && fin(generationPrice) && side === "buy" && generationPrice > s.entry) chartHeadline = "Waiting for a dip to buy.";
    else chartHeadline = a.kind === "idea" ? "Watching a possible " + side + "." : "Review the " + side + " setup.";
  }
  const goodChecks = (s.checklist ?? []).filter(x=>x.ok).length;
  const factList:VisionFact[]=[
    {label:"HIGHER TF",value:s.bias||"Not confirmed",tone:toneOf(s.bias)},
    {label:"STRATEGY",value:s.setup||"Market structure",tone:s.setup?"ok":"watch"},
    {label:"MOMENTUM",value:s.momentum_rating||"Awaiting",tone:toneOf(s.momentum_rating)},
    {label:"CONFLUENCE",value:s.checklist?.length?goodChecks+"/"+s.checklist.length+" checks":
      s.flow?.aligned?"4H + 1H aligned":"Unconfirmed",tone:s.flow?.aligned?"ok":"watch"},
    {label:"ENTRY",value:a.kind==="setup"?"Engine setup":a.kind==="idea"?"Watchlist only":"Not qualified",
      tone:a.kind==="setup"?"ok":"watch"},
  ];
  return (
    <article className="om-play" aria-label={`${r.symbol} play`} data-experience={isSimple ? "simple" : "advanced"}>
      <header className="om-play-head">
        <div style={{ minWidth: 0 }}>
          <p className="om-label">{[STYLE_WORD[r.style ?? ""] ?? s.timeframe, r.interval].filter(Boolean).join(" · ")}</p>
          <h2 data-no-i18n translate="no">{r.symbol}<small>{r.name}</small></h2>
          {!isSimple && <p className="om-label om-play-meta" data-no-i18n translate="no">Analysed {when} · {priceLabel.toLowerCase()} {px(generationPrice)}{r.marketClosed ? " · the market was closed" : ""}</p>}
        </div>
        <div className="om-play-state">
          <span className="om-chip" data-kind={a.kind}>{a.label}</span>
          {!isSimple && s.grade && <span className="om-label" title="The engine's quality grade for the setup — not a chance of winning">Grade {s.grade}{fin(s.gate_score) ? ` · ${s.gate_score}/100` : ""}</span>}
          <button type="button" className="om-icon-btn" aria-label="Close this play" title="Close this play" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>

      {isSimple ? <MarketStory compact headline={chartHeadline} market={r.name || r.symbol} lean direction={storyDirection(visionBias)} feed="recorded"
        stage={t.resolved ? "finished" : a.kind === "setup" ? "review" : a.kind === "idea" ? "forming" : "looking"}
        stamp={r.marketClosed ? "Market closed at analysis" : "At analysis"}
        next={t.resolved ? r.status === "loss" ? "This plan reached its stop." : "This plan reached a target." :
          r.marketClosed ? "Get a new read when the market opens." : a.kind === "setup" ? "Check the entry and stop against the market now."
          : a.kind === "idea" ? "Wait for confirmation before using these prices." : "Wait for a clearer setup."}/> : <VisionDirection product="OM AI PLAYS" bias={visionBias}
        eyebrow="ONE MISSION / MULTI-MARKET SIGNAL INTELLIGENCE"
        status={r.marketClosed?"MARKET CLOSED":"SAVED SIGNAL"}
        quote={generationPrice} quoteSymbol={r.symbol} quoteLabel={priceLabel.toUpperCase()} dec={chart.dec}
        tagline={a.kind==="setup"?"SIGNAL SETUP · REVIEW ENTRY":
          a.kind==="idea"?"CONDITIONAL WATCH · CONFIRMATION NEEDED":"NO QUALIFIED ENTRY"}
        score={quality} scoreName="ENGINE QUALITY" facts={factList}/>}
      {chart.bars.length>0 ? <VisionChart
          simpleView={isSimple} watchPrice={hasLevels && !t.resolved && !r.marketClosed ? s.entry : null}
          bars={chart.bars} timeKnown={chart.timeKnown} tfMs={chart.tfMs}
          timeframe={chart.tfLabel} symbol={r.symbol} dec={chart.dec}
          price={generationPrice} priceLabel={priceLabel} marketStatus={`Saved snapshot · ${priceLabel.toLowerCase()}`} priceLive={false} snapshot
          levels={levels} direction={visionBias}
          reference={a.kind!=="setup"} viewKey={chart.viewKey}
          title={r.symbol+" saved candles and recorded trade levels"}/>
        : <p className="om-play-note" role="status">Verified original candles unavailable for this saved read.</p>}
      {isSimple && stopDistance > 0 && targetDistance > 0 && <section className="om-chart-summary" aria-label="First target versus stop">
        <header><h3>First target vs. stop</h3><span>{(targetDistance / stopDistance).toFixed(2)} : 1</span></header>
        <div className="om-chart-distance-meter" aria-hidden="true">
          <i data-stop style={{flexGrow: stopDistance / (stopDistance + targetDistance)}}/>
          <i data-target style={{flexGrow: targetDistance / (stopDistance + targetDistance)}}/>
        </div>
        <div className="om-chart-distance-labels"><span>Stop distance {px(stopDistance)}</span><span>Target distance {px(targetDistance)}</span></div>
      </section>}
      {isSimple ? <details className="om-play-simple-levels om-simple-fold"><summary>Plan prices and rules</summary>
        <p className="om-label">{a.kind === "setup" ? "Prices saved with this plan" : "Reference prices · confirmation required"}</p>
        <dl data-no-i18n translate="no" aria-label="Entry, stop and targets">
          <div><dt>Entry</dt><dd>{px(hasLevels ? s.entry : null)}</dd></div>
          <div data-kind="stop"><dt>Stop loss</dt><dd>{px(hasLevels ? s.stopLoss : null)}</dd></div>
          {hasLevels && targets.length ? targets.map((target) => <div key={target.n} data-kind="target"><dt>Target {target.n}</dt><dd>{px(target.price)}</dd></div>)
            : <div data-kind="target"><dt>Target</dt><dd>—</dd></div>}
        </dl>
        {s.invalidation && <p className="om-play-simple-invalidation"><strong>Cancel this idea if:</strong> {s.invalidation}</p>}
        {hasLevels && copy && <div className="om-vision-copy">{copy}</div>}
      </details> : <VisionLevels symbol={r.symbol} dec={chart.dec} entry={hasLevels?s.entry:null}
        stop={hasLevels?s.stopLoss:null} targets={hasLevels?s.takeProfits:[]}
        rr={targets[0]?.r ?? null} reference={a.kind!=="setup"}/>}
      {!isSimple && hasLevels && copy&&<div className="om-vision-copy">{copy}</div>}
      {!isSimple && <p className="om-play-decision">{decision}</p>}
      {s.chased && r.status === "open" && <p className="om-play-note" role="note"><b>Price has moved past the ideal entry.</b> {s.chase_note}</p>}

      {ticket && (
        <section className="om-play-next" aria-label="Execute this signal">
          <details className="om-play-order">
            <summary className="om-play-order-summary"><span>Execute {a.side?.toUpperCase()}{a.kind === "idea" ? " · manual override" : ""}</span><ChevronDown aria-hidden="true" /></summary>
            {/* Opening the ticket only reviews accounts and risk. Its existing confirmation places the order. */}
            {/* A play whose levels were already reached is history: placing it now is a new trade at today's price. */}
            {t.resolved && <p className="om-play-note" role="note"><b>Price has already reached {r.status === "win" ? "a target" : "the stop"} for this play.</b> Placing it now is a new trade at today&rsquo;s price, sized on today&rsquo;s accounts.</p>}
            {ticket}
          </details>
        </section>
      )}

      <details className="om-vision-play-breakdown">
        <summary>{isSimple ? "Show the analysis behind this plan" : "Why it lines up · Timeframe confirmations"}<ChevronDown aria-hidden="true"/></summary>
        <PlayBreakdown signal={s} interval={r.interval}/>
      </details>

      <section className="om-play-track" aria-label="Since the play was made">
        <div>
          <p className="om-label">Since it was made · price against its levels</p>
          <p className={t.tone === "pos" ? "om-pos" : t.tone === "neg" ? "om-neg" : undefined}><b>{t.label}</b>{r.hitAt && t.resolved ? <span className="om-faint"> · {new Date(r.hitAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null}</p>
          <p className="om-label">{t.note}</p>
        </div>
        {r.status === "open" && a.kind !== "none" && (
          <div className="om-play-track-acts">
            <button type="button" className="om-btn-quiet" onClick={onUpdate} disabled={updating} title="Re-reads the market for this play. Free.">{updating ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Activity aria-hidden="true" />}Get update</button>
            <button type="button" className="om-btn-quiet" onClick={onCheck} disabled={checking} title="Measures the play's levels against price since it was made. Free.">{checking ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}Check result</button>
          </div>
        )}
      </section>
      {update && <div className="om-legacy om-play-update">{update}</div>}
      {live && <div className="om-legacy om-play-live">{live}</div>}

      <div className="om-play-acts">
        <button type="button" className="om-btn-quiet" onClick={onDive}>Deep dive</button>
        <button type="button" className="om-go" onClick={onAsk}>Ask Atlas about this play<ArrowUpRight aria-hidden="true" /></button>
      </div>

      <section className="om-play-why">
        <button type="button" className="om-disclose" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
          <span><b>Why this trade</b><span className="om-label">The market read, confirmations, and rationale.</span></span>
          <ChevronDown aria-hidden="true" />
        </button>
        {why && (
          <div className="om-play-why-body">
            <p className="om-label" data-no-i18n translate="no">Analysed {when} · {priceLabel.toLowerCase()} {px(generationPrice)}{r.marketClosed ? " · market closed" : ""}</p>
            <p className="om-label">{[r.market ? r.market.charAt(0).toUpperCase() + r.market.slice(1) : null, s.mode === "accelerator" ? "Accelerator" : s.mode === "institutional" ? "Institutional" : null, r.method ? METHOD_WORD[r.method] : null, s.grade ? `Grade ${s.grade}${fin(s.gate_score) ? ` · ${s.gate_score}/100` : ""}` : null].filter(Boolean).join(" · ")}</p>
            {(s.bias || s.setup) && (
              <dl className="om-kv">
                {s.bias && <div><dt>Higher-timeframe bias</dt><dd>{s.bias}</dd></div>}
                {s.setup && <div><dt>Strategy</dt><dd>{s.setup}</dd></div>}
                {s.poi && <div><dt>Point of interest</dt><dd>{s.poi}</dd></div>}
                {s.liquidityTarget && <div><dt>Targeting</dt><dd>{s.liquidityTarget}</dd></div>}
                {!hasFrameEvidence && s.flow && <div><dt>Flow · 4H, 1H</dt><dd>{s.flow.h4}, {s.flow.h1} · {s.flow.aligned ? "aligned" : "mixed — following the 1H"}</dd></div>}
              </dl>
            )}
            {!hasFrameEvidence && (Array.isArray(s.timeframes) && s.timeframes.length > 0 ? (
              <div className="om-play-tfs">
                {s.timeframes.map((x) => (
                  <div key={x.tf}>
                    <p className="om-label">{x.tf} · {x.trend}{x.unavailable ? " · no data" : ` · ${x.confirmed} of ${x.total}`}</p>
                    <ul className="om-checks">{x.checklist.map((c, i) => <li key={i} data-ok={c.ok || undefined}>{c.label}</li>)}</ul>
                  </div>
                ))}
              </div>
            ) : Array.isArray(s.checklist) && s.checklist.length > 0 ? (
              <div>
                <p className="om-label">Confirmations · {s.confirmed ?? s.checklist.filter((c) => c.ok).length} of {s.checklist.length}</p>
                <ul className="om-checks">{s.checklist.map((c, i) => <li key={i} data-ok={c.ok || undefined}>{c.label}</li>)}</ul>
              </div>
            ) : null)}
            {s.verdict && <p><b>Verdict.</b> {s.verdict}</p>}
            {s.rationale && <p>{s.rationale}</p>}
            {s.invalidation && <p><b>Invalidation.</b> {s.invalidation}</p>}
            <p className="om-label">Confidence {s.confidence}{s.trend_rating ? ` · trend ${s.trend_rating}` : ""}{s.momentum_rating ? ` · momentum ${s.momentum_rating}` : ""} · {s.timeframe}. Confidence is the engine&rsquo;s rating of the setup, not a chance of winning.</p>
          </div>
        )}
      </section>

      {chat && <details className="om-play-followup"><summary>Follow this play<ChevronDown aria-hidden="true" /></summary><div className="om-legacy om-play-chat">{chat}</div></details>}
      {!isSimple && <p className="om-legal" data-no-i18n translate="no">Price {px(r.price)} · as of {r.asOf} · live data via Twelve Data. Educational analysis, not financial advice.</p>}
    </article>
  );
}
