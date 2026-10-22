import { createHash } from "node:crypto";

/**
 * CASHTRAP CONFIGURATION — two kinds of setting, kept apart on purpose.
 *
 *  1. SCREENSHOT SETTINGS — the owner's own indicator settings, read off his TradingView screenshots.
 *     They are fixed in code (`SCREENSHOT_SETTINGS`) and cannot be changed from the dashboard.
 *
 *  2. V1 ASSUMPTIONS — choices the owner has not specified. They are implementation defaults, every
 *     one of them configurable (admin settings), and every one of them is shown on the dashboard as
 *     an assumption, never as something the owner confirmed. `ASSUMPTION_NOTES` says which are the
 *     owner's own listed defaults and which were added by the implementation.
 *
 * Every decision and signal records STRATEGY_VERSION and the configuration version (a hash of the
 * screenshot settings and the assumptions in force), so a record always says exactly which rules
 * produced it.
 */
export const STRATEGY_VERSION = "cashtrap-1.0.0";

export const SCREENSHOT_SETTINGS = Object.freeze({
  /** Calculation timeframe: the chart timeframe, fixed to 5 minutes in this module. */
  timeframe: "5min" as const,
  bollinger: Object.freeze({ length: 20, basis: "SMA" as const, source: "close" as const, stdDevMult: 2, offset: 0 }),
  rsi: Object.freeze({ length: 4, source: "close" as const, upper: 80, lower: 20 }),
  /** The RSI-based moving average: a separate line, shown, never used in a condition. */
  rsiMa: Object.freeze({ type: "SMA" as const, length: 4 }),
  /** The screenshot's "BB StdDev 2" applies only when the RSI MA type is Bollinger Bands; with SMA it is inactive. */
  rsiMaBbStdDev: Object.freeze({ value: 2, active: false }),
  rsiDivergence: false,
  /** Ordinary Stochastic (not Stochastic RSI). With smoothing 1 and 1, %K and %D are the same line. */
  stochastic: Object.freeze({ kLength: 5, kSmoothing: 1, dSmoothing: 1, upper: 80, middle: 50, lower: 20 }),
  /** DMI-Stochastic inputs. The calculation itself needs the original source (dmi.ts). */
  dmiStochastic: Object.freeze({ dmiLength: 10, stoLength: 3 }),
  /** Actionable signals use completed candles only. */
  confirmedCalculations: true,
});

export type ExpiryConfig =
  /** Duration measured from the accepted reference entry (V1 provisional: 300 seconds). */
  | { mode: "duration"; durationSec: number }
  /** A fixed clock time defined by the contract: the next `boundaryMinutes` boundary at least `minSecondsToExpiry` after entry. */
  | { mode: "fixed"; boundaryMinutes: number; minSecondsToExpiry: number };

