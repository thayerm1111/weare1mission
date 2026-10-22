import type { Candle } from "./candles";
import { closeOf } from "./candles";
import type { Series } from "./indicators";
import type { CashtrapSymbol } from "./symbols";

/**
 * SUPPORT AND RESISTANCE — automatic zones from confirmed swings, plus zones the owner marks by hand.
 *
 * Automatic zones (owner's starting assumptions, all configurable):
 *   • A swing high at candle p: its high is HIGHER than each of the `left` candles before it and AT
 *     LEAST AS HIGH as each of the `right` candles after it (mirror for a swing low). The strict/
 *     non-strict split is an implementation choice so a flat top of equal highs yields one swing, at
 *     its first candle.
 *   • A swing is available only once its `right` candles have CLOSED: the zone is created at the close
 *     of candle p + right, and can be used from the next candle's open. Nothing is ever placed back on
 *     an earlier candle.
 *   • Only swings inside the most recent `lookback` completed candles are used.
 *   • Resistance from swing highs, support from swing lows. Half-width = halfWidthAtrMult × ATR(atrLength)
 *     at the candle that confirms the swing, frozen for the zone's life.
 *   • A support zone is invalidated by a completed close below its lower edge; resistance by a
 *     completed close above its upper edge. A broken zone does not flip to the other role.
 *
 * Manual zones are used from the moment they were created (`activeFrom`) until removed (`activeUntil`);
 * they are never applied to candles before they existed.
 */
export type ZoneKind = "support" | "resistance";
export type Zone = {
  id: string;
  symbol: CashtrapSymbol;
  kind: ZoneKind;
  origin: "auto" | "manual";
  lower: number;
  upper: number;
  center: number;
  /** auto: the swing candle's open time. */
  pivotT: number | null;
  /** When the zone came into existence: auto — the close of the confirming candle; manual — when it was marked. */
  createdAt: number;
  /** When it became usable: auto — same as createdAt (the next candle opens then); manual — activeFrom. */
  confirmedAt: number;
  atrAtCreation: number | null;
  halfWidth: number | null;
  touches: number;
  firstTouchT: number | null;
  lastTouchT: number | null;
  invalidatedAt: number | null;
  invalidatedByClose: number | null;
  activeUntil: number | null;
  note?: string | null;
};

export type ZoneConfig = { pivotLeft: number; pivotRight: number; lookbackCandles: number; halfWidthAtrMult: number; manualInvalidateOnClose: boolean };

/**
 * A zone the owner marked. `invalidatedAt` / `invalidatedByClose` carry a break seen earlier (kept in
 * the engine state and on the stored zone), so a broken manual zone stays broken after the breaking
 * candle has left the calculation window.
 */
export type ManualZoneInput = { id: string; symbol: CashtrapSymbol; kind: ZoneKind; lower: number; upper: number; activeFrom: number; activeUntil: number | null; note?: string | null; invalidatedAt?: number | null; invalidatedByClose?: number | null };

function isSwingHigh(c: Candle[], p: number, left: number, right: number): boolean {
  for (let k = 1; k <= left; k++) if (!(c[p].h > c[p - k].h)) return false;
  for (let k = 1; k <= right; k++) if (!(c[p].h >= c[p + k].h)) return false;
  return true;
}
function isSwingLow(c: Candle[], p: number, left: number, right: number): boolean {
  for (let k = 1; k <= left; k++) if (!(c[p].l < c[p - k].l)) return false;
  for (let k = 1; k <= right; k++) if (!(c[p].l <= c[p + k].l)) return false;
  return true;
}

/** Walk the candles after a zone's creation up to (and including) index `last`: touches and invalidation. */
function track(z: Zone, c: Candle[], from: number, last: number, invalidate: boolean): Zone {
  for (let j = from; j <= last; j++) {
    const k = c[j];
    if (k.h >= z.lower && k.l <= z.upper) {
      z.touches += 1;
      if (z.firstTouchT == null) z.firstTouchT = k.t;
      z.lastTouchT = k.t;
    }
    if (invalidate && ((z.kind === "support" && k.c < z.lower) || (z.kind === "resistance" && k.c > z.upper))) {
      z.invalidatedAt = closeOf(k.t);
      z.invalidatedByClose = k.c;
      break;
    }
  }
  return z;
}

/**
 * Every automatic zone known at the OPEN of candle `e` (built only from candles before e), with its
 * touches and invalidation as of that moment. `atr` is aligned with `c`.
 */
