/**
 * SETUP ORIGINATION — ATLAS decides whether there is a trade.
 *
 * This is the file that inverts the product. Before it, the member picked a side, a style and a stop and
 * the system graded the result; that is a trade ticket with an opinion attached. After it, ATLAS
 * watches gold, forms its own view, and either presents a complete trade — side, style, entry, stop,
 * objectives, reasoning, invalidation — or says, in words, that it is staying out.
 *
 * THREE RULES GOVERN EVERYTHING BELOW.
 *
 * 1. EVERY NUMBER COMES FROM THE SNAPSHOT. There is no model here, no sampling, no invented level. A
 *    stop is a real swing plus a real ATR pad; a target is a real level that exists in `snapshot.levels`.
 *    If the data needed for a leg of the argument is missing, that candidate is not produced at all —
 *    it is never filled in with a plausible-looking default.
 *
 * 2. SAYING NO IS A RESULT. A system that always has a trade is not a trader, it is a slot machine. The
 *    scoring floor here is set so that the ordinary middle of a range produces NO_SETUP, and the words
 *    it returns explain what would have to happen instead.
 *
 * 3. THE STYLE IS AN OUTPUT, NOT AN INPUT. Whether something is QUICK, INTRADAY or SWING is a property of
 *    the opportunity — which timeframes are carrying it — not a preference the member expresses. The
 *    member's profile may FORBID a style, and then that candidate is discarded rather than downgraded,
 *    because the same trade managed on the wrong clock is a different and worse trade.
 */
import type { Level, MarketSnapshot, Side, Timeframe } from "../core/types";
import { PIP } from "../core/types";
import { STYLE, STYLES, horizonForMove, shortfall, type Style } from "../core/style";
import { toPips } from "../core/instrument";
import type { Bias, SnapshotDiff } from "../brain/types";

/* ── the shape of a setup ───────────────────────────────────────────────── */

export type SetupState =
  | "blocked"              // something upstream means no trade may be considered at all
  | "no_setup"             // ATLAS has looked and does not want a trade here
  | "watching"             // a direction it likes, without a trade yet
  | "setup_developing"     // some of what it needs has happened
  | "waiting_for_trigger"  // everything but the entry trigger
  | "trade_ready"          // all conditions met; this is a complete, executable trade
  | "setup_invalidated"    // what it was waiting for can no longer happen
  | "setup_expired";       // it waited long enough that the opportunity is stale

export const SETUP_RANK: Record<SetupState, number> = {
  blocked: 0, no_setup: 0, setup_expired: 0, setup_invalidated: 0,
  watching: 1, setup_developing: 2, waiting_for_trigger: 3, trade_ready: 4,
};

/** One thing ATLAS needs to see. Every condition is a live boolean over the current snapshot. */
export type SetupCondition = {
  id: string;
  /** What the member reads: "Hold above 4382.30". */
  text: string;
  met: boolean;
  /** The measurement behind it, so a member can check it on their own chart. */
  detail: string;
  /** Only the trigger may be the last thing missing before TRADE READY. */
  trigger: boolean;
};

export type SetupStrategy =
  | "breakout_retest" | "sweep_reclaim" | "trend_pullback" | "momentum_continuation" | "range_edge";

export const STRATEGY_LABEL: Record<SetupStrategy, string> = {
  breakout_retest: "Breakout and retest",
  sweep_reclaim: "Sweep and reclaim",
  trend_pullback: "Pullback into trend",
  momentum_continuation: "Momentum continuation",
  range_edge: "Range edge rejection",
};

export type BrainSetup = {
  state: SetupState;
  side: Side | null;
  style: Style | null;
  strategy: SetupStrategy | null;
  /** Why THIS style and not another — the member should never have to guess. */
  styleWhy: string | null;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  initialObjective: number | null;
  extendedObjective: number | null;
  stopPips: number | null;
  expectedMovePips: [number, number] | null;
  conditions: SetupCondition[];
  metCount: number;
  totalCount: number;
  confidence: number;                 // 0–100, from the evidence, never from a model
  thesis: string | null;
  invalidation: string | null;
  invalidationPrice: number | null;
  /** When there is no trade: exactly what would have to happen for there to be one. */
  waitingFor: string[];
  /** ATLAS's own words about the current state. Read aloud unchanged. */
  say: string;
  /** Short headline for the button/strip. */
  headline: string;
  /** Set when a candidate was found but the member's profile forbids that style. */
  blockedBy: string | null;
  /** The setup stops being offerable after this. Null while there is nothing to expire. */
  expiresAt: number | null;
  at: number;
};

export const noSetup = (say: string, waitingFor: string[] = [], state: SetupState = "no_setup", at = Date.now()): BrainSetup => ({
  state, side: null, style: null, strategy: null, styleWhy: null,
  entryLow: null, entryHigh: null, stop: null, initialObjective: null, extendedObjective: null,
  stopPips: null, expectedMovePips: null, conditions: [], metCount: 0, totalCount: 0, confidence: 0,
  thesis: null, invalidation: null, invalidationPrice: null, waitingFor, say,
  headline: state === "blocked" ? "STANDING DOWN" : state === "watching" ? "NOT YET" : "NO TRADE",
  blockedBy: null, expiresAt: null, at,
});

/* ── what the member's profile allows ───────────────────────────────────── */

export type SetupProfile = {
  allowQuick: boolean;
  allowHold: boolean;
  allowSwing: boolean;
  /** The minimum confidence ATLAS must have before it is willing to present a trade at all. */
  minConfidence: number;
};

export const DEFAULT_SETUP_PROFILE: SetupProfile = {
  allowQuick: true, allowHold: true, allowSwing: true, minConfidence: 55,
};

