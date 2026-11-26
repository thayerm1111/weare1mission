import { Activity, CalendarClock, CircleHelp, ClipboardCheck, Clock3, Eye, Flag, Focus, History, MoveHorizontal, Pause, ScanLine, TrendingDown, TrendingUp } from "lucide-react";

export type StoryDirection = "up" | "down" | "sideways" | "unclear";
export type StoryStage = "looking" | "forming" | "review" | "inTrade" | "finished";
export type StoryFeed = "current" | "recorded" | "closed" | "delayed" | "loading" | "unavailable";

export function storyDirection(value?: string | null): StoryDirection {
  switch (value?.trim().toLowerCase()) {
    case "up": case "rising": case "uptrend": case "buy": case "long": case "bullish": case "bullish_lean": return "up";
    case "down": case "falling": case "downtrend": case "sell": case "short": case "bearish": case "bearish_lean": return "down";
    case "range": case "ranging": case "sideways": case "flat": return "sideways";
    default: return "unclear";
  }
}

const directionWord = { up: "Rising", down: "Falling", sideways: "Sideways", unclear: "No clear direction" };
const feedWord = { current: "Market read", recorded: "Saved read", closed: "Market closed", delayed: "Update delayed", loading: "Reading the market", unavailable: "Waiting for data" };
const directions = { up: TrendingUp, down: TrendingDown, sideways: MoveHorizontal, unclear: CircleHelp };
const phases = {
  looking: { label: "Waiting", icon: ScanLine },
  forming: { label: "Forming", icon: Focus },
  review: { label: "Review plan", icon: ClipboardCheck },
  inTrade: { label: "In a trade", icon: Activity },
  finished: { label: "Plan finished", icon: Flag },
};
const steps = ["looking", "forming", "review"] as const;

/** A qualitative reading of the tool's own state. The stages do not represent probabilities. */
export function MarketStory({ market, direction, stage, feed = "current", next, pausedNext, stamp, lean = false, className = "", compact = false, headline: setupHeadline }: {
  market: string; direction: StoryDirection; stage: StoryStage; feed?: StoryFeed;
  next: string; pausedNext?: string; stamp?: string; lean?: boolean; className?: string; compact?: boolean; headline?: string;
}) {
  const known = feed === "current" || feed === "recorded";
  const shown = known ? direction : "unclear";
  const headline = lean && (shown === "up" || shown === "down") ? "Leans " + shown : directionWord[shown];
  const active = known ? steps.findIndex(step => step === stage) : -1;
  const DirectionIcon = known ? directions[shown] : feed === "closed" ? CalendarClock : Clock3;
  const phase = known ? phases[stage] : { label: "Paused", icon: Pause };
  const PhaseIcon = phase.icon;
  const follow = known ? next : pausedNext;
  if (compact) return <section className={"om-chart-headline " + className} data-direction={shown} data-feed={feed} aria-label={market + " market story"}>
    <span className="om-chart-headline-source">{market}{known && (stamp || feed === "recorded") ? " · " + (stamp || feedWord[feed]) : ""}</span>
    <h2>{known ? setupHeadline || headline : feedWord[feed]}</h2>
    {follow && <p>{follow}</p>}
  </section>;
  return <section className={'om-market-story ' + className} data-direction={shown} data-feed={feed} aria-label={market + " market story"}>
    <div className="om-story-reading">
      <span className="om-story-direction-icon"><DirectionIcon aria-hidden="true" strokeWidth={2.2}/></span>
      <div><span className="om-story-market">{market}</span>
        <h2>{known ? headline : feedWord[feed]}</h2>
        {(stamp || feed === "recorded") && <small>{feed === "recorded" && <History size={12} aria-hidden="true"/>}{stamp || feedWord[feed]}</small>}
      </div>
    </div>
    <div className="om-story-progress" data-stage={known ? stage : "paused"}>
      <span className="om-story-caption">{feed === "recorded" ? "Setup at the time" : "Setup"}</span>
      <p className="om-story-outcome"><PhaseIcon size={16} aria-hidden="true"/>{phase.label}</p>
      {active !== -1 && <ol aria-label="Setup progress">{steps.map((key, i) =>
        <li key={key} data-current={i === active || undefined} data-past={i < active || undefined} aria-current={i === active ? "step" : undefined}>
          <i aria-hidden="true"/><span className="om-sr">{phases[key].label}</span>
        </li>)}</ol>}
    </div>
    {follow && <p className="om-story-next"><Eye size={17} aria-hidden="true"/><span><span className="om-sr">{feed === "recorded" ? "For review. " : "Watch next. "}</span>{follow}</span></p>}
  </section>;
}
