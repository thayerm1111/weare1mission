import { CURRENCIES, PAIRS, PAIR_KEYS, type Ccy, type PairKey } from "./pairs";

/**
 * MONEY ARITHMETIC — pips, ticks and currency conversion. Pure.
 *
 * A pip of a pair is worth `lotSize × pip` units of the pair's QUOTE currency per 1.0 lot (EURUSD:
 * 100,000 × 0.0001 = 10 USD; USDJPY: 100,000 × 0.01 = 1,000 JPY). Turning that into the account's
 * currency needs a rate, taken from the seven pairs' own live quotes — directly when one pair joins
 * the two currencies, through USD otherwise. No rate, no number: the caller refuses the trade rather
 * than sizing on a guess (the August forex run sized yen pairs on an approximation).
 *
 * Prices are snapped to the broker's tick in integer tick counts, so 1.08 + 0.001 does not become
 * 1.0810000000000002 on its way to an order.
 */

export type Quote = { bid: number; ask: number };
export type Rates = Partial<Record<PairKey, Quote>>;

const mid = (q: Quote) => (q.bid + q.ask) / 2;

const isCcy = (c: string): c is Ccy => (CURRENCIES as string[]).includes(c);

/** Units of `to` per 1 unit of `from`, from the live quotes, or null. */
export function rate(from: string, to: string, rates: Rates): number | null {
  const f = from.toUpperCase(), t = to.toUpperCase();
  if (f === t) return 1;
  if (!isCcy(f) || !isCcy(t)) return null;
  for (const k of PAIR_KEYS) {
    const q = rates[k];
    if (!q || !(q.bid > 0) || !(q.ask > 0)) continue;
    const p = PAIRS[k];
    if (p.base === f && p.quote === t) return mid(q);
    if (p.base === t && p.quote === f) return 1 / mid(q);
  }
  if (f !== "USD" && t !== "USD") {
    const a = rate(f, "USD", rates), b = rate("USD", t, rates);
    return a != null && b != null ? a * b : null;
  }
  return null;
}

export function convert(amount: number, from: string, to: string, rates: Rates): number | null {
  const r = rate(from, to, rates);
  return r == null ? null : amount * r;
}

export type ContractSpec = { lotSize: number; pipSize: number; quote: string; base: string; leverage: number | null };

/** Account currency per pip per 1.0 lot. */
export function pipValuePerLot(spec: ContractSpec, accountCcy: string, rates: Rates): number | null {
  return convert(spec.lotSize * spec.pipSize, spec.quote, accountCcy, rates);
}

/** Account currency controlled by 1.0 lot at `price` (lotSize units of the base currency). */
export function notionalPerLot(spec: ContractSpec, price: number, accountCcy: string, rates: Rates): number | null {
  if (!(price > 0)) return null;
  return convert(spec.lotSize * price, spec.quote, accountCcy, rates);
}

/** Decimal places of a tick such as 0.00001 → 5, 0.001 → 3. */
export function decimalsOf(step: number): number {
  if (!(step > 0)) return 0;
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return (s.split(".")[1] ?? "").length;
}

/** Snap a price to the tick: "down", "up" or "nearest". */
export function snap(price: number, tick: number, mode: "down" | "up" | "nearest"): number {
  const n = price / tick;
  const r = Math.round(n);
  // Within a billionth of a tick of a whole tick is that tick (floating noise, not a real fraction).
  const ticks = Math.abs(n - r) < 1e-9 ? r : mode === "down" ? Math.floor(n) : mode === "up" ? Math.ceil(n) : r;
  return Number((ticks * tick).toFixed(decimalsOf(tick)));
}

/** Round a quantity DOWN to the broker's lot step. */
export function floorLots(lots: number, step: number): number {
  if (!(lots > 0) || !(step > 0)) return 0;
  const n = lots / step;
  const r = Math.round(n);
  const steps = Math.abs(n - r) < 1e-9 ? r : Math.floor(n);
  return Number((steps * step).toFixed(decimalsOf(step)));
}

export const pipsBetween = (a: number, b: number, pip: number): number => Math.abs(a - b) / pip;

/** Round for display/storage (2 decimals of a pip is plenty). */
export const r2 = (n: number) => Math.round(n * 100) / 100;
