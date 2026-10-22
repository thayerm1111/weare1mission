import { closeOf, type Candle } from "./candles";
import type { EffectiveConfig } from "./config";
import type { DmiEvent, DmiMode } from "./dmi";
import { initialState, step, type Decision, type EngineEvent, type EngineState, type ArmedSetup, type Confirmation } from "./engine";
import { acceptEntry, draftSignal, settle, type QuoteSource, type SignalRecord } from "./signals";
import type { CashtrapSymbol } from "./symbols";
import type { ManualZoneInput } from "./zones";

/**
 * HISTORICAL REPLAY — the live engine's own `step()`, run candle by candle over stored history.
 *
 * Nothing here looks ahead: candle i is decided with candles up to i only, zones known at its open,
 * DMI events computed (or received) by its decision time. Manual zones apply only from when they were
 * marked. Signals are SIMULATED records: the reference entry and the settlement come from the quote
 * source given (recorded ticks, or the labelled bar-open proxy), with the same entry window, expiry
 * and tie rules as live.
 */
export type SetupRecord = {
  id: string;
  symbol: CashtrapSymbol;
  direction: ArmedSetup["direction"];
  exhaustionT: number;
  armedAt: number;
  status: "armed" | "confirmed" | "cancelled" | "expired";
  reason: string | null;
  endedAt: number | null;
  confirmT: number | null;
  published: boolean | null;
  suppressedReason: string | null;
  setup: ArmedSetup;
};

export type ReplayOptions = {
  symbol: CashtrapSymbol;
  candles: Candle[];
  config: EffectiveConfig;
  manualZones?: ManualZoneInput[];
  dmiMode: DmiMode;
  dmiAvailable: boolean;
  externalEvents?: DmiEvent[];
  /** decidedAt = candle close + this (live uses the feed settle time). */
  decisionLatencyMs: number;
  /** publishedAt = decidedAt + this. */
  publishLatencyMs: number;
  quotes: QuoteSource | null;
  /** First candle index to decide; earlier candles are warmup. Default: the configured warmup. */
  startIndex?: number;
  initialState?: EngineState;
};

export type ReplayResult = { decisions: Decision[]; setups: SetupRecord[]; signals: SignalRecord[]; state: EngineState };

/** Apply one step's events to the setup ledger (shared by replay and the live service). */
export function applyEvents(ledger: Map<string, SetupRecord>, events: EngineEvent[]): Confirmation[] {
  const toPublish: Confirmation[] = [];
  for (const e of events) {
    if (e.type === "armed") {
      ledger.set(e.setup.id, { id: e.setup.id, symbol: e.setup.symbol, direction: e.setup.direction, exhaustionT: e.setup.exhaustionT, armedAt: e.setup.armedAt, status: "armed", reason: null, endedAt: null, confirmT: null, published: null, suppressedReason: null, setup: e.setup });
    } else {
      const id = e.type === "confirmed" ? e.confirmation.setup.id : e.setup.id;
      const r = ledger.get(id);
      if (!r) continue;
      if (e.type === "confirmed") {
        r.status = "confirmed"; r.endedAt = e.confirmation.decidedAt; r.confirmT = e.confirmation.confirmT; r.published = e.publish; r.suppressedReason = e.suppressedReason;
        r.reason = e.publish ? "confirmed by DMI" : `confirmed, not published: ${e.suppressedReason}`;
        if (e.publish) toPublish.push(e.confirmation);
      } else {
        r.status = e.type; r.reason = e.reason; r.endedAt = e.at;
      }
    }
  }
  return toPublish;
}

export async function replay(o: ReplayOptions): Promise<ReplayResult> {
  const A = o.config.assumptions;
  const start = Math.max(o.startIndex ?? A.data.minWarmupCandles - 1, 0);
  let state = o.initialState ?? initialState(o.symbol);
  const decisions: Decision[] = [];
  const ledger = new Map<string, SetupRecord>();
  const signals: SignalRecord[] = [];
  for (let i = start; i < o.candles.length; i++) {
    if (state.lastT != null && o.candles[i].t <= state.lastT) continue;
    const from = Math.max(0, i + 1 - A.data.windowCandles - A.data.contiguityCandles - 2);
    const decidedAt = closeOf(o.candles[i].t) + o.decisionLatencyMs;
    const out = step(state, {
      candles: o.candles.slice(from, i + 1), manualZones: o.manualZones ?? [], dmiMode: o.dmiMode, dmiAvailable: o.dmiAvailable,
      externalEvents: o.externalEvents, decidedAt, config: o.config,
    });
    state = out.state;
    decisions.push(out.decision);
    for (const c of applyEvents(ledger, out.events)) {
      let sig = draftSignal(c, decidedAt + o.publishLatencyMs, o.config, "simulated");
      const q = o.quotes ? await o.quotes.firstQuote(o.symbol, sig.entryWindowStart, sig.entryDeadline) : null;
      sig = acceptEntry(sig, q, o.config);
      if (sig.status === "active" && sig.expiryAt != null) {
        const sq = o.quotes ? await o.quotes.firstQuote(o.symbol, sig.expiryAt, sig.expiryAt + A.settlementToleranceSec * 1000) : null;
        sig = settle(sig, sq, o.config);
      }
      if (!o.quotes) sig.notes.push("no quote source: entry and outcome cannot be simulated");
      signals.push(sig);
    }
  }
  return { decisions, setups: [...ledger.values()], signals, state };
}
