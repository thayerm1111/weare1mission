import { callPut, type Confirmation, type Values, type ZoneSnap } from "./engine";
import type { EffectiveConfig } from "./config";
import { roundPrice, type CashtrapSymbol } from "./symbols";

/**
 * SIGNALS — timing, reference entry, expiry and outcome.
 *
 * TIMING. A confirmation exists at the close of its confirming candle; the signal is PUBLISHED when
 * the service records it (later). The entry window opens at publication and closes `maxEntryDelaySec`
 * after it. The REFERENCE ENTRY is the first quote observed at or after publication; if none arrives
 * by the deadline the signal is MISSED — it never instructs a late entry, and an entry is never
 * backdated to the confirming candle's close.
 *
 * EXPIRY. Two distinct modes:
 *   duration — expiry = accepted reference entry time + durationSec;
 *   fixed    — a contract clock time: the first `boundaryMinutes` boundary at least
 *              `minSecondsToExpiry` after the reference entry.
 * The provisional V1 expiry (5-minute duration) is a simulation default, not a confirmed contract.
 *
 * OUTCOME (binary, never pips or stop/target hits). Settlement is the first quote observed at or after
 * expiry, accepted only within `settlementToleranceSec`. CALL wins when settlement > entry; PUT wins
 * when settlement < entry; equal prices are a TIE, paid per the configured tie rule; no settlement
 * quote → UNRESOLVED, never an invented win or loss. Prices are compared at the instrument's precision.
 * Payout is tracked separately from direction and only when a payout rate has been configured.
 *
 * RECORD TYPES: "reference-feed" (live, against the market-data feed), "simulated" (replay), and
 * "broker-verified" (only with the broker's own entry and settlement records — none exist yet).
 */
export type Quote = { px: number; at: number; source: string };
export type RecordType = "reference-feed" | "simulated" | "broker-verified";
export type SignalStatus = "published" | "active" | "missed" | "settled";
export type SignalResult = "pending" | "missed" | "win" | "loss" | "tie" | "unresolved";

export type SignalRecord = {
  dedupeKey: string;
  setupId: string;
  symbol: CashtrapSymbol;
  direction: "CALL" | "PUT";
  setupCandleT: number;
  confirmationT: number;
  confirmedAt: number;
  publishedAt: number;
  entryWindowStart: number;
  entryDeadline: number;
  expiryMode: "duration" | "fixed";
  expiryDurationSec: number | null;
  expiryAt: number | null;
  referencePrice: number | null;
  referenceAt: number | null;
  referenceSource: string | null;
  settlementPrice: number | null;
  settlementAt: number | null;
  settlementSource: string | null;
  status: SignalStatus;
  result: SignalResult;
  recordType: RecordType;
  payoutRate: number | null;
  payout: number | null;
  exhaustionValues: Values;
  confirmationValues: Values;
  zone: ZoneSnap | null;
  strategyVersion: string;
  configVersion: string;
  notes: string[];
};

/** Setup identity: symbol, direction, exhaustion candle, strategy version. One signal per setup, ever. */
export const dedupeKeyOf = (c: Confirmation, strategyVersion: string): string => `${c.setup.symbol}:${callPut(c.setup.direction)}:${c.setup.exhaustionT}:${strategyVersion}`;

export function draftSignal(c: Confirmation, publishedAt: number, cfg: EffectiveConfig, recordType: RecordType): SignalRecord {
  const A = cfg.assumptions;
  if (publishedAt < c.confirmedAt) throw new Error("a signal cannot be published before its confirming candle closed");
  return {
    dedupeKey: dedupeKeyOf(c, cfg.strategyVersion), setupId: c.setup.id, symbol: c.setup.symbol, direction: callPut(c.setup.direction),
    setupCandleT: c.setup.exhaustionT, confirmationT: c.confirmT, confirmedAt: c.confirmedAt,
    publishedAt, entryWindowStart: publishedAt, entryDeadline: publishedAt + A.maxEntryDelaySec * 1000,
    expiryMode: A.expiry.mode, expiryDurationSec: A.expiry.mode === "duration" ? A.expiry.durationSec : null, expiryAt: null,
    referencePrice: null, referenceAt: null, referenceSource: null, settlementPrice: null, settlementAt: null, settlementSource: null,
    status: "published", result: "pending", recordType, payoutRate: A.payoutRate, payout: null,
    exhaustionValues: c.setup.values, confirmationValues: c.values, zone: c.setup.zone,
    strategyVersion: cfg.strategyVersion, configVersion: cfg.configVersion, notes: [],
  };
}

/** The expiry time for a reference entry accepted at `entryAt`. */
export function expiryFor(entryAt: number, cfg: EffectiveConfig): number {
  const E = cfg.assumptions.expiry;
  if (E.mode === "duration") return entryAt + E.durationSec * 1000;
  const b = E.boundaryMinutes * 60_000;
  return Math.ceil((entryAt + E.minSecondsToExpiry * 1000) / b) * b;
}

/**
 * Accept (or miss) the reference entry. `q` must be the FIRST quote observed at or after publication.
 * A quote from before publication is refused — that would be a backdated entry.
 */
