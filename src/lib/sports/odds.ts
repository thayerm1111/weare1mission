/**
 * Odds math — pure, deterministic helpers. NOTHING here invents data. Every
 * function takes REAL priced odds as input and returns a derived number. If the
 * input is missing/invalid, functions return null so callers can render
 * "DATA UNAVAILABLE" rather than a fabricated figure.
 */

/** American odds -> implied probability (0..1). Includes the book's vig. */
export function americanToImplied(american: number | null | undefined): number | null {
  if (american == null || !Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

/** American odds -> decimal multiplier (total return per 1 unit staked). */
export function americanToDecimal(american: number | null | undefined): number | null {
  if (american == null || !Number.isFinite(american) || american === 0) return null;
  return american > 0 ? american / 100 + 1 : 100 / -american + 1;
}

/** Decimal odds -> American odds (rounded to the nearest integer). */
export function decimalToAmerican(decimal: number | null | undefined): number | null {
  if (decimal == null || !Number.isFinite(decimal) || decimal <= 1) return null;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

/**
 * Remove the vig from a two-way market to get fair (no-vig) probabilities.
 * Input: the two implied probabilities (each 0..1). Output: normalized pair or
 * null if either side is missing.
 */
export function noVig(pa: number | null, pb: number | null): { a: number; b: number } | null {
  if (pa == null || pb == null) return null;
  const sum = pa + pb;
  if (sum <= 0) return null;
  return { a: pa / sum, b: pb / sum };
}

/**
 * Edge in percentage POINTS: modelProb (0..1) minus the priced implied prob
 * (0..1), expressed as points (e.g. 0.55 vs 0.50 => +5.0). Returns null if
 * either input is missing — we never assert an edge without both numbers.
 */
export function edgePoints(modelProb: number | null, impliedProb: number | null): number | null {
  if (modelProb == null || impliedProb == null) return null;
  return (modelProb - impliedProb) * 100;
}

/** Combined American odds for a parlay from its legs' American prices. */
export function parlayAmerican(legs: Array<number | null | undefined>): number | null {
  const decimals: number[] = [];
  for (const l of legs) {
    const d = americanToDecimal(l ?? null);
    if (d == null) return null; // any missing leg -> no combined price (no fabrication)
    decimals.push(d);
  }
  if (!decimals.length) return null;
  const combined = decimals.reduce((acc, d) => acc * d, 1);
  return decimalToAmerican(combined);
}

/** Combined implied probability of an independent-leg parlay (product of legs). */
export function parlayImplied(legImplieds: Array<number | null | undefined>): number | null {
  let p = 1;
  for (const li of legImplieds) {
    if (li == null || !Number.isFinite(li)) return null;
    p *= li;
  }
  return p;
}

/** Profit (not total return) on a stake at American odds. null if unknown. */
export function profitOnStake(stake: number, american: number | null): number | null {
  const dec = americanToDecimal(american);
  if (dec == null || !Number.isFinite(stake)) return null;
  return stake * (dec - 1);
}

/**
 * Closing Line Value in percentage points: how much better the price you got
 * was vs the closing price, on an implied-probability basis. Positive = you
 * beat the close. null if either price is missing.
 */
export function clvPoints(placedAmerican: number | null, closingAmerican: number | null): number | null {
  const pPlaced = americanToImplied(placedAmerican);
  const pClose = americanToImplied(closingAmerican);
  if (pPlaced == null || pClose == null) return null;
  // Beating the close means your implied prob was LOWER than the closing implied prob.
  return (pClose - pPlaced) * 100;
}

/** Format American odds with an explicit sign, or a dash when unknown. */
export function fmtAmerican(american: number | null | undefined): string {
  if (american == null || !Number.isFinite(american)) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

export type Classification = "ELITE" | "STRONG" | "LEAN" | "PASS" | "NO BET";

/**
 * Classify an opportunity from its edge (points) and confidence (0..100).
 * Conservative by design — it is comfortable returning PASS / NO BET. If we
 * have no real edge number, it is NO BET (never a guess).
 */
export function classify(edgePts: number | null, confidence: number | null): Classification {
  if (edgePts == null || confidence == null) return "NO BET";
  if (edgePts >= 4 && confidence >= 75) return "ELITE";
  if (edgePts >= 2.5 && confidence >= 62) return "STRONG";
  if (edgePts >= 1 && confidence >= 52) return "LEAN";
  return "PASS";
}

export type DataQuality = "HIGH" | "MEDIUM" | "LOW";

/**
 * Blend a base confidence with the data-quality score. LOW data materially cuts
 * confidence (spec: uncertain pitcher/QB, GTD star, stale odds, missing lineup).
 */
export function applyDataQuality(baseConfidence: number, dq: DataQuality): number {
  const factor = dq === "HIGH" ? 1 : dq === "MEDIUM" ? 0.85 : 0.6;
  return Math.max(0, Math.min(100, Math.round(baseConfidence * factor)));
}
