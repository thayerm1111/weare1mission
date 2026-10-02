import { series, livePrice } from "@/lib/marketData";
import { CONFIRM_IV, MOMENTUM_MAX_EXT, type ConfirmState } from "@/lib/genxConfirm";
import { type FxPair, U, units, fmtPx, px } from "@/lib/genfx/pairs";

/**
 * GEN FX LIVE ENTRY CONFIRMATION — "is it time to enter yet?" for a setup that is waiting.
 *
 * The rule is GENX's (src/lib/genxConfirm.ts), move for move: it reads CLOSED candles on the horizon's
 * own trigger frame (5-minute for Quick, 15-minute for Intraday, 1-hour for Swing — the same table,
 * imported), and calls CONFIRMED on a real reaction at the zone, a sweep-and-reclaim, or a decisive
 * break that never came back. Nothing fires on a wick.
 *
 * It is a separate file because GENX's version reads XAU/USD by name, prints prices to two decimals
 * and carries a 20-cent floor in two places. Here the pair is a parameter, prices print at the pair's
 * precision, and the 20 cents is 0.2 units (pairs.ts).
 *
 * The decision is split from the fetch — `confirmFromCandles` is pure — so the replay runs the
 * identical rule over history, and so it can be tested without a market.
 */

export type Candle = { o: number; h: number; l: number; c: number };
export type FxConfirm = {
  state: ConfirmState; detail: string; side: "buy" | "sell";
  price: number | null; enter: number | null;
  zoneLow: number; zoneHigh: number; invalidation: number; interval: string;
};

/** GENX's momentumBreakout with the 20-cent floor on the risk distance turned into units. Pure. */
export function fxMomentumBreakout(o: {
  side: "buy" | "sell"; lastClosed: Candle; priorClosed: Candle[];
  zoneLo: number; zoneHi: number; inv: number; price: number; maxExtMult: number; floor: number;
}): boolean {
  const k = o.lastClosed;
  const range = Math.max(k.h - k.l, 1e-9);
  const body = Math.abs(k.c - k.o) / range;
  if (body < 0.45) return false;
  const riskDist = Math.max(Math.abs(o.zoneHi - o.inv), o.zoneHi - o.zoneLo, o.floor);
  if (o.side === "buy") {
    const green = k.c > k.o;
    const closesStrong = (k.c - k.l) / range >= 0.55;
    const priorHigh = o.priorClosed.length ? Math.max(...o.priorClosed.map((p) => p.h)) : k.h;
    const brokeOut = k.c > priorHigh;
    const holdsInv = k.c > o.inv;
    const notExtended = o.price <= o.zoneHi + o.maxExtMult * riskDist;
    return green && closesStrong && brokeOut && holdsInv && notExtended;
  }
  const red = k.c < k.o;
  const closesStrong = (k.h - k.c) / range >= 0.55;
  const priorLow = o.priorClosed.length ? Math.min(...o.priorClosed.map((p) => p.l)) : k.l;
  const brokeOut = k.c < priorLow;
  const holdsInv = k.c < o.inv;
  const notExtended = o.price >= o.zoneLo - o.maxExtMult * riskDist;
  return red && closesStrong && brokeOut && holdsInv && notExtended;
}

/**
 * The confirmation decision over candles already in hand. `candles` is oldest → newest and the LAST
 * one is the candle still forming, exactly as the feed returns them; `live` is the current price, or
 * null to use the forming candle's close.
 */
