"use client";

import type { AtlasIdea } from "../../../../command-center/engines/idea";
import type { TradeStateView } from "../TradePanel";
import { fmt2 } from "./theme";

type Props = {
  idea: AtlasIdea | null;
  trade: TradeStateView | null;
  now: number;
  replay: boolean;
  readUnavailable: boolean;
  onReview: () => void;
  onManage: () => void;
};

const value = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n) ? fmt2(n) : "—";

/** A view of recorded engine levels. The buttons open the existing review and
 * management drawers; this component cannot qualify or submit an entry. */
export function SimplePlan({ idea, trade, now, replay, readUnavailable, onReview, onManage }: Props) {
  if (trade?.active) return <section className="atlas-simple-plan" aria-label="Open gold position" data-plan-kind="position">
    <div className="atlas-simple-plan-heading"><strong>{replay ? "Recorded" : "Open"} {trade.side ?? "gold"} position</strong>
      <button type="button" onClick={onManage}>Manage position</button></div>
    {readUnavailable && <p role="status">The market read is not current. Position controls remain available.</p>}
    <dl className="atlas-simple-plan-levels">
      <div><dt>Entry</dt><dd>{value(trade.entry)}</dd></div>
      <div data-level="stop"><dt>Current stop</dt><dd>{value(trade.stop)}</dd></div>
      <div data-level="target"><dt>Target</dt><dd>{value(trade.takeProfit)}</dd></div>
    </dl>
    <p>Review the position to adjust protection, reduce size or close it.</p>
  </section>;

  const unmanaged = (trade?.unmanaged.length ?? 0) > 0;
  const hasLevels = !!idea?.side && !!idea.entry && !!idea.stop;
  const expired = idea?.expiresAt != null && now > 0 && now >= idea.expiresAt;
  const captured = idea && Number.isFinite(idea.at) && idea.at > 0
    ? new Date(idea.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return <section className="atlas-simple-plan" aria-label="Atlas plan levels" data-plan-kind={idea ? "recorded" : "empty"}>
    <div className="atlas-simple-plan-heading"><strong>{hasLevels ? `Recorded ${idea.side} plan` : idea ? "No entry plan" : "Your entry plan"}</strong>
      {idea && <button type="button" onClick={onReview}>Review plan</button>}</div>
    {unmanaged && <button type="button" className="atlas-simple-position-warning" onClick={onManage}>Review {trade!.unmanaged.length} untracked gold position{trade!.unmanaged.length === 1 ? "" : "s"}</button>}
    {hasLevels && idea ? <>
      <p className="atlas-simple-plan-time">{replay ? "Replay" : "Generated"}{captured ? ` · ${captured}` : " · time unavailable"}{expired ? " · expired" : ""}</p>
      <dl className="atlas-simple-plan-levels">
        <div><dt>Entry{idea.entry!.low !== idea.entry!.high ? " zone" : ""}</dt><dd>{idea.entry!.low !== idea.entry!.high ? `${value(idea.entry!.low)} – ${value(idea.entry!.high)}` : value(idea.entry!.price)}</dd></div>
        <div data-level="stop"><dt>Stop loss</dt><dd>{value(idea.stop!.price)}</dd></div>
        {idea.targets.map((target) => <div data-level="target" key={target.label}><dt>{target.label}</dt><dd>{value(target.price)}</dd><small>{target.basis === "measured" ? "Risk projection" : "Structure level"}</small></div>)}
      </dl>
      <p><b>Condition when generated:</b> {idea.entry!.trigger ?? idea.waitingFor[0] ?? idea.entry!.text}</p>
      {idea.invalidation && <p><b>Invalidation:</b> {idea.invalidation.text}</p>}
      <p className="atlas-simple-plan-status" role="status">{expired ? "This plan has expired. Generate a new read before considering an entry." : readUnavailable ? "The market read is not current. These are recorded levels, pending a fresh review." : "Recorded levels, not a current entry instruction. Review the plan for its latest status."}</p>
      {idea.warnings.map((warning, index) => <p className="atlas-simple-plan-warning" key={index}>{warning}</p>)}
    </> : <p>{idea ? idea.headline : "Generate a gold signal to see its entry, stop loss and targets. Atlas may return no valid trade."}</p>}
  </section>;
}
