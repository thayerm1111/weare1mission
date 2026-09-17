/** Live trade card helpers (owner 09-17). Pure, unit-tested. */
export function setupLabel(dedupeKey: string | null | undefined): string {
  const k = String(dedupeKey ?? "");
  if (k.startsWith("pd:") && k.includes(":PDH:")) return "PDH Breakout · Retest";
  if (k.startsWith("pd:") && k.includes(":PDL:")) return "PDL Breakdown · Retest";
  if (k.startsWith("quick:")) return "Pullback Entry";
  return "GENX Entry";
}
export function gradeOf(pips: number | null): "WIN" | "LESSON" | "BREAKEVEN" {
  if (pips == null || pips === 0) return "BREAKEVEN";
  return pips > 0 ? "WIN" : "LESSON";
}

