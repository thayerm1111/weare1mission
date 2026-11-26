import { Activity, Flag, ClipboardCheck, Crosshair, Focus, ScanLine } from "lucide-react";

export type StoryDirection = "up" | "down" | "sideways" | "unclear";
export type StoryStage = "looking" | "forming" | "review" | "inTrade" | "finished";
export type StoryFeed = "current" | "recorded" | "closed" | "delayed" | "loading" | "unavailable";

export function storyDirection(value?: string | null): StoryDirection {
  switch (value?.trim().toLowerCase()) {
    case "up": case "uptrend": case "buy": case "long": case "bullish": case "bullish_lean": return "up";
    case "down": case "downtrend": case "sell": case "short": case "bearish": case "bearish_lean": return "down";
    case "range": case "ranging": case "sideways": case "flat": return "sideways";
    default: return "unclear";
  }
}

const directionWord = { up: "Rising", down: "Falling", sideways: "Sideways", unclear: "No clear direction" };
const feedWord = { current: "Market read", recorded: "Saved read", closed: "Market closed", delayed: "Update delayed", loading: "Reading the market", unavailable: "Waiting for data" };
const steps = [
  { key: "looking", label: "Looking", icon: ScanLine },
  { key: "forming", label: "Forming", icon: Focus },
  { key: "review", label: "Review", icon: ClipboardCheck },
] as const;

function DirectionDial({ direction }: { direction: StoryDirection }) {
  const angle = direction === "up" ? 48 : direction === "down" ? -48 : 0;
  return <svg className="om-story-dial" viewBox="0 0 108 65" fill="none" aria-hidden="true">
    <g strokeWidth="6" strokeLinecap="round">
      <path data-on={direction === "down"} d="M10 52A44 44 0 0 1 29 19"/>
      <path data-on={direction === "sideways"} d="M37 14A44 44 0 0 1 71 14"/>
      <path data-on={direction === "up"} d="M79 19A44 44 0 0 1 98 52"/>
    </g>
    {direction !== "unclear" && <g transform={'rotate(' + angle + ' 54 53)'}>
      <path d="M54 24 57.5 51A4 4 0 1 1 50.5 51Z" fill="currentColor"/>
    </g>}
    <circle cx="54" cy="53" r="3.2" fill="currentColor"/>
  </svg>;
}

/** A qualitative reading of the tool's own state. The stages do not represent probabilities. */
export function MarketStory({ market, direction, stage, feed = "current", next, pausedNext, stamp, lean = false, className = "" }: {
  market: string; direction: StoryDirection; stage: StoryStage; feed?: StoryFeed;
  next: string; pausedNext?: string; stamp?: string; lean?: boolean; className?: string;
}) {
  const known = feed === "current" || feed === "recorded";
  const shown = known ? direction : "unclear";
  const headline = lean && (shown === "up" || shown === "down") ? "Leans " + shown : directionWord[shown];
  const active = known ? steps.findIndex(step => step.key === stage) : -1;
  const follow = !known && pausedNext ? pausedNext : feed === "closed" ? "Check again when the market opens." :
    feed === "delayed" ? "Wait for a fresh market update." :
    feed === "loading" ? "The latest market read is loading." :
    feed === "unavailable" ? "Wait for fresh prices before reviewing a setup." : next;
  return <section className={'om-market-story ' + className} data-direction={shown} data-feed={feed} aria-label={market + " market story"}>
    <div className="om-story-reading">
      <DirectionDial direction={shown}/>
      <div><span className="om-story-market">{market}</span>
        <h2>{known ? headline : feedWord[feed]}</h2>
        <small>{stamp || (known ? feedWord[feed] : "Setup paused")}</small>
      </div>
    </div>
    <div className="om-story-progress"><span className="om-story-caption">{feed === "recorded" ? "Setup at the time" : "Setup status"}</span>
      {known && (stage === "inTrade" || stage === "finished") ? <p className="om-story-outcome">{stage === "inTrade" ? <Activity aria-hidden="true"/> : <Flag aria-hidden="true"/>}{stage === "inTrade" ? "In a trade" : "Plan finished"}</p> : <ol aria-label="Setup progress">{steps.map(({ key, label, icon: Icon }, i) =>
        <li key={key} data-current={i === active || undefined} data-past={i < active || undefined} aria-current={i === active ? "step" : undefined}>
          <i aria-hidden="true"/><span><Icon size={16} aria-hidden="true"/>{label}</span>
        </li>)}</ol>}
    </div>
    <div className="om-story-next"><Crosshair size={18} aria-hidden="true"/><span><strong>{feed === "recorded" ? "For review" : "Watch next"}</strong>{follow}</span></div>
  </section>;
}
