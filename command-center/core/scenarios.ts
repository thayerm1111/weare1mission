/**
 * ATLAS'S SCENARIOS — the base case, the alternative, and what would change the view.
 *
 * A read says which way ATLAS leans. A scenario says what has to HAPPEN, in prices, for that to play out,
 * for the other path to win, or for ATLAS to change its mind — and then keeps score honestly:
 *
 *   watching → developing → confirmed | invalidated        (expired: superseded by new levels, or no
 *                                                           resolution within the horizon)
 *
 * THE RULES.
 *
 * • PRICES, NOT ADJECTIVES. Every trigger and invalidation is a price (or, for a range, a price zone) taken
 *   from the read's own levels, with a reference the chart can draw.
 *
 * • A LEAN NEVER CONFIRMS A SCENARIO. Confirmation needs the trigger condition met by a CLOSED candle of the
 *   scenario's timeframe (15 minutes), closed after the scenario was opened. A 5-minute close through the
 *   trigger only makes it "developing". The read moving the other way only ever supersedes it.
 *
 * • THE HISTORY IS APPEND-ONLY. A scenario's trigger, invalidation and direction never change after it is
 *   opened; its statuses are appended with a timestamp and a reason and are never rewritten. A terminal
 *   status (confirmed / invalidated / expired) is final. When the read's levels move, the old scenario is
 *   expired as superseded and a new one opens — the old call stays on the record as it was made.
 *
 * Pure: no I/O, no clock except `now`. The same read, candles and history produce the same scenarios.
 */
import type { Bar, MarketSnapshot, Timeframe } from "./types";
import { TF_MINUTES } from "./types";
import { LEAN_LABEL, type AtlasRead, type EvidenceRef, type Scenario, type ScenarioRole, type ScenarioStatus } from "./atlasContract";
import { closedOnly, edgesOfRead, fmtPx, signed, type Anchor } from "./read";
import { atr } from "./math";

export const SCENARIO_RULES = {
  /** The timeframe whose CLOSED candles confirm or invalidate a scenario. */
  TF: "15m" as "15m" | "1h",
  /** A scenario with no resolution after this long has expired: the levels it was built on are stale. */
  HORIZON_MS: { "15m": 4 * 3600_000, "1h": 12 * 3600_000 } as Record<"15m" | "1h", number>,
  /** "Developing" when the last closed 5-minute candle is within this many 15-minute ATRs of the trigger. */
  APPROACH_ATR: 0.35,
  /** A watching scenario is superseded when the read's levels for its path move by more than this (15m ATR). */
  SUPERSEDE_ATR: 0.5,
  /** For a balanced / transitioning read, |score| below this keeps the current roles instead of re-tilting. */
  TILT_MIN: 10,
  /** A path confirmed or invalidated at the same levels is not re-opened for this long. */
  REOPEN_COOLDOWN_MS: 45 * 60_000,
  /** Finished scenarios kept alongside the live ones (the full record is in the persisted rows). */
  KEEP_TERMINAL: 6,
  KEEP_TERMINAL_MS: 3 * 3600_000,
  EVIDENCE_MAX: 3,
} as const;

const ROLE_ORDER: ScenarioRole[] = ["base", "alternative", "view_change"];
const ROLE_WORD: Record<ScenarioRole, string> = { base: "base case", alternative: "alternative", view_change: "view change" };
const ACTIVE: ScenarioStatus[] = ["watching", "developing"];
export const isActiveScenario = (s: Scenario): boolean => ACTIVE.includes(s.status);

type Direction = Scenario["direction"];
type Edge = { price: number; label: string; ref?: EvidenceRef };
type Spec = {
  key: string; role: ScenarioRole; direction: Direction; title: string;
  trigger: Scenario["trigger"]; invalidation: Scenario["invalidation"]; evidence: string[];
};

export type ScenarioOptions = {
  /** Candles per timeframe. Only candles CLOSED by `now` are read. */
  bars?: Partial<Record<Timeframe, Bar[]>>;
  /** The support and resistance the read chose its levels from (computeReadDetailed().edges). When absent
   *  they are recovered from the read's own invalidation / next-watch references. */
  edges?: { support: Anchor | null; resistance: Anchor | null };
};

const utcHm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const cents = (n: number | null | undefined) => (n == null ? "-" : n.toFixed(2));

/** The support/resistance a read implies, recovered from its own references (prices only — no invention). */
function edgesFromRead(read: AtlasRead): { S: Edge | null; R: Edge | null } {
  const e = edgesOfRead(read);
  return {
    S: e.support ? { price: e.support.price, label: "support", ...(e.support.ref ? { ref: e.support.ref } : {}) } : null,
    R: e.resistance ? { price: e.resistance.price, label: "resistance", ...(e.resistance.ref ? { ref: e.resistance.ref } : {}) } : null,
  };
}