export function autoZonesAt(symbol: CashtrapSymbol, c: Candle[], atr: Series, e: number, cfg: ZoneConfig): Zone[] {
  const { pivotLeft: L, pivotRight: R, lookbackCandles: N, halfWidthAtrMult: m } = cfg;
  const first = Math.max(0, e - N);         // the window: the N most recent completed candles before e
  const out: Zone[] = [];
  for (let p = first + L; p + R <= e - 1; p++) {
    const conf = p + R;
    const a = atr[conf];
    if (a == null || !(a > 0)) continue;
    const hw = m * a;
    const make = (kind: ZoneKind, center: number): Zone => ({
      id: `auto:${symbol}:${kind}:${c[p].t}`, symbol, kind, origin: "auto",
      lower: center - hw, upper: center + hw, center, pivotT: c[p].t,
      createdAt: closeOf(c[conf].t), confirmedAt: closeOf(c[conf].t), atrAtCreation: a, halfWidth: hw,
      touches: 0, firstTouchT: null, lastTouchT: null, invalidatedAt: null, invalidatedByClose: null, activeUntil: null,
    });
    if (isSwingHigh(c, p, L, R)) out.push(track(make("resistance", c[p].h), c, conf + 1, e - 1, true));
    if (isSwingLow(c, p, L, R)) out.push(track(make("support", c[p].l), c, conf + 1, e - 1, true));
  }
  return out;
}

/** Manual zones in force at the open of candle `e`, with touches/invalidation from the candles that closed after they were marked. */
export function manualZonesAt(manual: ManualZoneInput[], c: Candle[], e: number, cfg: ZoneConfig): Zone[] {
  const openT = c[e].t;
  const out: Zone[] = [];
  for (const mz of manual) {
    if (!(mz.activeFrom <= openT) || (mz.activeUntil != null && mz.activeUntil <= openT)) continue;
    const z: Zone = {
      id: mz.id, symbol: mz.symbol, kind: mz.kind, origin: "manual",
      lower: Math.min(mz.lower, mz.upper), upper: Math.max(mz.lower, mz.upper), center: (mz.lower + mz.upper) / 2,
      pivotT: null, createdAt: mz.activeFrom, confirmedAt: mz.activeFrom, atrAtCreation: null, halfWidth: null,
      touches: 0, firstTouchT: null, lastTouchT: null, invalidatedAt: null, invalidatedByClose: null, activeUntil: mz.activeUntil, note: mz.note ?? null,
    };
    let from = e;
    for (let j = 0; j < e; j++) if (closeOf(c[j].t) > mz.activeFrom) { from = j; break; }
    track(z, c, from, e - 1, cfg.manualInvalidateOnClose);
    // A break recorded earlier (possibly by a candle no longer in the window) still counts — from its time on.
    if (cfg.manualInvalidateOnClose && mz.invalidatedAt != null && mz.invalidatedAt <= openT && (z.invalidatedAt == null || mz.invalidatedAt < z.invalidatedAt)) {
      z.invalidatedAt = mz.invalidatedAt;
      z.invalidatedByClose = mz.invalidatedByClose ?? null;
    }
    out.push(z);
  }
  return out;
}

/**
 * The first completed close beyond each manual zone among `candles` (candles that closed after the zone
 * was marked and before it was removed). Used to remember breaks beyond the calculation window.
 */
export function manualBreaks(manual: ManualZoneInput[], candles: Candle[]): Record<string, { at: number; close: number }> {
  const out: Record<string, { at: number; close: number }> = {};
  for (const mz of manual) {
    const lo = Math.min(mz.lower, mz.upper), hi = Math.max(mz.lower, mz.upper);
    for (const k of candles) {
      const close = closeOf(k.t);
      if (close <= mz.activeFrom) continue;
      if (mz.activeUntil != null && k.t >= mz.activeUntil) break;
      if ((mz.kind === "support" && k.c < lo) || (mz.kind === "resistance" && k.c > hi)) { out[mz.id] = { at: close, close: k.c }; break; }
    }
  }
  return out;
}

/** Zones still valid (not invalidated) — the ones a setup may use. */
export const validZones = (zones: Zone[]): Zone[] => zones.filter((z) => z.invalidatedAt == null);

/**
 * The zone that confirms a candle, if any. BUY: a valid support zone the candle's range touches or
 * overlaps, with the close at or above its lower edge. SELL: a valid resistance zone the range
 * touches, with the close at or below its upper edge. If several qualify, the one whose centre is
 * nearest the candle's low (BUY) / high (SELL); then the most recently confirmed; then the id.
 */
export function contributingZone(zones: Zone[], k: Candle, dir: "BUY" | "SELL"): Zone | null {
  const kind: ZoneKind = dir === "BUY" ? "support" : "resistance";
  const ext = dir === "BUY" ? k.l : k.h;
  const ok = validZones(zones).filter((z) => z.kind === kind && k.h >= z.lower && k.l <= z.upper && (dir === "BUY" ? k.c >= z.lower : k.c <= z.upper));
  ok.sort((a, b) => Math.abs(a.center - ext) - Math.abs(b.center - ext) || b.confirmedAt - a.confirmedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok[0] ?? null;
}
