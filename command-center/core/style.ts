/**
 * TRADE STYLE — QUICK, INTRADAY, SWING.
 *
 * These are NOT three take-profit distances with different names. A style changes what THE BRAIN pays
 * attention to, how long it gives the trade to prove itself, how fast it protects, and — most importantly
 * — what it is willing to ignore. A five-minute wobble is information in a QUICK trade and noise in a
 * SWING one, and a system that reacts to both identically will either panic out of good swings or sit
 * through the death of good scalps.
 *
 * Everything here is deterministic policy. The model may choose a style; it may not change what a style
 * means.
 */
import type { Mode, Timeframe } from "./types";

export type Style = "quick" | "hold" | "swing";
export const STYLES: Style[] = ["quick", "hold", "swing"];

/**
 * INTRADAY was the old name for HOLD, and rows written under it still exist. The alias is permanent, not
 * transitional: a stored style is a historical fact about a trade that was already managed one way, and
 * silently reinterpreting old rows would corrupt every performance comparison that reads them.
 */
const STYLE_ALIAS: Record<string, Style> = { intraday: "hold", scalp: "quick" };

/** The engine's internal mode vocabulary, so the existing thesis and health code needs no translation. */
export const STYLE_MODE: Record<Style, Mode> = { quick: "scalp", hold: "intraday", swing: "swing" };

export type StylePolicy = {
  label: string;
  subtitle: string;
  /** Timeframes that DECIDE for this style, most important first. */
  decisive: Timeframe[];
  /** Timeframes that provide context but must never trigger an exit on their own. */
  context: Timeframe[];
  /** Movement below this is noise for this style, in pips. Nothing reacts beneath it. */
  noiseFloorPips: number;
  /**
   * The widest stop this style may use, in pips.
   *
   * This HAS to be per style. A single global cap is the kind of number that looks reasonable in a
   * config file and then quietly rejects every real trade of one kind: a 100-pip ceiling leaves a SWING
   * trade a usable window of 45 to 100 pips, when a genuine swing stop on gold is routinely two or three
   * hundred. The same ceiling is far too generous for a QUICK trade, where a 95-pip stop means the setup
   * was never quick in the first place.
   */
  maxStopPips: number;
  /** How long the setup has to do something before its silence becomes evidence against it. */
  followThroughMs: number;
  /** A trade that has gone nowhere for this long, having never moved, is stale for this style. */
  stallMs: number;
  /** Profit, in R, at which break-even protection starts being worth considering. */
  breakEvenR: number;
  /** Profit, in R, at which taking something off the table starts being worth considering. */
  partialR: number;
  /** Fraction of the position a first partial takes. */
  partialFraction: number;
  /** How far behind price a protective stop is allowed to sit, in ATR of the decisive timeframe. */
  trailAtr: number;
  /** How much of a peak give-back is tolerated before profit protection speaks, as a fraction of MFE. */
  giveBackFraction: number;
  /** How many independent deteriorating signals are needed before character is called changed. */
  characterVotesNeeded: number;
  /** Expected holding time, in words, for the UI. */
  expect: string;
  /**
   * The size of move this horizon EXISTS FOR, in pips: [minimum, maximum or null for open-ended].
   *
   * This is an opportunity category, never a promise and never a target. Its only job is eligibility: a
   * setup whose realistic room is nowhere near this band is not this horizon, and the honest response is
   * to label it correctly or decline it — NOT to stretch a target until the label fits. Doing that is how
   * a losing QUICK trade gets quietly relabelled a SWING so nobody has to admit the thesis failed.
   */
  opportunityPips: [number, number | null];
};