/**
 * Which way a read with no side tilts. Outside the dead band, the score decides. Inside it, the roles stay
 * where they are — a score wobbling around zero is not a new view, and re-labelling the alternative and the
 * view change on every reading would only fill the history with noise.
 */
function tiltOf(read: AtlasRead, live: Scenario[]): "up" | "down" {
  if (Math.abs(read.score) >= SCENARIO_RULES.TILT_MIN) return read.score > 0 ? "up" : "down";
  const cur = live.find((s) => isActiveScenario(s) && s.direction !== "range" && s.role !== "view_change");
  if (cur) return cur.direction as "up" | "down";
  return read.htfTrend.state === "down" ? "down" : read.htfTrend.state === "up" ? "up"
    : read.momentum.state === "falling" ? "down" : read.score < 0 ? "down" : "up";
}

/** The three paths around the read's two levels, with roles assigned by the lean. */
function specsFor(read: AtlasRead, S: Edge | null, R: Edge | null, tilt: "up" | "down"): Spec[] {
  if (read.lean === "insufficient_data" || !S || !R || !(S.price < R.price)) return [];
  const zone: EvidenceRef = { kind: "zone", from: S.price, to: R.price, label: `${fmtPx(S.price)}–${fmtPx(R.price)}` };
  const above = (e: Edge): Scenario["trigger"] => ({ text: `A 15-minute close above ${fmtPx(e.price)} (${e.label})`, price: e.price, ...(e.ref ? { ref: e.ref } : {}) });
  const below = (e: Edge): Scenario["trigger"] => ({ text: `A 15-minute close below ${fmtPx(e.price)} (${e.label})`, price: e.price, ...(e.ref ? { ref: e.ref } : {}) });

  // The evidence that argues for each direction, from the read's own lists.
  const forUp = read.lean === "bullish_lean" || ((read.lean === "balanced" || read.lean === "transitioning") && read.score >= 0);
  const bull = (forUp ? read.evidenceFor : read.evidenceAgainst).map((x) => x.text);
  const bear = (forUp ? read.evidenceAgainst : read.evidenceFor).map((x) => x.text);
  const rangeEv = [`The evidence is ${signed(read.score)}: ${Math.abs(read.score) < 15 ? "neither side has control" : "not decisive either way"}`, read.momentum.text];

  const base = {
    up: { direction: "up" as const, trigger: above(R), invalidation: below(S), evidence: bull.slice(0, SCENARIO_RULES.EVIDENCE_MAX) },
    down: { direction: "down" as const, trigger: below(S), invalidation: above(R), evidence: bear.slice(0, SCENARIO_RULES.EVIDENCE_MAX) },
    range: {
      direction: "range" as const,
      trigger: { text: `A 15-minute candle that trades through ${fmtPx(S.price)} or ${fmtPx(R.price)} and closes back inside`, price: null, ref: zone },
      invalidation: { text: `A 15-minute close outside ${fmtPx(S.price)}–${fmtPx(R.price)}`, price: null, ref: zone },
      evidence: rangeEv,
    },
  };
  const other = tilt === "up" ? "down" : "up";
  const roles: Record<ScenarioRole, "up" | "down" | "range"> =
    read.lean === "bullish_lean" ? { base: "up", alternative: "range", view_change: "down" }
    : read.lean === "bearish_lean" ? { base: "down", alternative: "range", view_change: "up" }
    : read.lean === "balanced" ? { base: "range", alternative: tilt, view_change: other }
    : { base: tilt, alternative: "range", view_change: other };      // transitioning

  return ROLE_ORDER.map((role) => {
    const b = base[roles[role]];
    return { ...b, role, key: keyOf(b.direction, b.trigger, b.invalidation), title: titleOf(role, b.direction, S.price, R.price) };
  });
}

function keyOf(direction: Direction, trigger: Scenario["trigger"], invalidation: Scenario["invalidation"]): string {
  const z = (r?: EvidenceRef) => (r?.kind === "zone" ? `${cents(r.from)}~${cents(r.to)}` : "");
  return `${direction}|${cents(trigger.price)}${z(trigger.ref)}|${cents(invalidation.price)}${z(invalidation.ref)}`;
}

