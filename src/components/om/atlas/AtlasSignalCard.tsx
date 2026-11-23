"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, MessageCircle } from "lucide-react";
import { ProductIcon } from "@/components/om/ProductIcon";
import { PlayBreakdown } from "@/components/om/plays/PlayBreakdown";
import { priceFor } from "@/lib/flow/display";
import { analysisOf } from "@/lib/plays/lifecycle";
import { actionWords, convictionWords } from "@/lib/genx/words";
import { atlasExecution, atlasSignalContext, type AtlasSignalResult } from "@/lib/atlas/signals";
import { openAtlas, type AtlasContext } from "@/lib/atlas/open";
import { AtlasSignalChart } from "./AtlasSignalChart";
import "./atlas-signal.css";

const ExecuteSignal = dynamic(() => import("@/components/portal/SignalGenerator").then((module) => module.ExecuteSignal), {
  ssr: false, loading: () => <p className="om-atlas-signal-note" role="status">Loading your ticket…</p>,
});

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const words = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
const brief = (value: string | undefined) => {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  if (text.length <= 180) return text;
  const beginning = text.slice(0, 180);
  const boundary = beginning.lastIndexOf(" ");
  return `${beginning.slice(0, boundary > 100 ? boundary : 180).trimEnd()}…`;
};
const when = (stamp: string) => {
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : stamp;
};

