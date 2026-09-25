import type { InstrumentSpec, Quote, Side } from "../core/types";
import type { BrokerPort, BrokerPosition } from "./port";

/**
 * A broker simulator whose purpose is to FAIL on demand.
 *
 * The paths worth testing are the ones a live demo account will not reproduce: a submit that times
 * out after the exchange accepted it, an amendment rejected inside an HTTP 200, a close that
 * completes later, a position that vanishes. Each of those is a scripted behaviour here.
 */
export type SimScript = {
  /** Submit returns an unknown outcome, but the order DID reach the broker. */
  submitTimesOutButFills?: boolean;
  /** Submit is rejected outright. */
  submitRejects?: string;
  /** Submit fails because the session is closed. */
  submitSessionClosed?: boolean;
  /** The broker acknowledges with an order id only; the position must be resolved. */
  ackWithoutPositionId?: boolean;
  /** Native protection is silently not attached, so the verifier has to notice. */
  dropProtectionOnEntry?: boolean;
  /** Every amendment is rejected. */
  amendAlwaysRejects?: string;
  /** The close request is accepted but the position stays open (a delayed close). */
  closeIsDelayed?: boolean;
  /** Close fails outright. */
  closeFails?: string;
  /** The position disappears from the broker after the acknowledgement. */
  positionVanishes?: boolean;
  /** Positions cannot be read at all. */
  positionsUnreadable?: string;
};

export class SimulatedBroker implements BrokerPort {
  readonly calls: string[] = [];
  private rows: BrokerPosition[] = [];
  private nextId = 1;
  private orderToPosition = new Map<string, string>();

  constructor(
    private readonly state: { bid: number; ask: number; equity: number; freeMargin: number; currency: string; spec: InstrumentSpec },
    private readonly script: SimScript = {},
  ) {}

  setPrice(bid: number, ask: number) { this.state.bid = bid; this.state.ask = ask; }
  openRows(): BrokerPosition[] { return this.rows.map((r) => ({ ...r })); }

  async quote(): Promise<{ ok: true; quote: Quote } | { ok: false; error: string }> {
    this.calls.push("quote");
    return { ok: true, quote: { source: "broker", bid: this.state.bid, ask: this.state.ask, providerTs: null, providerTsPrecision: "none", receivedAt: Date.now(), seq: null } };
  }

  async spec() {
    this.calls.push("spec");
    return { ok: true as const, spec: this.state.spec, missing: [] as string[] };
  }

  async accountState() {
    this.calls.push("accountState");
    return { ok: true as const, equity: this.state.equity, freeMargin: this.state.freeMargin, currency: this.state.currency };
  }

  async submit(o: { side: Side; qty: number; stopLoss: number | null; takeProfit: number | null; strategyId: string }) {
    this.calls.push("submit");
    if (this.script.submitSessionClosed) return { ok: false as const, error: "market is closed for this instrument", uncertain: false, sessionClosed: true };
    if (this.script.submitRejects) return { ok: false as const, error: this.script.submitRejects, uncertain: false };

    const positionId = `P${this.nextId++}`;
    const orderId = `O${this.nextId++}`;
    this.rows.push({
      positionId,
      strategyId: o.strategyId,
      side: o.side,
      qty: o.qty,
      entry: o.side === "buy" ? this.state.ask : this.state.bid,
      stopLoss: this.script.dropProtectionOnEntry ? null : o.stopLoss,
      takeProfit: this.script.dropProtectionOnEntry ? null : o.takeProfit,
    });
    this.orderToPosition.set(orderId, positionId);
    if (this.script.positionVanishes) this.rows = this.rows.filter((r) => r.positionId !== positionId);

    // The order reached the exchange, but we never heard back.
    if (this.script.submitTimesOutButFills) return { ok: false as const, error: "timeout", uncertain: true };
    if (this.script.ackWithoutPositionId) return { ok: true as const, orderId, positionId: null };
    return { ok: true as const, orderId, positionId };
  }

  async resolvePosition(orderId: string) {
    this.calls.push("resolvePosition");
    const positionId = this.orderToPosition.get(orderId);
    if (!positionId) return null;
    const row = this.rows.find((r) => r.positionId === positionId);
    return { positionId, fillPrice: row?.entry ?? null, filledQty: row?.qty ?? null };
  }

  async positions() {
    this.calls.push("positions");
    if (this.script.positionsUnreadable) return { ok: false as const, error: this.script.positionsUnreadable };
    return { ok: true as const, rows: this.openRows() };
  }

  async amend(positionId: string, mod: { stopLoss?: number | null; takeProfit?: number | null }) {
    this.calls.push(`amend:${positionId}:${JSON.stringify(mod)}`);
    if (this.script.amendAlwaysRejects) return { ok: false as const, error: this.script.amendAlwaysRejects, uncertain: false };
    const row = this.rows.find((r) => r.positionId === positionId);
    if (!row) return { ok: false as const, error: "no such position", uncertain: false };
    // `undefined` leaves a leg alone; `null` removes it. Exactly the broker's semantics.
    if (mod.stopLoss !== undefined) row.stopLoss = mod.stopLoss;
    if (mod.takeProfit !== undefined) row.takeProfit = mod.takeProfit;
    return { ok: true as const };
  }

  async close(positionId: string, qty?: number) {
    this.calls.push(`close:${positionId}:${qty ?? 0}`);
    if (this.script.closeFails) return { ok: false as const, error: this.script.closeFails, uncertain: false };
    if (this.script.closeIsDelayed) return { ok: true as const };
    const row = this.rows.find((r) => r.positionId === positionId);
    if (!row) return { ok: true as const };
    if (qty && qty > 0 && row.qty != null && qty < row.qty) row.qty = Number((row.qty - qty).toFixed(6));
    else this.rows = this.rows.filter((r) => r.positionId !== positionId);
    return { ok: true as const };
  }

  async cancelOrder(orderId: string) {
    this.calls.push(`cancelOrder:${orderId}`);
    return { ok: true as const };
  }
}

/** An in-memory Store so the submission machine can be driven without a database. */
export class MemoryStore {
  states: Array<{ state: string; patch?: Record<string, unknown> }> = [];
  events: Array<Record<string, unknown>> = [];
  opened: Array<Record<string, unknown>> = [];

  setState = async (_id: string, state: string, patch?: Record<string, unknown>) => {
    this.states.push({ state, patch });
  };
  recordBrokerEvent = async (_id: string, e: Record<string, unknown>) => {
    this.events.push(e);
  };
  openPosition = async (_id: string, p: Record<string, unknown>) => {
    this.opened.push(p);
  };
  get finalState() { return this.states[this.states.length - 1]?.state ?? null; }
  get sequence() { return this.states.map((s) => s.state); }
}

export const goldSpec: InstrumentSpec = {
  tradableInstrumentId: "1", tradeRouteId: "TRADE", infoRouteId: "INFO", brokerSymbol: "XAUUSD",
  contractSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 50, tickSize: 0.01, tickValue: 1,
  priceDecimals: 2, currency: "USD", minStopDistance: 0.1, raw: null,
};
