/**
 * SAMPLE CONTENT FOR THE DESIGN-REVIEW ROUTE (/floor-preview) — and for nothing else.
 *
 * The Floor draws only what its three sources send it, so reviewing the layout without a signed-in member
 * and a connected broker needs a stand-in for those sources. This is that stand-in: fixed, invented
 * figures matching the concept the owner supplied on 11-20, shown under a label that says "Sample data".
 * The route exists only where OM_FLOOR_SAMPLE=1 is set (a developer's machine); everywhere else it is a
 * 404, and no member-facing page imports this file. The prices it charges-for are NOT invented: they are
 * read from the same settings the real screens use and handed in by the caller.
 *
 * It answers the screen's own choices too — the three timeframes, the four periods, the second account —
 * so a click on the review route behaves the way the product does. Every answer is the same labelled sample.
 */
import type { AccountFigures, FloorAccount, FloorOverview, FloorPeriod, FlowResults, GenxResults } from "./overview";
import type { FloorMode } from "./setupInstruments";
import type { FloorSample, SetupAnswer } from "@/components/om/floor/Floor";

export type SampleState = "connected" | "locked" | "stale" | "empty" | "loss";

/** A fixed pseudo-random stream — the same numbers on the server and in the browser, every time. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

type Shape = "dip" | "range" | "climb";
const SHAPES: Record<Shape, (x: number) => number> = {
  // down through the first two thirds, back up into the close — the shape of the concept image
  dip: (x) => (x < 0.14 ? 3556 + x * 30 : x < 0.62 ? 3560 - (x - 0.14) * 66 : 3528.5 + (x - 0.62) * 57),
  range: (x) => 3547.5 + 5.5 * Math.sin(x * 9.2) + 2.6 * Math.sin(x * 23),
  climb: (x) => 3512 + 41 * x - 5 * Math.sin(x * 7.5),
};

function candles(shape: Shape, stepMin: number, seed: number, last = 3550, n = 60): { t: string; o: number; h: number; l: number; c: number }[] {
  const rnd = stream(seed), path = SHAPES[shape];
  const wick = shape === "range" ? 1.4 : 2.6, noise = shape === "range" ? 2.4 : 5.2;
  const t0 = Date.parse("2026-11-20T21:00:00Z") - (n - 1) * stepMin * 60_000;
  const out = [];
  let prev = path(0);
  for (let i = 0; i < n; i++) {
    const c = i === n - 1 ? last : path(i / (n - 1)) + (rnd() - 0.5) * noise;
    const o = prev, hi = Math.max(o, c) + rnd() * wick, lo = Math.min(o, c) - rnd() * wick;
    const t = new Date(t0 + i * stepMin * 60_000).toISOString().slice(0, 19).replace("T", " ");
    out.push({ t, o: +o.toFixed(2), h: +hi.toFixed(2), l: +lo.toFixed(2), c: +c.toFixed(2) });
    prev = c;
  }
  return out;
}

/** A results line that wanders from zero to `end` over `n` trades. */
function walk(n: number, end: number, seed: number): number[] {
  const rnd = stream(seed), out = [0];
  for (let i = 1; i <= n; i++) out.push(Math.round((end * i) / n + (i === n ? 0 : (rnd() - 0.5) * Math.max(24, Math.abs(end) * 0.22))));
  return out;
}

