import { createAdminClient } from "@/lib/supabase/admin";
import { goldMaxEntry } from "@/lib/flow/executor";
import { capGoldStop } from "@/lib/flow/sizing";

/**
 * GENX GOLD QUALITY GATE (owner 09-16: "GENX has got to take better trades").
 *
 * Two deterministic checks every GENX gold entry must pass before any account takes it.
 * Chosen from a replay of every GENX ENTER NOW from 08-13 to 09-14 against 1-minute gold
 * prices (one position at a time, fill only within 10 pips of the zone, 100-pip stop cap,
 * original target, 3-pip cost), tuned on the first 60% and checked on the last 40%:
 *
 *   as called:            81 trades · PF 1.73 · +2,644 pips · worst drawdown 512 pips
 *   with this gate:       43 trades · PF 2.38 · +2,538 pips · worst drawdown 357 pips
 *                         (first 60%: PF 1.79 → 2.42; held-out 40%: PF 1.68 → 2.50)
 *
 * 1. TREND SLOPE: the 20-hour average gold price must have moved at least MIN_SLOPE dollars
 *    in the trade's direction over the last 3 hours. No buying a falling 20h average, no
 *    selling a rising one, no trading a flat one.
 * 2. REWARD AT THE WORST FILL: from the worst price we allow (zone edge + chase limit), with
 *    the capped stop, target distance ÷ stop distance must be at least MIN_RR.
 *
 * Prices come from genx_candle_archive (XAU/USD 1-min, topped up every 5 min). If that data
 * is missing or stale the gate FAILS OPEN (the entry proceeds on the existing guards), so a
 * data hiccup can never freeze the desk.
 *
 * Env: GENX_QUALITY_GATE (default on; "off" disables), GENX_MIN_SLOPE_USD (default 1),
 *      GENX_MIN_RR (default 1.5).
 */
export type GateResult = { ok: boolean; reason: string; slope: number | null; rr: number | null };

const num = (v: string | undefined, d: number) => { const n = Number(v); return v != null && v.trim() !== "" && Number.isFinite(n) ? n : d; };
export const gateEnabled = () => !/^(0|off|false|no)$/i.test(String(process.env.GENX_QUALITY_GATE ?? "").trim());
export const minSlopeUsd = () => num(process.env.GENX_MIN_SLOPE_USD, 1);
export const minRR = () => num(process.env.GENX_MIN_RR, 1.5);

/** Pure decision (unit tested). slope = sma20h(now) - sma20h(3h ago), in dollars. */
export function decideGate(o: {
  side: "buy" | "sell"; entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null;
  slope: number | null; minSlope?: number; minRr?: number;
}): GateResult {
  const dir = o.side === "buy" ? 1 : -1;
  const maxEntry = goldMaxEntry(o.side, o.entryLow, o.entryHigh);
  const ref = maxEntry ?? (o.side === "buy" ? (o.entryHigh ?? o.entryLow) : (o.entryLow ?? o.entryHigh));
  let rr: number | null = null;
  if (ref != null && o.stop != null && o.tp != null) {
    const sl = capGoldStop(o.side, ref, o.stop) ?? o.stop;
    const risk = Math.abs(ref - sl);
    const reward = dir * (o.tp - ref);
    rr = risk > 0 ? reward / risk : null;
  }
  const mr = o.minRr ?? minRR();
  const ms = o.minSlope ?? minSlopeUsd();
  if (rr != null && rr < mr) return { ok: false, reason: `rr ${rr.toFixed(2)} < ${mr} at the worst allowed fill`, slope: o.slope, rr };
  if (o.slope != null && dir * o.slope < ms) {
    return { ok: false, reason: `20h trend ${o.slope >= 0 ? "+" : ""}${o.slope.toFixed(2)} over 3h is not ${o.side === "buy" ? "rising" : "falling"} ≥ $${ms}`, slope: o.slope, rr };
  }
  return { ok: true, reason: "ok", slope: o.slope, rr };
}

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const cache: { at: number; slope: number | null } = { at: 0, slope: null };

/** sma20h(now) − sma20h(3h ago) from the candle archive; null if data is missing/stale. */
export async function goldTrendSlope(admin: Admin): Promise<number | null> {
  if (Date.now() - cache.at < 60_000) return cache.slope;
  let slope: number | null = null;
  try {
    const since = new Date(Date.now() - 23 * 3600e3).toISOString();
    const { data } = await admin.from("genx_candle_archive").select("t,c")
      .eq("symbol", "XAU/USD").eq("interval", "1min").gte("t", since).order("t", { ascending: true }).limit(2000);
    const rows = ((data ?? []) as { t: string; c: number | string }[]).map((r) => ({ t: Date.parse(r.t), c: Number(r.c) })).filter((r) => Number.isFinite(r.c));
    const now = Date.now();
    const newest = rows.length ? rows[rows.length - 1].t : 0;
    if (rows.length >= 600 && now - newest < 30 * 60_000) {
      const avg = (from: number, to: number) => {
        const xs = rows.filter((r) => r.t > from && r.t <= to);
        return xs.length >= 300 ? xs.reduce((a, r) => a + r.c, 0) / xs.length : null;
      };
      const a = avg(now - 20 * 3600e3, now);
      const b = avg(now - 23 * 3600e3, now - 3 * 3600e3);
      slope = a != null && b != null ? a - b : null;
    }
  } catch { slope = null; }
  cache.at = Date.now(); cache.slope = slope;
  return slope;
}

export async function genxGoldQualityGate(admin: Admin, sig: { side: "buy" | "sell"; entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null }): Promise<GateResult> {
  if (!gateEnabled()) return { ok: true, reason: "gate_off", slope: null, rr: null };
  const slope = await goldTrendSlope(admin);
  return decideGate({ ...sig, slope });
}