export const allowsStyle = (p: SetupProfile, s: Style): boolean =>
  s === "quick" ? p.allowQuick : s === "hold" ? p.allowHold : p.allowSwing;

/* ── reading the snapshot ───────────────────────────────────────────────── */

const BULL = /^(strong_uptrend|uptrend|weak_uptrend|bullish_transition)$/;
const BEAR = /^(strong_downtrend|downtrend|weak_downtrend|bearish_transition)$/;

type TfView = NonNullable<MarketSnapshot["timeframes"][Timeframe]>;

const tf = (s: MarketSnapshot, t: Timeframe): TfView | null => s.timeframes[t] ?? null;

/** +1 bullish, -1 bearish, 0 neither. */
const lean = (v: TfView | null): number => (!v ? 0 : BULL.test(v.state) ? 1 : BEAR.test(v.state) ? -1 : 0);

const dirOf = (n: number): Side => (n > 0 ? "buy" : "sell");
const sign = (side: Side) => (side === "buy" ? 1 : -1);

/** The nearest level strictly ahead of price in the trade's direction. */
function levelAhead(s: MarketSnapshot, side: Side, beyond = 0): Level | null {
  const d = sign(side);
  const ahead = s.levels
    .filter((l) => d * (l.price - s.price) > beyond)
    .sort((a, b) => Math.abs(a.price - s.price) - Math.abs(b.price - s.price));
  return ahead[0] ?? null;
}

/** The nearest level at least `minDistance` in price away, in the trade's direction. */
function levelBeyond(s: MarketSnapshot, side: Side, minDistance: number): Level | null {
  const d = sign(side);
  return s.levels
    .filter((l) => d * (l.price - s.price) >= minDistance)
    .sort((a, b) => Math.abs(a.price - s.price) - Math.abs(b.price - s.price))[0] ?? null;
}

/** The nearest level behind price — where a stop has somewhere real to hide. */
function levelBehind(s: MarketSnapshot, side: Side): Level | null {
  const d = sign(side);
  const behind = s.levels
    .filter((l) => d * (l.price - s.price) < 0)
    .sort((a, b) => Math.abs(a.price - s.price) - Math.abs(b.price - s.price));
  return behind[0] ?? null;
}

/* ── style selection ────────────────────────────────────────────────────── */

export type StyleFit = { style: Style; score: number; why: string };

/** "a QUICK trade" / "an INTRADAY trade". Small thing; a system that gets it wrong reads like a machine. */
export const article = (label: string) => (/^[AEIOU]/.test(label) ? "an" : "a");

/**
 * Which clocks could this opportunity be traded on?
 *
 * Scored per style from that style's OWN decisive timeframes agreeing with the direction, its context
 * timeframes not contradicting it, and the movement characteristics that style depends on.
 *
 * THE TIMEFRAME THE CANDIDATE WAS FOUND ON IS A HARD CONSTRAINT, and learning that cost a session of
 * replay. Without it, a structural break found on the DAILY chart — whose nearest shelter was three
 * hundred pips away — was handed to INTRADAY, whose ceiling is a hundred and fifty, and the setup was
 * thrown away as "too wide" when what had actually happened was that a swing trade had been mislabelled.
 * A candidate may only be traded on a style that listens to the timeframe it was found on.
 */
export function styleFits(s: MarketSnapshot, side: Side, profile: SetupProfile, on: Timeframe): StyleFit[] {
  const d = side === "buy" ? 1 : -1;
  const fits: StyleFit[] = [];

  for (const style of STYLES) {
    if (!allowsStyle(profile, style)) continue;
    const pol = STYLE[style];
    const isDecisive = pol.decisive.includes(on);
    const isContext = pol.context.includes(on);
    if (!isDecisive && !isContext) continue;          // this style does not listen to that timeframe at all

    const decisive = pol.decisive.map((t) => tf(s, t)).filter(Boolean) as TfView[];
    // A style needs at least ONE of its own decisive timeframes to be readable. Requiring two looked
    // prudent and was not: when a single timeframe was briefly missing — which happens whenever a higher
    // timeframe has not accumulated enough bars yet — every style was excluded at once, and ATLAS
    // fell through to "nothing has set up cleanly", blaming the market for its own blind spot. Missing
    // data is now a PENALTY that is said out loud, never a silent veto.
    if (!decisive.length) continue;
    const missing = pol.decisive.length - decisive.length;

    const agreeing = decisive.filter((v) => lean(v) === d).length;
    const opposing = decisive.filter((v) => lean(v) === -d).length;
    if (opposing > agreeing) continue;                 // its own clock disagrees

    const context = pol.context.map((t) => tf(s, t)).filter(Boolean) as TfView[];
    const contextAgainst = context.filter((v) => lean(v) === -d).length;

    let score = 30 + agreeing * 22 - opposing * 25 - contextAgainst * 12;
    score += isDecisive ? 18 : -10;                    // the argument belongs on this clock, or merely near it
    score -= missing * 9;                              // judging a style half-blind is worth less

    const lead = decisive[0];
    if (style === "quick") {
      // A quick trade needs the market to be MOVING. Expansion and velocity are the whole premise.
      if (lead.features.rangeExpansion >= 1.3) score += 16;
      if (lead.features.volRatio >= 1.05) score += 8;
      if (Math.abs(lead.features.velocity) >= 0.5) score += 8;
      if (lead.features.volRatio < 0.8) score -= 22;
    }
    if (style === "hold") {
      if (s.minutesIntoSession >= 45) score += 10;
      if (lead.features.efficiency >= 0.3) score += 10;
      if (s.session === "closed") score -= 30;
    }
    if (style === "swing") {
      const daily = tf(s, "1d");
      const h4 = tf(s, "4h");
      if (daily && lean(daily) === d) score += 18;
      if (h4 && lean(h4) === d) score += 12;
      if (lead.features.slopeR2 >= 0.5) score += 8;
      if (!daily && !h4) score -= 30;
    }

    const names = pol.decisive.filter((t) => lean(tf(s, t)) === d);
    const why =
      style === "quick"
        ? `This is momentum on the ${names.join(" and ") || "short"} timeframes, and it is expanding. It should either go quickly or prove itself wrong quickly.`
        : style === "hold"
        ? `The ${names.join(" and ") || "session"} structure is carrying this inside today's session, so it needs room for ordinary pullbacks.`
        : `The ${names.join(", ") || "higher"} timeframes are carrying this, so five-minute noise is not allowed to end it.`;

    const blind = pol.decisive.filter((t) => !tf(s, t));
    const whyFull = blind.length
      ? `${why} I can't read the ${blind.join(" or ")} chart right now, so I'm judging this on what I can see.`
      : why;
    if (score > 0) fits.push({ style, score, why: whyFull });
  }

  return fits.sort((a, b) => b.score - a.score);
}

