import { type Mode } from "@/lib/genxCompute";
import { type FxPair, U, units, px } from "@/lib/genfx/pairs";

/**
 * GEN FX — THE PURE DECISIONS. Each of these is GENX's rule (the file it came from is named beside
 * it), with gold's dollars turned into the pair's units and nothing else changed. No database, no
 * network: the scanner, the fast watch and the replay all call the same functions, and
 * tests/genfx-decide.test.ts checks them against GENX's own on gold's numbers.
 */

/** Reward ÷ risk at a price. Null when a level is missing or the stop is not behind the price. */
export function rewardRisk(entry: number | null, stop: number | null, tp: number | null): number | null {
  if (entry == null || stop == null || tp == null) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return Math.abs(tp - entry) / risk;
}

// ── watchTick.decideGoldEntry ────────────────────────────────────────────────────────────────────
export const ENTRY_FLOOR_RR = 0.8;        // take the trade at 0.8:1 or better; below it, wait for a pullback
export const ARM_MAX_MS = 5 * 60_000;     // wait five minutes for that pullback, then let it go

/** Enter now, arm and wait for a pullback, abandon, or keep waiting. `armed` = already announced once. */
export function decideFxEntry(pair: FxPair, o: {
  armed: boolean; confState: string; lp: number | null;
  entryLow: number | null; entryHigh: number | null; stop: number | null; tp1: number | null;
  armedAtMs: number; nowMs: number;
}): { do: "enter" | "arm" | "invalidate" | "wait"; reason: string } {
  if (o.confState === "INVALIDATED") return { do: "invalidate", reason: "invalidated" };
  const rr = rewardRisk(o.lp, o.stop, o.tp1);
  const zLo = Math.min(Number(o.entryLow), Number(o.entryHigh));
  const zHi = Math.max(Number(o.entryLow), Number(o.entryHigh));
  const floor = units(pair, U.confirmBuf);
  const buf = Number.isFinite(zHi - zLo) ? Math.max(floor, (zHi - zLo) * 0.15) : floor;
  const inZone = o.lp != null && Number.isFinite(zLo) && o.lp >= zLo - buf && o.lp <= zHi + buf;
  const takeable = inZone || (rr != null && rr >= ENTRY_FLOOR_RR);
  if (!o.armed) {
    if (o.confState !== "CONFIRMED") return { do: "wait", reason: "pending:" + o.confState };
    if (takeable) return { do: "enter", reason: "confirmed_rr_ok" };
    return { do: "arm", reason: "chased_below_floor" };
  }
  if (takeable) return { do: "enter", reason: "pullback_to_entry" };
  if (o.nowMs - o.armedAtMs > ARM_MAX_MS) return { do: "invalidate", reason: "arm_expired_5min" };
  return { do: "wait", reason: "armed_waiting" };
}

// ── watchTick.sameSetupZone ──────────────────────────────────────────────────────────────────────
export const SAME_SETUP_WINDOW_MS = 4 * 3600_000;
type ZoneLike = { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null };

/** The engine re-derives a zone every scan and it drifts; a zone this close on the same side is the same setup. */
export function sameSetupZone(pair: FxPair, a: ZoneLike, b: ZoneLike): boolean {
  if (a.side !== b.side || a.entry_low == null || a.entry_high == null || b.entry_low == null || b.entry_high == null) return false;
  const mid = (z: ZoneLike) => (Number(z.entry_low) + Number(z.entry_high)) / 2;
  const width = Math.max(Math.abs(Number(a.entry_high) - Number(a.entry_low)), Math.abs(Number(b.entry_high) - Number(b.entry_low)));
  return Math.abs(mid(a) - mid(b)) <= Math.max(units(pair, U.sameSetup), 1.5 * width);
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────
// GENX keys a scanner setup "quick:sell:4357:4359" — the zone rounded to the dollar — and a page
// setup "zone:quick:sell:4348.2" — the entry rounded to ten cents. A dollar is one unit and ten
// cents a tenth of one, so here both are whole numbers of those steps, with the pair in front.
// The mode stays the SECOND segment of a scanner key and the pair the FIRST, so neither can be
// mistaken for a gold key ("quick:…") by anything that reads both tables.
//
// ONE DIFFERENCE FROM GENX, on purpose: the key ends with the UTC day. A key is unique forever in
// the alerts table, so gold's undated key means a zone that was called once can never be called
// again at the same level, however many weeks later price returns to it — its "expired" row is
// still in the way. Currency pairs revisit round levels constantly. Dated, the same level can be
// called again on another day; within a day the unique key still makes a call impossible to announce
// or place twice, and the same-setup check (above) carries a setup across midnight.
const steps = (pair: FxPair, price: number, u: number) => Math.round(price / units(pair, u));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
export const scanKey = (pair: FxPair, mode: Mode, side: "buy" | "sell", entryLow: number, entryHigh: number, nowMs: number): string =>
  `${pair.key}:${mode}:${side}:${steps(pair, entryLow, U.dedupe)}:${steps(pair, entryHigh, U.dedupe)}:${day(nowMs)}`;
export const zoneKey = (pair: FxPair, mode: Mode, side: "buy" | "sell", entry: number, nowMs: number): string =>
  `zone:${pair.key}:${mode}:${side}:${steps(pair, entry, U.zoneKey)}:${day(nowMs)}`;
export const isZoneKey = (k: string) => k.startsWith("zone:");

// ── zoneSetups.zoneOf / zoneAction ───────────────────────────────────────────────────────────────
type Read = { action?: unknown; entry?: unknown; stop_loss?: unknown; tp1?: unknown; tp2?: unknown; tp3?: unknown };
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type Zone = { side: "buy" | "sell"; entry: number; stop: number; tp1: number; tp2: number | null; tp3: number | null };

/** The page setup a read is showing — a WAIT-for-trigger or a LIMIT at a level — or null. */
export function zoneOf(g: Read): Zone | null {
  const a = String(g.action ?? "").toUpperCase();
  const side = /^WAIT_FOR_BUY_TRIGGER$|^BUY_LIMIT$/.test(a) ? "buy" : /^WAIT_FOR_SELL_TRIGGER$|^SELL_LIMIT$/.test(a) ? "sell" : null;
  const entry = n(g.entry), stop = n(g.stop_loss), tp1 = n(g.tp1);
  if (!side || entry == null || stop == null || tp1 == null) return null;
  if (side === "sell" ? !(stop > entry && entry > tp1) : !(stop < entry && entry < tp1)) return null;
  return { side, entry, stop, tp1, tp2: n(g.tp2), tp3: n(g.tp3) };
}

/** What to do with a registered setup at live price `lp`: enter on touch, drop through the stop, else wait. */
export function zoneAction(pair: FxPair, side: "buy" | "sell", entry: number, stop: number, lp: number): "enter" | "invalidate" | "wait" {
  const touch = units(pair, U.zoneTouch);
  if (side === "sell") { if (lp >= stop) return "invalidate"; return lp >= entry - touch ? "enter" : "wait"; }
  if (lp <= stop) return "invalidate";
  return lp <= entry + touch ? "enter" : "wait";
}

/** The band a page setup is stored with: the entry, a touch either side. */
export function zoneBand(pair: FxPair, entry: number): { low: number; high: number } {
  const touch = units(pair, U.zoneTouch);
  return { low: px(pair, entry - touch), high: px(pair, entry + touch) };
}
export const ZONE_TTL_MS = 12 * 3600_000;

// ── genxConservativeGate is imported where it is used; it has no gold numbers in it. ──