export function acceptEntry(s: SignalRecord, q: Quote | null, cfg: EffectiveConfig): SignalRecord {
  const out: SignalRecord = { ...s, notes: [...s.notes] };
  if (q && q.at < s.publishedAt) {
    out.status = "missed"; out.result = "missed";
    out.notes.push(`quote from ${new Date(q.at).toISOString()} predates publication; entries are never backdated`);
    return out;
  }
  if (!q || q.at > s.entryDeadline || !(q.px > 0)) {
    out.status = "missed"; out.result = "missed";
    out.notes.push(q ? `first quote ${((q.at - s.publishedAt) / 1000).toFixed(1)} s after publication — past the ${((s.entryDeadline - s.publishedAt) / 1000).toFixed(0)} s entry window` : "no quote within the entry window");
    return out;
  }
  out.status = "active";
  out.referencePrice = roundPrice(s.symbol, q.px);
  out.referenceAt = q.at;
  out.referenceSource = q.source;
  out.expiryAt = expiryFor(q.at, cfg);
  return out;
}

/** Settle an active signal from the first quote observed at or after its expiry. */
export function settle(s: SignalRecord, q: Quote | null, cfg: EffectiveConfig): SignalRecord {
  const out: SignalRecord = { ...s, notes: [...s.notes] };
  if (s.status !== "active" || s.expiryAt == null || s.referencePrice == null) return out;
  const tol = cfg.assumptions.settlementToleranceSec * 1000;
  out.status = "settled";
  if (!q || q.at < s.expiryAt || q.at > s.expiryAt + tol || !(q.px > 0)) {
    out.result = "unresolved";
    out.notes.push(q ? `settlement quote ${((q.at - s.expiryAt) / 1000).toFixed(1)} s from expiry — outside the ${cfg.assumptions.settlementToleranceSec} s tolerance` : "no settlement quote");
    return out;
  }
  const px = roundPrice(s.symbol, q.px);
  out.settlementPrice = px;
  out.settlementAt = q.at;
  out.settlementSource = q.source;
  out.result = px === s.referencePrice ? "tie" : (s.direction === "CALL" ? px > s.referencePrice : px < s.referencePrice) ? "win" : "loss";
  out.payout = payoutFor(out.result, s.payoutRate, cfg.assumptions.tieRule);
  return out;
}

/** Net units per unit staked: +r for a win, −1 for a loss, a tie per the tie rule. Null without a payout rate. */
export function payoutFor(result: SignalResult, rate: number | null, tieRule: "refund" | "loss"): number | null {
  if (rate == null) return null;
  if (result === "win") return rate;
  if (result === "loss") return -1;
  if (result === "tie") return tieRule === "refund" ? 0 : -1;
  return null;
}

/* ── quote sources ────────────────────────────────────────────────────────────────────────────── */
export interface QuoteSource {
  /** The first quote observed at or after `fromMs` and no later than `toMs`, or null. */
  firstQuote(symbol: CashtrapSymbol, fromMs: number, toMs: number): Promise<Quote | null>;
  readonly label: string;
}

/** Replay from recorded ticks (e.g. an imported tick file). */
export class TickQuoteSource implements QuoteSource {
  readonly label = "recorded ticks";
  private bySymbol = new Map<string, Quote[]>();
  constructor(ticks: Array<{ symbol: CashtrapSymbol; px: number; at: number }>, source = "tick-file") {
    for (const t of ticks) {
      const a = this.bySymbol.get(t.symbol) ?? [];
      a.push({ px: t.px, at: t.at, source });
      this.bySymbol.set(t.symbol, a);
    }
    for (const a of this.bySymbol.values()) a.sort((x, y) => x.at - y.at);
  }
  async firstQuote(symbol: CashtrapSymbol, fromMs: number, toMs: number): Promise<Quote | null> {
    const a = this.bySymbol.get(symbol) ?? [];
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].at < fromMs) lo = mid + 1; else hi = mid; }
    const q = a[lo];
    return q && q.at <= toMs ? q : null;
  }
}

/**
 * BAR-OPEN PROXY for historical replay without tick data. The first quote at or after an instant is
 * taken to be the OPEN of the first 5-minute candle starting at or after it. This is only coherent with
 * a zero publication delay (publication at the confirming candle's close), so replay that uses it
 * publishes at the close: an OPTIMISTIC proxy — in live use a signal is published several seconds
 * later and the price may have moved. Results from it are labelled as a proxy.
 */
export class BarOpenProxyQuoteSource implements QuoteSource {
  readonly label = "bar-open proxy (zero publication delay — optimistic)";
  private bySymbol = new Map<string, Array<{ t: number; o: number }>>();
  constructor(series: Partial<Record<CashtrapSymbol, Array<{ t: number; o: number }>>>) {
    for (const [s, a] of Object.entries(series)) this.bySymbol.set(s, [...(a ?? [])].sort((x, y) => x.t - y.t));
  }
  async firstQuote(symbol: CashtrapSymbol, fromMs: number, toMs: number): Promise<Quote | null> {
    const a = this.bySymbol.get(symbol) ?? [];
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].t < fromMs) lo = mid + 1; else hi = mid; }
    const k = a[lo];
    return k && k.t <= toMs ? { px: k.o, at: k.t, source: "bar-open-proxy" } : null;
  }
}