/** An actual tool result, kept in the conversation. Only opening its ticket loads account sizing. */
export function AtlasSignalCard({ signal, onAsk }: {
  signal: AtlasSignalResult;
  onAsk?: (question: string, context: AtlasContext) => void;
}) {
  const [ticketOpen, setTicketOpen] = useState(false);
  const play = signal.kind === "plays" ? signal.result : null;
  const gold = signal.kind === "genx" ? signal.result : null;
  const symbol = play?.symbol ?? "XAU/USD";
  const analysis = play ? analysisOf(play.signal) : null;
  const action = gold ? actionWords(gold.genx.action) : null;
  const waiting = analysis ? analysis.kind !== "setup" : action?.waiting !== false;
  const title = analysis?.label ?? action?.label ?? "Waiting";
  const at = play ? play.as_of ?? play.asOf : gold!.asOf;
  const horizon = play ? play.style ?? play.signal.timeframe : gold!.mode;
  const story = gold ? words(gold.genx.market_story) : [];
  const reason = play
    ? analysis?.kind === "idea" ? play.signal.no_trade_reason || "The market has not confirmed this idea yet." : play.signal.rationale
    : story.join(" ") || gold!.genx.trigger_condition;
  const summary = brief(reason);
  const fullReason = reason && reason.trim().replace(/\s+/g, " ") !== summary;
  const invalidation = play ? play.signal.invalidation : gold!.genx.invalidation_reason;
  const trigger = gold?.genx.trigger_condition;
  const conviction = gold ? convictionWords(gold.genx.confidence_score) : null;
  const detail = play ? [] : words(gold!.genx.trade_reasoning);
  const risk = play ? [] : words(gold!.genx.risk_factors);
  const execution = atlasExecution(signal);
  const levels: { kind: "price" | "entry" | "stop" | "target" | "support" | "resistance"; label: string; value: number }[] = [];
  const add = (kind: (typeof levels)[number]["kind"], label: string, value: unknown) => { if (finite(value)) levels.push({ kind, label, value }); };
  add("price", "Price at signal", play ? play.price : gold!.price);
  if (play && analysis?.kind !== "none") {
    add("entry", "Entry", play.signal.entry); add("stop", "Stop", play.signal.stopLoss);
    (play.signal.takeProfits ?? []).slice(0, 3).forEach((value, index) => add("target", "Target " + (index + 1), value));
  } else if (gold && action?.side != null) {
    add("entry", "Entry", gold.genx.entry); add("stop", "Stop", gold.genx.stop_loss);
    add("target", "Target 1", gold.genx.tp1); add("target", "Target 2", gold.genx.tp2); add("target", "Target 3", gold.genx.tp3);
  } else if (gold) {
    add("support", "Support", gold.genx.closest_support);
    add("resistance", "Resistance", gold.genx.closest_resistance);
  }
  const hasTradeLevels = levels.some((level) => level.kind === "entry" || level.kind === "stop" || level.kind === "target");
  const levelCaption = hasTradeLevels ? waiting ? "Reference levels · confirmation is still needed" : "Signal levels"
    : levels.some((level) => level.kind !== "price") ? "Market levels" : "Saved price";
  const explain = () => {
    const context = atlasSignalContext(signal);
    const question = "Explain this " + (play ? "OM AI Play on " + symbol : "GENX gold read") + ". What needs to happen next, and what would invalidate it?";
    if (onAsk) onAsk(question, context);
    else openAtlas({ question, context });
  };
  const saveText = signal.saved === "synced" ? "Saved in " + (play ? "OM AI Plays" : "GENX")
    : signal.saved === "device" ? "Saved on this device · account sync is unavailable"
      : "This read could not be saved · keep this conversation open";

  return (
    <article className="om-atlas-signal" aria-label={(play ? "OM AI Play" : "GENX read") + " for " + symbol} data-state={waiting ? "waiting" : "ready"} data-side={execution?.direction === "LONG" ? "buy" : execution?.direction === "SHORT" ? "sell" : undefined}>
      <header className="om-atlas-signal-head">
        <ProductIcon kind={play ? "plays" : "genx"} size="sm" />
        <div><span>{play ? "OM AI Plays" : "GENX"}</span><strong>{symbol}<small>{horizon}</small></strong></div>
      </header>
      <div className="om-atlas-signal-decision">
        <h3>{title}</h3>
        {play?.marketClosed && <span className="om-atlas-signal-tag">Market closed · last available data</span>}
        {gold && gold.data_status !== "live" && <span className="om-atlas-signal-tag">Reference data</span>}
      </div>

      {levels.length > 0 && <section aria-label="Signal price and levels">
        <p className="om-atlas-signal-caption">{levelCaption}</p>
        <dl className="om-atlas-signal-levels" data-no-i18n translate="no">
          {levels.map((level) => <div key={level.label} data-level={level.kind}><dt>{level.label}</dt><dd>{priceFor(symbol, level.value)}</dd></div>)}
        </dl>
      </section>}

      <AtlasSignalChart signal={signal} />

      {(conviction || summary) && <section className="om-atlas-signal-reason" aria-label="Signal explanation">
        {conviction && <p className="om-atlas-signal-conviction">{conviction}</p>}
        {summary && <p>{summary}</p>}
      </section>}
      {fullReason && <details className="om-atlas-signal-evidence om-atlas-signal-story">
        <summary>Read full analysis<ChevronDown aria-hidden="true" /></summary>
        {(gold && story.length > 0 ? story : [reason]).map((text, index) => <p key={index}>{text}</p>)}
      </details>}

      {execution && <details className="om-atlas-signal-order" onToggle={(event) => setTicketOpen(event.currentTarget.open)}>
        <summary><span>Execute {execution.direction === "LONG" ? "BUY" : "SELL"}{execution.unconfirmed ? " · manual override" : ""}</span><ChevronDown aria-hidden="true" /></summary>
        <div className="om-atlas-signal-ticket">
          {gold && <p className="om-atlas-signal-note">This opens a manual FLOW ticket from this read. It places at the current price after your confirmation; it does not schedule a GENX entry or turn on automation.</p>}
          {ticketOpen && <ExecuteSignal key={play ? String(play.id) : gold!.signal_id ?? gold!.asOf} {...execution} />}
        </div>
      </details>}

      {play && <PlayBreakdown signal={play.signal} interval={play.interval} fullReasoning />}

      {gold && (trigger || invalidation) && <dl className="om-atlas-signal-next">
        {trigger && <div><dt>What to wait for</dt><dd>{trigger}</dd></div>}
        {invalidation && <div><dt>What invalidates it</dt><dd>{invalidation}</dd></div>}
      </dl>}

      {(detail.length > 0 || risk.length > 0) && <details className="om-atlas-signal-evidence">
        <summary>Why this setup<ChevronDown aria-hidden="true" /></summary>
        {detail.length > 0 && <ul>{detail.map((text, index) => <li key={index}>{text}</li>)}</ul>}
        {risk.length > 0 && <><p>Watch for</p><ul>{risk.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      </details>}
      <button className="om-atlas-signal-explain" type="button" onClick={explain}><MessageCircle aria-hidden="true" />Explain this signal</button>
      <footer><time dateTime={at}>Read · {when(at)}</time><span>{saveText}</span></footer>
    </article>
  );
}
