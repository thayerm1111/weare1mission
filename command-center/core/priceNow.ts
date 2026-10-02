/**
 * WHICH PRICE IS "NOW"? (owner 10-01: "when I talk to ATLAS it's behind on actual live price").
 *
 * A snapshot carries the price the worker MEASURED. Everything that decides something — the setup, the
 * open position's read, protection, watches, the record a call is graded from — is built on that number,
 * and the server recomputes from it when a member presses a button. It must stay exactly what was
 * measured, or the screen and the server would be reading two different markets.
 *
 * What ATLAS SAYS the price is, and what the screen SHOWS as the price, is a different question: that
 * should be the freshest quote there is. So a fresher quote is ATTACHED to the snapshot (`live`) and
 * never written over `price`. The few places that say or show "the price now" ask for it here.
 *
 *   s.price        what the worker measured — decisions, records, anything a button will recompute
 *   priceNow(s)    what to say and show — the fresher quote when one is attached, else the same number
 *
 * Pure: no I/O, no clock.
 */
import type { MarketSnapshot } from "./types";

/** The price to SAY or SHOW. */
export function priceNow(s: MarketSnapshot): number {
  return s.live?.price ?? s.price;
}

/** When the said/shown price was read. */
export function priceReadAt(s: MarketSnapshot): number {
  return s.live?.at ?? s.at;
}

/**
 * A DISPLAY COPY with the fresher quote in `price`, for the presentation layer only (present/intel.ts —
 * "Current price", the day's change, which levels sit above and below). Bid/ask described the measured
 * quote, so they are dropped rather than shown beside a price they no longer belong to.
 *
 * Never hand this to anything that decides, sizes, places, manages or records a trade.
 */
export function shownSnapshot(s: MarketSnapshot): MarketSnapshot {
  return s.live ? { ...s, price: s.live.price, bid: null, ask: null, spread: null } : s;
}