function titleOf(role: ScenarioRole, d: Direction, S: number, R: number): string {
  if (d === "up") return role === "base" ? `Continuation higher through ${fmtPx(R)}` : role === "alternative" ? `Breakout above ${fmtPx(R)}` : `A close above ${fmtPx(R)} turns me bullish`;
  if (d === "down") return role === "base" ? `Continuation lower through ${fmtPx(S)}` : role === "alternative" ? `Breakdown below ${fmtPx(S)}` : `A close below ${fmtPx(S)} turns me bearish`;
  return role === "base" ? `The range holds between ${fmtPx(S)} and ${fmtPx(R)}` : `Rotation inside ${fmtPx(S)}–${fmtPx(R)}`;
}

/** Append a status. Never edits an earlier entry; timestamps never run backwards. */
function append(sc: Scenario, status: ScenarioStatus, at: number, reason: string, now: number): Scenario {
  const lastAt = sc.history.length ? sc.history[sc.history.length - 1].at : sc.since;
  return { ...sc, status, updatedAt: now, history: [...sc.history, { at: Math.max(at, lastAt), status, reason }] };
}

const zoneOf = (sc: Scenario): { S: number; R: number } | null => {
  const r = sc.trigger.ref?.kind === "zone" ? sc.trigger.ref : sc.invalidation.ref?.kind === "zone" ? sc.invalidation.ref : null;
  return r ? { S: Math.min(r.from, r.to), R: Math.max(r.from, r.to) } : null;
};

/**
 * What one closed candle of the scenario's timeframe says about it, if anything. A CLOSE counts when it
 * happened after the scenario opened. A WICK (the range's "traded through and closed back inside") counts
 * only on a candle that OPENED after the scenario did — otherwise the extreme may predate the call.
 */
function judge(sc: Scenario, b: Bar, closeAt: number): { status: "confirmed" | "invalidated"; reason: string } | null {
  const when = `The ${sc.tf === "1h" ? "1-hour" : "15-minute"} candle that closed at ${utcHm(closeAt)} UTC`;
  if (sc.direction === "range") {
    const z = zoneOf(sc);
    if (!z) return null;
    if (b.c > z.R || b.c < z.S) return { status: "invalidated", reason: `${when} closed ${b.c > z.R ? "above" : "below"} the range at ${fmtPx(b.c)}.` };
    if (b.t >= sc.since && (b.h > z.R || b.l < z.S)) return { status: "confirmed", reason: `${when} traded through ${fmtPx(b.h > z.R ? z.R : z.S)} and closed back inside at ${fmtPx(b.c)} — the range held.` };
    return null;
  }
  const t = sc.trigger.price, inv = sc.invalidation.price;
  const up = sc.direction === "up";
  if (t != null && (up ? b.c > t : b.c < t)) return { status: "confirmed", reason: `${when} closed ${up ? "above" : "below"} ${fmtPx(t)} at ${fmtPx(b.c)}.` };
  if (inv != null && (up ? b.c < inv : b.c > inv)) return { status: "invalidated", reason: `${when} closed ${up ? "below" : "above"} ${fmtPx(inv)} at ${fmtPx(b.c)}.` };
  return null;
}