/** The single best clock for this opportunity, or null when none of them fit. */
export const styleFit = (s: MarketSnapshot, side: Side, profile: SetupProfile, on: Timeframe = "5m"): StyleFit | null =>
  styleFits(s, side, profile, on)[0] ?? null;

/* ── candidates ─────────────────────────────────────────────────────────── */

export type Candidate = {
  strategy: SetupStrategy;
  side: Side;
  /** The price the whole trade is built on — the level that must hold. */
  pivot: number;
  /** Structural low (for a long) / high (for a short) the stop hides behind. */
  shelter: number;
  /** Price that must be traded through for the setup to trigger. Null = already triggered. */
  trigger: number | null;
  atr: number;
  score: number;
  reason: string;
  /** The timeframe this argument was made on. */
  on: Timeframe;
};

/**
 * Every strategy ATLAS knows, evaluated against one timeframe.
 *
 * Each returns a candidate only when the evidence for it genuinely exists on that timeframe. A missing
 * swing, a missing range or an absent break means no candidate — never a candidate with a guessed number.
 */
export function candidatesOn(s: MarketSnapshot, t: Timeframe): Candidate[] {
  const v = tf(s, t);
  if (!v) return [];
  const out: Candidate[] = [];
  const { structure: st, features: f } = v;
  const atr = f.atr;
  if (!(atr > 0)) return [];
  const price = s.price;
  const net = s.pressure.net;

  /* 1 — BREAKOUT AND RETEST. Structure broke, the break has not failed, and price is holding beyond it.
         The level that broke is the pivot: it is what the whole trade depends on. */
  if (st.brokeStructure && !st.failedBreak) {
    const up = st.brokeStructure === "up";
    const side: Side = up ? "buy" : "sell";
    const pivot = up ? st.swingHigh : st.swingLow;
    const shelter = up ? st.swingLow : st.swingHigh;
    const holding = pivot != null && (up ? price > pivot : price < pivot);
    if (pivot != null && shelter != null && holding) {
      const aligned = up ? net > 0 : net < 0;
      let score = 44;
      if (f.rangeExpansion >= 1.4) score += 12;
      if (aligned) score += Math.min(16, Math.abs(net) / 3);
      if (Math.abs(price - pivot) > atr * 2.2) score -= 20;             // too far from the level to be a retest
      out.push({
        strategy: "breakout_retest", side, pivot, shelter, trigger: null, atr, score, on: t,
        reason: `${t} structure broke ${up ? "up" : "down"} through ${pivot.toFixed(2)} and price is holding ${up ? "above" : "below"} it`,
      });
    }
  }

  /* 2 — SWEEP AND RECLAIM. A level was taken and immediately given back. The direction is AGAINST the
         sweep, which is the whole point: the move that took the liquidity failed. */
  if (st.sweptLevel != null && st.reclaimed) {
    const sweptHigh = st.swingHigh != null && Math.abs(st.sweptLevel - st.swingHigh) < 1e-9;
    const side: Side = sweptHigh ? "sell" : "buy";
    const shelter = sweptHigh
      ? Math.max(st.sweptLevel, price) + atr * 0.15
      : Math.min(st.sweptLevel, price) - atr * 0.15;
    const aligned = side === "buy" ? net > -10 : net < 10;
    let score = 42;
    if (aligned) score += 12;
    if (f.wickBias !== 0 && ((side === "buy" && f.wickBias < 0) || (side === "sell" && f.wickBias > 0))) score += 8;
    out.push({
      strategy: "sweep_reclaim", side, pivot: st.sweptLevel, shelter, trigger: null, atr, score, on: t,
      reason: `${t} swept ${st.sweptLevel.toFixed(2)} and closed back ${sweptHigh ? "below" : "above"} it — that move failed`,
    });
  }

  /* 3 — MOMENTUM CONTINUATION. A genuine trend, efficient, with pressure behind it, not yet stretched.
         The stop hides behind the last swing in the direction of travel. */
  const trending = f.slopeR2 >= 0.55 && f.efficiency >= 0.38;
  if (trending && Math.abs(f.slope) >= 1) {
    const up = f.slope > 0;
    const side: Side = up ? "buy" : "sell";
    const shelter = up ? st.swingLow : st.swingHigh;
    const stretched = Math.abs(f.zScore) >= 2.2;
    if (shelter != null && !stretched) {
      const aligned = up ? net > 10 : net < -10;
      let score = 38;
      if (aligned) score += 14;
      if (f.efficiency >= 0.55) score += 10;
      if ((up && f.rsi > 74) || (!up && f.rsi < 26)) score -= 16;        // buying the top of the push
      out.push({
        strategy: "momentum_continuation", side, pivot: shelter, shelter, trigger: null, atr, score, on: t,
        reason: `${t} is in an efficient ${up ? "up" : "down"}trend and ${up ? "buyers" : "sellers"} still have the pressure`,
      });
    }
  }

  /* 4 — PULLBACK INTO TREND. The sequence still says trend, but momentum has come back against it and
         RSI has unwound. This one WAITS: the trigger is a reclaim, not the pullback itself. */
  if ((st.sequence === "HH_HL" || st.sequence === "LH_LL") && st.swingHigh != null && st.swingLow != null) {
    const up = st.sequence === "HH_HL";
    const side: Side = up ? "buy" : "sell";
    const pulling = up ? f.returns5 < 0 : f.returns5 > 0;
    const unwound = up ? f.rsi >= 36 && f.rsi <= 58 : f.rsi <= 64 && f.rsi >= 42;
    const shelter = up ? st.swingLow : st.swingHigh;
    const trigger = up ? st.swingHigh : st.swingLow;
    if (pulling && unwound && trigger != null) {
      let score = 36;
      if (f.slopeR2 >= 0.45) score += 10;
      if (Math.abs(price - shelter) < atr * 3) score += 8;                // the stop is a sensible distance away
      out.push({
        strategy: "trend_pullback", side, pivot: shelter, shelter, trigger, atr, score, on: t,
        reason: `${t} is still making ${up ? "higher lows" : "lower highs"} and this pullback has unwound momentum without breaking it`,
      });
    }
  }

  /* 5 — RANGE EDGE. Only inside an actual range, only at its extreme, and only back INTO the range.
         Deliberately the lowest-scoring family: fading an edge is right until the day it breaks. */
  const ranging = /sideways_range|tight_range|compression|volatility_squeeze/.test(s.regime);
  if (ranging && st.rangeHigh != null && st.rangeLow != null && st.positionInRange != null) {
    const width = st.rangeHigh - st.rangeLow;
    if (width > atr * 1.5) {
      const atLow = st.positionInRange <= 0.14;
      const atHigh = st.positionInRange >= 0.86;
      if (atLow || atHigh) {
        const side: Side = atLow ? "buy" : "sell";
        const shelter = atLow ? st.rangeLow - atr * 0.35 : st.rangeHigh + atr * 0.35;
        let score = 30;
        if (atLow ? net > -20 : net < 20) score += 8;
        out.push({
          strategy: "range_edge", side, pivot: atLow ? st.rangeLow : st.rangeHigh, shelter, trigger: null, atr, score, on: t,
          reason: `price is at the ${atLow ? "bottom" : "top"} of a ${Math.round(width / PIP)}-pip ${t} range and the range is still intact`,
        });
      }
    }
  }

  return out;
}

