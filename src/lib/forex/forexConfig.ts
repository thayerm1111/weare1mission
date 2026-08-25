/**
 * FOREX SEGMENT — configuration (standalone, gold-independent).
 *
 * This module is the SEPARATE forex product: its own pairs, its own risk caps, its own
 * session windows, its own reward:risk floor. It shares NOTHING with the gold (FLOW/GENX)
 * strategy — gold and forex have different pip values, volatility and risk, so they are kept
 * completely apart on purpose. Everything here ships behind an OFF toggle; nothing trades until
 * the `forex_enabled` switch AND a per-account opt-in are both on.
 */

// Pairs the forex segment trades (majors only to start — tightest spreads, cleanest structure).
export const FOREX_PAIRS = ["EURUSD", "GBPUSD", "USDJPY"] as const;
export type ForexPair = (typeof FOREX_PAIRS)[number];

// Pip size per pair (JPY pairs are 2-decimal → 0.01; the rest 4-decimal → 0.0001).
export const FOREX_PIP: Record<string, number> = { EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01 };

// ── RISK CAPS ────────────────────────────────────────────────────────────────
// Percent-of-equity risk, but hard-bounded so a tight stop can NEVER balloon the position the
// way it did on the mixed engine (a 27-lot AUDUSD, a 19-lot GBPUSD). Every one of these is a
// backstop, not a target.
export const FOREX_DEFAULT_RISK_PCT = 0.5;   // default per-trade risk when a user hasn't set one
export const FOREX_MAX_RISK_PCT = 1.0;       // ceiling — a user can never risk more than this per trade
export const FOREX_MIN_STOP_PIPS = 12;       // a stop tighter than this is noise → rejected / sizing floor
export const FOREX_MAX_LOTS = 5;             // absolute per-trade lot cap (the hard "no monster position" backstop)
export const FOREX_MAX_CONCURRENT = 2;       // max open forex positions at once, desk-wide per member
export const FOREX_RR_FLOOR = 1.5;           // target must be ≥ 1.5× the stop, checked at placement

// ── SESSION WINDOW (UTC) ─────────────────────────────────────────────────────
// Trade only through the liquid London + New York hours; skip the thin Asian / rollover window
// where majors chop and spreads widen. London ~07:00–16:00 UTC, New York ~12:00–21:00 UTC →
// the union is 07:00–21:00 UTC.
export const FOREX_SESSION_START_UTC = 7;
export const FOREX_SESSION_END_UTC = 21;