/** Move one live scenario forward on candles that closed after it was opened. */
function evaluate(sc: Scenario, closed: Partial<Record<Timeframe, Bar[]>>, atr15: number, now: number): Scenario {
  if (!isActiveScenario(sc)) return sc;
  const tf: Timeframe = sc.tf;
  const span = TF_MINUTES[tf] * 60_000;
  const horizonEnd = sc.since + SCENARIO_RULES.HORIZON_MS[sc.tf];

  // 1. Resolution: the FIRST closed candle (oldest first) that meets the trigger or the invalidation decides it.
  for (const b of closed[tf] ?? []) {
    const closeAt = b.t + span;
    if (closeAt <= sc.since || closeAt > now) continue;
    if (closeAt > horizonEnd) break;
    const v = judge(sc, b, closeAt);
    if (v) return append(sc, v.status, closeAt, v.reason, now);
  }
  // 2. The horizon.
  if (now > horizonEnd) {
    return append(sc, "expired", horizonEnd, `No resolution within ${Math.round(SCENARIO_RULES.HORIZON_MS[sc.tf] / 3600_000)} hours — the levels it was built on are stale.`, now);
  }
  // 3. Developing: a 5-minute close through the trigger (the 15-minute close still decides), or price
  //    closing close to it. Only ever watching → developing; it never goes back.
  if (sc.status !== "watching") return sc;
  const c5 = (closed["5m"] ?? []).filter((b) => b.t + 5 * 60_000 > sc.since && b.t + 5 * 60_000 <= now);
  if (!c5.length) return sc;
  const near = SCENARIO_RULES.APPROACH_ATR * (atr15 > 0 ? atr15 : 0);
  if (sc.direction === "range") {
    const z = zoneOf(sc);
    if (!z) return sc;
    const tested = c5.find((b) => b.t >= sc.since && (b.h > z.R || b.l < z.S) && b.c >= z.S && b.c <= z.R);
    if (tested) return append(sc, "developing", tested.t + 5 * 60_000, `A 5-minute candle tested ${fmtPx(tested.h > z.R ? z.R : z.S)} and closed back inside at ${fmtPx(tested.c)}; the 15-minute close decides it.`, now);
    const last = c5[c5.length - 1];
    if (near > 0 && (z.R - last.c <= near || last.c - z.S <= near)) {
      const edge = z.R - last.c <= near ? z.R : z.S;
      return append(sc, "developing", last.t + 5 * 60_000, `Price closed at ${fmtPx(last.c)}, within ${(Math.abs(edge - last.c)).toFixed(2)} of the range edge ${fmtPx(edge)}.`, now);
    }
    return sc;
  }
  const t = sc.trigger.price;
  if (t == null) return sc;
  const up = sc.direction === "up";
  const through = c5.find((b) => (up ? b.c > t : b.c < t));
  if (through) return append(sc, "developing", through.t + 5 * 60_000, `A 5-minute candle closed ${up ? "above" : "below"} ${fmtPx(t)} at ${fmtPx(through.c)}; the 15-minute close decides it.`, now);
  const last = c5[c5.length - 1];
  if (near > 0 && (up ? t - last.c <= near : last.c - t <= near)) {
    return append(sc, "developing", last.t + 5 * 60_000, `Price closed at ${fmtPx(last.c)}, within ${Math.abs(t - last.c).toFixed(2)} of ${fmtPx(t)}.`, now);
  }
  return sc;
}

/** The two prices a scenario was opened on: [support, resistance]. */
function levelsOf(sc: Scenario): [number, number] | null {
  if (sc.direction === "range") { const z = zoneOf(sc); return z ? [z.S, z.R] : null; }
  const t = sc.trigger.price, inv = sc.invalidation.price;
  if (t == null || inv == null) return null;
  return sc.direction === "up" ? [inv, t] : [t, inv];
}
function levelsOfSpec(s: Spec): [number, number] | null {
  if (s.direction === "range") {
    const r = s.trigger.ref;
    return r?.kind === "zone" ? [Math.min(r.from, r.to), Math.max(r.from, r.to)] : null;
  }
  const t = s.trigger.price, inv = s.invalidation.price;
  if (t == null || inv == null) return null;
  return s.direction === "up" ? [inv, t] : [t, inv];
}

/**
 * Advance the scenarios one reading.
 *
 *   1. Every live scenario is judged on the candles that closed since it opened (and expires at its horizon).
 *   2. There is at most ONE live scenario per direction (up, down, range). The lean decides which of them is
 *      the base case, the alternative and the view change; a change of role is recorded in its history.
 *   3. A live scenario keeps the prices it was opened with. It is superseded only while it is still
 *      "watching" and the read's levels for that path have moved by more than SUPERSEDE_ATR — a scenario
 *      that is already developing is left to resolve or expire, never pulled before its candle closes.
 *   4. A direction with no live scenario opens a new one from the read's current levels.
 *   5. Finished scenarios stay on the list for a while, newest first, after the live ones.
 *
 * When the read cannot be trusted (insufficient data) or its levels are incomplete, nothing is opened,
 * re-roled or superseded: live scenarios are only judged on real candles and left to resolve or expire.
 */
