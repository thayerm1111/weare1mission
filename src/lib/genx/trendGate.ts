/**
 * GENX TREND GATE (owner 09-21: "GenX isn't winning anymore and I need it to start winning again.
 * Look into why the strategy isn't winning").
 *
 * What the evidence said. Replaying the live GENX 1.0 engine on every closed 5-minute bar of two
 * years of archived XAU/USD (scripts/genx-backtest) showed the engine's calls, taken as a whole, are
 * roughly break-even: about −0.02R a trade before spread. The late-August / early-September run was
 * a strong one-way trend that suited it; since 09-11 gold has chopped inside ~4240–4400 and the same
 * calls lose. Among everything tested, one simple rule held in BOTH halves of the two years and in
 * 8 of 9 quarters: only take a call when the 1-hour EMA 20/50/200 are stacked in the trade's
 * direction (20 > 50 > 200 for a buy, 20 < 50 < 200 for a sell) and the engine grades it "core".
 * Replayed, that kept about a third of the calls and turned them from −0.02R to about +0.14R (first
 * year) and +0.05R (second year) a trade before costs. On the live calls since 09-11, 30 of the 33
 * graded ones were NOT stacked, and those 30 lost 1,558 pips.
 *
 * This is a filter, not a promise: the edge it leaves is thin, it will still have losing days, and
 * it makes GENX call less often — in a choppy market it will mostly sit out. It never raises risk.
 * Off switch: GENX_TREND_GATE=off.
 */
import { series } from "@/lib/marketData";

export type Stack = "up" | "down" | "mixed";

export function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1); const out: number[] = [];
  let e = values[0];
  for (const v of values) { e = v * k + e * (1 - k); out.push(e); }
  return out;
}

/** The 1-hour EMA 20/50/200 stack from CLOSED hourly closes, oldest first. Needs ≥ 220 bars. */
export function hourlyStack(closes: number[]): { stack: Stack; e20: number; e50: number; e200: number } | null {
  const c = closes.filter((x) => Number.isFinite(x));
  if (c.length < 220) return null;
  const e20 = ema(c, 20).at(-1)!, e50 = ema(c, 50).at(-1)!, e200 = ema(c, 200).at(-1)!;
  const stack: Stack = e20 > e50 && e50 > e200 ? "up" : e20 < e50 && e50 < e200 ? "down" : "mixed";
  return { stack, e20, e50, e200 };
}

export const stackAgrees = (side: "buy" | "sell", s: Stack): boolean => (side === "buy" ? s === "up" : s === "down");

// OFF by default since 09-21 (owner: "go back to how it finds trades … straight GENX how it used to be").
// GENX_TREND_GATE=on turns it back on; the research above still stands.
export const trendGateOn = (): boolean => (process.env.GENX_TREND_GATE ?? "").toLowerCase() === "on";

let cache: { at: number; res: ReturnType<typeof hourlyStack> } | null = null;

/** Live gate for the scanner. Fails CLOSED: no trend read means no new call. */
export async function genxTrendGate(side: "buy" | "sell", mdKey: string, opts: { profile?: string | null } = {}): Promise<{ ok: boolean; reason: string; stack?: Stack }> {
  if (!trendGateOn()) return { ok: true, reason: "gate_off" };
  if (opts.profile != null && opts.profile !== "core") return { ok: false, reason: `trend_gate: ${opts.profile} setup (only core setups pass)` };
  if (!cache || Date.now() - cache.at > 5 * 60_000) {
    const rows = await series("XAU/USD", "1h", 500, mdKey, false);
    if (!Array.isArray(rows) || rows.length < 222) return { ok: false, reason: "trend_gate: no hourly data" };
    cache = { at: Date.now(), res: hourlyStack(rows.slice(0, -1).map((r) => +r.close)) }; // the last row is the hour still forming
  }
  const r = cache.res;
  if (!r) return { ok: false, reason: "trend_gate: not enough hourly history" };
  return stackAgrees(side, r.stack)
    ? { ok: true, reason: "ok", stack: r.stack }
    : { ok: false, reason: `trend_gate: 1h EMA 20/50/200 ${r.stack === "mixed" ? "not stacked" : `stacked ${r.stack}`} — no ${side}`, stack: r.stack };
}

/** Same gate from 1-minute bars the caller already holds (the PDH/PDL loop). */
export function trendGateFrom1m(side: "buy" | "sell", closed1m: { t: number; c: number }[]): { ok: boolean; reason: string } {
  if (!trendGateOn()) return { ok: true, reason: "gate_off" };
  const byHour = new Map<number, number>();
  for (const b of closed1m) byHour.set(Math.floor(b.t / 3_600_000), b.c);
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const r = hourlyStack(hours.slice(0, -1).map((h) => byHour.get(h)!));
  if (!r) return { ok: false, reason: "trend_gate: not enough hourly history" };
  return stackAgrees(side, r.stack) ? { ok: true, reason: "ok" } : { ok: false, reason: `trend_gate: 1h EMA stack ${r.stack} — no ${side}` };
}
