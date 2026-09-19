/**
 * GRADING A FINISHED TRADE — the only part of this system that can make the next one better.
 *
 * The report already recorded what happened. This decides what it MEANT, and it is written to be useful
 * rather than flattering: the questions it answers are the ones a trader avoids asking themselves.
 *
 *   Did we close too early?
 *   Did we hold too long after the market told us?
 *   Was the entry good, or were we just rescued by a wide stop?
 *   Did we protect at the right moment, or give profit back for nothing?
 *
 * THREE RULES.
 *
 * 1. GRADE WHAT WAS MEASURED, NOT WHAT WAS FELT. Every judgement below traces to a number that exists in
 *    the report or the position's own timeline. Nothing infers intent.
 *
 * 2. A WINNER IS NOT AUTOMATICALLY A GOOD TRADE. A 1.3R win that took 0.9R of heat before it worked was
 *    a bad entry that got paid, and saying so is the only way it stops happening. The reverse is also
 *    true: a loss taken quickly, for the stated reason, at the stated level, is a GOOD trade.
 *
 * 3. WHAT CANNOT BE KNOWN YET IS LEFT NULL. Whether an exit was early depends on what gold did AFTER it,
 *    which does not exist at the moment of closing. So the report schedules its own second look rather
 *    than guessing, and `continuation` stays null until that look happens.
 */
import { db } from "../adapters/db";
import { STYLE, styleOf, type Style } from "../core/style";
import { TF_MINUTES } from "../core/types";
import type { Side } from "../core/types";

export type Mark = "excellent" | "good" | "acceptable" | "poor";

export type GradeLine = {
  what: string;
  mark: Mark | null;      // null when the evidence for it does not exist
  note: string;
};

export type TradeGrade = {
  /** 0–100. A summary, never a probability, and never used to size anything. */
  score: number;
  verdict: "well traded" | "good outcome, loose process" | "correct loss" | "mistimed" | "avoidable";
  lines: GradeLine[];
  /** The single thing most worth doing differently. Null when there genuinely isn't one. */
  lesson: string | null;
  /** How much of the move the trade actually kept, 0–1. The most honest number in the whole report. */
  capture: number | null;
};

export type GradeInput = {
  side: Side;
  style: Style;
  entry: number;
  exit: number;
  pips: number;
  r: number | null;
  mfePips: number;
  maePips: number;
  riskPips: number | null;
  heldMs: number;
  partials: { at: number; fraction: number; qty: number; price?: number }[];
  /** The position's own timeline, so timing can be judged rather than assumed. */
  events: { at: number; code: string }[];
  openedAt: number;
  exitReason: string | null;
  /** Filled by the second look, once gold has had time to answer. */
  continuationPips?: number | null;
};

const mark = (m: Mark) => m;

