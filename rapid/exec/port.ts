import type { InstrumentSpec, Quote, Side } from "../core/types";

/**
 * The broker contract Rapid depends on.
 *
 * Everything execution-related is written against this interface rather than against TradeLocker
 * directly, for one reason: the failure paths — a timeout whose outcome is unknown, a protection
 * amendment that is rejected inside an HTTP 200, a close that completes later — are the parts most
 * likely to be wrong, and they are unreachable in a live test. A simulator that can be told to fail
 * in each of those specific ways is the only way to exercise them before real money does.
 *
 * The live implementation is `rapid/exec/tradelockerPort.ts`.
 */
export type BrokerPort = {
  quote(): Promise<{ ok: true; quote: Quote } | { ok: false; error: string }>;
  spec(): Promise<{ ok: true; spec: InstrumentSpec; missing: string[] } | { ok: false; error: string }>;
  accountState(): Promise<{ ok: true; equity: number | null; freeMargin: number | null; currency: string | null } | { ok: false; error: string }>;

  /**
   * Submit a protected market order. `uncertain` means the outcome is genuinely unknown and the
   * caller must reconcile — never resubmit.
   */
  submit(o: {
    side: Side;
    qty: number;
    stopLoss: number | null;
    takeProfit: number | null;
    strategyId: string;
  }): Promise<
    | { ok: true; orderId: string | null; positionId: string | null }
    | { ok: false; error: string; uncertain: boolean; sessionClosed?: boolean }
  >;

  /** Resolve the position an acknowledged order became. An acknowledgement is not a fill. */
  resolvePosition(orderId: string): Promise<{ positionId: string; fillPrice: number | null; filledQty: number | null } | null>;

  positions(): Promise<{ ok: true; rows: BrokerPosition[] } | { ok: false; error: string }>;

  /** `undefined` leaves a leg alone. `null` REMOVES it. */
  amend(positionId: string, mod: { stopLoss?: number | null; takeProfit?: number | null }): Promise<{ ok: true } | { ok: false; error: string; uncertain: boolean }>;

  /** `qty` omitted or 0 is a full close. */
  close(positionId: string, qty?: number): Promise<{ ok: true } | { ok: false; error: string; uncertain: boolean }>;

  cancelOrder(orderId: string): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type BrokerPosition = {
  positionId: string;
  strategyId: string | null;
  side: Side | null;
  qty: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
};