/* ── conditions ─────────────────────────────────────────────────────────── */

function conditionsFor(s: MarketSnapshot, c: Candidate, style: Style): SetupCondition[] {
  const up = c.side === "buy";
  const d = sign(c.side);
  const v = tf(s, c.on);
  const price = s.price;
  const out: SetupCondition[] = [];

  // 1 — the level this trade is built on must be holding.
  const holding = up ? price > c.pivot : price < c.pivot;
  out.push({
    id: "pivot",
    text: `${up ? "Hold above" : "Hold below"} ${c.pivot.toFixed(2)}`,
    met: holding,
    detail: holding
      ? `Gold is ${Math.abs(toPips(price - c.pivot, PIP)).toFixed(0)} pips ${up ? "above" : "below"} it.`
      : `Gold is ${Math.abs(toPips(price - c.pivot, PIP)).toFixed(0)} pips the wrong side of it.`,
    trigger: false,
  });

  // 2 — the side we are trading must actually have the pressure.
  const need = style === "swing" ? 54 : 58;
  const ours = up ? s.pressure.bullish : s.pressure.bearish;
  out.push({
    id: "pressure",
    text: `${up ? "Buyers" : "Sellers"} holding pressure above ${need}`,
    met: ours >= need,
    detail: `${up ? "Buyers" : "Sellers"} are at ${Math.round(ours)}.`,
    trigger: false,
  });

  // 3 — the strategy's own extra requirement.
  if (c.strategy === "breakout_retest") {
    const expanding = (v?.features.rangeExpansion ?? 0) >= 1.2;
    out.push({
      id: "expansion",
      text: `The break keeps expanding on ${c.on}`,
      met: expanding,
      detail: `${c.on} range expansion is ${(v?.features.rangeExpansion ?? 0).toFixed(2)}×.`,
      trigger: false,
    });
  }
  if (c.strategy === "momentum_continuation") {
    const eff = v?.features.efficiency ?? 0;
    out.push({
      id: "efficiency",
      text: `The move stays efficient on ${c.on}`,
      met: eff >= 0.38,
      detail: `${c.on} efficiency is ${eff.toFixed(2)}.`,
      trigger: false,
    });
  }
  if (c.strategy === "sweep_reclaim") {
    const back = up ? price > c.pivot : price < c.pivot;
    out.push({
      id: "reclaim",
      text: `The reclaim of ${c.pivot.toFixed(2)} holds`,
      met: back,
      detail: back ? "Price is back inside and staying there." : "Price has slipped back through it.",
      trigger: false,
    });
  }
  if (c.strategy === "range_edge") {
    const pir = v?.structure.positionInRange ?? 0.5;
    out.push({
      id: "edge",
      text: `Price stays at the ${up ? "bottom" : "top"} of the range`,
      met: up ? pir <= 0.2 : pir >= 0.8,
      detail: `It is ${Math.round(pir * 100)}% of the way up the range.`,
      trigger: false,
    });
  }

  // 4 — the trigger. This is what turns WAITING into READY, and it is always last.
  if (c.trigger != null) {
    const fired = up ? price > c.trigger : price < c.trigger;
    out.push({
      id: "trigger",
      text: `${up ? "Break" : "Break"} ${c.trigger.toFixed(2)}`,
      met: fired,
      detail: fired
        ? "It has gone through."
        : `${Math.abs(toPips(price - c.trigger, PIP)).toFixed(0)} pips away.`,
      trigger: true,
    });
  } else {
    // Already at the level: the trigger is that price has not run away from the entry.
    const stretch = Math.abs(price - c.pivot) / Math.max(c.atr, 1e-9);
    out.push({
      id: "trigger",
      text: "Entry is still close to the level",
      met: stretch <= 1.8,
      detail: stretch <= 1.8
        ? `Price is ${stretch.toFixed(1)} ATR from the level.`
        : `Price is already ${stretch.toFixed(1)} ATR past it — too extended to enter here.`,
      trigger: true,
    });
  }

  void d;
  return out;
}