export const STYLE: Record<Style, StylePolicy> = {
  /**
   * QUICK — a fast gold move. Roughly the 50–100 pip kind of push, though the pip itself comes from the
   * broker's instrument spec, never from here. Momentum failure matters immediately, and a setup that
   * does nothing for half an hour has told you something.
   */
  quick: {
    label: "QUICK",
    subtitle: "Fast XAUUSD move.",
    decisive: ["1m", "5m"],
    context: ["15m", "1h"],
    opportunityPips: [30, 100],
    noiseFloorPips: 12,
    maxStopPips: 60,
    followThroughMs: 20 * 60_000,
    stallMs: 35 * 60_000,
    breakEvenR: 0.6,
    partialR: 0.9,
    partialFraction: 0.5,
    trailAtr: 1.0,
    giveBackFraction: 0.38,
    characterVotesNeeded: 2,
    expect: "Minutes. If it does nothing, that matters.",
  },

  /**
   * HOLD — session momentum, held for the move rather than the push. Three hundred pips of gold is not
   * something a five-minute chart can carry you through, so the FIFTEEN-MINUTE and HOURLY structure
   * decide and the four-hour provides the frame. That is the substantive difference from the old
   * INTRADAY, which decided on the 5m and was therefore being shaken out of exactly the moves it was
   * supposed to hold. Its stop is wider to match, because a stop sized for a hundred-pip idea cannot
   * survive a three-hundred-pip one.
   */
  hold: {
    label: "HOLD",
    subtitle: "Session momentum, held for the move.",
    decisive: ["15m", "1h"],
    context: ["4h", "5m"],
    opportunityPips: [300, null],
    noiseFloorPips: 40,
    maxStopPips: 200,
    followThroughMs: 3 * 3600_000,
    stallMs: 6 * 3600_000,
    breakEvenR: 0.9,
    partialR: 1.3,
    partialFraction: 0.5,
    trailAtr: 1.8,
    giveBackFraction: 0.45,
    characterVotesNeeded: 3,
    expect: "Hours. Held through ordinary pullbacks, not through a broken thesis.",
  },

  /**
   * SWING — a larger move, held through sessions and overnight. The daily and four-hour decide. Five-minute
   * noise is explicitly NOT allowed to end this trade; only meaningful higher-timeframe deterioration is.
   */
  swing: {
    label: "SWING",
    subtitle: "Larger market move.",
    decisive: ["1h", "4h", "1d"],
    context: ["15m"],
    opportunityPips: [500, 1000],
    noiseFloorPips: 90,
    maxStopPips: 450,
    followThroughMs: 24 * 3600_000,
    stallMs: 3 * 24 * 3600_000,
    breakEvenR: 1.2,
    partialR: 1.8,
    partialFraction: 0.4,
    trailAtr: 2.6,
    giveBackFraction: 0.55,
    characterVotesNeeded: 4,
    expect: "Sessions to days. Short-term noise is ignored on purpose.",
  },
};

export const styleOf = (s: string | null | undefined): Style => {
  if (s === "quick" || s === "hold" || s === "swing") return s;
  const alias = s ? STYLE_ALIAS[s] : undefined;
  return alias ?? "hold";
};

/**
 * Is this timeframe allowed to end a trade in this style?
 *
 * The single most important question in trade management. A 1-minute structure break is a reason to act
 * on a QUICK trade and is not evidence of anything on a SWING one.
 */
export const decisiveFor = (style: Style, tf: Timeframe): boolean => STYLE[style].decisive.includes(tf);


/**
 * Does the room this setup actually has match what the horizon is FOR?
 *
 * Returns the horizon whose opportunity band the move genuinely belongs to, or null when nothing fits.
 * Used to LABEL a setup honestly rather than to stretch one: if the realistic move is eighty pips, it is
 * a QUICK trade whatever the higher timeframes are doing, and calling it a HOLD to justify a wider stop
 * is the exact dishonesty this function exists to prevent.
 */
export function horizonForMove(movePips: number, allowed: Style[] = STYLES): Style | null {
  const fits = allowed.filter((s) => {
    const [lo, hi] = STYLE[s].opportunityPips;
    return movePips >= lo && (hi == null || movePips <= hi);
  });
  if (fits.length) return fits.sort((a, b) => STYLE[b].opportunityPips[0] - STYLE[a].opportunityPips[0])[0];
  return null;
}

/** How far short of its own horizon's band a move is, as a fraction. 0 means it fits. */
export function shortfall(style: Style, movePips: number): number {
  const [lo] = STYLE[style].opportunityPips;
  return movePips >= lo ? 0 : +(1 - movePips / lo).toFixed(2);
}
