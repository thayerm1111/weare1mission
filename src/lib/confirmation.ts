/**
 * Institutional confirmation gate — the shared heart of the redesigned engine.
 *
 * Philosophy (per the desk spec): REACT, never anticipate. A setup is only issued
 * after the market has PROVEN itself — the higher timeframes agree, structure has
 * broken in the trade's favour, price has pulled back and TURNED, the trigger
 * candle has CLOSED back in the trend direction, momentum has confirmed, and the
 * reward:risk clears an institutional floor. If any of those is false, the answer
 * is NO TRADE — "waiting for confirmation." We would rather miss a move than
 * anticipate one.
 *
 * Pure module (no I/O). Each engine maps its own analysis into `SetupInput` and
 * calls `evaluateSetup`. Hard gates first (any failure → NO_TRADE); only if all
 * pass do we compute the weighted quality score + grade, and only A+ / A release.
 *
 * `confirmationSignals(rows, dir)` derives the trigger/pullback/momentum reads
 * straight from a candle series, so all three engines feed the gate identically.
 */

export type Dir = "long" | "short";
export type Trend = "up" | "down" | "range";
export type Candle = { open: string; high: string; low: string; close: string; datetime?: string };

export type SetupInput = {
  direction: Dir;
  // Stage 2 — higher-timeframe bias. A list of the higher frames each engine has
  // (e.g. [1h, 4h] or [1h, 4h, daily]); ALL must agree and match the trade.
  htf: Trend[];
  htfLabel?: string;
  // Stage 3 — market structure.
  structure: {
    bosWithTrend: boolean;         // break of structure in the trade direction
    pullbackComplete: boolean;     // price pulled back and is NOT still moving into the level
    atInstitutionalLevel: boolean; // at OB / FVG / sweep / session level etc.
    score: number;                 // 0–100 structure quality
  };
  // Stage 5 — momentum.
  momentum: {
    turnedWithTrend: boolean;      // momentum has turned back in the trend direction
    strongAgainst: boolean;        // strong momentum AGAINST the trade (fading risk)
    score: number;                 // 0–100
  };
  // Stage 6 — the trigger candle (the reaction, not the anticipation).
  trigger: {
    closed: boolean;               // the trigger candle has fully CLOSED
    closedWithTrend: boolean;      // it closed back in the trend direction off the level
  };
  liquidityScore: number;          // Stage 4 — institutional confluence 0–100
  entry: number;
  stop: number;
  tps: number[];                   // first element is TP1
  sessionScore?: number;           // 0–100
  volatilityScore?: number;        // 0–100
  volumeScore?: number;            // 0–100 — volume expansion (accelerator weights this)
  trendStrength?: number;          // 0–100 — execution-frame trend strength (ADX / MA-slope)
  newsRisk?: boolean;              // imminent high-impact news → stand aside
  // Continuous-learning feedback: a bounded, penalty-only score deduction the
  // gate subtracts before grading, learned from buckets with proven-negative
  // expectancy. It can only ever TIGHTEN selectivity, never loosen it.
  scorePenalty?: number;           // 0..TOTAL_CAP
  penaltyReasons?: string[];
};

export type Grade = "A+" | "A" | "B" | "C" | "D";
export type Profile = "institutional" | "accelerator";

export type Decision = {
  decision: "TRADE" | "NO_TRADE";
  direction: Dir;
  grade: Grade | null;
  score: number;                   // weighted 0–100 QUALITY/confidence score (NOT a win probability)
  rr: number;
  reasons: string[];
  noTradeReason?: string;
  profile: Profile;                // which personality graded this setup
  momentumRating?: string;         // Strong / Moderate / Building
  trendRating?: string;            // Strong / Moderate / Weak
  penalty?: number;                // learned score penalty that was applied
  penaltyReasons?: string[];       // which buckets drove the penalty
};

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const RR_FLOOR = 2.5;

