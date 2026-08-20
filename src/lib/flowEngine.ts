import { series, livePrice, livePriceSane } from "@/lib/marketData";
import { runEngine, type EngineCfg } from "@/lib/omEngine";
import { MODES, sessionNow, arr, type Mode, type Row } from "@/lib/genxCompute";
import { getInstrument } from "@/lib/flow/instruments";

/**
 * FLOW multi-instrument engine (separate from GENX).
 *
 * GENX is Gold-only. FLOW trades many pairs, so it needs a symbol-parameterized
 * read. This reuses the SHARED deterministic engine (runEngine) + the shared
 * mode config + the shared market-data governor — nothing here modifies GENX.
 * The instrument's pip/decimals/twelve-data symbol come from flow/instruments.
 */

function catOf(assetClass: string): EngineCfg["cat"] {
  switch (assetClass) {
    case "gold": return "gold";
    case "forex": return "forex";
    case "index": return "index";
    case "crypto": return "crypto";
    case "stock": return "stock";
    default: return "commodity"; // metals, oil, etc.
  }
}

function volBucket(rows: Row[] | null, price: number): { label: string; atr: number | null } {
  if (!rows || rows.length < 15 || !price) return { label: "Normal", atr: null };
  const tr: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const h = +rows[i].high, l = +rows[i].low, pc = +rows[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const pct = atr / price;
  const label = pct >= 0.0018 ? "High" : pct <= 0.0007 ? "Low" : "Normal";
  return { label, atr };
}

export type FlowReadOk = {
  ok: true; read: Record<string, unknown>; price: number; session: string; dataStatus: string;
  volatility: string; atr: number | null; m15: Row[] | null; nowMs: number;
  tdSymbol: string; pip: number; dec: number;
};
export type FlowReadErr = { ok: false; error: string; detail?: string; status?: number };

/** Read + run the shared engine for ANY FLOW instrument (not just Gold). */
export async function flowRead(opts: { canonical: string; mode: Mode; mdKey: string; fresh: boolean }): Promise<FlowReadOk | FlowReadErr> {
  const inst = getInstrument(opts.canonical);
  const m = MODES[opts.mode];
  const cfg: EngineCfg = {
    symbol: inst.twelveDataSymbol, label: inst.displayName, cat: catOf(inst.assetClass),
    pip: inst.pipSize, dec: inst.pricePrecision, ...m.eng,
  };
  const TD = inst.twelveDataSymbol;
  const fresh = opts.fresh, mdKey = opts.mdKey;

  const [d1, h4, h1, m30, m15, m5] = await Promise.all([
    series(TD, m.tf.d1, 90, mdKey, fresh),
    series(TD, m.tf.h4, 90, mdKey, fresh),
    series(TD, m.tf.h1, 120, mdKey, fresh),
    series(TD, m.tf.m30, 120, mdKey, fresh),
    series(TD, m.tf.m15, 150, mdKey, fresh),
    series(TD, m.tf.m5, 150, mdKey, fresh),
  ]);
  if ([d1, h4, h1, m30, m15, m5].some((x) => x === "ratelimit")) return { ok: false, error: "ratelimit", status: 429 };
  if (!arr(m15) || arr(m15)!.length < 20) return { ok: false, error: "insufficient_data", status: 200 };

  const live = await livePrice(TD, mdKey, fresh);
  const refRows = arr(m5) && arr(m5)!.length >= 3 ? arr(m5) : arr(m15);
  const liveOk = livePriceSane(live, refRows as never);
  const fallback = arr(m5)?.length ? +arr(m5)![arr(m5)!.length - 1].close : arr(m15)?.length ? +arr(m15)![arr(m15)!.length - 1].close : null;
  const price = (live != null && liveOk.ok) ? live : (liveOk.reference ?? fallback);
  if (price == null) return { ok: false, error: "marketdata_error", status: 502 };
  const dataStatus = (live != null && liveOk.ok) ? "live" : "reference";

  const now = new Date();
  const nowMs = now.getTime();
  const session = sessionNow(now);
  const read = runEngine(cfg, { d1: arr(d1), h4: arr(h4), h1: arr(h1), m30: arr(m30), m15: arr(m15), m5: arr(m5), price, nowMs, session }) as Record<string, unknown>;
  const vol = volBucket(arr(m15), price);

  return {
    ok: true, read, price, session, dataStatus,
    volatility: vol.label, atr: vol.atr, m15: arr(m15), nowMs,
    tdSymbol: TD, pip: inst.pipSize, dec: inst.pricePrecision,
  };
}

// ── FLOW live entry confirmation (symbol-parameterized; GENX's is Gold-only) ──
export type FlowConfirmState = "WAIT" | "AT_ZONE" | "CONFIRMED" | "INVALIDATED" | "BUSY" | "NO_DATA";
const CONFIRM_IV: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export async function flowConfirm(opts: {
  tdSymbol: string; pip: number; side: "buy" | "sell";
  entryLow: number; entryHigh: number; watch: number; invalidation: number;
  mode: string; mdKey: string; fresh: boolean; interval?: string;
}): Promise<{ state: FlowConfirmState; detail: string; enter: number | null; price: number | null; interval: string }> {
  const side = opts.side, inv = Number(opts.invalidation), watch = Number(opts.watch);
  let zoneLo = Number(opts.entryLow), zoneHi = Number(opts.entryHigh);
  if (!numOk(zoneLo) || !numOk(zoneHi)) { zoneLo = watch; zoneHi = watch; }
  if (zoneLo > zoneHi) { const t = zoneLo; zoneLo = zoneHi; zoneHi = t; }
  // Optional interval override (the fast-watch passes "1min" so an entry can
  // confirm on a 1-minute close once price is already sitting in the zone).
  const interval = opts.interval || CONFIRM_IV[String(opts.mode)] || "5min";
  if (!numOk(inv) || (!numOk(zoneLo) && !numOk(watch))) return { state: "NO_DATA", detail: "Missing setup levels.", enter: null, price: null, interval };

  const rowsRaw = await series(opts.tdSymbol, interval, 24, opts.mdKey, opts.fresh);
  if (rowsRaw === "ratelimit") return { state: "BUSY", detail: "Feed busy — retrying shortly.", enter: null, price: null, interval };
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as Row[];
  if (rows.length < 4) return { state: "NO_DATA", detail: "Not enough candles right now.", enter: null, price: null, interval };

  const live = await livePrice(opts.tdSymbol, opts.mdKey, opts.fresh);
  const c = rows.map((r) => ({ o: +r.open, h: +r.high, l: +r.low, c: +r.close }));
  const formingIdx = c.length - 1;
  const lastClosed = c[formingIdx - 1];
  const recentClosed = c.slice(Math.max(0, formingIdx - 5), formingIdx);
  const price = numOk(live) ? (live as number) : c[formingIdx].c;
  // pip-aware buffer (Gold pip 0.1 → 0.2; EURUSD pip 0.0001 → 0.0002).
  const buf = Math.max((zoneHi - zoneLo) * 0.15, opts.pip * 2);
  const bodyAbs = Math.abs(lastClosed.c - lastClosed.o);
  const range = Math.max(lastClosed.h - lastClosed.l, 1e-9);
  const bodyOk = bodyAbs / range >= 0.4;

  let state: FlowConfirmState, detail = "", enter: number | null = null;
  const dp = (n: number) => +n.toFixed(6);
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
    // sharp reversals). The entry engine's chase guard still turns a reclaim into
    // MISSED if price has already run too far, so this can't chase a spent move.
    const sweptRecent = recentClosed.slice(-3).some((k) => k.l <= zoneHi + buf) || lastClosed.l <= zoneHi + buf;
    const reclaimed = !confirmed && sweptRecent && lastClosed.c > lastClosed.o && bodyOk && lastClosed.c > zoneLo - buf && lastClosed.c > inv;
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed below the invalidation (${inv}). This buy is done.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = dp(price); detail = `A green candle closed reacting off ${zoneLo}–${zoneHi} while holding ${inv}. Buyers confirmed.`; }
    else if (reclaimed) { state = "CONFIRMED"; enter = dp(price); detail = `Price swept ${zoneLo}–${zoneHi} and a green candle reclaimed it, holding ${inv}. Bullish reclaim confirmed.`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zoneLo}–${zoneHi} buy zone. Waiting for a green candle to CLOSE here.`; }
    else { state = "WAIT"; detail = `Price is above the zone. Waiting for a pullback to ${zoneLo}–${zoneHi}.`; }
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
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed above the invalidation (${inv}). This sell is done.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = dp(price); detail = `A red candle closed reacting off ${zoneLo}–${zoneHi} while holding ${inv}. Sellers confirmed.`; }
    else if (reclaimed) { state = "CONFIRMED"; enter = dp(price); detail = `Price swept ${zoneLo}–${zoneHi} and a red candle reclaimed it, holding ${inv}. Bearish reclaim confirmed.`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zoneLo}–${zoneHi} sell zone. Waiting for a red candle to CLOSE here.`; }
    else { state = "WAIT"; detail = `Price is below the zone. Waiting for a rally to ${zoneLo}–${zoneHi}.`; }
  }
  return { state, detail, enter, price: dp(price), interval };
}
