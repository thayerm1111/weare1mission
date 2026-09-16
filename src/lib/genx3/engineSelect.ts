/**
 * Which GENX brain may trade (GENX_ENGINE env; code default below).
 *   genx1 — the original engine (GENX 2.0 additions forced off). Owner 09-16: "turn on all
 *           accounts to GENX 1.0 until the new version is finished". CURRENT DEFAULT.
 *   genx2 — the same pipeline with the GENX 2.0 flags honoured (GENX2_ENABLED / GENX2_FAMILIES).
 *   genx3 — the GENX 3.x engine (worker loop); every legacy entry point is blocked.
 * genx1 and genx2 share the legacy pipeline (scan, watch, owner levels, origin "genx2").
 */
export type GenxEngine = "genx1" | "genx2" | "genx3";
const DEFAULT_ENGINE: GenxEngine = "genx1";
export function activeEngine(): GenxEngine {
  const v = String(process.env.GENX_ENGINE ?? "").trim().toLowerCase();
  return v === "genx1" || v === "genx2" || v === "genx3" ? v : DEFAULT_ENGINE;
}
/** Legacy (GENX 1.0 / 2.0) pipeline active. */
export const genx2Active = () => activeEngine() !== "genx3";
export const genx1Active = () => activeEngine() === "genx1";
export const genx3Active = () => activeEngine() === "genx3";
/** Does a placement from this origin match the selected engine? */
export function originAllowed(origin: "genx2" | "genx3" | undefined): boolean {
  // GENX 3.x placements are governed by genx3_control (mode + scope), so they are allowed under any
  // engine selection; the legacy pipeline only runs when it is the selected engine.
  return (origin ?? "genx2") === "genx3" ? true : genx2Active();
}

/** Which GENX 3.x brain a genx3_control.strategy_version selects; null = unknown (fail closed). */
export function selectBrain(version: string | null | undefined): "3.1.0" | "3.2.0" | null {
  return version === "3.1.0" || version === "3.2.0" ? version : null;
}
/** GENX 3.x account isolation. A 3.x signal reaches ONLY whitelisted accounts; a legacy signal never
 *  reaches an account running 3.x. Pure, so it is unit-tested. */
export function genx3AccountFilter<T>(list: T[], idOf: (x: T) => string, sig: { origin?: "genx2" | "genx3"; onlyAccountIds?: string[] | null }, reservedAccounts: Set<string>): T[] {
  if (sig.onlyAccountIds) { const allow = new Set(sig.onlyAccountIds.map(String)); return list.filter((x) => allow.has(String(idOf(x)))); }
  if ((sig.origin ?? "genx2") !== "genx3" && reservedAccounts.size) return list.filter((x) => !reservedAccounts.has(String(idOf(x))));
  return list;
}
