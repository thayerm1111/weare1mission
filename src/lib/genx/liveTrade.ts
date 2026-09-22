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

export function gradeOf(pips: number | null): "WIN" | "LESSON" | "BREAKEVEN" {
  if (pips == null || pips === 0) return "BREAKEVEN";
  return pips > 0 ? "WIN" : "LESSON";
}