export function gradeTrade(i: GradeInput): TradeGrade {
  const pol = STYLE[i.style];
  const lines: GradeLine[] = [];
  const won = i.pips > 0;
  const riskPips = i.riskPips && i.riskPips > 0 ? i.riskPips : null;
  const heatR = riskPips ? Math.abs(i.maePips) / riskPips : null;
  /*
   * Two numbers the first version got wrong, and both were caught by grading a loss.
   *
   * PEAK R, not final R. "It reached 1R and the stop was never moved" is a statement about the best the
   * trade ever offered. Using the closing R meant a trade that went to +2R and came back to a full stop
   * was graded as though it had never been in profit at all — which is precisely the mistake the line
   * exists to catch.
   *
   * NOTHING TO CAPTURE. A trade whose best was eight pips did not have an exit problem; it had a
   * direction problem. Capture is only meaningful once the move was big enough to be worth keeping, so
   * anything under half this style's noise floor is treated as no move at all.
   */
  const peakR = riskPips ? i.mfePips / riskPips : null;
  const hadSomethingToKeep = i.mfePips >= pol.noiseFloorPips * 0.5;
  const capture = i.mfePips > 0 && hadSomethingToKeep
    ? Math.max(0, Math.min(1, Math.max(0, i.pips) / i.mfePips))
    : null;
  // A trade that simply never worked. Grading its ENTRY by heat would call every honest stop-out a bad
  // entry, which is both wrong and the fastest way to teach somebody to stop taking their stops.
  const neverWorked = !won && !hadSomethingToKeep;
  const at = (code: string) => i.events.find((e) => e.code === code)?.at ?? null;

  let score = 50;
  const push = (what: string, m: Mark | null, note: string, delta: number) => {
    lines.push({ what, mark: m, note });
    score += delta;
  };

  /* ── ENTRY. Measured by how much heat it took before it worked. ───────── */
  if (heatR == null) {
    push("Entry", null, "There is no recorded risk distance, so the entry cannot be judged.", 0);
  } else if (neverWorked) {
    push("Entry", null, `It never went our way at all — the best it managed was ${Math.round(i.mfePips)} pips. The entry was not the problem here; the direction was.`, 0);
  } else if (heatR <= 0.25) {
    push("Entry", mark("excellent"), `It went our way almost immediately — only ${Math.abs(Math.round(i.maePips))} pips of heat against a ${Math.round(riskPips!)}-pip stop.`, 14);
  } else if (heatR <= 0.5) {
    push("Entry", mark("good"), `Took ${Math.abs(Math.round(i.maePips))} pips of heat, about ${(heatR * 100).toFixed(0)}% of the risk. Normal.`, 7);
  } else if (heatR <= 0.8) {
    push("Entry", mark("acceptable"), `Took ${(heatR * 100).toFixed(0)}% of the stop before it worked. The idea was right but the entry was early.`, -4);
  } else {
    push("Entry", mark("poor"), `It came within ${Math.round((1 - heatR) * 100)}% of the stop before doing anything. ${won ? "This one got paid, but that is not a repeatable entry." : "The entry was wrong before the idea was."}`, -14);
  }

  /* ── THE STOP. Was it wide enough to survive, tight enough to matter? ─── */
  if (riskPips == null) {
    push("Stop", null, "No recorded risk distance.", 0);
  } else if (!won && heatR != null && heatR >= 0.98) {
    const tight = riskPips < pol.noiseFloorPips;
    push("Stop", tight ? mark("poor") : mark("acceptable"),
      tight
        ? `Stopped out with a ${Math.round(riskPips)}-pip stop, which is inside what a ${pol.label} trade does on its own. That was noise, not a signal.`
        : `Stopped out at ${Math.round(riskPips)} pips. The stop was a reasonable distance for a ${pol.label} trade — the read was wrong, not the placement.`,
      tight ? -12 : 2);
  } else if (heatR != null && heatR >= 0.85 && won) {
    push("Stop", mark("good"), `Came within ${Math.round((1 - heatR) * 100)}% of the stop and survived. The placement earned its keep.`, 6);
  } else {
    push("Stop", mark("good"), `${Math.round(riskPips)} pips, never seriously threatened.`, 4);
  }

  /* ── BREAK EVEN. Early costs winners; never costs losers. ─────────────── */
  const beAt = at("STOP_TO_BREAK_EVEN");
  if (beAt) {
    const minutesIn = (beAt - i.openedAt) / 60_000;
    const earnedAt = pol.breakEvenR;
    const looksEarly = i.mfePips > 0 && capture != null && capture < 0.35 && won === false;
    if (looksEarly) {
      push("Break even", mark("poor"), `Protected after ${Math.round(minutesIn)} minutes and then got taken out at break even while the best was ${Math.round(i.mfePips)} pips. On a ${pol.label} trade I want ${earnedAt}R before touching the stop.`, -10);
    } else {
      push("Break even", mark("good"), `Stop moved to break even ${Math.round(minutesIn)} minutes in. The loss was off the table from there.`, 8);
    }
  } else if (peakR != null && peakR >= pol.breakEvenR && !won) {
    push("Break even", mark("poor"), `It reached ${peakR.toFixed(1)}R — ${Math.round(i.mfePips)} pips — and the stop was never moved. That profit was given back for nothing.`, -16);
  } else {
    push("Break even", null, "The stop was never moved, and it never earned the right to be.", 0);
  }

  /* ── PARTIALS. ────────────────────────────────────────────────────────── */
  if (i.partials.length) {
    const took = i.partials.reduce((a, p) => a + p.fraction, 0);
    const banked = i.partials[0];
    const bankedPips = banked.price != null ? Math.abs(banked.price - i.entry) : null;
    const tooEarly = bankedPips != null && i.mfePips > 0 && bankedPips < i.mfePips * 0.3;
    push("Partials", tooEarly ? mark("acceptable") : mark("good"),
      tooEarly
        ? `Took ${Math.round(took * 100)}% off early — the move went on to ${Math.round(i.mfePips)} pips. Banking is never wrong, but that was most of the position for a third of the move.`
        : `Took ${Math.round(took * 100)}% off along the way, which is what let the rest run without anxiety.`,
      tooEarly ? -2 : 8);
  } else if (i.mfePips > pol.partialR * (riskPips ?? pol.noiseFloorPips) && !won) {
    push("Partials", mark("poor"), `It reached ${Math.round(i.mfePips)} pips and nothing was banked. The whole move was handed back.`, -12);
  } else {
    push("Partials", null, "Nothing was taken off. For this trade that was not obviously wrong.", 0);
  }

  /* ── THE EXIT. Capture is the number, and it does not flatter anybody. ── */
  if (capture == null) {
    push("Exit", won ? mark("good") : null,
      won ? "Closed in profit without ever being meaningfully offside." : "There was never enough of a move to capture — this was taken off at the stop, which is what a stop is for.",
      won ? 4 : 0);
  } else if (capture >= 0.8) {
    push("Exit", mark("excellent"), `Kept ${Math.round(capture * 100)}% of the move — out near the high of what this trade ever offered.`, 16);
  } else if (capture >= 0.55) {
    push("Exit", mark("good"), `Kept ${Math.round(capture * 100)}% of the ${Math.round(i.mfePips)} pips it offered.`, 8);
  } else if (capture >= 0.3) {
    push("Exit", mark("acceptable"), `Kept ${Math.round(capture * 100)}% — ${Math.round(i.mfePips - i.pips)} pips of the best was given back before getting out.`, -6);
  } else {
    push("Exit", mark("poor"), `Only ${Math.round(capture * 100)}% of the move was kept. It was ${Math.round(i.mfePips)} pips onside and closed at ${Math.round(i.pips)}.`, -16);
  }

  /* ── ACTING ON THE CHARACTER CHANGE. The timing question that matters. ── */
  const chAt = at("TRADE_THESIS_WEAKENING") ?? at("TRADE_THESIS_INVALIDATED");
  const closedAt = i.openedAt + i.heldMs;
  if (chAt) {
    const lagMin = (closedAt - chAt) / 60_000;
    /*
     * REACTION TIME IS MEASURED IN BARS OF THE DECIDING CHART, not as a fraction of the trade's patience.
     *
     * The first version used the follow-through window, and renaming INTRADAY to HOLD exposed why that
     * was wrong: HOLD's follow-through is longer, so the same seventy minutes of sitting flipped from
     * "poor" to "good" purely because a policy number moved. Nothing about the trader's behaviour had
     * changed, which means the measure was not measuring behaviour.
     *
     * Bars of the deciding timeframe is the honest unit. Three bars is reacting; eight is sitting. On a
     * QUICK trade deciding on the 1-minute that is three minutes; on a SWING deciding on the hourly it is
     * three hours. Both are the same judgement, correctly scaled.
     */
    const barMin = TF_MINUTES[pol.decisive[0]] ?? 5;
    const bars = lagMin / barMin;
    if (bars <= 3) {
      push("Reacting", mark("excellent"), `Out ${Math.round(lagMin)} minutes — about ${bars.toFixed(1)} ${pol.decisive[0]} bars — after the character changed. That is what protects profit.`, 12);
    } else if (bars <= 8) {
      push("Reacting", mark("good"), `Closed ${Math.round(lagMin)} minutes after the character changed, inside what a ${pol.label} trade is allowed to take.`, 5);
    } else {
      push("Reacting", mark("poor"), `The character changed ${Math.round(lagMin)} minutes — ${Math.round(bars)} ${pol.decisive[0]} bars — before this was closed. The warning was there and it was sat through.`, -14);
    }
  } else {
    push("Reacting", null, "The character never changed while this was open, so there was nothing to react to.", 0);
  }

  /* ── WHAT HAPPENED NEXT. Null until the second look has been taken. ───── */
  if (i.continuationPips == null) {
    push("After the exit", null, "Not measured yet — I'll look again once gold has had time to answer.", 0);
  } else if (i.continuationPips > pol.noiseFloorPips) {
    push("After the exit", mark("acceptable"), `Gold went another ${Math.round(i.continuationPips)} pips our way after we were out. This was closed early.`, -8);
  } else if (i.continuationPips < -pol.noiseFloorPips) {
    push("After the exit", mark("excellent"), `Gold went ${Math.abs(Math.round(i.continuationPips))} pips against us after we were out. The exit was well timed.`, 12);
  } else {
    push("After the exit", mark("good"), "Gold went nowhere after the exit. Nothing was left behind.", 4);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  /* ── THE VERDICT. Process and outcome are judged separately, on purpose. ── */
  const looseProcess = lines.some((l) => l.mark === "poor");
  const verdict: TradeGrade["verdict"] =
    won && !looseProcess ? "well traded"
    : won ? "good outcome, loose process"
    : !won && !looseProcess ? "correct loss"
    : heatR != null && heatR >= 0.9 && i.mfePips < pol.noiseFloorPips ? "avoidable"
    : "mistimed";

  const worst = lines.filter((l) => l.mark === "poor").sort((a, b) => a.what.localeCompare(b.what))[0];
  const lesson = worst
    ? `${worst.what}: ${worst.note}`
    : lines.some((l) => l.mark === "acceptable")
      ? `${lines.find((l) => l.mark === "acceptable")!.what}: ${lines.find((l) => l.mark === "acceptable")!.note}`
      : null;

  return { score, verdict, lines, lesson, capture: capture == null ? null : +capture.toFixed(2) };
}

/** THE BRAIN's account of the trade, built from the grade. Read aloud unchanged. */
export function gradeNarrative(g: TradeGrade, i: GradeInput): string {
  const won = i.pips > 0;
  const mins = Math.max(1, Math.round(i.heldMs / 60_000));
  const bits: string[] = [];

  bits.push(
    won
      ? `The ${i.side === "buy" ? "long" : "short"} worked — ${Math.round(i.pips)} pips${i.r != null ? `, ${i.r}R` : ""} over ${mins} minutes.`
      : `The ${i.side === "buy" ? "long" : "short"} lost ${Math.abs(Math.round(i.pips))} pips${i.r != null ? `, ${Math.abs(i.r)}R` : ""} over ${mins} minutes.`,
  );

  const best = g.lines.find((l) => l.mark === "excellent");
  if (best) bits.push(`${best.what.toLowerCase()} was the best part of it: ${best.note.charAt(0).toLowerCase()}${best.note.slice(1)}`);

  if (g.lesson) bits.push(`The thing worth doing differently — ${g.lesson.charAt(0).toLowerCase()}${g.lesson.slice(1)}`);
  else bits.push("There is nothing here I would have done differently.");

  bits.push(
    g.verdict === "well traded" ? "Well traded."
    : g.verdict === "good outcome, loose process" ? "It paid, but the process was looser than the result suggests."
    : g.verdict === "correct loss" ? "That is a correct loss — the idea was wrong, the execution was not."
    : g.verdict === "avoidable" ? "This one was avoidable."
    : "Mistimed rather than misread.",
  );

  return bits.join(" ");
}

/* ── storage ────────────────────────────────────────────────────────────── */

const c = () => db();

/** How long to wait before asking what gold did after the exit. */
const FOLLOW_UP_MS = 45 * 60_000;

/**
 * Grade a report that has just been written, and schedule its second look.
 *
 * Deliberately best-effort: a grading failure must never be able to affect a position or an order. The
 * trade is already closed and the money is already decided by the time this runs.
 */
export async function gradeReport(userId: string, positionId: string): Promise<TradeGrade | null> {
  const db0 = c();
  if (!db0) return null;
  try {
    const { data: rep } = await db0.from("cc_trade_reports")
      .select("*").eq("user_id", userId).eq("position_id", positionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!rep) return null;
    const r = rep as Record<string, unknown>;

    const { data: pos } = await db0.from("cc_positions")
      .select("opened_at, init_stop, entry, pip_size").eq("id", positionId).maybeSingle();
    const p = (pos ?? {}) as { opened_at?: string; init_stop?: number; entry?: number; pip_size?: number };

    const { data: evs } = await db0.from("cc_position_events")
      .select("at, code").eq("position_id", positionId).order("at", { ascending: true }).limit(200);

    const pipSize = p.pip_size ?? 0.1;
    const riskPips = p.init_stop != null && p.entry != null
      ? Math.abs(p.entry - p.init_stop) / pipSize
      : null;

    const input: GradeInput = {
      side: (r.side as Side) ?? "buy",
      style: styleOf(String(r.style ?? "")),
      entry: Number(r.entry ?? 0),
      exit: Number(r.exit_price ?? 0),
      pips: Number(r.pips ?? 0),
      r: r.r != null ? Number(r.r) : null,
      mfePips: Number(r.mfe_pips ?? 0),
      maePips: Number(r.mae_pips ?? 0),
      riskPips,
      heldMs: Number(r.held_ms ?? 0),
      partials: (r.partials as GradeInput["partials"]) ?? [],
      events: ((evs ?? []) as { at: string; code: string }[]).map((e) => ({ at: Date.parse(e.at), code: e.code })),
      openedAt: p.opened_at ? Date.parse(p.opened_at) : Date.now() - Number(r.held_ms ?? 0),
      exitReason: (r.exit_reason as string) ?? null,
      continuationPips: null,
    };

    const grade = gradeTrade(input);
    await db0.from("cc_trade_reports").update({
      grade,
      narrative: gradeNarrative(grade, input),
      graded_at: new Date().toISOString(),
      follow_up_at: new Date(Date.now() + FOLLOW_UP_MS).toISOString(),
    }).eq("id", r.id as string);

    return grade;
  } catch {
    return null;   // the trade is already closed; grading must never be load-bearing
  }
}

/**
 * The second look: what did gold actually do after we got out?
 *
 * Run from the worker, which is the only thing with a reliable clock. Without this, "did we close too
 * early?" is a question the system can ask and never answer.
 */
export async function applyFollowUps(price: number | null, limit = 10): Promise<number> {
  const db0 = c();
  if (!db0 || price == null) return 0;
  const { data } = await db0.from("cc_trade_reports")
    .select("id, user_id, position_id, side, exit_price, style, pips, r, mfe_pips, mae_pips, held_ms, partials, entry, exit_reason")
    .lte("follow_up_at", new Date().toISOString())
    .is("pips_after_exit", null)
    .limit(limit);

  const rows = (data ?? []) as Record<string, unknown>[];
  for (const r of rows) {
    const side = (r.side as Side) ?? "buy";
    const exit = Number(r.exit_price ?? 0);
    if (!(exit > 0)) continue;
    // Positive = gold kept going the way the trade wanted after we were out.
    const continuation = ((side === "buy" ? price - exit : exit - price)) / 0.1;
    const verdict =
      continuation > 30 ? "closed early"
      : continuation < -30 ? "well timed"
      : "neutral";
    await db0.from("cc_trade_reports").update({
      pips_after_exit: +continuation.toFixed(1),
      continuation_verdict: verdict,
    }).eq("id", r.id as string);
  }
  return rows.length;
}
