/**
 * THE TRACK RECORD — what it said, and whether it was right.
 *
 * A trading system that talks all day and never checks itself is a commentator. The difference between
 * a commentator and a trader is that the trader keeps a journal and the journal is allowed to be
 * unflattering. This is that journal, and it is deliberately built so that ATLAS cannot flatter
 * itself with it.
 *
 * WHAT "LEARNING" HONESTLY MEANS HERE, because the word is usually oversold. No weights are updated;
 * nothing about the language model changes. What changes is the EVIDENCE it is given about itself. Every
 * directional read is recorded with the price and the conditions at the moment it was made, scored
 * against what the market actually did once enough time has passed, and the scored history is handed
 * back on later turns as measured fact. So it can say "my five-minute breakout reads have been right
 * four times out of eleven this month" — and be right about that, because the arithmetic is in a table
 * anyone can query.
 *
 * TWO RULES THAT MAKE IT TRUSTWORTHY.
 *
 * First, a claim is only recorded when a claim was actually made. The extractor below is conservative
 * to the point of being unhelpful, and that is correct: a system that invents a position it never took
 * so that it can score a win is worse than one with no record at all. Most answers record `none`.
 *
 * Second, nothing is scored early. A read given a one-hour horizon is judged after that hour and not
 * before, so a call cannot be quietly graded at the moment it happened to look good.
 */
import { db } from "../adapters/db";
import { PIP } from "../core/types";

export type Direction = "up" | "down" | "none";

export type Call = {
  userId: string | null;
  channel: "voice" | "text" | "narrator";
  question: string;
  answer: string;
  priceAt: number | null;
  snapshotId: number | null;
  direction: Direction;
  horizonMin: number;
  regime: string | null;
  sessionName: string | null;
  thesisId: string | null;
  setupState: string | null;
};

/*
 * Phrases that mean a direction, and phrases that only look like they do.
 *
 * "I'd wait" contains no view. "It could go either way" contains no view. "Buyers are in control"
 * does. The negative list exists because the cheap version of this — search for the word "up" — would
 * score ATLAS on sentences it never meant as calls, and a record built from misreadings is worse
 * than no record.
 */
