"use client";

import { floorMarketRead } from "@/lib/floor/marketIntelligence";
import type { TimedBar } from "@/lib/chart/candleTime";
import { storyDirection, type StoryFeed, type StoryStage } from "../simple/MarketStory";
import { actionWords } from "@/lib/genx/words";

const price = (value: number | null | undefined, dec: number) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : "—";

export function genxMarketStory({ market, action, bias, entry, dec, snapshot, closed, failed, loaded,
  stage, bars, tfMs, timeKnown, asOf, now, scalp }: {
  market: string; action?: string; bias?: string | null; entry?: number | null; dec: number;
  snapshot: boolean; closed: boolean; failed: boolean; loaded: boolean;
  stage?: "watching" | "forming" | "live" | null; bars: TimedBar[]; tfMs: number;
  timeKnown: boolean; asOf?: string | null; now: number; scalp?: "buy" | "sell";
}) {
  const candleRead = floorMarketRead(bars, tfMs, now, timeKnown);
  const candleAge = candleRead.candleAt == null ? null : now - candleRead.candleAt - tfMs;
  const recentCandles = timeKnown && candleAge !== null && candleAge >= 0 && candleAge <= tfMs * 2 + 60_000;
  const biasDirection = storyDirection(bias);
  const observed = snapshot || recentCandles ? storyDirection(candleRead.momentum) : "unclear";
  const direction = biasDirection === "unclear" ? observed : biasDirection;
  const age = asOf ? now - Date.parse(asOf) : NaN;
  const feed: StoryFeed = snapshot ? "recorded" : closed ? "closed" : failed ? "delayed" :
    !loaded || !now ? "loading" : !Number.isFinite(age) || age < -3000 || age > 300_000 ? "delayed" :
    !stage && !recentCandles ? bars.length ? "delayed" : "unavailable" : "current";
  const signal = actionWords(action);
  const phase: StoryStage = scalp ? "forming" : action ? !signal.side ? "looking" : signal.waiting ? "forming" : "review" :
    stage === "live" ? "review" : stage === "forming" ? "forming" : "looking";
  const level = typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? price(entry, dec) : null;
  let watchPrice = level && (scalp || phase !== "looking") ? entry : null;
  let next = "Wait for a clearer setup.";
  if (scalp) next = "Check the short-term entry and stop before deciding.";
  else if (phase === "review") next = snapshot ? "Check the saved entry and stop against the market now." : "Open the setup to review the entry and stop.";
  else if (phase === "forming") {
    if (level && (action === "BUY_STOP" || action === "SELL_STOP"))
      next = "Watch for price to break " + (action === "BUY_STOP" ? "above " : "below ") + level + ".";
    else if (level && (action === "BUY_LIMIT" || action === "SELL_LIMIT"))
      next = "Wait for price to come back near " + level + ".";
    else next = level ? "Watch " + level + " for the entry signal." : "Wait for the entry signal.";
  }
  if (!level && !scalp && phase !== "review" && recentCandles && !snapshot && candleRead.close != null) {
    const close = candleRead.close;
    const nearby = [candleRead.support, candleRead.resistance].flatMap(mark => mark ? [mark.price] : []);
    const nearest = nearby.sort((a, b) => Math.abs(a - close) - Math.abs(b - close))[0];
    if (nearest != null) {
      watchPrice = nearest;
      next = "See how price reacts near " + price(nearest, dec) + ".";
    }
  }
  return { market, lean: biasDirection === "up" || biasDirection === "down", direction, stage: phase, feed, next, stamp: snapshot ? "At analysis" : undefined,
    watchPrice: feed === "recorded" || feed === "current" ? watchPrice : null };
}

export function SimpleGenxLevels({ entry, stop, target, dec, reference }: {
  entry: number | null | undefined; stop: number | null | undefined; target: number | null | undefined; dec: number; reference: boolean;
}) {
  return <details className="om-simple-fold"><summary>Entry, stop and target</summary>
    <dl className="om-genx-simple-levels" aria-label="Entry, protection stop and first target" data-no-i18n translate="no">
      <div data-kind="entry"><dt>Entry price</dt><dd>{price(entry, dec)}</dd></div>
      <div data-kind="stop"><dt>Protection stop</dt><dd>{price(stop, dec)}</dd></div>
      <div data-kind="target"><dt>First target</dt><dd>{price(target, dec)}</dd></div>
    </dl>
    {reference && <p className="om-genfx-read-note">These are reference prices. Wait for the entry condition to confirm.</p>}
  </details>;
}
