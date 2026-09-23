import type { AuricConfig } from "../config/defaults";
import type { Bar, Pivot, Side } from "../core/types";
import { roundToStep } from "../core/decimal";
import { tightenedStop } from "./protection";

export type ManagedPosition = {
  side: Side; entry: number; stop: number; target: number; qty: number; openedAt: number; initialRisk: number;
  managementVersion: string; setupFamily: string; invalidation: number; breakevenDone: boolean;
};
export type ManagementAction =
  | { kind: "none"; note?: string }
  | { kind: "modify_stop"; newStop: number; reason: string; breakeven?: boolean }
  | { kind: "close"; reason: string; code: "TIME_STOP" | "SESSION_END" | "SETUP_INVALIDATED" };

/**
 * Rule-defined management. No LLM. Never widens a stop. Partials are disabled unless explicitly
 * enabled AND the position can be split at the broker's minimum close size.
 */
export function manage(
  p: ManagedPosition, bid: number, ask: number, tick: number, minStopDistance: number, m1: Bar[], m5Highs: Pivot[], m5Lows: Pivot[],
  now: number, cfg: AuricConfig["protection"], minutesToSessionEnd: number | null, spread: number,
): ManagementAction {
  const mark = p.side === "buy" ? bid : ask;
  const r = p.initialRisk > 0 ? (p.side === "buy" ? mark - p.entry : p.entry - mark) / p.initialRisk : 0;

  if (minutesToSessionEnd != null && minutesToSessionEnd <= cfg.closeBeforeSessionEndMin)
    return { kind: "close", code: "SESSION_END", reason: `${minutesToSessionEnd} min to session end/maintenance (policy: flatten at ${cfg.closeBeforeSessionEndMin})` };
  if (now - p.openedAt >= cfg.timeStopMinutes * 60_000)
    return { kind: "close", code: "TIME_STOP", reason: `held ${Math.round((now - p.openedAt) / 60_000)} min ≥ ${cfg.timeStopMinutes} min time-stop (${p.managementVersion})` };

  // Early exit when the setup is invalidated by a CLOSED M1 bar beyond the invalidation level while price is still inside the stop.
  const last = m1[m1.length - 1];
  if (last && (p.side === "buy" ? last.c < p.invalidation : last.c > p.invalidation))
    return { kind: "close", code: "SETUP_INVALIDATED", reason: `M1 closed ${last.c.toFixed(2)} beyond invalidation ${p.invalidation.toFixed(2)} before the stop` };

  // Cost-adjusted breakeven after ≥ +1R, only when structure supports it (a confirmed M5 pivot now sits between entry and price).
  if (cfg.breakevenEnabled && !p.breakevenDone && r >= cfg.breakevenAtR) {
    const supporting = p.side === "buy" ? m5Lows.some((pv) => pv.price > p.entry && pv.price < mark) : m5Highs.some((pv) => pv.price < p.entry && pv.price > mark);
    if (supporting) {
      const costAdj = spread + 2 * tick;
      const be = roundToStep(p.side === "buy" ? p.entry + costAdj : p.entry - costAdj, tick);
      const ns = tightenedStop(p.side, p.stop, be, bid, ask, tick, minStopDistance);
      if (ns != null) return { kind: "modify_stop", newStop: ns, breakeven: true, reason: `+${r.toFixed(2)}R with a confirmed M5 ${p.side === "buy" ? "low" : "high"} between entry and price → cost-adjusted stop ${ns.toFixed(2)} (entry ${p.entry.toFixed(2)} + costs; not a guaranteed breakeven)` };
    }
  }
  // Trail only behind CONFIRMED structure, after breakeven.
  if (cfg.trailEnabled && p.breakevenDone) {
    const pv = p.side === "buy" ? m5Lows.filter((x) => x.price > p.stop && x.price < mark).sort((a, b) => b.price - a.price)[0] : m5Highs.filter((x) => x.price < p.stop && x.price > mark).sort((a, b) => a.price - b.price)[0];
    if (pv) {
      const buf = Math.max(2 * spread, tick);
      const proposed = roundToStep(p.side === "buy" ? pv.price - buf : pv.price + buf, tick);
      const ns = tightenedStop(p.side, p.stop, proposed, bid, ask, tick, minStopDistance);
      if (ns != null) return { kind: "modify_stop", newStop: ns, reason: `trail behind confirmed M5 ${pv.kind} ${pv.price.toFixed(2)} (buffer ${buf.toFixed(2)})` };
    }
  }
  return { kind: "none" };
}

/** Partial-close feasibility: respects minimum close size and the remaining size. */
export function partialCloseQty(qty: number, fraction: number, minLot: number, lotStep: number): number | null {
  const part = roundToStep(qty * fraction, lotStep, "down");
  if (part < minLot) return null;
  if (qty - part < minLot) return null;
  return part;
}
