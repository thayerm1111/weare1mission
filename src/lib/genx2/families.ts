/**
 * GENX 2.0 — new deterministic setup families (gold-only), flag-gated by GENX2_FAMILIES.
 *
 * Pure functions over CLOSED candles. No RNG, no clock, no network — every number is
 * derived from the candles + ATR + spread that the caller passes, so each detector is
 * unit-testable in isolation. The engine (omEngine) supplies these and arbitrates the
 * winner; the LLM never touches any number here.
 *
 * Families:
 *   C  local-range rejection      — fade a defined local consolidation at its edge
 *   D  compression breakout        — a confirmed displacement out of a compression box
 *   E  breakout retest             — enter the hold/reclaim of a boundary that just broke
 *
 * Every candidate carries its OWN evidence, its structural stop, a reachable target, and
 * (for breakout/retest) a bounded validity. The 0.75 reward:risk floor is NOT enforced
 * here — it is enforced downstream at execution against the per-account executable price,
 * exactly as for the trend family. A candidate whose *structural* R:R is already below the
 * floor is dropped early so it never reaches execution.
 */

export type Candle = { t?: string | number; o: number; h: number; l: number; c: number };
export type Dir = "buy" | "sell";

export type FamilyCandidate = {
  family: "local_range_rejection" | "compression_breakout" | "breakout_retest";
  dir: Dir;
  strategy: string;             // human label
  entry: number;                // reference entry price
  stop: number;                 // structural stop (absolute)
  target: number;               // primary reachable target (absolute)
  orderType: "market" | "limit";
  invalidation: string;         // plain-language structural invalidation
  boundary: number;             // the range/breakout boundary this setup is tied to
  validityMs: number | null;    // bounded validity (breakout/retest); null = candle-driven like trend
  structureQ: number;           // 0..100 setup-structure quality (independent axis)
  directionalQ: number;         // 0..100 directional evidence (independent axis)
  executionQ: number;           // 0..100 execution quality (R:R + spread room)
  rr: number;                   // structural reward:risk (entry→target vs entry→stop)
  evidence: string[];           // why this qualified (for the narrative)
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const last = <T>(a: T[]): T | undefined => (a.length ? a[a.length - 1] : undefined);

/** Reward:risk from absolute levels for a side. Returns 0 when malformed/misordered. */
export function structuralRR(dir: Dir, entry: number, stop: number, target: number): number {
  if (![entry, stop, target].every((n) => Number.isFinite(n) && n > 0)) return 0;
  if (dir === "buy") { if (!(stop < entry && entry < target)) return 0; }
  else { if (!(target < entry && entry < stop)) return 0; }
  const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
  if (!(risk > 0)) return 0;
  return reward / risk;
}

/** Count separated touches of a level (within tol), each ≥ minGapBars apart, using wicks. */
function separatedTouches(cs: Candle[], level: number, tol: number, side: "hi" | "lo", minGapBars = 2): number {
  let count = 0, lastIdx = -minGapBars - 1;
  for (let i = 0; i < cs.length; i++) {
    const near = side === "hi" ? Math.abs(cs[i].h - level) <= tol : Math.abs(cs[i].l - level) <= tol;
    if (near && i - lastIdx >= minGapBars) { count += 1; lastIdx = i; }
  }
  return count;
}

/**
 * C — LOCAL-RANGE REJECTION. Requires: identifiable upper+lower boundaries, ≥2 separated
 * reactions at each, sufficient width vs spread/noise/stop/target, price near an edge, an
 * actual rejection or sweep-and-reclaim on the last CLOSED candle, a structural stop OUTSIDE
 * the range, and a reachable target (opposite boundary / internal structure). Stands down if
 * the range is breaking.
 */
export function detectLocalRange(
  cs: Candle[], atr: number, spread: number, rrFloor: number, window = 20,
): FamilyCandidate | null {
  if (cs.length < window + 2 || !(atr > 0)) return null;
  const w = cs.slice(-window - 1, -1);       // closed bars forming the range (exclude the deciding last bar)
  const decide = last(cs)!;                    // the most recent CLOSED bar decides the reaction
  const hi = Math.max(...w.map((c) => c.h)), lo = Math.min(...w.map((c) => c.l));
  const width = hi - lo;
  const tol = Math.max(atr * 0.25, spread * 2);
  const minWidth = Math.max(atr * 1.5, spread * 6);
  if (width < minWidth) return null;           // too tight vs noise/spread → not a tradeable range

  const touchHi = separatedTouches(w, hi, tol, "hi");
  const touchLo = separatedTouches(w, lo, tol, "lo");
  if (touchHi < 2 || touchLo < 2) return null; // need repeated separated reactions at BOTH edges

  // Stand down if the range is breaking: the deciding bar CLOSED beyond a boundary.
  if (decide.c > hi + tol || decide.c < lo - tol) return null;

  const eq = (hi + lo) / 2;
  const edge = Math.min(atr * 0.6, width * 0.3);
  const nearHi = decide.h >= hi - edge && decide.c <= hi;   // trading up into resistance
  const nearLo = decide.l <= lo + edge && decide.c >= lo;   // trading down into support
  if (!nearHi && !nearLo) return null;                       // must be AT an edge, not mid-range

  const dir: Dir = nearHi ? "sell" : "buy";
  // Confirmation: an actual rejection (wick beyond, close back inside) OR a sweep-and-reclaim.
  const rejectedHi = nearHi && decide.h > hi && decide.c < hi;
  const rejectedLo = nearLo && decide.l < lo && decide.c > lo;
  const bearBody = decide.c < decide.o, bullBody = decide.c > decide.o;
  const confirmed = dir === "sell" ? (rejectedHi || (decide.h >= hi - tol && bearBody)) : (rejectedLo || (decide.l <= lo + tol && bullBody));
  if (!confirmed) return null;

  const entry = decide.c;
  const stop = dir === "sell" ? hi + Math.max(atr * 0.4, spread * 2) : lo - Math.max(atr * 0.4, spread * 2);
  const target = dir === "sell" ? Math.max(eq, lo + width * 0.15) : Math.min(eq, hi - width * 0.15);
  const rr = structuralRR(dir, entry, stop, target);
  if (rr < rrFloor) return null;               // target must be reachable at the floor

  const structureQ = clamp(55 + (touchHi + touchLo - 4) * 4 + (rejectedHi || rejectedLo ? 8 : 0), 40, 88);
  const directionalQ = clamp(45 + (width / atr) * 3, 40, 70);   // ranges are not trend trades — capped
  const executionQ = clamp(50 + (rr - rrFloor) * 25 + Math.min(20, (width / Math.max(spread, atr * 0.05))), 40, 92);
  return {
    family: "local_range_rejection", dir,
    strategy: `Local range rejection (${dir === "sell" ? "fade high" : "fade low"})`,
    entry, stop, target, orderType: "market",
    invalidation: `15m close ${dir === "sell" ? "above" : "below"} the range ${dir === "sell" ? "high" : "low"} (${(dir === "sell" ? hi : lo).toFixed(2)})`,
    boundary: dir === "sell" ? hi : lo, validityMs: null,
    structureQ, directionalQ, executionQ, rr,
    evidence: [
      `range ${lo.toFixed(2)}–${hi.toFixed(2)} width ${(width / atr).toFixed(1)}×ATR`,
      `${touchHi}/${touchLo} separated reactions at high/low`,
      `${rejectedHi || rejectedLo ? "wick rejection" : "reaction"} at the ${dir === "sell" ? "high" : "low"}`,
    ],
  };
}

/**
 * D — COMPRESSION BREAKOUT. Requires: a compression box identified BEFORE the break, a
 * confirmed CLOSE beyond a boundary with a displacement + close-quality criterion, enough
 * clearance to the next opposing structure, a structural stop, a reachable target, and an
 * extension limit that refuses a chase. No ADX≥40 requirement; no volume.
 */
export function detectCompressionBreakout(
  cs: Candle[], atr: number, spread: number, rrFloor: number,
  nextResistance: number, nextSupport: number, window = 16, maxExtAtr = 1.2,
): FamilyCandidate | null {
  if (cs.length < window + 2 || !(atr > 0)) return null;
  const box = cs.slice(-window - 1, -1);       // the compression box (before the breakout bar)
  const decide = last(cs)!;
  const hi = Math.max(...box.map((c) => c.h)), lo = Math.min(...box.map((c) => c.l));
  const boxW = hi - lo;
  // Compression: the box must be NARROW relative to ATR (a real squeeze), else it's just range.
  if (!(boxW > 0) || boxW > atr * 2.2) return null;

  const range = decide.h - decide.l || atr * 0.1;
  const body = Math.abs(decide.c - decide.o);
  const closeQuality = body / range;                       // strong-body close, no volume needed
  const upBreak = decide.c > hi + Math.max(atr * 0.3, spread * 2);
  const dnBreak = decide.c < lo - Math.max(atr * 0.3, spread * 2);
  if (!upBreak && !dnBreak) return null;                    // need a CONFIRMED close beyond the box
  if (closeQuality < 0.5) return null;                      // displacement/close-quality gate

  const dir: Dir = upBreak ? "buy" : "sell";
  const boundary = upBreak ? hi : lo;
  // Extension limit: if price already ran > maxExt beyond the boundary, this is too far to
  // enter — the retest family (E) handles it instead.
  const ext = Math.abs(decide.c - boundary);
  if (ext > atr * maxExtAtr) return null;

  const opposing = dir === "buy" ? nextResistance : nextSupport;
  const clearance = Math.abs(opposing - decide.c);
  const stop = dir === "buy" ? boundary - Math.max(atr * 0.4, spread * 2) : boundary + Math.max(atr * 0.4, spread * 2);
  // Target: measured move (box height) projected, capped by the next opposing structure.
  const measured = dir === "buy" ? decide.c + boxW : decide.c - boxW;
  const target = dir === "buy"
    ? (Number.isFinite(opposing) && opposing > decide.c ? Math.min(measured, opposing - spread) : measured)
    : (Number.isFinite(opposing) && opposing < decide.c ? Math.max(measured, opposing + spread) : measured);
  const rr = structuralRR(dir, decide.c, stop, target);
  if (rr < rrFloor) return null;
  if (clearance < Math.abs(decide.c - stop)) return null;  // not enough room to the next structure

  const structureQ = clamp(60 + (atr * 2.2 - boxW) / atr * 10, 45, 86);
  const directionalQ = clamp(55 + closeQuality * 25 + (ext < atr * 0.6 ? 8 : 0), 45, 90);
  const executionQ = clamp(50 + (rr - rrFloor) * 22, 40, 90);
  return {
    family: "compression_breakout", dir,
    strategy: `Compression breakout (${dir === "buy" ? "long" : "short"})`,
    entry: decide.c, stop, target, orderType: "market",
    invalidation: `15m close back inside the box beyond ${boundary.toFixed(2)}`,
    boundary, validityMs: null,
    structureQ, directionalQ, executionQ, rr,
    evidence: [
      `compression box ${lo.toFixed(2)}–${hi.toFixed(2)} (${(boxW / atr).toFixed(2)}×ATR)`,
      `close ${(closeQuality * 100).toFixed(0)}% body beyond ${boundary.toFixed(2)}`,
      `extension ${(ext / atr).toFixed(2)}×ATR (≤ ${maxExtAtr})`,
    ],
  };
}

/**
 * E — BREAKOUT RETEST. When a breakout is too extended for an immediate entry, enter the
 * pullback to the broken boundary that HOLDS (or reclaims). Linked to the origin boundary,
 * bounded validity, invalidated when the boundary fails.
 */
export function detectBreakoutRetest(
  cs: Candle[], atr: number, spread: number, rrFloor: number,
  nextResistance: number, nextSupport: number, lookback = 10, validityBars = 8, barMs = 15 * 60 * 1000,
): FamilyCandidate | null {
  if (cs.length < lookback + 3 || !(atr > 0)) return null;
  const recent = cs.slice(-lookback - 1, -1);
  const decide = last(cs)!;
  const tol = Math.max(atr * 0.3, spread * 2);

  // Find the most recent bar that CLOSED beyond a prior local boundary (the breakout origin).
  const prior = cs.slice(-lookback - 6, -lookback - 1);
  if (prior.length < 3) return null;
  const priorHi = Math.max(...prior.map((c) => c.h)), priorLo = Math.min(...prior.map((c) => c.l));

  let brokeUp = false, brokeDn = false, boundary = NaN, brokeIdx = -1;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].c > priorHi + tol) { brokeUp = true; boundary = priorHi; brokeIdx = i; }
    if (recent[i].c < priorLo - tol) { brokeDn = true; boundary = priorLo; brokeIdx = i; }
  }
  if ((!brokeUp && !brokeDn) || brokeIdx < 0) return null;
  const barsSinceBreak = (recent.length - brokeIdx) + 1;
  if (barsSinceBreak > validityBars) return null;          // retest window expired

  const dir: Dir = brokeUp ? "buy" : "sell";
  // The deciding bar must be a RETEST that holds: pulled back to the boundary and closed
  // back in the breakout direction off it (a hold), not a failure.
  const retested = dir === "buy"
    ? (decide.l <= boundary + tol && decide.c > boundary && decide.c > decide.o)
    : (decide.h >= boundary - tol && decide.c < boundary && decide.c < decide.o);
  if (!retested) return null;
  // Invalidated if the boundary already failed on the close.
  if (dir === "buy" ? decide.c < boundary - tol : decide.c > boundary + tol) return null;

  const entry = decide.c;
  const stop = dir === "buy" ? boundary - Math.max(atr * 0.5, spread * 2) : boundary + Math.max(atr * 0.5, spread * 2);
  const opposing = dir === "buy" ? nextResistance : nextSupport;
  const measured = dir === "buy" ? entry + (priorHi - priorLo) : entry - (priorHi - priorLo);
  const target = dir === "buy"
    ? (Number.isFinite(opposing) && opposing > entry ? Math.min(measured, opposing - spread) : measured)
    : (Number.isFinite(opposing) && opposing < entry ? Math.max(measured, opposing + spread) : measured);
  const rr = structuralRR(dir, entry, stop, target);
  if (rr < rrFloor) return null;

  const structureQ = clamp(58 + (validityBars - barsSinceBreak) * 2, 45, 84);
  const directionalQ = clamp(60 + (Math.abs(decide.c - decide.o) / (decide.h - decide.l || atr * 0.1)) * 20, 45, 88);
  const executionQ = clamp(52 + (rr - rrFloor) * 22, 40, 90);
  return {
    family: "breakout_retest", dir,
    strategy: `Breakout retest (${dir === "buy" ? "long" : "short"})`,
    entry, stop, target, orderType: "market",
    invalidation: `15m close back through the retested boundary ${boundary.toFixed(2)}`,
    boundary, validityMs: validityBars * barMs,
    structureQ, directionalQ, executionQ, rr,
    evidence: [
      `broke ${dir === "buy" ? priorHi.toFixed(2) : priorLo.toFixed(2)} ${barsSinceBreak} bars ago`,
      `retest held at ${boundary.toFixed(2)}`,
      `validity ${validityBars} bars`,
    ],
  };
}

