import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, pairOf, type FxPair } from "@/lib/genfx/pairs";
import { fxSeries, candleFloorMs, settledCloseMs } from "@/lib/genfx/market";

/**
 * GEN FX — GRADING THE PAGE READS (GENX's genxResolve, with the pair as a parameter).
 *
 * Every read a member runs on the GEN FX page is recorded in genfx_signals exactly as it was shown.
 * This walks the candles that printed AFTER each one and fills in only the outcome columns:
 *   WIN      a take-profit filled before the stop
 *   LOSS     the stop filled first
 *   EXPIRED  neither by the horizon's deadline, or a limit/trigger that never reached its entry
 * The decision fields are never rewritten.
 *
 * WHAT A CANDLE CANNOT SHOW IS SETTLED AGAINST THE READ — the same rule the scanner's calls are graded
 * by (decide.gradeCandle), so the two records on the GEN FX page are kept one way:
 *   • a candle whose range holds both the stop and a target is a LOSS;
 *   • the candle the read was ISSUED in, and the candle that FILLED a waiting entry, can stop the read
 *     but cannot pay it. Part of each candle's range was printed before the trade existed, and a
 *     target "hit" in that part is not a win. (GENX's version skips the issue candle altogether — so
 *     a stop inside it is never seen — and lets the fill candle pay.)
 *   • the issue candle cannot FILL a waiting entry either: a limit touched at 12:01 was not filled by
 *     a read issued at 12:04. A waiting read is filled by a candle that opened after it was issued.
 *   • how far price ran for and against the read is measured from candles that opened after it was
 *     issued, too — the issue candle's range is mostly from before the read existed.
 *   • only CLOSED candles are read — closed, and given the feed's few seconds to finish them — and none
 *     that starts after the read's deadline;
 *   • a read is out of time only once the LAST candle of its window has closed and is in hand. That
 *     candle starts before the deadline and closes up to five minutes after it: a pass that runs in
 *     between would call "expired" a read whose target is being hit as it looks.
 * To keep the doubt small on every horizon, all three are graded on FIVE-MINUTE candles: the issue
 * candle is then five minutes of doubt for a Swing read too, not an hour.
 *
 * Candles are requested in UTC, for the reason gold's are: without it the feed's exchange-local
 * times read hours late, and candles from before a read get graded as if they came after it.
 */
type Row = { datetime: string; open: string; high: string; low: string; close: string };

const IV_MS = 5 * 60_000;
const MODE_EXPIRY_MS: Record<string, number> = { quick: 12 * 3600_000, intraday: 3 * 24 * 3600_000, swing: 14 * 24 * 3600_000 };

const tsOf = (dt: string): number => {
  const s = (dt || "").trim().replace(" ", "T");
  return /(z|[+-]\d{2}(:?\d{2})?)$/i.test(s) ? Date.parse(s) : Date.parse(s + "Z");
};

export type Sig = { id: string; created_at: string; mode: string | null; action: string | null; direction: string | null; entry: number | null; stop_loss: number | null; tp1: number | null; tp2: number | null; tp3: number | null };
export type Verdict = {
  status: "WIN" | "LOSS" | "EXPIRED" | "open"; filled: boolean;
  tp1_hit: boolean; tp2_hit: boolean; tp3_hit: boolean; sl_hit: boolean;
  mfe_pips: number | null; mae_pips: number | null; minutes_to_tp: number | null; minutes_to_sl: number | null;
  directional_correct: boolean | null;
};
const OPEN: Verdict = { status: "open", filled: false, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: false, mfe_pips: null, mae_pips: null, minutes_to_tp: null, minutes_to_sl: null, directional_correct: null };

