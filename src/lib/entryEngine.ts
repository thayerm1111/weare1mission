/**
 * FLOW ENTRY ENGINE — deterministic "is NOW a good time to enter?" layer.
 *
 * The SETUP engine (omEngine / genxCompute) answers "is there a quality
 * opportunity?".  This module answers the *separate* question "should the
 * trader act right now, wait, or has the entry already been missed?" — and
 * scores the CURRENT entry (Entry Quality) independently of the setup (Edge).
 *
 * 100% deterministic. It receives numbers the setup engine + confirmation layer
 * already produced (it never fetches, never calls the AI, never invents a
 * price). Claude may narrate the result but must not change any field here.
 *
 * State machine:
 *   WAIT → APPROACHING → ARMED → ENTER_NOW
 *   with side-exits ENTER_ON_PULLBACK (rest a limit), MISSED (do-not-chase),
 *   INVALIDATED (thesis failed) and EXPIRED (window elapsed).
 *
 * The confirmation signal (WAIT / AT_ZONE / CONFIRMED / INVALIDATED) comes from
 * genxConfirm.ts, which reacts to CLOSED candles. This engine layers timing,
 * distance, chase-protection, expiry and Entry Quality on top of it.
 */

import type { Mode } from "@/lib/genxCompute";

export type SetupState = "READY" | "DEVELOPING" | "WATCHING" | "NO_EDGE";
export type EntryState =
  | "WAIT"
  | "APPROACHING"
  | "ARMED"
  | "ENTER_NOW"
  | "ENTER_ON_PULLBACK"
  | "MISSED"
  | "INVALIDATED"
  | "EXPIRED";
export type EntryType =
  | "MARKET_NOW"
  | "LIMIT"
  | "STOP"
  | "WAIT_FOR_PULLBACK"
  | "WAIT_FOR_BREAKOUT"
  | "WAIT_FOR_RECLAIM";
/** Confirmation signal from genxConfirm.ts (NONE = not evaluated on this pass). */
export type ConfirmSignal = "WAIT" | "AT_ZONE" | "CONFIRMED" | "INVALIDATED" | "NONE";

/** Per-mode chase / expiry tuning. Points are in PRICE units (already pip-scaled by caller via atr). */
type EntryTuning = {
  approachAtr: number;        // within this many ATR of the zone edge ⇒ APPROACHING (else WAIT)
  maxChaseAtr: number;        // beyond entryMax by this many ATR ⇒ MISSED (do-not-chase)
  pullbackBandAtr: number;    // price above zone but within this ⇒ ENTER_ON_PULLBACK (rest a limit)
  maxMinutesSinceConfirm: number; // ENTER_NOW goes stale ⇒ MISSED after this long
  minRemainingRR: number;     // if remaining reward:risk drops below this ⇒ MISSED
  windowMinutes: number;      // hard expiry of an actionable window
};

export const ENTRY_TUNING: Record<Mode, EntryTuning> = {
  quick:    { approachAtr: 0.8, maxChaseAtr: 0.5, pullbackBandAtr: 1.6, maxMinutesSinceConfirm: 12,  minRemainingRR: 1.2, windowMinutes: 25 },
  intraday: { approachAtr: 1.0, maxChaseAtr: 0.7, pullbackBandAtr: 2.2, maxMinutesSinceConfirm: 35,  minRemainingRR: 1.3, windowMinutes: 90 },
  swing:    { approachAtr: 1.2, maxChaseAtr: 1.0, pullbackBandAtr: 3.0, maxMinutesSinceConfirm: 180, minRemainingRR: 1.4, windowMinutes: 480 },
};

export type EntryEngineInput = {
  side: "buy" | "sell";
  /** Raw engine state string (TRADE_READY / DEVELOPING_SETUP / WATCHLIST / NO_TRADE). */
  engineState: string;
  /** Raw engine action string (BUY_NOW / BUY_LIMIT / WAIT_FOR_BUY_TRIGGER / …). */
  action: string;
  edgeScore: number;              // setup quality 0–100 (confidence_score)
  preferredEntry: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;    // stop
  tp1: number | null;
  currentPrice: number;           // analysis price (Twelve Data) OR broker price when connected
  atr: number | null;
  pip: number;
  dec: number;
  mode: Mode;
  triggerTf: string;              // e.g. "5-minute" — the confirmation timeframe label
  nowMs: number;
  confirm?: { state: ConfirmSignal; confirmedAtMs?: number | null };
  /** When this opportunity FIRST became actionable (persisted by the scanner). */
  activatedAtMs?: number | null;
  /** Broker spread in price units, when a TradeLocker account is connected. */
  spread?: number | null;
};