// ── Two personalities, one brain ─────────────────────────────────────────────
// The SAME hard gates that enforce "react, never anticipate" (trigger candle
// CLOSED with the trend, not fading strong momentum, momentum turned) apply to
// BOTH profiles — neither ever enters before confirmation. The profiles differ
// only in SELECTIVITY: institutional demands full HTF agreement, a completed
// pullback into an institutional level, and ≥2.5R, releasing only A+/A. The
// accelerator relaxes those context filters (majority HTF, breakout entries
// without a pullback, mid-structure momentum) and drops the floor to 1.8R,
// releasing anything scoring ≥75 — more opportunities, same discipline on entry.
type GateConfig = {
  rrFloor: number;
  releaseScore: number;            // minimum weighted score to release as a TRADE
  releaseGrades: Grade[] | null;   // if set, ALSO require this grade (institutional: A+/A)
  htf: "all" | "majority";         // HTF-agreement strictness
  requireBosWithTrend: boolean;    // hard-require a break of structure in the trade dir
  requirePullbackComplete: boolean;// hard-require the pullback has completed
  requireInstitutionalLevel: boolean; // hard-require an OB / FVG / sweep / S-R level
  usesVolume: boolean;
  rrCeil: number;                  // rr that maps to a full rr-score (scaling)
};

const PROFILES: Record<Profile, GateConfig> = {
  institutional: {
    rrFloor: 2.5, releaseScore: 80, releaseGrades: ["A+", "A"],
    htf: "all", requireBosWithTrend: true, requirePullbackComplete: true, requireInstitutionalLevel: true,
    usesVolume: false, rrCeil: 3.5,
  },
  accelerator: {
    rrFloor: 1.8, releaseScore: 75, releaseGrades: null,
    htf: "majority", requireBosWithTrend: false, requirePullbackComplete: false, requireInstitutionalLevel: false,
    usesVolume: true, rrCeil: 3.0,
  },
};

const ratingOf = (score: number): string => (score >= 75 ? "Strong" : score >= 50 ? "Moderate" : score >= 30 ? "Building" : "Weak");

export function rrToTp1(entry: number, stop: number, tps: number[]): number {
  const risk = Math.abs(entry - stop);
  const tp1 = tps.find((t) => Number.isFinite(t));
  if (!risk || tp1 == null) return 0;
  return +(Math.abs(tp1 - entry) / risk).toFixed(2);
}

// ── RSI (Wilder) on a close series, for the momentum reads ───────────────────
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

/**
 * Derive the confirmation reads from a candle series (oldest→newest, completed
 * candles only). The last candle IS the just-closed trigger candle.
 *
 * - closedWithTrend : the trigger candle closed in the trade direction.
 * - pullbackComplete: there was a pullback (an opposing candle) that the trigger
 *   candle has now reversed — i.e. price turned, it is not still moving into the
 *   level. This is the core "react, don't anticipate" read.
 * - momentumTurned  : RSI is turning back the trade's way and the trigger candle
 *   has a real body (not a doji).
 * - strongAgainst   : the last few candles show strong displacement AGAINST the
 *   trade — momentum we must not fade.
 */
export function confirmationSignals(
  rows: Candle[],
  dir: Dir,
): { closed: boolean; closedWithTrend: boolean; pullbackComplete: boolean; momentumTurned: boolean; strongAgainst: boolean; momentumScore: number } {
  const n = rows.length;
  if (n < 6) {
    return { closed: false, closedWithTrend: false, pullbackComplete: false, momentumTurned: false, strongAgainst: true, momentumScore: 0 };
  }
  const long = dir === "long";
  const c = rows.map((r) => +r.close);
  const o = rows.map((r) => +r.open);
  const h = rows.map((r) => +r.high);
  const l = rows.map((r) => +r.low);
  const last = n - 1;

  const bodyOf = (i: number) => Math.abs(c[i] - o[i]);
  const rangeOf = (i: number) => Math.max(h[i] - l[i], 1e-9);
  const withTrend = (i: number) => (long ? c[i] > o[i] : c[i] < o[i]);
  const against = (i: number) => (long ? c[i] < o[i] : c[i] > o[i]);

  // Trigger candle: last completed candle, closed in trend direction with a real body.
  const closed = true;
  const bodyPct = bodyOf(last) / rangeOf(last);
  const closedWithTrend = withTrend(last) && bodyPct >= 0.45;

  // Pullback complete: at least one of the two candles before the trigger pulled
  // back against the trend, and the trigger reclaimed it (turned the other way).
  const pulledBack = against(last - 1) || against(last - 2);
  const pullbackComplete = pulledBack && withTrend(last);

  // Momentum turned: RSI moving the trade's way over the last couple of bars.
  const r0 = rsi(c.slice(0, last + 1));
  const r1 = rsi(c.slice(0, last));
  const rsiTurning = r0 != null && r1 != null ? (long ? r0 > r1 : r0 < r1) : false;
  const momentumTurned = rsiTurning && bodyPct >= 0.4;

  // Strong momentum against: the last 3 candles net strongly against the trade
  // AND their bodies are big (a real move, not chop).
  const net3 = c[last] - c[last - 3];
  const avgBody = (bodyOf(last) + bodyOf(last - 1) + bodyOf(last - 2)) / 3;
  const avgRange = (rangeOf(last) + rangeOf(last - 1) + rangeOf(last - 2)) / 3;
  const strongAgainst =
    (long ? net3 < 0 : net3 > 0) && Math.abs(net3) > avgRange * 1.2 && avgBody / avgRange > 0.5;

  // Momentum score (0–100): RSI distance in the trade's favour + trigger body.
  const rsiScore = r0 == null ? 50 : long ? clamp((r0 - 40) * 2.5) : clamp((60 - r0) * 2.5);
  const momentumScore = Math.round(clamp(rsiScore * 0.6 + bodyPct * 100 * 0.4));

  return { closed, closedWithTrend, pullbackComplete, momentumTurned, strongAgainst, momentumScore };
}