/* ── the setup ──────────────────────────────────────────────────────────── */

/** Owner 09-21: ATLAS takes a setup it likes as long as reward:risk from the live price is at least this. */
export const ATLAS_MIN_TAKE_RR = 0.8;

export type FindSetupInput = {
  snapshot: MarketSnapshot | null;
  diffs?: SnapshotDiff[];
  profile?: SetupProfile;
  marketOpen?: boolean;
  /** The broker's real pip size when an account is connected; gold's 0.1 otherwise. */
  pipSize?: number;
  /**
   * ATLAS's own open market thesis, when it has one.
   *
   * Used as hysteresis, not as a veto. ATLAS already refuses to flip its market read more than once
   * every eight minutes; without feeding that back in here, the SETUP could flip from long to short in
   * two, and a member would watch it contradict itself on the same screen. A setup that argues against
   * the standing thesis is still allowed — a sweep and reclaim is exactly that — but it has to be more
   * convincing, and it has to say that it is going against the house view.
   */
  thesisBias?: Bias | null;
  thesisConfidence?: number | null;
  now?: number;
};

const BIAS_SIDE: Partial<Record<Bias, Side>> = {
  bullish_continuation: "buy", bullish_reversal: "buy",
  bearish_continuation: "sell", bearish_reversal: "sell",
};

/**
 * Look at gold and decide whether there is a trade.
 *
 * Pure: the same snapshot always produces the same answer, which is what makes the replay harness able to
 * prove what ATLAS would have said at any moment of a recorded session.
 */
