"use client";

import { useId, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, Layers3, Minus, ShieldX, Target } from "lucide-react";
import { playFrameNote, playFrameScore, playFrameViews, playNotes, playTrendLabel, type PlayFrameKey } from "@/lib/plays/breakdown";
import "./play-breakdown.css";

/** One saved read, shown consistently in the workspace and the Atlas conversation. No requests or trading actions. */
export function PlayBreakdown({ signal, interval, fullReasoning = false }: {
  signal: unknown; interval?: string; fullReasoning?: boolean;
}) {
  const [selected, setSelected] = useState<PlayFrameKey | null>(null);
  const id = useId();
  const frames = playFrameViews(signal, interval), notes = playNotes(signal);
  const active = frames.find((frame) => frame.tf === selected);
  const hasReasoning = notes.rationale || notes.bias || notes.poi || notes.target;

  return (
    <section className="om-play-breakdown" aria-label="Trade breakdown">
      <header className="om-play-breakdown-heading">
        <div><Layers3 aria-hidden="true" /><h3>Trade breakdown</h3></div>
        <span className="om-play-breakdown-state" data-waiting={notes.waiting || undefined}>{notes.noSetup ? "No setup" : notes.waiting ? "Not confirmed" : "Setup"}</span>
      </header>
      <div className="om-play-breakdown-label"><span>Timeframe confirmations</span><span>Checks at generation</span></div>
      <div className="om-play-frame-grid" role="group" aria-label="Timeframe confirmations">
        {frames.map((frame) => {
          const Icon = frame.trend === "bullish" ? ArrowUpRight : frame.trend === "bearish" ? ArrowDownRight : Minus;
          const expanded = selected === frame.tf;
          const hasCount = frame.confirmed != null && frame.total != null && frame.total > 0;
          const score = playFrameScore(frame);
          return <button key={frame.tf} type="button" className="om-play-frame" data-trend={frame.trend ?? "unknown"}
            data-selected={expanded || undefined} data-available={frame.availability}
            aria-expanded={expanded} aria-controls={`${id}-checks`}
            aria-label={`${frame.tf} confirmations: ${playTrendLabel(frame.trend)}; ${hasCount ? `${frame.confirmed} of ${frame.total} checks met` : score}`}
            onClick={() => setSelected(expanded ? null : frame.tf)}>
            <strong>{frame.tf}</strong><Icon aria-hidden="true" /><span className="om-play-frame-trend">{playTrendLabel(frame.trend)}</span>
            <span className="om-play-frame-score">{score}</span>
            <span className="om-play-frame-meter" aria-hidden="true"><i style={{ width: hasCount ? `${frame.confirmed! / frame.total! * 100}%` : "0%" }} /></span>
          </button>;
        })}
      </div>
      <p className="om-play-breakdown-hint">Tap a timeframe to see its checks.</p>

      <div id={`${id}-checks`} hidden={!active} className="om-play-frame-detail" role="region" aria-label={active ? `${active.tf} confirmation details` : "Confirmation details"}>
        {active && <>
          <div className="om-play-frame-detail-head"><strong>{active.tf} confirmations</strong><span>{active.confirmed != null && active.total != null ? `${active.confirmed} of ${active.total} met` : playFrameScore(active)}</span></div>
          {active.checklist.length > 0 && <ul className="om-play-factor-list">
            {active.checklist.map((check, index) => <li key={`${check.label}-${index}`} data-met={check.ok || undefined}>
              {check.ok ? <Check aria-hidden="true" /> : <Minus aria-hidden="true" />}<span>{check.label}</span><small>{check.ok ? "Met" : "Not met"}</small>
            </li>)}
          </ul>}
          <p>{playFrameNote(active)}</p>
          {active.asOf && <small className="om-play-frame-stamp" data-no-i18n translate="no">Last closed candle · {active.asOf} · feed time</small>}
        </>}
      </div>

      {(notes.setup || notes.invalidation) && <dl className="om-play-mini-notes">
        {notes.setup && <div><dt><Target aria-hidden="true" />The idea</dt><dd>{notes.setup}</dd></div>}
        {notes.invalidation && <div><dt><ShieldX aria-hidden="true" />Invalidation</dt><dd>{notes.invalidation}</dd></div>}
      </dl>}

      {fullReasoning && hasReasoning && <details className="om-play-breakdown-full">
        <summary>Full breakdown<ChevronDown aria-hidden="true" /></summary>
        <div>
          {(notes.bias || notes.poi || notes.target) && <dl>
            {notes.bias && <div><dt>Bias</dt><dd>{notes.bias}</dd></div>}
            {notes.poi && <div><dt>Entry area</dt><dd>{notes.poi}</dd></div>}
            {notes.target && <div><dt>Targeting</dt><dd>{notes.target}</dd></div>}
          </dl>}
          {notes.rationale && <p>{notes.rationale}</p>}
          {(notes.confidence || notes.grade) && <p className="om-play-breakdown-rating">{[notes.confidence ? `Confidence: ${notes.confidence}` : null, notes.grade ? `Grade: ${notes.grade}` : null].filter(Boolean).join(" · ")}. These describe the setup, not the chance of winning.</p>}
        </div>
      </details>}
    </section>
  );
}