export type EntryQualityFactor = { label: string; delta: number; note: string };

export type EntryDecision = {
  setupState: SetupState;
  entryState: EntryState;
  entryType: EntryType;
  edgeScore: number;
  entryQuality: number;                 // 0–100
  entryQualityFactors: EntryQualityFactor[];
  direction: "LONG" | "SHORT";
  // Entry window (spec §3)
  preferredEntry: number | null;
  entryMin: number | null;
  entryMax: number | null;
  currentPrice: number;
  distanceToEntryPips: number | null;   // signed: >0 = price must still travel to reach zone
  maxChasePips: number | null;
  chaseRemainingPips: number | null;    // pips left before ENTER_NOW becomes MISSED
  invalidation: number | null;
  remainingRR: number | null;
  entryActivatedAtMs: number | null;
  entryExpiresAtMs: number | null;
  confirmationTimeframe: string;
  confirmationConditions: string[];
  /** 0..1 marker for the TOO-EARLY | IDEAL | GETTING-LATE meter. */
  meter: number;
  meterBand: "too_early" | "approaching" | "ideal" | "acceptable" | "getting_late" | "missed";
  actionable: boolean;                  // true ⇒ user can act now (ENTER_NOW or place-limit)
  headline: string;                     // short label e.g. "ENTER NOW", "APPROACHING", "DO NOT CHASE"
  detail: string;                       // one-line plain-English explanation
};

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function mapSetupState(engineState: string, edge: number): SetupState {
  const s = engineState.toUpperCase();
  if (s.includes("TRADE_READY") || s === "READY") return "READY";
  if (s.includes("DEVELOP")) return "DEVELOPING";
  if (s.includes("WATCH")) return "WATCHING";
  if (edge >= 62) return "DEVELOPING";
  return "NO_EDGE";
}

/**
 * Core decision. Pure function — same inputs always yield the same decision.
 */