export function findSetup(i: FindSetupInput): BrainSetup {
  const now = i.now ?? Date.now();
  const s = i.snapshot;
  const profile = i.profile ?? DEFAULT_SETUP_PROFILE;
  const pipSize = i.pipSize ?? PIP;

  if (!s) return noSetup("I can't see gold right now, so I'm not looking for a trade.", [], "blocked", now);
  if (i.marketOpen === false) return noSetup("Gold is closed. I'll start looking again when it reopens.", [], "blocked", now);
  if (s.blockers.length) return noSetup(`I'm standing down: ${s.blockers[0].detail}`, [], "blocked", now);
  if (!profile.allowQuick && !profile.allowHold && !profile.allowSwing) {
    return noSetup("Every trade style is switched off in your profile, so I have nothing I'm allowed to take.", [], "blocked", now);
  }

  /* 1 — gather every candidate across every timeframe. */
  const all: Candidate[] = [];
  for (const t of ["1m", "5m", "15m", "1h", "4h", "1d"] as Timeframe[]) all.push(...candidatesOn(s, t));
  if (!all.length) return standingAside(s, profile, now);
  all.sort((a, b) => b.score - a.score);

  /*
   * 2 — PRICE EVERY CANDIDATE ON EVERY CLOCK IT COULD BE TRADED ON, and keep the ones that survive.
   *
   * Two rounds of replaying a real session shaped this loop, and both lessons are worth keeping written
   * down because both were invisible in synthetic fixtures:
   *
   *   • The first version took the first candidate whose style was allowed and, if its stop did not fit,
   *     declared there was no trade in the market at all. One daily-scale break silenced ATLAS for a
   *     whole session while four other candidates sat unexamined.
   *
   *   • The second version aimed at the nearest level ahead, and so offered a trade risking 107 pips to
   *     make 28 — with ninety confidence. Being right about direction does not rescue that arithmetic.
   *
   * So a candidate is never rejected on behalf of the whole market: it is rejected FOR THAT PAIRING, the
   * reason is kept, and the next pairing is tried. Only when nothing at all survives does ATLAS speak,
   * and then it says the most specific true thing it found rather than a generic refusal.
   */
  const viable: Priced[] = [];
  const nearMisses: NearMiss[] = [];
  let blockedBy: string | null = null;

  for (const c of all.slice(0, 8)) {
    const allowed = styleFits(s, c.side, profile, c.on);
    if (!allowed.length && !blockedBy) {
      const anywhere = styleFits(s, c.side, DEFAULT_SETUP_PROFILE, c.on)[0];
      if (anywhere && !allowsStyle(profile, anywhere.style)) {
        const lab = STYLE[anywhere.style].label;
        blockedBy = `I see ${article(lab)} ${lab} setup here, but ${lab} trades are switched off in your profile.`;
      }
    }
    for (const fit of allowed) {
      const priced = priceTheTrade(s, c, fit, pipSize);
      if (priced.ok) viable.push(priced);
      else nearMisses.push(priced);
    }
  }

  if (!viable.length) {
    nearMisses.sort((a, b) => b.rank - a.rank);
    const best = nearMisses[0];
    const out = best ? noSetup(best.why, best.waiting, "watching", now) : standingAside(s, profile, now);
    if (blockedBy) {
      out.blockedBy = blockedBy;
      if (!best) out.say = blockedBy;
    }
    return out;
  }

  viable.sort((a, b) => b.rank - a.rank);
  const p = viable[0];
  const { c, fit, stop, stopPips, initialObjective, extendedObjective, toInitial, toExtended, rToInitial } = p;
  const pol = STYLE[fit.style];
  const up = c.side === "buy";

  /* 3 — conditions, and the state that follows from them. */
  const conditions = conditionsFor(s, c, fit.style);
  /*
   * TAKE IT AT 0.8:1 (owner 09-21: "ATLAS's analysis is almost perfect. The problem is it's not taking any
   * trades. If its analysis is there and it likes the trade and it sees the setup, take the trade in the
   * direction it sees — it just has to be at least a .8 to 1").
   *
   * The only trigger this relaxes is "Entry is still close to the level" — the rule that refused a setup
   * once price had moved more than 1.8 ATR from the level, however good the trade still was from here.
   * Every other condition still has to hold, a "Break X" trigger still has to break, the confidence floor
   * and the counter-thesis bar still apply, and the stop is still the structural one priced from the
   * live price. What replaces the distance rule is the arithmetic that actually matters: reward to the
   * first objective over risk to the stop, from the price it would fill at, must be at least 0.8:1.
   */
  if (c.trigger == null) {
    const ext = conditions.find((x) => x.id === "trigger" && x.trigger);
    if (ext && !ext.met && rToInitial >= ATLAS_MIN_TAKE_RR) {
      ext.met = true;
      ext.text = "Reward:risk from here is at least 0.8:1";
      ext.detail = `Price has moved away from the level, but from ${s.price.toFixed(2)} it is ${rToInitial.toFixed(1)}:1 to the first objective — good enough to take.`;
    }
  }
  const metCount = conditions.filter((x) => x.met).length;
  const totalCount = conditions.length;
  const nonTrigger = conditions.filter((x) => !x.trigger);
  const nonTriggerMet = nonTrigger.filter((x) => x.met).length;
  const triggerMet = conditions.filter((x) => x.trigger).every((x) => x.met);

  /* 4 — confidence, from evidence and from reward. Never from a model. */
  let confidence = Math.round(Math.min(94, c.score + fit.score * 0.22 + metCount * 6));
  if (s.warnings.length) confidence -= 4;
  if (s.news.nextEvent && (s.news.minutesToNext ?? 999) <= 20) confidence -= 10;
  if (rToInitial < 1.2) confidence -= 14;
  else if (rToInitial >= 2) confidence += 6;
  confidence = Math.max(0, Math.min(94, confidence));

  const invalidationPrice = c.pivot;
  const invalidation = `${up ? "A close back below" : "A close back above"} ${invalidationPrice.toFixed(2)} with ${up ? "bearish" : "bullish"} pressure expanding.`;

  let state: SetupState;
  if (nonTriggerMet === nonTrigger.length && triggerMet) state = "trade_ready";
  else if (nonTriggerMet === nonTrigger.length) state = "waiting_for_trigger";
  else if (nonTriggerMet >= Math.ceil(nonTrigger.length / 2)) state = "setup_developing";
  else state = "watching";

  // A trade ATLAS is not confident enough about is never presented as ready. It stays a watch.
  if (state === "trade_ready" && confidence < profile.minConfidence) state = "waiting_for_trigger";

  /*
   * Hysteresis against ATLAS's own standing market thesis.
   *
   * The thesis engine will not flip its read more than once every eight minutes, on purpose. If the setup
   * engine ignored that, a member could watch ATLAS THESIS say "bullish continuation" while the trade
   * card underneath it offered a SELL — the two halves of the same mind disagreeing on one screen. A
   * counter-thesis setup is still allowed, because a sweep and reclaim IS a counter-thesis trade; it just
   * has to clear a higher bar and say plainly that it is arguing with the house view.
   */
  const houseSide = i.thesisBias ? BIAS_SIDE[i.thesisBias] ?? null : null;
  const againstHouse = houseSide != null && houseSide !== c.side;
  let counterNote: string | null = null;
  if (againstHouse) {
    const houseConf = i.thesisConfidence ?? 50;
    const bar = Math.min(90, profile.minConfidence + 18 + Math.round(houseConf * 0.1));
    counterNote = `This argues against my current ${houseSide === "buy" ? "bullish" : "bearish"} read of the market, so I want more from it than usual.`;
    if (state === "trade_ready" && confidence < bar) state = "waiting_for_trigger";
  }

  const thesis = `${STRATEGY_LABEL[c.strategy]}. ${cap(c.reason)}. ${up ? "Buyers" : "Sellers"} are at ${Math.round(
    up ? s.pressure.bullish : s.pressure.bearish,
  )} and the market is ${s.regime.replace(/_/g, " ")}.`;

  const missing = conditions.filter((x) => !x.met);
  const say = ((): string => {
    if (state === "trade_ready") {
      return `I want to ${up ? "BUY" : "SELL"} gold. ${cap(c.reason)}. I'd risk to ${stop.toFixed(2)} — ${Math.round(
        stopPips,
      )} pips — and I'm looking for ${Math.round(toInitial)} to ${Math.round(toExtended)} pips, so ${rToInitial.toFixed(
        1,
      )}R to the first objective. ${fit.why}`;
    }
    if (state === "waiting_for_trigger") {
      return `I'm ${up ? "long" : "short"}-biased and everything is in place except the trigger. ${missing
        .map((m) => m.text.toLowerCase())
        .join(", ")} — that's what I'm waiting on.`;
    }
    if (state === "setup_developing") {
      return `A ${up ? "long" : "short"} is developing. ${cap(c.reason)}. I still need ${missing
        .map((m) => m.text.toLowerCase())
        .join(" and ")}.`;
    }
    return `I'm interested in a ${up ? "long" : "short"} here, but it isn't ready. ${cap(c.reason)}, and I want ${missing
      .map((m) => m.text.toLowerCase())
      .join(" and ")} before I'd take it.`;
  })();
  const saidOutLoud = counterNote ? `${say} ${counterNote}` : say;

  const headline =
    state === "trade_ready" ? "TRADE READY"
    : state === "waiting_for_trigger" ? "WAITING FOR TRIGGER"
    : state === "setup_developing" ? "SETUP DEVELOPING"
    : `WATCHING ${up ? "LONG" : "SHORT"}`;

  return {
    state,
    side: c.side,
    style: fit.style,
    strategy: c.strategy,
    styleWhy: fit.why,
    entryLow: up ? +(s.price - c.atr * 0.12).toFixed(2) : +s.price.toFixed(2),
    entryHigh: up ? +s.price.toFixed(2) : +(s.price + c.atr * 0.12).toFixed(2),
    stop: +stop.toFixed(2),
    initialObjective: +initialObjective.toFixed(2),
    extendedObjective: +extendedObjective.toFixed(2),
    stopPips: Math.round(stopPips),
    expectedMovePips: [Math.round(toInitial), Math.round(toExtended)],
    conditions,
    metCount,
    totalCount,
    confidence,
    thesis,
    invalidation,
    invalidationPrice: +invalidationPrice.toFixed(2),
    waitingFor: missing.map((m) => m.text),
    say: saidOutLoud,
    headline,
    blockedBy,
    expiresAt: now + Math.round(pol.followThroughMs * 0.5),
    at: now,
  };
}

