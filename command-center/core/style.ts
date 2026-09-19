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

export type Style = "quick" | "intraday" | "swing";
export const STYLES: Style[] = ["quick", "intraday", "swing"];

/** The engine's internal mode vocabulary, so the existing thesis and health code needs no translation. */
export const STYLE_MODE: Record<Style, Mode> = { quick: "scalp", intraday: "intraday", swing: "swing" };

export type StylePolicy = {
  label: string;
  subtitle: string;
  /** Timeframes that DECIDE for this style, most important first. */
  decisive: Timeframe[];
  /** Timeframes that provide context but must never trigger an exit on their own. */
  context: Timeframe[];
  /** Movement below this is noise for this style, in pips. Nothing reacts beneath it. */
  noiseFloorPips: number;
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
    noiseFloorPips: 12,
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
   * INTRADAY — session momentum. The session's own structure is the frame: London and New York highs and
   * lows, the breakout and its retest. It has to breathe more than QUICK does.
   */
  intraday: {
    label: "INTRADAY",
    subtitle: "Session momentum.",
    decisive: ["5m", "15m"],
    context: ["1h", "4h"],
    noiseFloorPips: 30,
    followThroughMs: 2 * 3600_000,
    stallMs: 4 * 3600_000,
    breakEvenR: 0.9,
    partialR: 1.3,
    partialFraction: 0.5,
    trailAtr: 1.6,
    giveBackFraction: 0.45,
    characterVotesNeeded: 3,
    expect: "Minutes to hours, inside this session.",
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
    noiseFloorPips: 90,
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

export const styleOf = (s: string | null | undefined): Style =>
  s === "quick" || s === "intraday" || s === "swing" ? s : "intraday";

/**
 * Is this timeframe allowed to end a trade in this style?
 *
 * The single most important question in trade management. A 1-minute structure break is a reason to act
 * on a QUICK trade and is not evidence of anything on a SWING one.
 */
export const decisiveFor = (style: Style, tf: Timeframe): boolean => STYLE[style].decisive.includes(tf);