const BULL = /\b(buyers?\s+(are\s+|look\s+|remain\s+)?(in control|stronger|on top)|higher|upside|pushing up|breaking up|bullish|i'?d be (a )?buyer|favou?r the long|going up|rally|lean long|long here)\b/i;
const BEAR = /\b(sellers?\s+(are\s+|look\s+|remain\s+)?(in control|stronger|on top)|lower|downside|pushing down|breaking down|bearish|i'?d be (a )?seller|favou?r the short|going down|sell off|lean short|short here)\b/i;
const HEDGED = /\b(either way|no firm|not sure|can'?t tell|i'?d wait|no view|too early|unclear|don'?t know|nothing (live|to read)|market is closed|two-sided|no edge)\b/i;

/**
 * Pull a directional claim out of an answer, or decline to.
 *
 * Hedging wins over direction on purpose. "Buyers are stronger but I'd wait" is not a call — it is a
 * description plus a refusal, and recording it as a long would be putting words in its mouth.
 */
export function extractClaim(answer: string): { direction: Direction; horizonMin: number } {
  const t = answer.toLowerCase();
  if (HEDGED.test(t)) return { direction: "none", horizonMin: 60 };

  const up = BULL.test(t), down = BEAR.test(t);
  if (up === down) return { direction: "none", horizonMin: 60 };   // both or neither is not a call

  // The horizon it implied, so a scalp read is not judged on where gold was a day later.
  const horizonMin =
    /\b(scalp|quick|next few minutes|right now|immediately|five[- ]minute)\b/i.test(t) ? 30
    : /\b(swing|this week|next few days|daily|multi[- ]day)\b/i.test(t) ? 1440
    : /\b(today|this session|intraday|next few hours|hold)\b/i.test(t) ? 240
    : 60;

  return { direction: up ? "up" : "down", horizonMin };
}

/**
 * Write the call down.
 *
 * Fire-and-forget by design: a journal that can fail a conversation is a journal that gets removed the
 * first time it does. It records the answer either way — an answer with no claim in it is still part
 * of the history of what was said, and "it kept refusing to commit all week" is itself worth knowing.
 */
export async function recordCall(c: Call): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client.from("cc_brain_calls").insert({
      user_id: c.userId, channel: c.channel,
      question: c.question.slice(0, 500), answer: c.answer.slice(0, 4000),
      price_at: c.priceAt, snapshot_id: c.snapshotId,
      direction: c.direction, horizon_min: c.horizonMin,
      regime: c.regime, session_name: c.sessionName,
      thesis_id: c.thesisId, setup_state: c.setupState,
    });
  } catch { /* best effort — never break a conversation to keep a diary */ }
}

/*
 * How far the market has to move before a read counts as right.
 *
 * Without a threshold every call is "correct" in whichever direction the last tick happened to fall,
 * and the record becomes a coin flip dressed up as a hit rate. Forty pips is roughly the noise floor
 * on gold over an hour; inside that, nothing was predicted.
 */
const MEANINGFUL_PIPS = 40;

/**
 * Score every call whose horizon has matured.
 *
 * `priceNow` is passed in rather than fetched so this can run inside the worker's existing tick, which
 * already holds a fresh price and has already decided the market is open. Scoring against a stale quote
 * would corrupt the record permanently, and a corrupted record is worse than none.
 */
export async function scoreMatured(priceNow: number, nowMs = Date.now()): Promise<number> {
  const c = db();
  if (!c) return 0;

  const { data } = await c.from("cc_brain_calls")
    .select("id, at, price_at, direction, horizon_min")
    .is("scored_at", null)
    .order("at", { ascending: true })
    .limit(200);

  const rows = (data ?? []) as { id: number; at: string; price_at: number | null; direction: Direction; horizon_min: number }[];
  let scored = 0;

  for (const r of rows) {
    const matureAt = Date.parse(r.at) + r.horizon_min * 60_000;
    if (matureAt > nowMs) continue;                       // not yet — never score a call early
    if (r.price_at == null) {
      // Nothing to measure against. Close it so it does not sit in the queue for ever.
      await c.from("cc_brain_calls").update({ scored_at: new Date().toISOString(), verdict: "unmeasurable" }).eq("id", r.id);
      scored++;
      continue;
    }

    const movedPips = (priceNow - r.price_at) / PIP;
    const verdict =
      r.direction === "none" ? "no_call"
      : Math.abs(movedPips) < MEANINGFUL_PIPS ? "flat"
      : (movedPips > 0) === (r.direction === "up") ? "right" : "wrong";

    await c.from("cc_brain_calls").update({
      scored_at: new Date().toISOString(),
      price_then: priceNow,
      moved_pips: +movedPips.toFixed(1),
      verdict,
    }).eq("id", r.id);
    scored++;
  }
  return scored;
}

/**
 * Is the member asking about the system itself rather than about gold?
 *
 * This needs a route of its own. "How accurate have you been" is not a market question and must not be
 * answered out of a live snapshot — asked at the weekend it came back "gold is closed", which is the
 * same failure as refusing to discuss last week: a router that never asked what was being requested.
 */
export function asksAboutRecord(q: string): boolean {
  return /\b(your (record|calls?|accuracy|track record|hit rate|performance)|how (accurate|often are you right|have you (been )?done)|been right|were you right|get it wrong|how many .* (right|wrong)|track record|scorecard)\b/i.test(q);
}

export type TrackRecord = {
  scored: number; right: number; wrong: number; flat: number; noCall: number;
  hitRate: number | null;
  byHorizon: { horizon: number; right: number; wrong: number }[];
  recentMisses: { at: number; direction: Direction; movedPips: number; answer: string }[];
};

/**
 * The record, as of now.
 *
 * Misses are surfaced and wins are not. That asymmetry is deliberate: the useful thing to put in front
 * of a trader about to repeat a read is the last time that read did not work.
 */
export async function trackRecord(days = 30): Promise<TrackRecord | null> {
  const c = db();
  if (!c) return null;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data } = await c.from("cc_brain_calls")
    .select("at, direction, horizon_min, verdict, moved_pips, answer")
    .not("scored_at", "is", null).gte("at", since)
    .order("at", { ascending: false }).limit(500);

  const rows = (data ?? []) as { at: string; direction: Direction; horizon_min: number; verdict: string; moved_pips: number | null; answer: string }[];
  if (!rows.length) return null;

  const right = rows.filter((r) => r.verdict === "right").length;
  const wrong = rows.filter((r) => r.verdict === "wrong").length;
  const flat = rows.filter((r) => r.verdict === "flat").length;
  const noCall = rows.filter((r) => r.verdict === "no_call").length;

  const horizons = [...new Set(rows.filter((r) => r.direction !== "none").map((r) => r.horizon_min))].sort((a, b) => a - b);
  return {
    scored: rows.length, right, wrong, flat, noCall,
    hitRate: right + wrong > 0 ? right / (right + wrong) : null,
    byHorizon: horizons.map((h) => ({
      horizon: h,
      right: rows.filter((r) => r.horizon_min === h && r.verdict === "right").length,
      wrong: rows.filter((r) => r.horizon_min === h && r.verdict === "wrong").length,
    })),
    recentMisses: rows.filter((r) => r.verdict === "wrong").slice(0, 3).map((r) => ({
      at: Date.parse(r.at), direction: r.direction,
      movedPips: r.moved_pips ?? 0, answer: r.answer.slice(0, 200),
    })),
  };
}

const ago = (ms: number) => {
  const h = Math.round((Date.now() - ms) / 3_600_000);
  return h < 1 ? "under an hour ago" : h < 24 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
};

/**
 * The record as lines for the context packet.
 *
 * Phrased as the member's own system reporting on itself, and blunt about a thin sample. Ten calls is
 * not a hit rate, and presenting it as one would be the same false precision this file exists to stop.
 */
export function trackRecordLines(t: TrackRecord): string[] {
  const L = [`=== YOUR OWN RECENT RECORD (measured, last 30 days) ===`];
  const decided = t.right + t.wrong;
  L.push(`${t.scored} answers scored: ${t.right} right, ${t.wrong} wrong, ${t.flat} where the market did not move enough to judge, ${t.noCall} where you gave no directional view.`);
  if (decided >= 10 && t.hitRate != null) {
    L.push(`That is ${Math.round(t.hitRate * 100)}% on the calls that resolved.`);
  } else {
    L.push(`Only ${decided} calls have actually resolved, which is far too few to be a hit rate. Do not quote a percentage from it.`);
  }
  for (const h of t.byHorizon) {
    if (h.right + h.wrong >= 5) L.push(`over about ${h.horizon} minutes: ${h.right} right, ${h.wrong} wrong`);
  }
  for (const m of t.recentMisses) {
    L.push(`recent miss (${ago(m.at)}): you leaned ${m.direction} and it went ${Math.round(m.movedPips)} pips — "${m.answer}"`);
  }
  L.push(`Use this honestly. If the current read resembles one of those misses, say so. Never claim a win that is not in these numbers.`);
  return L;
}