export type Assumptions = {
  /** Owner's listed default: signals are confirmed only after a 5-minute candle closes (V1 supports only true). */
  confirmOnCandleClose: boolean;
  /** Owner's listed default "wick": a wick outside the band counts as an excursion. Alternative "close". */
  bandExcursion: "wick" | "close";
  /** Owner's listed default 2: a DMI event on the exhaustion candle or either of the next two completed candles. */
  dmiWindowCandles: number;
  /** Owner's listed default true: support/resistance confirmation is required for an actionable signal. */
  requireZone: boolean;
  /** Owner's listed provisional default: 5-minute duration expiry (for simulation). NOT a confirmed contract. */
  expiry: ExpiryConfig;
  /** Owner's listed default 10 s: the reference entry must arrive within this many seconds of publication, or the signal is MISSED. */
  maxEntryDelaySec: number;
  /** Owner's listed starting assumptions for automatic zones. */
  zones: {
    pivotLeft: number;
    pivotRight: number;
    lookbackCandles: number;
    atrLength: number;
    halfWidthAtrMult: number;
    /** Implementation assumption: manual zones are invalidated by a completed close beyond them, as automatic zones are. */
    manualInvalidateOnClose: boolean;
  };
  /** Owner's listed default: one active signal per symbol until it expires. */
  oneActiveSignalPerSymbol: boolean;
  /**
   * Implementation assumption: when a direction counts as "reset" after a setup, so a new exhaustion can
   * arm again. "all-cleared": a completed candle where the band excursion, the RSI extreme and the
   * Stochastic extreme of that direction have ALL cleared. "any-cleared": any one of them.
   */
  resetRule: "all-cleared" | "any-cleared";
  /** Implementation assumption: the settlement quote must be received within this many seconds after expiry, or the result is unresolved. */
  settlementToleranceSec: number;
  /** BROKER RULE REQUIRED. What an equal settlement pays: "refund" (stake returned) or "loss". The result is recorded as a tie either way. */
  tieRule: "refund" | "loss";
  /** BROKER SETTING REQUIRED. Net payout per unit staked on a win (0.80 = 80%). Null = not configured: payouts are not computed. */
  payoutRate: number | null;
  /** Implementation assumptions about data. */
  data: {
    /** Completed candles needed before any decision (RSI/ATR smoothing settles well inside this). */
    minWarmupCandles: number;
    /** Every decision recomputes its indicators over exactly this many trailing candles, so live and replay agree to the bit. */
    windowCandles: number;
    /** The last this-many completed candles must have no unexpected gaps. */
    contiguityCandles: number;
    /**
     * Wait this long after a 5-minute candle closes before deciding on it. TwelveData builds its 5-minute
     * candles from 1-minute bars that arrive about a minute late, so a just-closed candle is final only
     * ~60–80 s after its close (measured live 10-22: every candle read 8–20 s after its close was revised
     * by ~80 s, never later).
     */
    feedSettleMs: number;
    /** When DMI events come from an external feed, wait this long after the close for that candle's event. */
    dmiGraceMs: number;
    /** A confirmation decided later than this after its candle closed (runner down, feed late) is recorded but not published. */
    maxPublishLagMs: number;
  };
};

export const DEFAULT_ASSUMPTIONS: Assumptions = Object.freeze({
  confirmOnCandleClose: true,
  bandExcursion: "wick",
  dmiWindowCandles: 2,
  requireZone: true,
  expiry: { mode: "duration", durationSec: 300 },
  maxEntryDelaySec: 10,
  zones: { pivotLeft: 2, pivotRight: 2, lookbackCandles: 200, atrLength: 14, halfWidthAtrMult: 0.15, manualInvalidateOnClose: true },
  oneActiveSignalPerSymbol: true,
  resetRule: "all-cleared",
  settlementToleranceSec: 5,
  tieRule: "refund",
  payoutRate: null,
  data: { minWarmupCandles: 250, windowCandles: 500, contiguityCandles: 12, feedSettleMs: 90_000, dmiGraceMs: 20_000, maxPublishLagMs: 150_000 },
}) as Assumptions;

