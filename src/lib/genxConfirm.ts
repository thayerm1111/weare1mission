import { series, livePrice } from "@/lib/marketData";

/**
 * GENX live entry confirmation — the deterministic "is it time to enter yet?"
 * check for a WAIT/LIMIT setup. Reacts to CLOSED candles, never a live wick, so
 * it won't flash ENTER on a bounce that reverses before the candle closes.
 *
 * Shared by the on-demand endpoint (/api/genx/confirm) and the alert scanner
 * (/api/cron/genx-scan), so "ENTER NOW" fires on exactly the same rule the member
 * sees in the app.
 */
export type ConfirmState = "WAIT" | "AT_ZONE" | "CONFIRMED" | "INVALIDATED" | "BUSY" | "NO_DATA";
export type ConfirmResult = {
  state: ConfirmState; detail: string; side: "buy" | "sell";
  price: number | null; enter: number | null;
  zoneLow: number; zoneHigh: number; invalidation: number; interval: string;
};

type Row = { datetime: string; open: string; high: string; low: string; close: string };
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// Trigger frame per GENX mode (where the entry is timed).
export const CONFIRM_IV: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };

// MOMENTUM / BREAKOUT entry — how far PAST the zone it will still take the trade, as a
// multiple of the stop distance. "Moderate": enter a decisive breakout up to 1.5× the stop
// distance beyond the zone (raised from 1.0, which was too tight — strong trends that ran
// without ever pulling back just expired in WAIT and never got taken). Past 1.5× the move is
// over-extended (chasing) and it's skipped, so it still won't buy a blow-off top.
export const MOMENTUM_MAX_EXT = 1.5;

/**
 * Momentum/breakout trigger: a DECISIVE candle closed continuing the trend (a new local
 * high for a buy / low for a sell) while holding invalidation, and price is NOT yet
 * over-extended past the zone. This is the fallback entry for a setup that ran WITHOUT ever
 * pulling back to the zone (so the pullback confirmation never fired). Pure + unit-tested.
 * The pullback/zone confirmation is always preferred (better price); this only fires when
 * that never happened.
 */
export function momentumBreakout(o: {
  side: "buy" | "sell";
  lastClosed: { o: number; h: number; l: number; c: number };
  priorClosed: { o: number; h: number; l: number; c: number }[];
  zoneLo: number; zoneHi: number; inv: number; price: number; maxExtMult: number;
}): boolean {
  const k = o.lastClosed;
  const range = Math.max(k.h - k.l, 1e-9);
  const body = Math.abs(k.c - k.o) / range;
  if (body < 0.45) return false; // only a decisive-bodied candle (moderate: 0.45, was 0.5)
  const riskDist = Math.max(Math.abs(o.zoneHi - o.inv), o.zoneHi - o.zoneLo, 0.2);
  if (o.side === "buy") {
    const green = k.c > k.o;
    const closesStrong = (k.c - k.l) / range >= 0.55; // closes in the top ~45% of its range (moderate)
    const priorHigh = o.priorClosed.length ? Math.max(...o.priorClosed.map((p) => p.h)) : k.h;
    const brokeOut = k.c > priorHigh; // new local high = trend continuation
    const holdsInv = k.c > o.inv;
    const notExtended = o.price <= o.zoneHi + o.maxExtMult * riskDist;
    return green && closesStrong && brokeOut && holdsInv && notExtended;
  }
  const red = k.c < k.o;
  const closesStrong = (k.h - k.c) / range >= 0.55; // closes in the bottom ~45% of its range (moderate)
  const priorLow = o.priorClosed.length ? Math.min(...o.priorClosed.map((p) => p.l)) : k.l;
  const brokeOut = k.c < priorLow;
  const holdsInv = k.c < o.inv;
  const notExtended = o.price >= o.zoneLo - o.maxExtMult * riskDist;
  return red && closesStrong && brokeOut && holdsInv && notExtended;
}

