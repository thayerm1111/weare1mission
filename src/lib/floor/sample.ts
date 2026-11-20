/**
 * SAMPLE CONTENT FOR THE DESIGN-REVIEW ROUTE (/floor-preview) — and for nothing else.
 *
 * The Floor draws only what its three sources send it, so reviewing the layout without a signed-in member
 * and a connected broker needs a stand-in for those sources. This is that stand-in: fixed, invented
 * figures matching the concept the owner supplied on 11-20, shown under a banner that says "Sample data".
 * The route exists only where OM_FLOOR_SAMPLE=1 is set (a developer's machine); everywhere else it is a
 * 404, and no member-facing page imports this file. The prices it charges-for are NOT invented: they are
 * read from the same settings the real screens use.
 */
import type { FloorOverview, FloorAccount } from "./overview";
import type { FloorSample, SetupAnswer } from "@/components/om/floor/Floor";

export type SampleState = "connected" | "locked" | "stale" | "empty" | "loss";

/** A fixed pseudo-random walk — the same candles on the server and in the browser, every time. */
function candles(n: number, startIso: string, stepMin: number): { t: string; o: number; h: number; l: number; c: number }[] {
  let seed = 20261120;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Down through the first two thirds, back up into the close — the shape of the concept image.
  const path = (i: number) => { const x = i / (n - 1); return x < 0.14 ? 3556 + x * 30 : x < 0.62 ? 3560 - (x - 0.14) * 66 : 3528.5 + (x - 0.62) * 57; };
  const out = [];
  let prev = path(0);
  const t0 = Date.parse(startIso);
  for (let i = 0; i < n; i++) {
    const c = i === n - 1 ? 3550 : path(i) + (rnd() - 0.5) * 5.2;
    const o = prev, hi = Math.max(o, c) + rnd() * 2.6, lo = Math.min(o, c) - rnd() * 2.6;
    const t = new Date(t0 + i * stepMin * 60_000).toISOString().slice(0, 19).replace("T", " ");
    out.push({ t, o: +o.toFixed(2), h: +hi.toFixed(2), l: +lo.toFixed(2), c: +c.toFixed(2) });
    prev = c;
  }
  return out;
}

export function floorSample(state: SampleState, prices: { play: number; playMinutes: number; atlas: number; atlasMinutes: number }): FloorSample {
  const nowMs = Date.parse("2026-11-20T21:04:00Z");
  const iso = (agoMs: number) => new Date(nowMs - agoMs).toISOString();
  const since = "2026-10-20T17:15:00Z";
  const a1: FloorAccount = { id: "sample-01", name: "Trading account 01", masked: "•••• 0001", broker: "TradeLocker", environment: "demo", currency: "USD", connection: "connected", isDefault: true };
  const a2: FloorAccount = { id: "sample-02", name: "Trading account 02", masked: "•••• 0002", broker: "TradeLocker", environment: "live", currency: "USD", connection: "connected", isDefault: false };
  const empty = state === "empty";
  const loss = state === "loss";

  const overview: FloorOverview = {
    asOf: iso(0),
    accountsKnown: true,
    accounts: empty ? [] : [a1, a2],
    account: empty ? null : a1,
    figures: empty ? null
      : state === "stale" ? { balance: 10000, equity: 10125, openPnl: 125, positions: 2, at: iso(3 * 3600_000), state: "last_known", note: "Your broker did not answer just now. This is the last reading." }
        : { balance: 10000, equity: loss ? 9912.5 : 10125, openPnl: loss ? -87.5 : 125, positions: 2, at: iso(40_000), state: "live", note: null },
    genx: { period: "7d", since, results: loss
      ? { trades: 9, wins: 4, losses: 5, breakeven: 0, winRate: 44, netPips: -64, open: 1, recent: [], series: [0, 22, -8, -30, 4, -22, -51, -30, -72, -64] }
      : { trades: 10, wins: 6, losses: 4, breakeven: 0, winRate: 60, netPips: 120, open: 0, recent: [{ at: iso(5 * 3600_000), side: "buy", pips: 16 }, { at: iso(22 * 3600_000), side: "sell", pips: 12 }, { at: iso(30 * 3600_000), side: "buy", pips: 34 }, { at: iso(49 * 3600_000), side: "sell", pips: -8 }, { at: iso(54 * 3600_000), side: "buy", pips: 25 }], series: [0, 18, 6, 34, 52, 41, 66, 58, 92, 104, 120] } },
    flow: empty ? null : { period: "today", since, results: loss
      ? { closed: 2, wins: 0, losses: 2, breakeven: 0, ungraded: 0, netPips: -31, realized: { amount: -155, currency: "USD", counted: 2, left: 0 }, open: 2, recent: [] }
      : { closed: 3, wins: 2, losses: 1, breakeven: 0, ungraded: 0, netPips: 48, realized: { amount: 240, currency: "USD", counted: 3, left: 0 }, open: 2, recent: [] } },
    atlas: state === "locked" || empty
      ? { open: false, preview: false, cost: prices.atlas, minutes: prices.atlasMinutes, read: null }
      : { open: true, preview: false, cost: prices.atlas, minutes: prices.atlasMinutes, read: { at: iso(120_000), summary: "Gold is approaching resistance. I'm watching for confirmation." } },
  };

  const cs = candles(60, "2026-11-20T06:15:00Z", 15);
  const gate = { cost: prices.play, minutes: prices.playMinutes };
  const setup: SetupAnswer = state === "locked" || empty
    ? { g: null, locked: { stage: "forming" }, candles: cs, price: 3550, asOf: iso(8_000), setups: { ...gate, open: false, via: null, until: null } }
    : {
      g: {
        action: "WAIT_FOR_SELL_TRIGGER", closest_support: 3532.8, closest_resistance: 3565.77,
        trigger_condition: "price to reach 3,565.77 (resistance) and show a bearish reaction.",
        invalidation_reason: "a decisive close beyond 3,571.40.",
      },
      candles: cs, price: 3550, asOf: iso(8_000), setups: { ...gate, open: true, via: "pass", until: null },
    };

  return {
    overview, setup, nowMs,
    ticks: [
      { label: "XAUUSD", price: 3550, percent: 0.48, dp: 2 },
      { label: "EURUSD", price: 1.08342, percent: 0.12, dp: 5 },
      { label: "GBPUSD", price: 1.26518, percent: -0.08, dp: 5 },
      { label: "USDJPY", price: 151.284, percent: 0.21, dp: 3 },
      { label: "BTCUSD", price: 91240, percent: -1.14, dp: 0 },
    ],
  };
}
