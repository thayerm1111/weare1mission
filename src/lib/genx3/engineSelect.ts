/**
 * Which GENX brain may trade. GENX_ENGINE=genx3 (default since 09-16, owner: "I only want
 * GENX 3.0 trading, shut down 2.0") blocks every GENX 2.0 entry point: the 5-min scan, the
 * fast watch, owner levels and any placement that does not carry origin "genx3".
 * GENX_ENGINE=genx2 is the rollback.
 */
export type GenxEngine = "genx2" | "genx3";
export function activeEngine(): GenxEngine {
  return String(process.env.GENX_ENGINE ?? "genx3").trim().toLowerCase() === "genx2" ? "genx2" : "genx3";
}
export const genx2Active = () => activeEngine() === "genx2";
export const genx3Active = () => activeEngine() === "genx3";
