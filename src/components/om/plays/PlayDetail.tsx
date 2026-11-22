"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Loader2, RefreshCw, Activity, X } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import { timedBars } from "@/lib/chart/candleTime";
import { priceFor } from "@/lib/flow/display";
import { analysisOf, trackingOf, targetsWithR, pipsBetween, type PlayDirection } from "@/lib/plays/lifecycle";
import type { ChartLevel } from "@/lib/floor/chart";
import { sanitizePlaySignal, type PlayDiagnostics } from "@/lib/plays/diagnostics";
import { PlayBreakdown } from "./PlayBreakdown";

/**
 * ONE OM AI PLAY, READ TOP TO BOTTOM (owner 11-21 brief §9):
 *   1  the market, the style, when it was analysed, and what the engine concluded
 *   2  one sentence: what is valid, what is missing, or what to wait for
 *   3  the play's own levels and a visible Execute action, opening its existing account/risk ticket
 *   4  candles and what price has done since (tracking: price only, never an order)
 *   5  the evidence and the full reasoning, a tap away
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
const TF_MS: Record<string, number> = { "1min": 60e3, "5min": 300e3, "15min": 900e3, "30min": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "1day": 86400e3 };
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
  const tb = useMemo(() => timedBars(r.candles ?? [], null), [r.candles]);
  const levels: ChartLevel[] = useMemo(() => {
    if (!hasLevels) return [];
    const L: ChartLevel[] = [{ kind: "entry", price: s.entry, label: limit ? "Limit entry" : "Entry" }, { kind: "stop", price: s.stopLoss, label: "Stop" }];
    for (const x of targets) L.push({ kind: "target", price: x.price, label: `Target ${x.n}` });
    return L;
  }, [hasLevels, s.entry, s.stopLoss, limit, targets]);

  // One sentence: what is valid, what is missing, or what to wait for — the engine's own words where it gave them.
  const decision = a.kind === "none"
    ? "No confirmed setup. Wait for a clearer opportunity."
    : a.kind === "idea"
      ? `Waiting for confirmation. ${s.no_trade_reason || "The market has not confirmed this idea."} Levels are for reference.`
      : `${a.side} ${limit ? "at the limit entry" : "around the entry"}${best != null ? ` · up to ${best}R` : ""}.`;

  return (
    <article className="om-play" aria-label={`${r.symbol} play`}>
      <header className="om-play-head">
        <div style={{ minWidth: 0 }}>
          <p className="om-label">{[STYLE_WORD[r.style ?? ""] ?? s.timeframe, r.interval].filter(Boolean).join(" · ")}</p>
          <h2 data-no-i18n translate="no">{r.symbol}<small>{r.name}</small></h2>
          <p className="om-label om-play-meta" data-no-i18n translate="no">Analysed {when} · price then {px(r.live_price ?? r.price)}{r.marketClosed ? " · the market was closed" : ""}</p>
        </div>
        <div className="om-play-state">
          <span className="om-chip" data-kind={a.kind}>{a.label}</span>
          {s.grade && <span className="om-label" title="The engine's quality grade for the setup — not a chance of winning">Grade {s.grade}{fin(s.gate_score) ? ` · ${s.gate_score}/100` : ""}</span>}
          <button type="button" className="om-icon-btn" aria-label="Close this play" title="Close this play" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>

      <p className="om-play-decision">{decision}</p>
      {s.chased && r.status === "open" && <p className="om-play-note" role="note"><b>Price has moved past the ideal entry.</b> {s.chase_note}</p>}

      {hasLevels && (
        <div className="om-play-levels">
          <dl className="om-play-lv">
            <div><dt>{limit ? "Limit entry" : "Entry"}</dt><dd className="om-num" data-no-i18n translate="no">{px(s.entry)}</dd></div>
            <div><dt>Stop</dt><dd className="om-num om-neg" data-no-i18n translate="no">{px(s.stopLoss)} <small>{pipsBetween(r.symbol, s.entry, s.stopLoss)} pips</small></dd></div>
            {targets.map((x) => (
              <div key={x.n}><dt>Target {x.n}</dt><dd className="om-num om-pos" data-no-i18n translate="no">{px(x.price)} <small>{pipsBetween(r.symbol, s.entry, x.price)} pips{x.r != null ? ` · ${x.r}R` : ""}</small></dd></div>
            ))}
          </dl>
          {copy}
        </div>
      )}

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

      <PlayBreakdown signal={s} interval={r.interval} />

      {tb.bars.length >= 2 && (
        <div className="om-play-chart">
          <OmChart bars={tb.bars} timeKnown={tb.known} tfMs={TF_MS[r.interval] ?? 3600e3} tfLabel={r.interval} price={fin(r.live_price) ? r.live_price : r.price} priceLive={false}
            dec={Math.max(0, Math.min(6, px(r.price).split(".")[1]?.length ?? 2))} levels={levels} viewKey={`${r.id}`}
            label={`${r.symbol}, the candles this play was analysed on, with its levels`} />
        </div>
      )}

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
            <p className="om-label" data-no-i18n translate="no">Analysed {when} · price then {px(r.live_price ?? r.price)}{r.marketClosed ? " · market closed" : ""}</p>
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
      <p className="om-legal" data-no-i18n translate="no">Price {px(r.price)} · as of {r.asOf} · live data via Twelve Data. Educational analysis, not financial advice.</p>
    </article>
  );
}