/** Composite score for arbitration — quality-weighted, correlated axes not double-counted. */
export function familyScore(c: FamilyCandidate): number {
  // structure 0.45, directional 0.25, execution 0.30 — directional deliberately light so a
  // range fade isn't punished for lacking trend, and a breakout isn't rewarded twice for it.
  return Math.round(c.structureQ * 0.45 + c.directionalQ * 0.25 + c.executionQ * 0.30);
}

/**
 * G — ARBITRATE competing family candidates into ONE coherent choice. Rules:
 *  • Never allow a range-fade and a breakout on the SAME boundary at once — a confirmed
 *    breakout beyond a boundary invalidates the fade at that boundary, so the fade is dropped.
 *  • Otherwise pick the highest composite score; tie-break on executable R:R then freshness
 *    (a bounded-validity family is fresher than an open-ended one).
 * Returns the winner or null.
 */
export function arbitrateFamilies(cands: (FamilyCandidate | null | undefined)[]): FamilyCandidate | null {
  const list = cands.filter((c): c is FamilyCandidate => !!c);
  if (!list.length) return null;
  const breakoutBoundaries = new Set(
    list.filter((c) => c.family !== "local_range_rejection").map((c) => `${c.dir}:${c.boundary.toFixed(2)}`),
  );
  // Drop a range fade whose boundary is simultaneously being broken (opposite dir at same level).
  const kept = list.filter((c) => {
    if (c.family !== "local_range_rejection") return true;
    const opp: Dir = c.dir === "buy" ? "sell" : "buy";
    return !breakoutBoundaries.has(`${opp}:${c.boundary.toFixed(2)}`);
  });
  const pool = kept.length ? kept : list;
  pool.sort((a, b) => {
    const s = familyScore(b) - familyScore(a);
    if (s !== 0) return s;
    if (b.rr !== a.rr) return b.rr - a.rr;
    return (a.validityMs ?? Infinity) - (b.validityMs ?? Infinity); // bounded validity = fresher
  });
  return pool[0] ?? null;
}