/** Pure: grade one read against five-minute candles (`rows`, any order; datetime = the candle's START, UTC). */
export function gradeRead(pair: FxPair, sig: Sig, rows: Row[], nowMs: number, ivMs = IV_MS): Verdict {
  const isLong = String(sig.direction).toLowerCase().startsWith("bull");
  const entry = Number(sig.entry), stop = Number(sig.stop_loss);
  const risk = Math.abs(entry - stop);
  const tps = [sig.tp1, sig.tp2, sig.tp3].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (sig.entry == null || sig.stop_loss == null || !Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return OPEN;

  const issued = tsOf(sig.created_at);
  const expires = issued + (MODE_EXPIRY_MS[String(sig.mode)] ?? MODE_EXPIRY_MS.quick);
  // A "NOW" action is filled at once; a LIMIT or a WAIT must first trade into its entry.
  let armed = String(sig.action || "").toUpperCase().includes("NOW");
  // Candles still open when the read was issued or later, closed by now — as the feed can be trusted to
  // have them: the last close as it stood eight seconds ago — and starting before the deadline.
  const closedBy = settledCloseMs(nowMs);
  const all = rows.map((r) => ({ t: tsOf(r.datetime), hi: +r.high, lo: +r.low, close: +r.close })).filter((c) => Number.isFinite(c.t));
  const fwd = all.filter((c) => c.t + ivMs > issued && c.t + ivMs <= closedBy && c.t < expires).sort((a, b) => a.t - b.t);

  let mfe = 0, mae = 0;
  for (const c of fwd) {
    const issueCandle = c.t <= issued;
    // Could this candle's range include prices from BEFORE the trade existed? Then it can stop it, not pay it.
    let partial = issueCandle;
    if (!armed) {
      if (issueCandle) continue;                                  // touched before the read was issued: not a fill
      if (c.lo <= entry && entry <= c.hi) { armed = true; partial = true; } else continue;
    }
    const closeAt = c.t + ivMs;
    if (!issueCandle) {
      mfe = Math.max(mfe, (isLong ? c.hi - entry : entry - c.lo) / pair.pip);
      mae = Math.max(mae, (isLong ? entry - c.lo : c.hi - entry) / pair.pip);
    }
    const stopHit = isLong ? c.lo <= stop : c.hi >= stop;
    if (stopHit) mae = Math.max(mae, risk / pair.pip);            // stopped: it went at least the stop's distance against the read
    let tpLevel = 0;
    if (!partial) for (let i = tps.length - 1; i >= 0; i--) { if (isLong ? c.hi >= tps[i] : c.lo <= tps[i]) { tpLevel = i + 1; break; } }
    if (stopHit) return { status: "LOSS", filled: true, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: true, mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1), minutes_to_tp: null, minutes_to_sl: Math.max(0, Math.round((closeAt - issued) / 60000)), directional_correct: mfe > mae };
    if (tpLevel > 0) return { status: "WIN", filled: true, tp1_hit: tpLevel >= 1, tp2_hit: tpLevel >= 2, tp3_hit: tpLevel >= 3, sl_hit: false, mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1), minutes_to_tp: Math.round((closeAt - issued) / 60000), minutes_to_sl: null, directional_correct: true };
  }
  if (nowMs >= expires) {
    // Out of time — once the window's last candle has closed and is among the candles in hand.
    const lastStart = Math.floor((expires - 1) / ivMs) * ivMs;
    const newest = all.reduce((m, c) => Math.max(m, c.t), -Infinity);
    if (!(closedBy >= lastStart + ivMs && newest >= lastStart)) return OPEN;
    if (!armed) return { ...OPEN, status: "EXPIRED", filled: false, mfe_pips: 0, mae_pips: 0, directional_correct: false };
    const lastClose = fwd.length ? fwd[fwd.length - 1].close : entry;
    return { status: "EXPIRED", filled: true, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: false, mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1), minutes_to_tp: null, minutes_to_sl: null, directional_correct: (isLong ? lastClose - entry : entry - lastClose) > 0 };
  }
  return OPEN;
}

const PAGE = 1000;       // the API returns at most this many rows per request, whatever limit is asked for