/** What each assumption is, for the dashboard's "rules vs assumptions" panel. */
export const ASSUMPTION_NOTES: Array<{ key: string; label: string; origin: "owner-default" | "implementation" | "broker-required" }> = [
  { key: "confirmOnCandleClose", label: "Signals confirm only after a 5-minute candle closes", origin: "owner-default" },
  { key: "bandExcursion", label: "A wick outside a Bollinger Band counts as an excursion (alternative: close outside)", origin: "owner-default" },
  { key: "dmiWindowCandles", label: "DMI event on the exhaustion candle or within the next two completed candles", origin: "owner-default" },
  { key: "expiry", label: "Provisional 5-minute expiry from the accepted reference entry (simulation only)", origin: "owner-default" },
  { key: "requireZone", label: "Support/resistance confirmation required for an actionable signal", origin: "owner-default" },
  { key: "maxEntryDelaySec", label: "Reference entry must come within 10 seconds of publication, or the signal is MISSED", origin: "owner-default" },
  { key: "zones", label: "Automatic zones: 2/2 swings, 200-candle window, half-width 0.15 × ATR(14) frozen at creation, invalidated by a close beyond", origin: "owner-default" },
  { key: "zones.pivot", label: "Swing high: higher than the 2 candles before it and at least as high as the 2 after it (mirror for lows)", origin: "implementation" },
  { key: "zones.created", label: "A zone's width uses ATR(14) at the candle that confirms the swing; a zone is usable from the next candle's open", origin: "implementation" },
  { key: "zones.contributing", label: "If several zones qualify, the one whose centre is nearest the candle's extreme contributes (then newest)", origin: "implementation" },
  { key: "zones.manualInvalidateOnClose", label: "Manual zones are invalidated by a completed close beyond them, like automatic zones", origin: "implementation" },
  { key: "oneActiveSignalPerSymbol", label: "One active signal per symbol until expiry", origin: "owner-default" },
  { key: "resetRule", label: "A direction resets after a candle where its band excursion, RSI extreme and Stochastic extreme have all cleared", origin: "implementation" },
  { key: "settlementToleranceSec", label: "Settlement quote must arrive within 5 seconds after expiry, or the result is unresolved", origin: "implementation" },
  { key: "tieRule", label: "Equal settlement: recorded as a tie; paid as a refund until the broker's rule is set", origin: "broker-required" },
  { key: "payoutRate", label: "Net payout per win: not set — payouts are not computed until the broker's payout is entered", origin: "broker-required" },
  { key: "data", label: "Data: 250-candle warmup, 500-candle calculation window, no unexpected gaps in the last 12 candles; each candle is decided 90 s after it closes, because the feed's 5-minute candle is final only ~60–80 s after the close; a confirmation decided more than 150 s after its candle closed is recorded but not published", origin: "implementation" },
  { key: "marketHours", label: "Trading hours (New York time): FX Sunday 17:00 to Friday 17:00; gold from Sunday 18:00 with a daily 17:00–18:00 break. Candles the feed sends outside these hours (it sends weekend bars) are ignored — a normal chart has none", origin: "implementation" },
  { key: "closedMarket", label: "A confirmation is not published when the market is closed at publication or would be closed at expiry (it could not be entered or settled); a settlement time inside a closure is unresolved", origin: "implementation" },
  { key: "dmiEventTiming", label: "Outside DMI events count only if received after their candle closed (an alert fired mid-candle is ignored) and by the time the candle is decided", origin: "implementation" },
];

/* ── validation ───────────────────────────────────────────────────────────────────────────────── */
const isInt = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const isNum = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;

