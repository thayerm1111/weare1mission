/** Public Floor trade contract. No broker credentials or account settings leave the server. */
export const ACTIVE_TRADE_FRESH_MS = 30_000;
export type ActiveTradeScope = { accountId: string; environment: "live" | "demo" };
export type ActiveTradeAction = "close" | "partial" | "breakeven";
export type ActiveTradePlan = { allowed: boolean; reason: string | null; qty?: number; stop?: number };
export type ActivePartialPlan = ActiveTradePlan & { fraction: 0.25 | 0.5 };
export type ActiveTrade = {
  id: string; symbol: string; side: "buy" | "sell"; qty: number;
  entry: number | null; stop: number | null; target: number | null;
  pips: number | null; revision: string;
  quote: { bid: number | null; ask: number | null; at: string | null; state: "live" | "unavailable" };
  actions: { close: ActiveTradePlan; partial: ActivePartialPlan[]; breakeven: ActiveTradePlan };
};
export type ActiveTradesSnapshot = ActiveTradeScope & {
  ok: true; observedAt: string | null; state: "live" | "stale" | "unavailable";
  note: string | null; positions: ActiveTrade[];
};
export type ActiveTradeActionRequest = ActiveTradeScope & {
  positionId: string; action: ActiveTradeAction; fraction?: 0.25 | 0.5;
  revision: string; confirm: true;
};
export type ActiveTradeActionResponse = ActiveTradeScope & {
  ok: boolean; state: "confirmed" | "pending" | "refused"; message: string;
  positionId: string; action: ActiveTradeAction; needsConsent?: boolean;
};