/* ── pricing one candidate on one clock ─────────────────────────────────── */

type Priced = {
  ok: true;
  c: Candidate;
  fit: StyleFit;
  stop: number;
  stopPips: number;
  initialObjective: number;
  extendedObjective: number;
  toInitial: number;
  toExtended: number;
  rToInitial: number;
  rank: number;
};

type NearMiss = { ok: false; why: string; waiting: string[]; rank: number };

/**
 * Turn one candidate on one clock into real numbers, or explain why it cannot be one.
 *
 * Every refusal in here is specific and quotes the measurement behind it, because "no trade" without a
 * reason is indistinguishable from a system that is broken.
 */
function priceTheTrade(s: MarketSnapshot, c: Candidate, fit: StyleFit, pipSize: number): Priced | NearMiss {
  const pol = STYLE[fit.style];
  const lab = pol.label;
  const up = c.side === "buy";
  const base = c.score + fit.score * 0.22;

  /*
   * The stop is a real structural shelter plus a fraction of that timeframe's ATR, so ordinary movement
   * does not reach it. Never a round number, never a fixed distance.
   *
   * 09-21 — AND A PAD FOR WHAT IT COSTS TO BE IN THE TRADE.
   *
   * A 14-lot sell was planned with a 13-pip stop, filled five pips worse than the entry it was priced
   * from, and was then taken out by a spike that traded 1.5 pips through the level. The read was right;
   * the stop was simply closer to the noise than the arithmetic admitted, because two real costs were
   * missing from it:
   *
   *   • the SPREAD. A sell is entered on the bid and stopped on the ask, so the stop is already that
   *     much nearer than it looks on the chart.
   *   • SLIPPAGE. A market order fills where the book is, not where the plan was.
   *
   * So the structural pad now carries the live spread plus a quarter of the execution frame's ATR. The
   * risk percentage is untouched: a wider stop simply sizes to fewer lots for the same dollars at risk.
   * This only moves a stop FURTHER from price, and only when the setup is first priced — nothing here
   * can widen a stop that has already been published or sent.
   */
  const spread = s.spread != null && s.spread > 0 ? s.spread : 0;
  const frictionPad = spread + c.atr * 0.25;
  const pad = c.atr * (fit.style === "quick" ? 0.35 : fit.style === "hold" ? 0.5 : 0.75) + frictionPad;
  const stop = up ? c.shelter - pad : c.shelter + pad;
  const stopPips = toPips(Math.abs(s.price - stop), pipSize);

  if (stopPips < pol.noiseFloorPips * 0.5) {
    return {
      ok: false, rank: base - 45,
      why: `I like the ${up ? "long" : "short"} here, but the only sensible stop is ${Math.round(stopPips)} pips away — that is inside the noise of ${article(lab)} ${lab} trade. Ordinary movement would take me out of it.`,
      waiting: ["a wider structure to place the stop behind"],
    };
  }
  if (stopPips > pol.maxStopPips) {
    return {
      ok: false, rank: base - 35,
      why: `The structure this trade needs is ${Math.round(stopPips)} pips away, which is wider than I will risk on ${article(lab)} ${lab} trade. I would rather wait for a tighter entry than pay for that stop.`,
      waiting: [`price to come back toward ${c.pivot.toFixed(2)} so the stop is closer`],
    };
  }

  const risk = Math.abs(s.price - stop);

  // Is something real sitting in the way? Buying straight into resistance with a wide stop is the most
  // expensive kind of being right.
  const obstruction = levelAhead(s, c.side, 0);
  if (obstruction && Math.abs(obstruction.price - s.price) < risk * 0.6) {
    const inWay = Math.round(toPips(Math.abs(obstruction.price - s.price), pipSize));
    return {
      ok: false, rank: base - 25,
      why: `I like the ${up ? "long" : "short"}, but ${obstruction.label} at ${obstruction.price.toFixed(2)} is only ${inWay} pips away and the stop this needs is ${Math.round(stopPips)}. That is risking ${Math.round(stopPips)} to make ${inWay}. I'd rather wait for that level to go than trade straight into it.`,
      waiting: [`${up ? "acceptance above" : "acceptance below"} ${obstruction.price.toFixed(2)} (${obstruction.label})`],
    };
  }

  // An objective closer than one R is not an objective.
  const first = levelBeyond(s, c.side, risk * 1.0);
  const initialObjective = first ? first.price : s.price + sign(c.side) * risk * 1.8;
  const second = levelBeyond(s, c.side, Math.abs(initialObjective - s.price) + risk * 0.6);
  const extendedObjective = second ? second.price : s.price + sign(c.side) * risk * 3.0;
  const toInitial = toPips(Math.abs(initialObjective - s.price), pipSize);
  const toExtended = toPips(Math.abs(extendedObjective - s.price), pipSize);
  const rToInitial = stopPips > 0 ? toInitial / stopPips : 0;

  /*
   * IS THIS ACTUALLY THAT HORIZON?
   *
   * A horizon is an opportunity category. QUICK exists for thirty-to-a-hundred-pip moves, HOLD for three
   * hundred and up. If the room this setup genuinely has is nowhere near the band, then calling it that
   * horizon is a lie that then justifies a wider stop — and a wider stop on a smaller idea is how a
   * losing QUICK trade gets quietly relabelled to avoid admitting the thesis failed.
   *
   * So the move is measured against the band and the pairing is REJECTED rather than stretched. When the
   * move honestly belongs to a different horizon, the refusal says which one.
   */
  const short = shortfall(fit.style, toExtended);
  if (short > 0.45) {
    const honest = horizonForMove(toExtended);
    return {
      ok: false, rank: base - 20,
      why: honest && honest !== fit.style
        ? `There is about ${Math.round(toExtended)} pips of room here, which is ${STYLE[honest].label}, not ${article(lab)} ${lab}. I am not going to widen a stop to make it fit the bigger label.`
        : `${article(lab).replace(/^a/, "A")} ${lab} trade is for ${STYLE[fit.style].opportunityPips[0]} pips and up, and there is only about ${Math.round(toExtended)} pips of room before the next thing in the way. That is not this trade.`,
      waiting: [`room for a real ${lab.toLowerCase()} move`],
    };
  }

  // Reward quality ranks a pairing; it does not by itself disqualify one, because the floor above has
  // already removed the trades that were not worth taking.
  const rank = base + Math.min(14, (rToInitial - 1) * 10) - short * 12;

  return { ok: true, c, fit, stop, stopPips, initialObjective, extendedObjective, toInitial, toExtended, rToInitial, rank };
}


