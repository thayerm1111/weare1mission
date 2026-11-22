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
import { AtlasPlayChart } from "./AtlasPlayChart";
import "./atlas-signal.css";

const ExecuteSignal = dynamic(() => import("@/components/portal/SignalGenerator").then((module) => module.ExecuteSignal), {
  ssr: false, loading: () => <p className="om-atlas-signal-note" role="status">Loading your ticket…</p>,
});

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const words = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
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
  const reason = play
    ? analysis?.kind === "idea" ? play.signal.no_trade_reason || "The market has not confirmed this idea yet." : play.signal.rationale
    : words(gold!.genx.market_story).join(" ") || gold!.genx.trigger_condition;
  const invalidation = play ? play.signal.invalidation : gold!.genx.invalidation_reason;
  const trigger = gold?.genx.trigger_condition;
  const conviction = gold ? convictionWords(gold.genx.confidence_score) : null;
  const detail = play ? [] : words(gold!.genx.trade_reasoning);
  const risk = play ? [] : words(gold!.genx.risk_factors);
  const execution = atlasExecution(signal);
  const levels: { label: string; value: number }[] = [];
  const add = (label: string, value: unknown) => { if (finite(value)) levels.push({ label, value }); };
  if (play && analysis?.kind !== "none") {
    add("Entry", play.signal.entry); add("Stop", play.signal.stopLoss);
    (play.signal.takeProfits ?? []).slice(0, 3).forEach((value, index) => add("Target " + (index + 1), value));
  } else if (gold) {
    add("Entry", gold.genx.entry); add("Stop", gold.genx.stop_loss);
    add("Target 1", gold.genx.tp1); add("Target 2", gold.genx.tp2); add("Target 3", gold.genx.tp3);
  }
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
        {conviction && <p className="om-atlas-signal-conviction">{conviction}</p>}
        {reason && <p>{reason}</p>}
      </div>

      {levels.length > 0 && <section aria-label="Signal levels">
        <p className="om-atlas-signal-caption">{waiting ? "Reference levels · confirmation is still needed" : "Signal levels"}</p>
        <dl className="om-atlas-signal-levels" data-no-i18n translate="no">
          {levels.map((level) => <div key={level.label} data-level={level.label === "Stop" ? "stop" : level.label.startsWith("Target") ? "target" : "entry"}><dt>{level.label}</dt><dd>{priceFor(symbol, level.value)}</dd></div>)}
        </dl>
      </section>}

      {execution && <details className="om-atlas-signal-order" onToggle={(event) => setTicketOpen(event.currentTarget.open)}>
        <summary><span>Execute {execution.direction === "LONG" ? "BUY" : "SELL"}{execution.unconfirmed ? " · manual override" : ""}</span><ChevronDown aria-hidden="true" /></summary>
        <div className="om-atlas-signal-ticket">
          {gold && <p className="om-atlas-signal-note">This opens a manual FLOW ticket from this read. It places at the current price after your confirmation; it does not schedule a GENX entry or turn on automation.</p>}
          {ticketOpen && <ExecuteSignal key={play ? String(play.id) : gold!.signal_id ?? gold!.asOf} {...execution} />}
        </div>
      </details>}

      {play && <AtlasPlayChart play={play} />}
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