export function decideEntry(inp: EntryEngineInput): EntryDecision {
  const { side, pip, dec, currentPrice: price, nowMs } = inp;
  const tune = ENTRY_TUNING[inp.mode] ?? ENTRY_TUNING.quick;
  const atr = isNum(inp.atr) && inp.atr > 0 ? inp.atr : Math.max(pip * 10, 1e-9);
  const round = (n: number | null) => (isNum(n) ? +n.toFixed(dec) : null);
  const toPips = (a: number | null, b: number | null): number | null =>
    isNum(a) && isNum(b) ? Math.round(Math.abs(a - b) / pip) : null;

  const direction: "LONG" | "SHORT" = side === "buy" ? "LONG" : "SHORT";
  const setupState = mapSetupState(inp.engineState, inp.edgeScore);

  const preferredEntry = round(inp.preferredEntry);
  let entryMin = round(inp.entryLow);
  let entryMax = round(inp.entryHigh);
  if (entryMin != null && entryMax != null && entryMin > entryMax) {
    const t = entryMin; entryMin = entryMax; entryMax = t;
  }
  const invalidation = round(inp.invalidation);
  const conf = inp.confirm?.state ?? "NONE";

  // ── Entry type (execution METHOD) from the engine's action ──────────────
  const act = inp.action.toUpperCase();
  let entryType: EntryType;
  if (act.includes("NOW")) entryType = "MARKET_NOW";
  else if (act.includes("LIMIT")) entryType = "LIMIT";
  else if (act.includes("TRIGGER") || act.includes("BREAK")) entryType = "WAIT_FOR_BREAKOUT";
  else if (act.includes("RECLAIM") || act.includes("SWEEP")) entryType = "WAIT_FOR_RECLAIM";
  else entryType = "WAIT_FOR_PULLBACK";

  // ── Distances (all in price units, then pip-rounded for display) ────────
  // Near edge of the zone in the direction price must travel to reach it.
  const nearEdge = side === "buy" ? (entryMax ?? preferredEntry) : (entryMin ?? preferredEntry);
  const farEdge = side === "buy" ? (entryMin ?? preferredEntry) : (entryMax ?? preferredEntry);
  // Signed "still to travel" distance to the zone: >0 = not there yet.
  let distanceToEntry: number | null = null;
  if (isNum(nearEdge)) {
    distanceToEntry = side === "buy" ? price - nearEdge : nearEdge - price; // buy: price above zone ⇒ +
    // If price is already inside/through the zone, distance is 0 or negative.
  }
  const distanceToEntryPips = isNum(distanceToEntry) ? Math.round(distanceToEntry / pip) : null;
  const inZone =
    isNum(entryMin) && isNum(entryMax) ? price >= entryMin - atr * 0.05 && price <= entryMax + atr * 0.05 : false;

  const maxChase = atr * tune.maxChaseAtr;          // price units beyond entryMax we still tolerate
  const maxChasePips = Math.round(maxChase / pip);
  // How far past the far side of the zone has price extended, in the trade direction?
  let extension: number | null = null;              // >0 ⇒ price beyond entry, chasing
  if (isNum(farEdge)) extension = side === "buy" ? price - (entryMax ?? farEdge) : (entryMin ?? farEdge) - price;
  const chaseRemaining = isNum(extension) ? maxChase - Math.max(0, extension) : null;
  const chaseRemainingPips = isNum(chaseRemaining) ? Math.round(chaseRemaining / pip) : null;

  // Effective fill for RR maths: prefer live price when in/near zone, else preferred entry.
  const effEntry = inZone ? price : (preferredEntry ?? price);
  let remainingRR: number | null = null;
  if (isNum(effEntry) && isNum(invalidation) && isNum(inp.tp1)) {
    const risk = Math.abs(effEntry - invalidation);
    const reward = Math.abs(inp.tp1 - price); // reward LEFT from here to TP1
    remainingRR = risk > 0 ? +(reward / risk).toFixed(2) : null;
  }

  // Time since confirmation.
  const confirmedAtMs = inp.confirm?.confirmedAtMs ?? null;
  const minsSinceConfirm = isNum(confirmedAtMs) ? (nowMs - confirmedAtMs) / 60000 : null;

  // ── Resolve entry STATE (timing) with strict precedence ─────────────────
  const beyondInvalidation =
    isNum(invalidation) && (side === "buy" ? price < invalidation : price > invalidation);
  const activatedAtMs = inp.activatedAtMs ?? null;
  const expiresAtMs = isNum(activatedAtMs) ? activatedAtMs + tune.windowMinutes * 60000 : null;
  const expired = isNum(expiresAtMs) ? nowMs > expiresAtMs : false;

  const tooExtended = isNum(extension) && extension > maxChase;
  const tooStale = isNum(minsSinceConfirm) && minsSinceConfirm > tune.maxMinutesSinceConfirm;
  const rrTooLow = isNum(remainingRR) && remainingRR < tune.minRemainingRR;

  let entryState: EntryState;

  if (setupState === "NO_EDGE") {
    entryState = "WAIT";
  } else if (conf === "INVALIDATED" || beyondInvalidation) {
    entryState = "INVALIDATED";
  } else if (conf === "CONFIRMED" && (tooExtended || tooStale || rrTooLow)) {
    entryState = "MISSED";
  } else if (conf === "CONFIRMED") {
    entryState = "ENTER_NOW";
  } else if (expired && setupState !== "READY") {
    entryState = "EXPIRED";
  } else if (conf === "AT_ZONE" || (conf === "NONE" && inZone)) {
    entryState = "ARMED";
  } else if (
    entryType === "LIMIT" &&
    isNum(distanceToEntry) &&
    distanceToEntry > 0 &&
    distanceToEntry <= atr * tune.pullbackBandAtr
  ) {
    // Valid-direction setup, price on the approach side of the zone within a
    // sensible band ⇒ rest a limit into the zone instead of chasing at market.
    entryState = "ENTER_ON_PULLBACK";
  } else if (isNum(distanceToEntry) && distanceToEntry > 0 && distanceToEntry <= atr * tune.approachAtr) {
    entryState = "APPROACHING";
  } else {
    entryState = "WAIT";
  }

  // ── Entry Quality (scores the CURRENT entry, not the setup) ─────────────
  // "Chasing" (extension past the zone in the profit direction) only counts
  // AFTER confirmation. Before confirmation, price sitting past the zone simply
  // means price hasn't pulled back yet → that's DISTANCE (too early), not chase.
  const chasing = conf === "CONFIRMED" && isNum(extension) && extension > 0;
  const factors: EntryQualityFactor[] = [];
  let q = 100;
  const penalise = (label: string, delta: number, note: string) => {
    if (delta === 0) return;
    q += delta;
    factors.push({ label, delta, note });
  };

  // 1. Extension past the zone (chasing) — the biggest killer of good entries.
  if (chasing) {
    const ratio = (extension as number) / maxChase; // 0..1 within tolerance, >1 = missed
    penalise("Extension", -Math.round(clamp(ratio, 0, 1.5) * 45), `${Math.round((extension as number) / pip)} pips past the zone`);
  } else if (inZone) {
    penalise("In zone", +4, "price is inside the preferred entry window");
  }
  // 2. Distance still to travel (too early ⇒ not a good entry *right now*).
  if (isNum(distanceToEntry) && distanceToEntry > 0 && !inZone && !chasing) {
    const ratio = distanceToEntry / (atr * Math.max(tune.approachAtr, 0.5));
    penalise("Distance", -Math.round(clamp(ratio, 0, 3) * 15), `${Math.round(distanceToEntry / pip)} pips from the zone`);
  }
  // 3. Remaining reward:risk.
  if (isNum(remainingRR)) {
    if (remainingRR < tune.minRemainingRR)
      penalise("Reward left", -Math.round(clamp((tune.minRemainingRR - remainingRR) * 20, 0, 30)), `only ${remainingRR}R left to TP1`);
    else if (remainingRR >= 2) penalise("Reward left", +5, `${remainingRR}R left to TP1`);
  }
  // 4. Staleness since confirmation.
  if (isNum(minsSinceConfirm) && minsSinceConfirm > 0) {
    const over = minsSinceConfirm - tune.maxMinutesSinceConfirm * 0.4;
    if (over > 0) penalise("Freshness", -Math.round(clamp(over / (tune.maxMinutesSinceConfirm * 0.6), 0, 1) * 25), `${Math.round(minsSinceConfirm)} min since confirmation`);
  }
  // 5. Spread (only when broker-connected).
  if (isNum(inp.spread) && isNum(invalidation) && isNum(effEntry)) {
    const risk = Math.abs(effEntry - invalidation);
    if (risk > 0) {
      const spreadRatio = inp.spread / risk;
      if (spreadRatio > 0.08) penalise("Spread", -Math.round(clamp(spreadRatio * 60, 0, 20)), `spread is ${Math.round(inp.spread / pip)} pips`);
    }
  }
  const entryQuality = Math.round(clamp(q, 0, 100));

  // ── Meter position (0 = too early, 0.5 = ideal, 1 = missed) ─────────────
  let meter = 0.5;
  let meterBand: EntryDecision["meterBand"] = "ideal";
  if (entryState === "MISSED" || entryState === "INVALIDATED" || entryState === "EXPIRED") {
    meter = 1; meterBand = "missed";
  } else if (chasing) {
    const r = clamp((extension as number) / maxChase, 0, 1);
    meter = 0.5 + r * 0.5;
    meterBand = r < 0.5 ? "acceptable" : "getting_late";
  } else if (inZone) {
    meter = 0.5; meterBand = "ideal";
  } else if (isNum(distanceToEntry) && distanceToEntry > 0) {
    const r = clamp(distanceToEntry / (atr * Math.max(tune.approachAtr, 0.5)), 0, 1);
    meter = 0.5 - r * 0.5;
    meterBand = r < 0.5 ? "approaching" : "too_early";
  }

  // ── Headline + human detail ─────────────────────────────────────────────
  const dirWord = side === "buy" ? "BUY" : "SELL";
  const zoneTxt = isNum(entryMin) && isNum(entryMax) ? `${entryMin}–${entryMax}` : `${preferredEntry ?? "—"}`;
  let headline: string;
  let detail: string;
  let actionable = false;
  switch (entryState) {
    case "ENTER_NOW":
      headline = "ENTER NOW";
      actionable = true;
      detail = `Confirmation completed${isNum(minsSinceConfirm) ? ` ${Math.max(0, Math.round(minsSinceConfirm))} min ago` : ""}. Price is inside the approved ${dirWord} window (${zoneTxt}).`;
      break;
    case "ARMED":
      headline = "ARMED";
      detail = `Price has reached the ${zoneTxt} ${dirWord} zone. FLOW is watching for the ${inp.triggerTf} confirmation to close.`;
      break;
    case "ENTER_ON_PULLBACK":
      headline = "DO NOT CHASE";
      actionable = true; // actionable as a resting LIMIT order
      detail = `Setup is valid but price is ${distanceToEntryPips ?? "—"} pips above the zone. Rest a ${dirWord} LIMIT into ${zoneTxt} instead of chasing.`;
      break;
    case "APPROACHING":
      headline = "APPROACHING";
      detail = `${dirWord} setup valid — price is ${distanceToEntryPips ?? "—"} pips from the ${zoneTxt} zone.`;
      break;
    case "MISSED":
      headline = "ENTRY MISSED";
      detail = tooStale
        ? `Confirmation is ${Math.round(minsSinceConfirm ?? 0)} min old — too late to enter cleanly. Wait for a re-entry.`
        : rrTooLow
        ? `Reward:risk from here is only ${remainingRR}R. The good entry has passed — do not chase.`
        : `Price ran ${isNum(extension) ? Math.round(extension / pip) : "—"} pips past the max approved entry. Do not chase — wait for a re-entry.`;
      break;
    case "INVALIDATED":
      headline = "INVALIDATED";
      detail = `Price broke the invalidation at ${invalidation}. This ${dirWord} thesis is done.`;
      break;
    case "EXPIRED":
      headline = "WINDOW CLOSED";
      detail = `The actionable window for this setup has elapsed. FLOW will re-arm if it sets up again.`;
      break;
    default:
      headline = "WAIT";
      detail = isNum(distanceToEntryPips) && distanceToEntryPips > 0
        ? `Setup is valid but price is ${distanceToEntryPips} pips ${side === "buy" ? "above" : "below"} the preferred ${zoneTxt} entry.`
        : `Setup is developing — no clean entry yet.`;
  }

  const confirmationConditions = buildConfirmConditions(side, entryType, zoneTxt, invalidation, inp.triggerTf);

  return {
    setupState,
    entryState,
    entryType,
    edgeScore: Math.round(inp.edgeScore),
    entryQuality,
    entryQualityFactors: factors,
    direction,
    preferredEntry,
    entryMin,
    entryMax,
    currentPrice: round(price)!,
    distanceToEntryPips,
    maxChasePips,
    chaseRemainingPips,
    invalidation,
    remainingRR,
    entryActivatedAtMs: activatedAtMs,
    entryExpiresAtMs: expiresAtMs,
    confirmationTimeframe: inp.triggerTf,
    confirmationConditions,
    meter: +meter.toFixed(3),
    meterBand,
    actionable,
    headline,
    detail,
  };
}

function buildConfirmConditions(
  side: "buy" | "sell",
  entryType: EntryType,
  zoneTxt: string,
  invalidation: number | null,
  tf: string,
): string[] {
  const dir = side === "buy" ? "buy" : "sell";
  const react = side === "buy" ? "green" : "red";
  const out: string[] = [];
  if (entryType === "WAIT_FOR_BREAKOUT") out.push(`Price breaks the trigger level`);
  if (entryType === "WAIT_FOR_RECLAIM") out.push(`Liquidity sweep completes, then price reclaims the level`);
  out.push(`Price reaches the ${zoneTxt} ${dir} zone`);
  out.push(`A ${react} ${tf} candle CLOSES reacting off the zone (not just a wick)`);
  if (isNum(invalidation)) out.push(`Price holds ${side === "buy" ? "above" : "below"} the ${invalidation} invalidation`);
  return out;
}