/**
 * Evaluate a setup through the gate for a given PROFILE. Hard gates first (any
 * failure → NO_TRADE); then the weighted score + release rule decide whether the
 * setup is worth issuing. Institutional is strict (full HTF agreement, completed
 * pullback at an institutional level, ≥2.5R, A+/A only). Accelerator relaxes the
 * context filters and drops the floor to 1.8R, releasing anything scoring ≥75 —
 * but BOTH share the confirmation hard gates, so neither enters before the market
 * proves itself.
 */
export function evaluateSetup(input: SetupInput, profile: Profile = "institutional"): Decision {
  const cfg = PROFILES[profile];
  const { direction: dir, htf, structure, momentum, trigger } = input;
  const rr = rrToTp1(input.entry, input.stop, input.tps);
  const reasons: string[] = [];
  const no = (why: string, grade: Grade | null = null, score = 0): Decision => ({
    decision: "NO_TRADE", direction: dir, grade, score, rr, reasons: [], noTradeReason: why, profile,
  });

  // ── HARD GATES ─────────────────────────────────────────────────────────────
  // News + the three confirmation gates (trigger closed with trend, not fading
  // strong momentum, momentum turned) are enforced for BOTH profiles.

  if (input.newsRisk) return no("High-impact news imminent — standing aside.");

  // Higher-timeframe bias. Institutional: every frame must agree. Accelerator:
  // only reject if the MAJORITY of frames lean against the trade.
  const wantTrend: Trend = dir === "long" ? "up" : "down";
  const n = htf.length;
  const agree = htf.filter((t) => t === wantTrend).length;
  const against = htf.filter((t) => t !== wantTrend && t !== "range").length;
  if (cfg.htf === "all") {
    if (!(n > 0 && agree === n)) return no("Higher timeframes don't all agree with the trade — no clean bias.");
    reasons.push(`Higher timeframes${input.htfLabel ? ` (${input.htfLabel})` : ""} all ${wantTrend === "up" ? "bullish" : "bearish"} — with the trend.`);
  } else {
    if (n > 0 && against > n / 2) return no("Higher timeframes lean against the trade — standing aside.");
    reasons.push(`Higher-timeframe bias not against the trade (${agree}/${n} with).`);
  }

  // Market structure. Institutional hard-requires a BOS with the trend AND a
  // completed pullback at an institutional level. Accelerator allows a momentum
  // breakout to stand in for the BOS, and does not require a pullback or a
  // classic institutional level (breakouts / VWAP rejections live mid-structure).
  if (cfg.requireBosWithTrend) {
    if (!structure.bosWithTrend) return no("No break of structure in the trade direction yet.");
    reasons.push("Structure broke with the trend.");
  } else if (!structure.bosWithTrend && !(momentum.turnedWithTrend && trigger.closedWithTrend)) {
    return no("No structural break and no confirmed momentum breakout to justify entry.");
  }
  if (cfg.requirePullbackComplete && !structure.pullbackComplete) {
    return no("Pullback not complete — price is still moving into the level.");
  }
  if (cfg.requireInstitutionalLevel && !structure.atInstitutionalLevel) {
    return no("Price is mid-range — not at an institutional level.");
  }

  // Confirmation candle — HARD for both: never enter before the trigger closes
  // back in the trend direction.
  if (!trigger.closed) return no("Waiting for the trigger candle to close.");
  if (!trigger.closedWithTrend) return no("Trigger candle hasn't closed back in the trend direction — no confirmation.");
  reasons.push("Confirmation candle CLOSED back in the trend direction.");

  // Momentum — HARD for both: don't fade strong momentum, and require it to have
  // turned with the trade.
  if (momentum.strongAgainst) return no("Strong momentum against the trade — not fading it.");
  if (!momentum.turnedWithTrend) return no("Momentum hasn't turned with the trend yet.");
  reasons.push("Momentum is with the trend.");

  // Reward:risk floor (profile-specific).
  if (rr < cfg.rrFloor) return no(`Reward:risk ${rr} is below the ${cfg.rrFloor} floor.`);
  reasons.push(`Reward:risk ${rr}:1 clears the ${cfg.rrFloor} floor.`);

  // ── WEIGHTED SCORE ─────────────────────────────────────────────────────────
  const rrScore = clamp(((rr - cfg.rrFloor) / (cfg.rrCeil - cfg.rrFloor)) * 40 + 60);
  const session = clamp(input.sessionScore ?? 70);
  const volatility = clamp(input.volatilityScore ?? 70);
  const structureScore = clamp(structure.score);
  const liquidity = clamp(input.liquidityScore);
  const momentumScore = clamp(momentum.score);
  const trendScore = clamp(input.trendStrength ?? 75);
  const volume = clamp(input.volumeScore ?? 60);
  const htfRatio = n ? agree / n : 0.5;

  let score: number;
  if (profile === "institutional") {
    // Gate guarantees full trend + HTF agreement, so those weights are maxed.
    score = Math.round(
      100 * 0.20 + 100 * 0.15 +
      structureScore * 0.15 + liquidity * 0.15 + momentumScore * 0.10 +
      liquidity * 0.10 + rrScore * 0.05 + session * 0.05 + volatility * 0.05 + 100 * 0.05
    );
  } else {
    // Accelerator: momentum-heavy, real (not assumed) trend + HTF components.
    score = Math.round(
      trendScore * 0.20 + momentumScore * 0.20 + structureScore * 0.15 +
      liquidity * 0.10 + volume * 0.10 + htfRatio * 100 * 0.10 +
      session * 0.05 + volatility * 0.05 + rrScore * 0.05
    );
  }

  // Continuous-learning: subtract the learned, bounded penalty BEFORE grading, so
  // buckets with proven-negative expectancy simply raise the bar (penalty-only).
  const penalty = Math.max(0, Math.round(input.scorePenalty ?? 0));
  const penaltyReasons = penalty > 0 ? (input.penaltyReasons ?? []) : [];
  score = Math.max(0, score - penalty);

  const grade: Grade =
    score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : "D";
  const momentumRating = ratingOf(momentumScore);
  const trendRating = ratingOf(trendScore);

  const gradeOk = !cfg.releaseGrades || cfg.releaseGrades.includes(grade);
  if (score < cfg.releaseScore || !gradeOk) {
    const base = profile === "institutional"
      ? `Grade ${grade} (${score}/100) — not enough institutional confluence.`
      : `Confidence ${score}/100 is below the ${cfg.releaseScore} threshold — insufficient edge.`;
    return {
      decision: "NO_TRADE", direction: dir, grade, score, rr, reasons: [], profile, momentumRating, trendRating,
      penalty, penaltyReasons,
      noTradeReason: penalty > 0 ? `${base} (learned −${penalty} from ${penaltyReasons.join("; ") || "recent losses"})` : base,
    };
  }
  return { decision: "TRADE", direction: dir, grade, score, rr, reasons, profile, momentumRating, trendRating, penalty, penaltyReasons };
}