/** No candidate anywhere. Say why, and say what would change it — using real levels. */
function standingAside(s: MarketSnapshot, profile: SetupProfile, now: number): BrainSetup {
  void profile;
  const above = levelAhead(s, "buy");
  const below = levelAhead(s, "sell");
  const waiting: string[] = [];
  if (above) waiting.push(`Break and acceptance above ${above.price.toFixed(2)} (${above.label})`);
  if (below) waiting.push(`Sweep and reclaim of ${below.price.toFixed(2)} (${below.label})`);
  const exec = tf(s, "5m");
  if (exec && exec.features.volRatio < 0.9) waiting.push("stronger 5-minute momentum than this");

  const ranging = /sideways_range|tight_range|compression|volatility_squeeze/.test(s.regime);
  const pir = exec?.structure.positionInRange;
  const middle = pir != null && pir > 0.3 && pir < 0.7;

  const say = ranging && middle
    ? "Gold is in the middle of the current range and neither side has meaningful control. I don't see an edge worth taking yet."
    : Math.abs(s.pressure.net) < 12
    ? "Buyers and sellers are evenly matched right now. There's nothing here I'd put money behind."
    : `The market is ${s.regime.replace(/_/g, " ")} and nothing has set up cleanly enough for me to want a position.`;

  const out = noSetup(say, waiting, "no_setup", now);
  return out;
}

const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);

/**
 * Has a setup we previously offered stopped being offerable?
 *
 * Kept separate from `findSetup` so it can be applied to a STORED setup — the one the member is looking at
 * — rather than a freshly computed one. A setup the member is about to approve must be re-checked against
 * the current market, never executed on the strength of what it said two minutes ago.
 */
export function stillValid(setup: BrainSetup, s: MarketSnapshot | null, now = Date.now()):
  { ok: true } | { ok: false; state: SetupState; reason: string } {
  if (setup.state !== "trade_ready") return { ok: false, state: setup.state, reason: "That setup is not ready to take." };
  if (setup.expiresAt != null && now > setup.expiresAt) {
    return { ok: false, state: "setup_expired", reason: "That setup has been sitting too long — I'd want to look again before taking it." };
  }
  if (!s) return { ok: false, state: "blocked", reason: "I can't see gold right now, so I won't send an order." };
  if (s.blockers.length) return { ok: false, state: "blocked", reason: s.blockers[0].detail };
  if (setup.invalidationPrice != null && setup.side) {
    const through = setup.side === "buy" ? s.price < setup.invalidationPrice : s.price > setup.invalidationPrice;
    if (through) {
      return { ok: false, state: "setup_invalidated", reason: `Price has gone back through ${setup.invalidationPrice.toFixed(2)}. That setup is gone — I'm not taking it now.` };
    }
  }
  // The entry must still be near where the setup said it was, or this is a different trade.
  if (setup.entryHigh != null && setup.entryLow != null) {
    const mid = (setup.entryHigh + setup.entryLow) / 2;
    const risk = setup.stop != null ? Math.abs(mid - setup.stop) : null;
    if (risk && Math.abs(s.price - mid) > risk * 0.6) {
      return { ok: false, state: "setup_expired", reason: `Gold has moved ${Math.abs(toPips(s.price - mid, PIP)).toFixed(0)} pips since I called that. The entry isn't there any more.` };
    }
  }
  return { ok: true };
}
