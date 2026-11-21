/**
 * WHAT A TICKET WILL ACTUALLY PLACE ON EACH ACCOUNT (owner 11-20 brief §9: "Verify and retain the existing
 * per-account sizing contract, and show per-account settings/results from the actual ticket service. Never
 * display one account's equity or lot size as though it applies to every account").
 *
 * The audit found the ticket's preview and its placement size an account differently. The preview sized every
 * account at the ticket's own risk; the placement (executor.placeOnActiveAccounts, placeOne) uses the account's
 * own risk when it has one, caps it at 2% under $2,000 of equity and at 0.5% at $600 or less, and takes the
 * broker's minimum lot rather than skip. So a $500 account previewed at 1% was placed at 0.5% — half the size
 * the ticket showed.
 *
 * This is that placement rule, written out so the preview can show it. It decides nothing: the executor keeps
 * its own copy and places exactly as before. tests/flow-ticket-sizing.test.ts reads the executor's source and
 * fails if its rule ever moves away from this one.
 */
import { sizeFromRisk } from "@/lib/flow/sizing";

/** The risk % the executor places this account at. */
export function placementRisk(accountRiskPct: number | null | undefined, ticketRiskPct: number, equity: number): number {
  let r = accountRiskPct != null && accountRiskPct > 0 ? accountRiskPct : ticketRiskPct;
  if (equity < 2000) r = Math.min(r, 2);
  if (equity <= 600) r = Math.min(r, 0.5);
  return r;
}

export type PlacementSize = {
  riskPct: number;
  /** The account's own risk was used, not the ticket's. */
  own: boolean;
  /** The small-account cap lowered it. */
  capped: boolean;
  lots: number | null;
  estLossAtStop: number | null;
  reason?: string;
};

/** The size the executor would place on one account, before its safety checks (which can still skip it). */
export function placementSize(o: { canonical: string; entry: number; stop: number; equity: number | null; accountRiskPct?: number | null; ticketRiskPct: number }): PlacementSize | null {
  if (o.equity == null || !Number.isFinite(o.equity)) return null;
  const own = o.accountRiskPct != null && o.accountRiskPct > 0;
  const wanted = own ? (o.accountRiskPct as number) : o.ticketRiskPct;
  const riskPct = placementRisk(o.accountRiskPct, o.ticketRiskPct, o.equity);
  const s = sizeFromRisk({ canonical: o.canonical, entry: o.entry, stop: o.stop, equity: o.equity, riskPct, floorToMinLot: true });
  return {
    riskPct, own, capped: riskPct < wanted,
    lots: s.ok && s.lots > 0 ? s.lots : null,
    estLossAtStop: s.ok && typeof s.estLossAtStop === "number" ? s.estLossAtStop : null,
    reason: s.ok ? undefined : s.reason,
  };
}
