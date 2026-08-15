/**
 * GENX — self-contained outcome resolver for recorded Gold signals (spec §28).
 *
 * Walks the candles that printed AFTER each open genx_signals row and grades it:
 *   WIN      — a take-profit filled before the stop.
 *   LOSS     — the stop filled first.
 *   EXPIRED  — armed but neither TP nor stop by the mode deadline (mark-to-market).
 *   (unfilled limit/trigger that never reached entry by the deadline is also
 *    recorded as EXPIRED with filled=false — the schema's outcome enum has no
 *    separate UNFILLED bucket.)
 *
 * The DECISION fields (entry/stop/tps/confidence/reasoning) are NEVER rewritten —
 * only the outcome_* columns are filled in, preserving spec §27 immutability.
 *
 * Like xGhost's resolver this is INDEPENDENT of the universal signal_log resolver
 * so the GENX Lab can grade on demand (when an admin opens it) with no scheduled
 * job, and a cron can call the same function on a schedule.
 *
 * Conservative intrabar rule: if one candle's range contains BOTH the stop and a
 * target, it counts as a LOSS. An audit-grade ledger never flatters itself.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { series } from "@/lib/marketData";

type Row = { datetime: string; open: string; high: string; low: string; close: string };

const GOLD_PIP = 0.1;

// Grading candle interval per GENX mode (fine enough to catch intrabar TP/SL).
const MODE_IV: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };
const IV_MIN: Record<string, number> = { "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60, "4h": 240, "1day": 1440 };

// How long a signal stays gradable before we mark it expired / unfilled.
const MODE_EXPIRY_MS: Record<string, number> = {
  quick: 12 * 3600 * 1000,        // scalp: 12h
  intraday: 3 * 24 * 3600 * 1000, // 3 days
  swing: 14 * 24 * 3600 * 1000,   // 2 weeks
};

const tsOf = (dt: string): number => {
  const s = (dt || "").trim().replace(" ", "T");
  return /(z|[+-]\d{2}(:?\d{2})?)$/i.test(s) ? Date.parse(s) : Date.parse(s + "Z");
};

type Sig = {
  id: string; created_at: string; mode: string | null;
  action: string | null; direction: string | null;
  entry: number | null; stop_loss: number | null;
  tp1: number | null; tp2: number | null; tp3: number | null;
};

type Verdict = {
  status: "WIN" | "LOSS" | "EXPIRED" | "open";
  filled: boolean;
  tp1_hit: boolean; tp2_hit: boolean; tp3_hit: boolean; sl_hit: boolean;
  mfe_pips: number | null; mae_pips: number | null;
  minutes_to_tp: number | null; minutes_to_sl: number | null;
  directional_correct: boolean | null;
};

const OPEN: Verdict = {
  status: "open", filled: false, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: false,
  mfe_pips: null, mae_pips: null, minutes_to_tp: null, minutes_to_sl: null, directional_correct: null,
};

function grade(sig: Sig, rows: Row[], nowMs: number): Verdict {
  // GENX stores directional_bias as bullish/bearish.
  const isLong = String(sig.direction).toLowerCase().startsWith("bull");
  const entry = Number(sig.entry), stop = Number(sig.stop_loss);
  const risk = Math.abs(entry - stop);
  const tps = [sig.tp1, sig.tp2, sig.tp3].map(Number);
  const finiteTps = tps.filter((n) => Number.isFinite(n)) as number[];
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return OPEN;

  const issued = tsOf(sig.created_at);
  const expires = issued + (MODE_EXPIRY_MS[String(sig.mode)] ?? MODE_EXPIRY_MS.quick);
  // A "NOW" action is a market fill (armed immediately); LIMIT / WAIT_FOR_* must
  // first trade into the entry price to arm.
  const isMarket = String(sig.action || "").toUpperCase().includes("NOW");

  const fwd = rows.filter((r) => tsOf(r.datetime) > issued).sort((a, b) => tsOf(a.datetime) - tsOf(b.datetime));
  if (!fwd.length) return OPEN;

  let armed = isMarket;
  let mfe = 0, mae = 0; // in pips, relative to entry, once armed

  for (const c of fwd) {
    const hi = +c.high, lo = +c.low, ct = tsOf(c.datetime);
    if (!armed) {
      if (lo <= entry && entry <= hi) { armed = true; }
      else continue;
    }
    // Excursions relative to entry (pips). favorable positive = moved our way.
    const favPips = (isLong ? hi - entry : entry - lo) / GOLD_PIP;
    const advPips = (isLong ? entry - lo : hi - entry) / GOLD_PIP;
    if (favPips > mfe) mfe = favPips;
    if (advPips > mae) mae = advPips;

    const stopHit = isLong ? lo <= stop : hi >= stop;
    let tpLevel = 0;
    for (let i = finiteTps.length - 1; i >= 0; i--) {
      if (isLong ? hi >= finiteTps[i] : lo <= finiteTps[i]) { tpLevel = i + 1; break; }
    }
    // Conservative: a bar that hits both is a LOSS.
    if (stopHit) {
      return {
        status: "LOSS", filled: true, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: true,
        mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1),
        minutes_to_tp: null, minutes_to_sl: Math.round((ct - issued) / 60000),
        directional_correct: mfe > mae,
      };
    }
    if (tpLevel > 0) {
      return {
        status: "WIN", filled: true,
        tp1_hit: tpLevel >= 1, tp2_hit: tpLevel >= 2, tp3_hit: tpLevel >= 3, sl_hit: false,
        mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1),
        minutes_to_tp: Math.round((ct - issued) / 60000), minutes_to_sl: null,
        directional_correct: true,
      };
    }
  }

  if (nowMs >= expires) {
    if (!armed) {
      // never triggered → expired unfilled
      return { ...OPEN, status: "EXPIRED", filled: false, mfe_pips: 0, mae_pips: 0, directional_correct: false };
    }
    const lastClose = +fwd[fwd.length - 1].close;
    const net = (isLong ? lastClose - entry : entry - lastClose) / GOLD_PIP;
    return {
      status: "EXPIRED", filled: true, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: false,
      mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1),
      minutes_to_tp: null, minutes_to_sl: null,
      directional_correct: net > 0,
    };
  }
  return OPEN;
}

export async function resolveGenxOpen(
  mdKey: string,
  limit = 120
): Promise<{ checked: number; resolved: number; breakdown: Record<string, number> }> {
  const admin = createAdminClient();
  if (!admin || !mdKey) return { checked: 0, resolved: 0, breakdown: {} };
  const nowMs = Date.now();

  // "Open" = not yet graded (outcome is null).
  const { data: openRows } = await admin
    .from("genx_signals")
    .select("id,created_at,mode,action,direction,entry,stop_loss,tp1,tp2,tp3")
    .is("outcome", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  const open = (openRows || []) as Sig[];
  if (!open.length) return { checked: 0, resolved: 0, breakdown: {} };

  // Group by grading interval (all XAUUSD) so each candle series is fetched once.
  const groups = new Map<string, Sig[]>();
  for (const s of open) {
    const iv = MODE_IV[String(s.mode)] ?? "5min";
    (groups.get(iv) || groups.set(iv, []).get(iv)!).push(s);
  }

  let checked = 0, resolved = 0;
  const breakdown: Record<string, number> = {};
  for (const [iv, sigs] of groups) {
    const ivMin = IV_MIN[iv] ?? 5;
    const oldest = Math.min(...sigs.map((s) => tsOf(s.created_at)));
    const barsNeeded = Math.ceil((nowMs - oldest) / (ivMin * 60 * 1000)) + 5;
    const size = Math.max(60, Math.min(500, barsNeeded));
    const rows = await series("XAU/USD", iv, size, mdKey, true);
    if (rows === "ratelimit" || !Array.isArray(rows) || rows.length < 2) continue;
    for (const s of sigs) {
      checked++;
      const v = grade(s, rows as Row[], nowMs);
      breakdown[v.status] = (breakdown[v.status] || 0) + 1;
      if (v.status === "open") continue;
      const { error } = await admin.from("genx_signals").update({
        outcome: v.status,
        filled: v.filled,
        tp1_hit: v.tp1_hit, tp2_hit: v.tp2_hit, tp3_hit: v.tp3_hit, sl_hit: v.sl_hit,
        mfe_pips: v.mfe_pips, mae_pips: v.mae_pips,
        minutes_to_tp: v.minutes_to_tp, minutes_to_sl: v.minutes_to_sl,
        directional_correct: v.directional_correct,
        status: "resolved",
        resolved_at: new Date(nowMs).toISOString(),
      }).eq("id", s.id).is("outcome", null);
      if (!error) resolved++;
    }
  }
  return { checked, resolved, breakdown };
}