const NOW = Date.parse("2026-11-20T21:04:00Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const H = 3600_000;
const SINCE = "2026-10-20T17:15:00Z";

const recent = (pips: number[]): GenxResults["recent"] => pips.map((p, i) => ({ at: iso((5 + i * 13) * H), side: i % 2 ? "sell" : "buy", pips: p }));
const genx = (trades: number, wins: number, net: number, open: number, last: number[], seed: number): GenxResults => ({
  trades, wins, losses: trades - wins, breakeven: 0, winRate: trades ? Math.round((wins / trades) * 100) : null, netPips: net, open,
  recent: recent(last), series: trades ? walk(Math.min(trades, 24), net, seed) : [0],
});
const TRADES: [number, "buy" | "sell", number, number][] = [[2, "buy", 22, 110], [5, "sell", 31, 155], [9, "buy", -5, -25], [27, "sell", 18, 90]];
const flow = (closed: number, wins: number, pips: number, amount: number | null, open: number): FlowResults => ({
  closed, wins, losses: closed - wins, breakeven: 0, ungraded: 0, netPips: pips,
  realized: closed && amount != null ? { amount, currency: "USD", counted: closed, left: 0 } : null, open,
  recent: TRADES.slice(0, Math.min(closed, 4)).map(([h, side, p, usd]) => ({ at: iso(h * H), symbol: "XAUUSD", side, pips: p, amount: usd })),
});

const A1: FloorAccount = { id: "sample-01", name: "Trading account 01", masked: "•••• 0001", broker: "TradeLocker", environment: "demo", currency: "USD", connection: "connected", isDefault: true };
const A2: FloorAccount = { id: "sample-02", name: "Trading account 02", masked: "•••• 0002", broker: "TradeLocker", environment: "live", currency: "USD", connection: "connected", isDefault: false };
const key = (a: FloorAccount) => `${a.environment}:${a.id}`;

export function floorSample(state: SampleState, prices: { play: number; playMinutes: number; atlas: number; atlasMinutes: number }): FloorSample {
  const empty = state === "empty", loss = state === "loss", locked = state === "locked" || empty;

  /* ── results ── */
  const genxBy: Record<FloorPeriod, GenxResults> = loss
    ? { today: genx(2, 0, -47, 1, [-29, -18], 7), "7d": { ...genx(9, 4, -64, 1, [-8, 21, -29, 34, -22], 11), series: [0, 22, -8, -30, 4, -22, -51, -30, -72, -64] }, "30d": genx(41, 22, 96, 1, [-8, 21, -29, 34, -22], 13), all: genx(95, 55, 318, 1, [-8, 21, -29, 34, -22], 17) }
    : { today: genx(0, 0, 0, 1, [], 3), "7d": { ...genx(10, 6, 120, 0, [16, 12, 34, -8, 25], 5), series: [0, 18, 6, 34, 52, 41, 66, 58, 92, 104, 120] }, "30d": genx(42, 26, 310, 0, [16, 12, 34, -8, 25], 19), all: genx(96, 59, 540, 0, [16, 12, 34, -8, 25], 23) };

  const fresh: AccountFigures = { balance: 10000, equity: loss ? 9912.5 : 10125, openPnl: loss ? -87.5 : 125, positions: 2, at: iso(40_000), state: "live", note: null };
  const old: AccountFigures = { balance: 10000, equity: 10125, openPnl: 125, positions: 2, at: iso(3 * H), state: "last_known", note: "Your broker did not answer just now. This is the last reading." };
  const accounts: NonNullable<FloorSample["accounts"]> = empty ? {} : {
    [key(A1)]: {
      figures: state === "stale" ? old : fresh,
      flow: loss
        ? { today: flow(2, 0, -31, -155, 2), "7d": flow(9, 4, -52, -260, 2), "30d": flow(33, 18, 64, 318.5, 2), all: flow(48, 27, 141, 702, 2) }
        : { today: flow(3, 2, 48, 240, 2), "7d": flow(11, 7, 122, 612.5, 2), "30d": flow(37, 23, 256, 1284, 2), all: flow(52, 32, 345, 1730.5, 2) },
    },
    [key(A2)]: {
      figures: { balance: 25480.2, equity: 25480.2, openPnl: 0, positions: 0, at: iso(55_000), state: "live", note: null },
      flow: { today: flow(0, 0, 0, null, 0), "7d": flow(6, 2, -18, -184, 0), "30d": flow(21, 13, 88, 905.4, 0), all: flow(29, 18, 137, 1410, 0) },
    },
  };

  /* ── gold, on each horizon ── */
  const gate = { cost: prices.play, minutes: prices.playMinutes };
  const reads: Record<FloorMode, { candles: ReturnType<typeof candles>; g: Record<string, unknown> }> = {
    quick: {
      candles: candles("range", 5, 20261121),
      g: { action: "WAIT_FOR_BUY_TRIGGER", closest_support: 3541.2, closest_resistance: 3556.4, trigger_condition: "price to reach 3,541.20 (support) and show a bullish reaction.", invalidation_reason: "a decisive close beyond 3,537.60." },
    },
    intraday: {
      candles: candles("dip", 15, 20261120),
      g: { action: "WAIT_FOR_SELL_TRIGGER", closest_support: 3532.8, closest_resistance: 3565.77, trigger_condition: "price to reach 3,565.77 (resistance) and show a bearish reaction.", invalidation_reason: "a decisive close beyond 3,571.40." },
    },
    swing: {
      candles: candles("climb", 60, 20261122),
      g: { action: "BUY_LIMIT", closest_support: 3512.4, closest_resistance: 3571.2, entry: 3538, entry_low: 3535.5, entry_high: 3540.5, stop_loss: 3524, tp1: 3566, trigger_condition: "a pullback into 3,535.50–3,540.50 that holds.", invalidation_reason: "a decisive close beyond 3,524.00." },
    },
  };
  const stageOf = (m: FloorMode) => (m === "swing" ? "forming" : "watching");
  const setup = (m: FloorMode): SetupAnswer => locked
    ? { g: null, locked: { stage: stageOf(m) }, candles: reads[m].candles, price: 3550, asOf: iso(8_000), setups: { ...gate, open: false, via: null, until: null } }
    : { g: reads[m].g, candles: reads[m].candles, price: 3550, asOf: iso(8_000), setups: { ...gate, open: true, via: "pass", until: null } };
  const setups: Record<FloorMode, SetupAnswer> = { quick: setup("quick"), intraday: setup("intraday"), swing: setup("swing") };
  // What "See the play" leads to where the sample starts with the play withheld: the same read, on a window with its clock running.
  const paid = (m: FloorMode): SetupAnswer => ({ g: reads[m].g, candles: reads[m].candles, price: 3550, asOf: iso(8_000), setups: { ...gate, open: true, via: "credits", until: iso(-prices.playMinutes * 60_000) } });
  const opened: FloorSample["opened"] = locked ? { quick: paid("quick"), intraday: paid("intraday"), swing: paid("swing") } : undefined;

  const overview: FloorOverview = {
    asOf: iso(0),
    accountsKnown: true,
    accounts: empty ? [] : [A1, A2],
    account: empty ? null : A1,
    figures: empty ? null : accounts[key(A1)].figures,
    genx: { period: "7d", since: SINCE, results: genxBy["7d"] },
    flow: empty ? null : { period: "today", since: SINCE, results: accounts[key(A1)].flow.today! },
    atlas: locked
      ? { open: false, preview: false, cost: prices.atlas, minutes: prices.atlasMinutes, read: null }
      : { open: true, preview: false, cost: prices.atlas, minutes: prices.atlasMinutes, read: { at: iso(120_000), summary: "Gold is approaching resistance. I'm watching for confirmation." } },
  };

  return {
    overview, setup: setups.intraday, nowMs: NOW, setups, opened, genx: genxBy, accounts,
    ticks: [
      { label: "XAUUSD", price: 3550, percent: 0.48, dp: 2 },
      { label: "EURUSD", price: 1.08342, percent: 0.12, dp: 5 },
      { label: "GBPUSD", price: 1.26518, percent: -0.08, dp: 5 },
      { label: "USDJPY", price: 151.284, percent: 0.21, dp: 3 },
      { label: "BTCUSD", price: 91240, percent: -1.14, dp: 0 },
    ],
  };
}