export function updateScenarios(read: AtlasRead, snapshot: MarketSnapshot | null, previous: Scenario[], now: number, opts: ScenarioOptions = {}): Scenario[] {
  const closed: Partial<Record<Timeframe, Bar[]>> = {};
  for (const tf of ["5m", "15m", "1h"] as Timeframe[]) closed[tf] = closedOnly(opts.bars?.[tf], tf, now);
  const atr15 = atr(closed["15m"] ?? [], 14) ?? snapshot?.timeframes["15m"]?.features.atr ?? 0;

  // 1 — judge what is live.
  let list = previous.filter(scenarioLooksValid).map((sc) => evaluate(sc, closed, atr15, now));

  // 2 — reconcile with the paths the read implies now.
  const fromRead = edgesFromRead(read);
  const S: Edge | null = opts.edges ? (opts.edges.support ? { price: opts.edges.support.price, label: opts.edges.support.label, ref: opts.edges.support.ref } : null) : fromRead.S;
  const R: Edge | null = opts.edges ? (opts.edges.resistance ? { price: opts.edges.resistance.price, label: opts.edges.resistance.label, ref: opts.edges.resistance.ref } : null) : fromRead.R;
  const specs = specsFor(read, S, R, tiltOf(read, list));
  if (specs.length) {
    const tol = atr15 > 0 ? SCENARIO_RULES.SUPERSEDE_ATR * atr15 : 0.005;
    const claimed = new Set<Direction>();
    list = list.map((sc) => {
      if (!isActiveScenario(sc)) return sc;
      const spec = specs.find((x) => x.direction === sc.direction);
      if (!spec) return sc;
      if (claimed.has(sc.direction)) return append(sc, "expired", now, "Superseded: another live scenario already covers this path.", now);
      const a = levelsOf(sc), b = levelsOfSpec(spec);
      const moved = !a || !b || Math.abs(a[0] - b[0]) > tol || Math.abs(a[1] - b[1]) > tol;
      if (moved && sc.status === "watching") {
        const was = a ? `${fmtPx(a[0])}–${fmtPx(a[1])}` : "its old levels";
        const is = b ? `${fmtPx(b[0])}–${fmtPx(b[1])}` : "new levels";
        return append(sc, "expired", now, `Superseded: the read's levels for this path moved from ${was} to ${is}.`, now);
      }
      claimed.add(sc.direction);
      if (spec.role === sc.role) return sc;
      const [s0, r0] = a ?? [0, 0];
      const re = append(sc, sc.status, now, `Now the ${ROLE_WORD[spec.role]} — the read is ${LEAN_LABEL[read.lean].toLowerCase()}.`, now);
      return { ...re, role: spec.role, title: a ? titleOf(spec.role, sc.direction, s0, r0) : sc.title };
    });
    for (const spec of specs) {
      if (claimed.has(spec.direction)) continue;
      // An alternative or view change that has just resolved at these same levels is not re-opened straight
      // away: that call has already played out, and opening it again would only repeat it. The base case
      // is always shown.
      const b = levelsOfSpec(spec);
      const justResolved = spec.role !== "base" && b && list.some((x) => !isActiveScenario(x) && x.status !== "expired" && x.direction === spec.direction
        && now - x.updatedAt < SCENARIO_RULES.REOPEN_COOLDOWN_MS
        && ((l) => !!l && Math.abs(l[0] - b[0]) <= tol && Math.abs(l[1] - b[1]) <= tol)(levelsOf(x)));
      if (justResolved) continue;
      const anchor = spec.trigger.price ?? (spec.trigger.ref?.kind === "zone" ? spec.trigger.ref.from : 0);
      list.push({
        id: `sc-${spec.direction}-${Math.round(now / 1000)}-${Math.round(anchor * 100)}`,
        role: spec.role,
        title: spec.title,
        tf: SCENARIO_RULES.TF,
        direction: spec.direction,
        evidence: spec.evidence,
        trigger: spec.trigger,
        invalidation: spec.invalidation,
        status: "watching",
        since: now,
        updatedAt: now,
        history: [{ at: now, status: "watching", reason: `Opened as the ${ROLE_WORD[spec.role]} for a ${LEAN_LABEL[read.lean].toLowerCase()} read (evidence ${signed(read.score)}).` }],
      });
    }
  }

  // 3 — live first in role order, then the recent finished ones, newest first.
  const live = list.filter(isActiveScenario).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.since - b.since);
  const done = list
    .filter((s) => !isActiveScenario(s) && now - s.updatedAt <= SCENARIO_RULES.KEEP_TERMINAL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, SCENARIO_RULES.KEEP_TERMINAL);
  return [...live, ...done];
}

/** A stored scenario, checked before it is carried forward. Anything malformed is dropped, not repaired. */
export function scenarioLooksValid(x: unknown): x is Scenario {
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<Scenario>;
  return typeof s.id === "string" && typeof s.since === "number" && typeof s.updatedAt === "number"
    && (s.direction === "up" || s.direction === "down" || s.direction === "range")
    && (s.tf === "15m" || s.tf === "1h")
    && ["watching", "developing", "confirmed", "invalidated", "expired"].includes(String(s.status))
    && !!s.trigger && !!s.invalidation && Array.isArray(s.history);
}

/** What changed between two lists, as plain lines (new scenarios and status changes). Empty when nothing did. */
export function scenarioChanges(before: Scenario[], after: Scenario[]): string[] {
  const prev = new Map(before.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const s of after) {
    const p = prev.get(s.id);
    if (!p) out.push(`opened "${s.title}" (${s.role})`);
    else if (p.status !== s.status) out.push(`"${s.title}" ${p.status} → ${s.status}`);
  }
  return out;
}