export async function confirmEntry(opts: {
  side: "buy" | "sell";
  entryLow: number; entryHigh: number; watch: number; invalidation: number;
  mode: string; mdKey: string; fresh: boolean; interval?: string;
}): Promise<ConfirmResult> {
  const side = opts.side;
  const inv = Number(opts.invalidation);
  const watch = Number(opts.watch);
  let zoneLo = Number(opts.entryLow), zoneHi = Number(opts.entryHigh);
  if (!numOk(zoneLo) || !numOk(zoneHi)) { zoneLo = watch; zoneHi = watch; }
  if (zoneLo > zoneHi) { const t = zoneLo; zoneLo = zoneHi; zoneHi = t; }

  const base = { side, zoneLow: zoneLo, zoneHigh: zoneHi, invalidation: inv, price: null as number | null, enter: null as number | null };
  // Optional interval override — the fast-watch passes "1min" so an ENTER can
  // fire on a 1-minute close once price is already at the zone (catches the move
  // ~4 min sooner than waiting for the 5-min close).
  const interval = opts.interval || CONFIRM_IV[String(opts.mode)] || "5min";
  if (!numOk(inv) || (!numOk(zoneLo) && !numOk(watch))) return { state: "NO_DATA", detail: "Missing setup levels.", interval, ...base };

  const rowsRaw = await series("XAU/USD", interval, 24, opts.mdKey, opts.fresh);
  if (rowsRaw === "ratelimit") return { state: "BUSY", detail: "Feed busy — retrying shortly.", interval, ...base };
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as Row[];
  if (rows.length < 4) return { state: "NO_DATA", detail: "Not enough candles right now.", interval, ...base };

  const live = await livePrice("XAU/USD", opts.mdKey, opts.fresh);
  const c = rows.map((r) => ({ o: +r.open, h: +r.high, l: +r.low, c: +r.close }));
  const formingIdx = c.length - 1;
  const lastClosed = c[formingIdx - 1];
  const recentClosed = c.slice(Math.max(0, formingIdx - 5), formingIdx);
  const price = numOk(live) ? (live as number) : c[formingIdx].c;
  const buf = Math.max((zoneHi - zoneLo) * 0.15, 0.2);

  const bodyAbs = Math.abs(lastClosed.c - lastClosed.o);
  const range = Math.max(lastClosed.h - lastClosed.l, 1e-9);
  const bodyOk = bodyAbs / range >= 0.4;

  let state: ConfirmState;
  let detail = "";
  let enter: number | null = null;

  if (side === "buy") {
    const invalidated = recentClosed.some((k) => k.c < inv);
    const reachedZone = recentClosed.some((k) => k.l <= zoneHi + buf) || price <= zoneHi + buf;
    const priorTested = recentClosed.length >= 2 && recentClosed[recentClosed.length - 2].l <= zoneHi + buf;
    const testedZone = lastClosed.l <= zoneHi + buf || priorTested;
    const confirmed = lastClosed.c > lastClosed.o && bodyOk && testedZone && lastClosed.c >= zoneLo - buf && lastClosed.c > inv;
    // Reclaim: price swept into/below the zone within the last few candles and a
    // green momentum candle has now CLOSED back above it while holding the
    // invalidation — a bullish reclaim. Catches fast V-bounces that never paused
    // to close a candle *inside* the zone (the reason strict confirmation misses
    // sharp reversals). Still requires momentum + holding invalidation.
    const sweptRecent = recentClosed.slice(-3).some((k) => k.l <= zoneHi + buf) || lastClosed.l <= zoneHi + buf;
    const reclaimed = !confirmed && sweptRecent && lastClosed.c > lastClosed.o && bodyOk && lastClosed.c > zoneLo - buf && lastClosed.c > inv;
    // MOMENTUM/BREAKOUT fallback — the trend ran without ever pulling back to the zone.
    const momentum = !confirmed && !reclaimed && momentumBreakout({ side: "buy", lastClosed, priorClosed: recentClosed.slice(0, -1), zoneLo, zoneHi, inv, price, maxExtMult: MOMENTUM_MAX_EXT });
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed below the invalidation (${inv}). This buy setup is done — don't take it.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `A green candle closed reacting off ${zoneLo}–${zoneHi} while holding ${inv}. Buyers confirmed — BUY is live.`; }
    else if (reclaimed) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `Price swept ${zoneLo}–${zoneHi} and a green candle reclaimed it while holding ${inv}. Bullish reclaim — BUY is live.`; }
    else if (momentum) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `A decisive green candle broke to a new high in the trend while holding ${inv} — momentum BUY is live (price never pulled back to ${zoneLo}–${zoneHi}).`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zoneLo}–${zoneHi} buy zone. Waiting for a green candle to CLOSE here (not just wick) before entering.`; }
    else { state = "WAIT"; detail = `Price is above the zone. Waiting for a pullback to ${zoneLo}–${zoneHi} first.`; }
  } else {
    const invalidated = recentClosed.some((k) => k.c > inv);
    const reachedZone = recentClosed.some((k) => k.h >= zoneLo - buf) || price >= zoneLo - buf;
    const priorTested = recentClosed.length >= 2 && recentClosed[recentClosed.length - 2].h >= zoneLo - buf;
    const testedZone = lastClosed.h >= zoneLo - buf || priorTested;
    const confirmed = lastClosed.c < lastClosed.o && bodyOk && testedZone && lastClosed.c <= zoneHi + buf && lastClosed.c < inv;
    // Reclaim (mirror of the buy side): price spiked up into/above the zone within
    // the last few candles and a red momentum candle has now CLOSED back below it
    // while holding the invalidation — a bearish reclaim. Catches fast rejections.
    const sweptRecent = recentClosed.slice(-3).some((k) => k.h >= zoneLo - buf) || lastClosed.h >= zoneLo - buf;
    const reclaimed = !confirmed && sweptRecent && lastClosed.c < lastClosed.o && bodyOk && lastClosed.c < zoneHi + buf && lastClosed.c < inv;
    // MOMENTUM/BREAKOUT fallback — the trend ran without ever rallying back to the zone.
    const momentum = !confirmed && !reclaimed && momentumBreakout({ side: "sell", lastClosed, priorClosed: recentClosed.slice(0, -1), zoneLo, zoneHi, inv, price, maxExtMult: MOMENTUM_MAX_EXT });
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed above the invalidation (${inv}). This sell setup is done — don't take it.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `A red candle closed reacting off ${zoneLo}–${zoneHi} while holding ${inv}. Sellers confirmed — SELL is live.`; }
    else if (reclaimed) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `Price swept ${zoneLo}–${zoneHi} and a red candle reclaimed it while holding ${inv}. Bearish reclaim — SELL is live.`; }
    else if (momentum) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `A decisive red candle broke to a new low in the trend while holding ${inv} — momentum SELL is live (price never rallied back to ${zoneLo}–${zoneHi}).`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zoneLo}–${zoneHi} sell zone. Waiting for a red candle to CLOSE here (not just wick) before entering.`; }
    else { state = "WAIT"; detail = `Price is below the zone. Waiting for a rally up to ${zoneLo}–${zoneHi} first.`; }
  }

  return { state, detail, side, price: +price.toFixed(2), enter, zoneLow: zoneLo, zoneHigh: zoneHi, invalidation: inv, interval };
}