/**
 * Grade the reads that have no outcome yet. Called from the scanner; cheap when there is nothing open.
 *
 * EVERY open read is looked at, a page at a time — not "the oldest sixty". Swing reads stay open for up
 * to fourteen days, and with only the head of the queue read, a day's new reads were graded days late or,
 * once the candles on hand no longer reached back to them, never. A read with no entry or no stop is not
 * a call and is never asked for: it has nothing to grade and would only sit at the front.
 */
export async function resolveGenfxOpen(mdKey: string, limit = 5000): Promise<{ checked: number; resolved: number }> {
  const admin = createAdminClient();
  if (!admin || !mdKey) return { checked: 0, resolved: 0 };
  const nowMs = Date.now();
  const open: (Sig & { pair: string })[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await admin.from("genfx_signals").select("id,created_at,pair,mode,action,direction,entry,stop_loss,tp1,tp2,tp3")
      .is("outcome", null).not("entry", "is", null).not("stop_loss", "is", null)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, Math.min(from + PAGE, limit) - 1);
    if (error) break;
    const rows = (data ?? []) as (Sig & { pair: string })[];
    open.push(...rows);
    if (rows.length < PAGE) break;
  }
  if (!open.length) return { checked: 0, resolved: 0 };

  // One request per pair, whatever the horizons: everything is graded on five-minute candles.
  const groups = new Map<string, (Sig & { pair: string })[]>();
  for (const s of open) {
    const p = pairOf(s.pair);
    if (!p) continue;
    (groups.get(p.key) ?? groups.set(p.key, []).get(p.key)!).push(s);
  }
  let checked = 0, resolved = 0;
  for (const [pk, sigs] of groups) {
    const pair = PAIRS[pk as keyof typeof PAIRS];
    const oldest = Math.min(...sigs.map((s) => tsOf(s.created_at)));
    const size = Math.max(60, Math.min(5000, Math.ceil((nowMs - oldest) / IV_MS) + 5));
    // Through the desk's shared reader: fetched after the last close the feed has had time to finish,
    // and given eight seconds — the market-data client has no timeout of its own, and this runs on the
    // loop that holds the GEN FX lock.
    const rows = await fxSeries(pair.td, "5min", size, { utc: true, maxAgeMs: 30_000, timeoutMs: 8_000, notBeforeMs: candleFloorMs(nowMs) });
    if (rows === "ratelimit" || !Array.isArray(rows) || rows.length < 2) continue;
    const first = Math.min(...(rows as Row[]).map((r) => tsOf(r.datetime)).filter(Number.isFinite));
    for (const s of sigs) {
      checked++;
      // The candles on hand must reach back to the read, or the first of them might already be past its
      // result. A read they no longer reach, whose deadline has passed, is closed with no result — it
      // cannot be graded, and left open it would sit at the front of this queue for ever.
      const issued = tsOf(s.created_at);
      const covered = first <= issued;
      if (!covered && nowMs < issued + (MODE_EXPIRY_MS[String(s.mode)] ?? MODE_EXPIRY_MS.quick)) continue;
      const v: Verdict = covered ? gradeRead(pair, s, rows as Row[], nowMs) : { ...OPEN, status: "EXPIRED" };
      if (v.status === "open") continue;
      const { error } = await admin.from("genfx_signals").update({
        outcome: v.status, filled: v.filled, tp1_hit: v.tp1_hit, tp2_hit: v.tp2_hit, tp3_hit: v.tp3_hit, sl_hit: v.sl_hit,
        mfe_pips: v.mfe_pips, mae_pips: v.mae_pips, minutes_to_tp: v.minutes_to_tp, minutes_to_sl: v.minutes_to_sl,
        directional_correct: v.directional_correct, status: "resolved", resolved_at: new Date(nowMs).toISOString(),
      }).eq("id", s.id).is("outcome", null);
      if (!error) resolved++;
    }
  }
  return { checked, resolved };
}