/** Merge a partial assumptions object over the defaults and validate the result. */
export function resolveAssumptions(input: unknown): { ok: true; value: Assumptions } | { ok: false; errors: string[] } {
  const src = (input && typeof input === "object" ? input : {}) as Partial<Assumptions> & Record<string, unknown>;
  const d = DEFAULT_ASSUMPTIONS;
  const v: Assumptions = {
    confirmOnCandleClose: src.confirmOnCandleClose ?? d.confirmOnCandleClose,
    bandExcursion: src.bandExcursion ?? d.bandExcursion,
    dmiWindowCandles: src.dmiWindowCandles ?? d.dmiWindowCandles,
    requireZone: src.requireZone ?? d.requireZone,
    expiry: (src.expiry as ExpiryConfig | undefined) ?? d.expiry,
    maxEntryDelaySec: src.maxEntryDelaySec ?? d.maxEntryDelaySec,
    zones: { ...d.zones, ...((src.zones as Partial<Assumptions["zones"]>) ?? {}) },
    oneActiveSignalPerSymbol: src.oneActiveSignalPerSymbol ?? d.oneActiveSignalPerSymbol,
    resetRule: src.resetRule ?? d.resetRule,
    settlementToleranceSec: src.settlementToleranceSec ?? d.settlementToleranceSec,
    tieRule: src.tieRule ?? d.tieRule,
    payoutRate: src.payoutRate === undefined ? d.payoutRate : src.payoutRate,
    data: { ...d.data, ...((src.data as Partial<Assumptions["data"]>) ?? {}) },
  };
  const e: string[] = [];
  if (v.confirmOnCandleClose !== true) e.push("confirmOnCandleClose: V1 confirms only on completed candles (intrabar confirmation is not implemented)");
  if (v.bandExcursion !== "wick" && v.bandExcursion !== "close") e.push("bandExcursion: 'wick' or 'close'");
  if (!isInt(v.dmiWindowCandles, 0, 5)) e.push("dmiWindowCandles: whole number 0–5");
  if (typeof v.requireZone !== "boolean") e.push("requireZone: true or false");
  if (v.expiry?.mode === "duration") {
    if (!isInt(v.expiry.durationSec, 30, 3600)) e.push("expiry.durationSec: whole seconds 30–3600");
  } else if (v.expiry?.mode === "fixed") {
    if (![1, 5, 10, 15, 30, 60].includes(v.expiry.boundaryMinutes)) e.push("expiry.boundaryMinutes: 1, 5, 10, 15, 30 or 60");
    if (!isInt(v.expiry.minSecondsToExpiry, 0, 3600)) e.push("expiry.minSecondsToExpiry: whole seconds 0–3600");
  } else e.push("expiry.mode: 'duration' or 'fixed'");
  if (!isInt(v.maxEntryDelaySec, 1, 60)) e.push("maxEntryDelaySec: whole seconds 1–60");
  const z = v.zones;
  if (!isInt(z.pivotLeft, 1, 10) || !isInt(z.pivotRight, 1, 10)) e.push("zones.pivotLeft/pivotRight: whole numbers 1–10");
  if (!isInt(z.lookbackCandles, 20, 2000)) e.push("zones.lookbackCandles: 20–2000");
  if (!isInt(z.atrLength, 2, 100)) e.push("zones.atrLength: 2–100");
  if (!isNum(z.halfWidthAtrMult, 0.01, 2)) e.push("zones.halfWidthAtrMult: 0.01–2");
  if (typeof z.manualInvalidateOnClose !== "boolean") e.push("zones.manualInvalidateOnClose: true or false");
  if (typeof v.oneActiveSignalPerSymbol !== "boolean") e.push("oneActiveSignalPerSymbol: true or false");
  if (v.resetRule !== "all-cleared" && v.resetRule !== "any-cleared") e.push("resetRule: 'all-cleared' or 'any-cleared'");
  if (!isInt(v.settlementToleranceSec, 1, 60)) e.push("settlementToleranceSec: whole seconds 1–60");
  if (v.tieRule !== "refund" && v.tieRule !== "loss") e.push("tieRule: 'refund' or 'loss'");
  if (v.payoutRate !== null && !isNum(v.payoutRate, 0.01, 5)) e.push("payoutRate: null or 0.01–5 (net payout per unit staked)");
  const dt = v.data;
  if (!isInt(dt.windowCandles, 260, 2000)) e.push("data.windowCandles: 260–2000");
  if (!isInt(dt.minWarmupCandles, 50, dt.windowCandles)) e.push("data.minWarmupCandles: 50 up to data.windowCandles");
  if (!isInt(dt.contiguityCandles, 1, 100)) e.push("data.contiguityCandles: 1–100");
  if (!isInt(dt.feedSettleMs, 0, 180_000)) e.push("data.feedSettleMs: 0–180000");
  if (!isInt(dt.dmiGraceMs, 0, 120_000)) e.push("data.dmiGraceMs: 0–120000");
  if (!isInt(dt.maxPublishLagMs, 5_000, 600_000)) e.push("data.maxPublishLagMs: 5000–600000");
  else if (isInt(dt.feedSettleMs, 0, 180_000) && dt.maxPublishLagMs < Math.max(dt.feedSettleMs, dt.dmiGraceMs) + 10_000) e.push("data.maxPublishLagMs must be at least 10 s more than the decision delay, or nothing could be published");
  if (z.lookbackCandles + z.pivotLeft + z.pivotRight + z.atrLength > dt.windowCandles) e.push("data.windowCandles must cover the zone lookback plus the ATR warmup");
  return e.length ? { ok: false, errors: e } : { ok: true, value: v };
}

/** Canonical JSON (keys sorted) so the same configuration always hashes the same. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

/** The configuration version: a short hash of everything that can change a decision. */
export function configVersion(a: Assumptions): string {
  const h = createHash("sha256").update(canonical({ strategy: STRATEGY_VERSION, screenshot: SCREENSHOT_SETTINGS, assumptions: a })).digest("hex");
  return `cfg-${h.slice(0, 10)}`;
}

export type EffectiveConfig = { strategyVersion: string; configVersion: string; screenshot: typeof SCREENSHOT_SETTINGS; assumptions: Assumptions };

export function effectiveConfig(a: Assumptions = DEFAULT_ASSUMPTIONS): EffectiveConfig {
  return { strategyVersion: STRATEGY_VERSION, configVersion: configVersion(a), screenshot: SCREENSHOT_SETTINGS, assumptions: a };
}
