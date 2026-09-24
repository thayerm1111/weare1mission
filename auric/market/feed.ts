import type { Bar } from "../core/types";
import * as TL from "../broker/tradelocker";
import { mergeBars } from "./bars";

/**
 * Shared market data per (broker host, instrument, route). XAUUSD quotes and M1 bars are identical for every
 * account on the same TradeLocker server, so N account runners must not spend N× the quote/history budget —
 * with five accounts the per-route rate gate left each runner a quote every 20–30s, and the 4s freshness gate
 * then refused every qualifying setup ("Broker quote is stale"). One poll feeds all runners; whichever runner
 * ticks first does the fetch, the others reuse the result until it ages past the poll interval.
 */
export type FeedResult<T> = { ok: true; data: T; latencyMs: number; shared: boolean } | { ok: false; status: number; error: string; latencyMs: number };

export class InstrumentFeed {
  m1: Bar[] = [];
  quote: TL.TLQuoteRaw | null = null;
  lastHistoryOk = 0; lastHistoryAttempt = 0;
  lastQuoteAttempt = 0;
  lastError: { kind: "history" | "quote"; status: number; error: string; at: number } | null = null;
  private hInflight: Promise<FeedResult<{ added: number; replaced: number; outOfOrder: number }>> | null = null;
  private qInflight: Promise<FeedResult<TL.TLQuoteRaw>> | null = null;
  constructor(public readonly env: TL.TLEnv, public readonly tradableInstrumentId: string, public readonly infoRouteId: string) {}

  /** Refresh M1 bars at most once per `refreshMs` across all runners. Backfills 3 days on first load. */
  refreshHistory(a: TL.TLAuth, refreshMs: number, force = false): Promise<FeedResult<{ added: number; replaced: number; outOfOrder: number }>> {
    if (this.hInflight) return this.hInflight;
    const now = Date.now();
    if (!force && this.m1.length && now - this.lastHistoryAttempt < refreshMs) return Promise.resolve({ ok: true, data: { added: 0, replaced: 0, outOfOrder: 0 }, latencyMs: 0, shared: true });
    this.lastHistoryAttempt = now;
    const need = this.m1.length < 1500;
    const from = need ? now - 3 * 86_400_000 : (this.m1[this.m1.length - 1]?.t ?? now - 3600_000) - 5 * 60_000;
    const p = (async (): Promise<FeedResult<{ added: number; replaced: number; outOfOrder: number }>> => {
      const r = await TL.getHistory(a, this.tradableInstrumentId, this.infoRouteId, "1m", from, now);
      if (!r.ok) { this.lastError = { kind: "history", status: r.status, error: r.error, at: Date.now() }; return { ok: false, status: r.status, error: r.error, latencyMs: r.latencyMs }; }
      const m = mergeBars(this.m1, r.data, 6000);
      this.m1 = m.bars; this.lastHistoryOk = Date.now();
      return { ok: true, data: { added: m.added, replaced: m.replaced, outOfOrder: m.outOfOrder }, latencyMs: r.latencyMs, shared: false };
    })().finally(() => { if (this.hInflight === p) this.hInflight = null; });
    this.hInflight = p;
    return p;
  }

  /** One quote per `pollMs` for everyone. A quote younger than `pollMs` is returned as-is (shared). */
  pollQuote(a: TL.TLAuth, pollMs: number): Promise<FeedResult<TL.TLQuoteRaw>> {
    if (this.qInflight) return this.qInflight;
    const now = Date.now();
    if (this.quote && now - this.quote.receivedAt < pollMs) return Promise.resolve({ ok: true, data: this.quote, latencyMs: 0, shared: true });
    if (now - this.lastQuoteAttempt < Math.min(pollMs, 500)) {
      // A very recent attempt failed (rate gate / backoff): don't hammer; report the last error.
      const e = this.lastError?.kind === "quote" ? this.lastError : null;
      if (e && now - e.at < 2000) return Promise.resolve({ ok: false, status: e.status, error: e.error, latencyMs: 0 });
    }
    this.lastQuoteAttempt = now;
    const p = (async (): Promise<FeedResult<TL.TLQuoteRaw>> => {
      const r = await TL.getQuote(a, this.tradableInstrumentId, this.infoRouteId);
      if (!r.ok) { this.lastError = { kind: "quote", status: r.status, error: r.error, at: Date.now() }; return { ok: false, status: r.status, error: r.error, latencyMs: r.latencyMs }; }
      this.quote = r.data;
      return { ok: true, data: r.data, latencyMs: r.latencyMs, shared: false };
    })().finally(() => { if (this.qInflight === p) this.qInflight = null; });
    this.qInflight = p;
    return p;
  }
}

const feeds = new Map<string, InstrumentFeed>();
export function feedFor(env: TL.TLEnv, tradableInstrumentId: string, infoRouteId: string): InstrumentFeed {
  const key = `${env}|${tradableInstrumentId}|${infoRouteId}`;
  let f = feeds.get(key);
  if (!f) { f = new InstrumentFeed(env, tradableInstrumentId, infoRouteId); feeds.set(key, f); }
  return f;
}
export function feedStats() { return [...feeds.entries()].map(([k, f]) => ({ key: k, bars: f.m1.length, quoteAgeMs: f.quote ? Date.now() - f.quote.receivedAt : null, lastError: f.lastError })); }
