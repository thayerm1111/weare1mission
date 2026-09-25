/**
 * Decimal-safe arithmetic for prices and quantities.
 *
 * Prices and quantities are held as integers in their smallest unit (ticks / lot steps) whenever they
 * are compared, rounded or combined. `0.1 + 0.2 !== 0.3` must never decide whether a stop is valid or
 * whether a quantity clears the broker minimum.
 */

/** Number of decimals needed to print `step` exactly (0.01 -> 2, 0.001 -> 3). */
export function decimalsOf(step: number): number {
  if (!(step > 0)) return 0;
  const s = step.toExponential();
  const m = /e-(\d+)$/.exec(s);
  const mant = s.split("e")[0].replace("-", "").replace(".", "");
  const fracFromMant = Math.max(0, mant.replace(/0+$/, "").length - 1);
  const exp = m ? Number(m[1]) : 0;
  return Math.min(10, fracFromMant + exp);
}

/** Integer count of `step`s in `value`, rounded to nearest to absorb float noise. */
export function toUnits(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return NaN;
  return Math.round(value / step);
}

export function fromUnits(units: number, step: number): number {
  return Number((units * step).toFixed(decimalsOf(step)));
}

export function roundToStep(value: number, step: number, mode: "nearest" | "down" | "up" = "nearest"): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const u = value / step;
  const r = mode === "down" ? Math.floor(u + 1e-9) : mode === "up" ? Math.ceil(u - 1e-9) : Math.round(u);
  return fromUnits(r, step);
}

export const roundDownToStep = (v: number, step: number) => roundToStep(v, step, "down");
export const roundUpToStep = (v: number, step: number) => roundToStep(v, step, "up");

/** Compare two prices at a given tick size. */
export function cmpAtTick(a: number, b: number, tick: number): -1 | 0 | 1 {
  const ua = toUnits(a, tick);
  const ub = toUnits(b, tick);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

export function addTicks(price: number, ticks: number, tick: number): number {
  return fromUnits(toUnits(price, tick) + ticks, tick);
}

export function ticksBetween(a: number, b: number, tick: number): number {
  return Math.abs(toUnits(a, tick) - toUnits(b, tick));
}

/**
 * Round a protective price OUTWARD — away from the entry, so rounding can never silently tighten a
 * stop or push a target through structure. `dir` is +1 when the safe direction is up.
 */
export function roundOutward(value: number, tick: number, dir: 1 | -1): number {
  return roundToStep(value, tick, dir === 1 ? "up" : "down");
}
