/** Live trade card helpers (owner 09-17). Pure, unit-tested. */
export function setupLabel(dedupeKey: string | null | undefined): string {
  const k = String(dedupeKey ?? "");
  if (k.startsWith("pd:") && k.includes(":PDH:")) return "PDH Breakout · Retest";
  if (k.startsWith("pd:") && k.includes(":PDL:")) return "PDL Breakdown · Retest";
  if (k.startsWith("quick:")) return "Pullback Entry";
  return "GENX Entry";
}
/**
 * A member's own trade, graded (owner 09-22): WIN when any of their accounts closed it in profit or at
 * break-even (hand-closed included); LESSON only when every account hit its full stop; CLOSED when they
 * closed it by hand at a loss. `pips` is the best account's result for a win, otherwise the average.
 */
export function memberGrade(f: { avgPips: number | null; bestPips: number | null; anyBreakeven: boolean; allStops: boolean }): { grade: "WIN" | "LESSON" | "CLOSED"; pips: number | null } {
  if ((f.bestPips ?? -1) > 0 || f.anyBreakeven) return { grade: "WIN", pips: Math.max(0, f.bestPips ?? 0) };
  if (f.allStops) return { grade: "LESSON", pips: f.avgPips };
  return { grade: "CLOSED", pips: f.avgPips };
}

/**
 * WIN STREAK (owner 09-23: "if there's three wins in a row, I wanted to say streak three … as soon as
 * there's one lesson, it goes back to no streak yet").
 *
 * Counts consecutive WINs from the newest trade backwards and stops at the first one that is not a win
 * — a Lesson or a hand-close at a loss both end it. Only wins are counted, so a streak of 7 means seven
 * winning trades in a row on this member's own accounts, with nothing else in between.
 */
export function winStreak(grades: readonly string[]): number {
  let n = 0;
  for (const g of grades) { if (g === "WIN") n++; else break; }
  return n;
}

/**
 * The streak and what it is worth (owner 09-23: "add the total pip count of the streak").
 *
 * Same rule, one pass: the consecutive wins from the newest trade backwards, and the pips those wins
 * made added together. A break-even win contributes 0 pips and still extends the streak — it was a win
 * by the owner's own rule, it just did not pay.
 */
export function winStreakOf(entries: readonly { grade: string; pips: number | null }[]): { count: number; pips: number } {
  let count = 0, pips = 0;
  for (const e of entries) {
    if (e.grade !== "WIN") break;
    count++;
    pips += Number.isFinite(Number(e.pips)) ? Number(e.pips) : 0;
  }
  return { count, pips: Math.round(pips) };
}

/**
 * THE RECORD (owner 09-23: "add best streak and how many pips the record is").
 *
 * The longest run of consecutive wins anywhere in the member's record, and what that run made. Ties on
 * length go to the run that made more pips, so the number beside the record is always the best version
 * of it. Same window as the card itself.
 */
export function bestStreakOf(entries: readonly { grade: string; pips: number | null }[]): { count: number; pips: number } {
  let best = { count: 0, pips: 0 }, run = { count: 0, pips: 0 };
  for (const e of entries) {
    if (e.grade !== "WIN") { run = { count: 0, pips: 0 }; continue; }
    run = { count: run.count + 1, pips: run.pips + (Number.isFinite(Number(e.pips)) ? Number(e.pips) : 0) };
    if (run.count > best.count || (run.count === best.count && run.pips > best.pips)) best = run;
  }
  return { count: best.count, pips: Math.round(best.pips) };
}

export function gradeOf(pips: number | null): "WIN" | "LESSON" | "BREAKEVEN" {
  if (pips == null || pips === 0) return "BREAKEVEN";
  return pips > 0 ? "WIN" : "LESSON";
}