export function confirmFromCandles(pair: FxPair, o: {
  side: "buy" | "sell"; zoneLo: number; zoneHi: number; inv: number;
  candles: Candle[]; live: number | null; noMomentum?: boolean;
}): { state: ConfirmState; detail: string; price: number | null; enter: number | null } {
  const { side, inv } = o;
  let zoneLo = o.zoneLo, zoneHi = o.zoneHi;
  if (zoneLo > zoneHi) { const t = zoneLo; zoneLo = zoneHi; zoneHi = t; }
  const c = o.candles;
  if (c.length < 4) return { state: "NO_DATA", detail: "Not enough candles right now.", price: null, enter: null };

  const formingIdx = c.length - 1;
  const lastClosed = c[formingIdx - 1];
  const recentClosed = c.slice(Math.max(0, formingIdx - 5), formingIdx);
  const price = typeof o.live === "number" && Number.isFinite(o.live) ? o.live : c[formingIdx].c;
  const floor = units(pair, U.confirmBuf);
  const buf = Math.max((zoneHi - zoneLo) * 0.15, floor);

  const bodyAbs = Math.abs(lastClosed.c - lastClosed.o);
  const range = Math.max(lastClosed.h - lastClosed.l, 1e-9);
  const bodyOk = bodyAbs / range >= 0.4;
  const f = (n: number) => fmtPx(pair, n);
  const zone = `${f(zoneLo)}–${f(zoneHi)}`;
  const at = px(pair, price);

  let state: ConfirmState;
  let detail = "";
  let enter: number | null = null;

  if (side === "buy") {
    const invalidated = recentClosed.some((k) => k.c < inv);
    const reachedZone = recentClosed.some((k) => k.l <= zoneHi + buf) || price <= zoneHi + buf;
    const priorTested = recentClosed.length >= 2 && recentClosed[recentClosed.length - 2].l <= zoneHi + buf;
    const testedZone = lastClosed.l <= zoneHi + buf || priorTested;
    const confirmed = lastClosed.c > lastClosed.o && bodyOk && testedZone && lastClosed.c >= zoneLo - buf && lastClosed.c > inv;
    const sweptRecent = recentClosed.slice(-3).some((k) => k.l <= zoneHi + buf) || lastClosed.l <= zoneHi + buf;
    const reclaimed = !confirmed && sweptRecent && lastClosed.c > lastClosed.o && bodyOk && lastClosed.c > zoneLo - buf && lastClosed.c > inv;
    const momentum = !o.noMomentum && !confirmed && !reclaimed && fxMomentumBreakout({ side: "buy", lastClosed, priorClosed: recentClosed.slice(0, -1), zoneLo, zoneHi, inv, price, maxExtMult: MOMENTUM_MAX_EXT, floor });
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed below the invalidation (${f(inv)}). This buy setup is done — don't take it.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = at; detail = `A green candle closed reacting off ${zone} while holding ${f(inv)}. Buyers confirmed — BUY is live.`; }
    else if (reclaimed) { state = "CONFIRMED"; enter = at; detail = `Price swept ${zone} and a green candle reclaimed it while holding ${f(inv)}. Bullish reclaim — BUY is live.`; }
    else if (momentum) { state = "CONFIRMED"; enter = at; detail = `A decisive green candle broke to a new high in the trend while holding ${f(inv)} — momentum BUY is live (price never pulled back to ${zone}).`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zone} buy zone. Waiting for a green candle to CLOSE here (not just wick) before entering.`; }
    else { state = "WAIT"; detail = `Price is above the zone. Waiting for a pullback to ${zone} first.`; }
  } else {
    const invalidated = recentClosed.some((k) => k.c > inv);
    const reachedZone = recentClosed.some((k) => k.h >= zoneLo - buf) || price >= zoneLo - buf;
    const priorTested = recentClosed.length >= 2 && recentClosed[recentClosed.length - 2].h >= zoneLo - buf;
    const testedZone = lastClosed.h >= zoneLo - buf || priorTested;
    const confirmed = lastClosed.c < lastClosed.o && bodyOk && testedZone && lastClosed.c <= zoneHi + buf && lastClosed.c < inv;
    const sweptRecent = recentClosed.slice(-3).some((k) => k.h >= zoneLo - buf) || lastClosed.h >= zoneLo - buf;
    const reclaimed = !confirmed && sweptRecent && lastClosed.c < lastClosed.o && bodyOk && lastClosed.c < zoneHi + buf && lastClosed.c < inv;
    const momentum = !o.noMomentum && !confirmed && !reclaimed && fxMomentumBreakout({ side: "sell", lastClosed, priorClosed: recentClosed.slice(0, -1), zoneLo, zoneHi, inv, price, maxExtMult: MOMENTUM_MAX_EXT, floor });
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed above the invalidation (${f(inv)}). This sell setup is done — don't take it.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = at; detail = `A red candle closed reacting off ${zone} while holding ${f(inv)}. Sellers confirmed — SELL is live.`; }
    else if (reclaimed) { state = "CONFIRMED"; enter = at; detail = `Price swept ${zone} and a red candle reclaimed it while holding ${f(inv)}. Bearish reclaim — SELL is live.`; }
    else if (momentum) { state = "CONFIRMED"; enter = at; detail = `A decisive red candle broke to a new low in the trend while holding ${f(inv)} — momentum SELL is live (price never rallied back to ${zone}).`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zone} sell zone. Waiting for a red candle to CLOSE here (not just wick) before entering.`; }
    else { state = "WAIT"; detail = `Price is below the zone. Waiting for a rally up to ${zone} first.`; }
  }
  return { state, detail, price: at, enter };
}

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Fetch the trigger frame and decide. Same contract as GENX's confirmEntry, plus the pair. */
export async function confirmFxEntry(opts: {
  pair: FxPair; side: "buy" | "sell";
  entryLow: number; entryHigh: number; watch: number; invalidation: number;
  mode: string; mdKey: string; fresh: boolean; interval?: string; noMomentum?: boolean;
}): Promise<FxConfirm> {
  const { pair, side } = opts;
  const inv = Number(opts.invalidation);
  const watch = Number(opts.watch);
  let zoneLo = Number(opts.entryLow), zoneHi = Number(opts.entryHigh);
  if (!numOk(zoneLo) || !numOk(zoneHi)) { zoneLo = watch; zoneHi = watch; }
  if (zoneLo > zoneHi) { const t = zoneLo; zoneLo = zoneHi; zoneHi = t; }

  const interval = opts.interval || CONFIRM_IV[String(opts.mode)] || "5min";
  const base = { side, zoneLow: zoneLo, zoneHigh: zoneHi, invalidation: inv, interval };
  if (!numOk(inv) || (!numOk(zoneLo) && !numOk(watch))) return { state: "NO_DATA", detail: "Missing setup levels.", price: null, enter: null, ...base };

  const rowsRaw = await series(pair.td, interval, 24, opts.mdKey, opts.fresh);
  if (rowsRaw === "ratelimit") return { state: "BUSY", detail: "Feed busy — retrying shortly.", price: null, enter: null, ...base };
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  if (rows.length < 4) return { state: "NO_DATA", detail: "Not enough candles right now.", price: null, enter: null, ...base };

  const live = await livePrice(pair.td, opts.mdKey, opts.fresh);
  const candles: Candle[] = rows.map((r) => ({ o: +r.open, h: +r.high, l: +r.low, c: +r.close }));
  const d = confirmFromCandles(pair, { side, zoneLo, zoneHi, inv, candles, live: numOk(live) ? live : null, noMomentum: opts.noMomentum });
  return { ...d, ...base };
}
