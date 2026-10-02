import { createAdminClient } from "@/lib/supabase/admin";
import { series } from "@/lib/marketData";
import { PAIRS, pairOf, type FxPair } from "@/lib/genfx/pairs";

/**
 * GEN FX — GRADING THE PAGE READS (GENX's genxResolve, with the pair as a parameter).
 *
 * Every read a member runs on the GEN FX page is recorded in genfx_signals exactly as it was shown.
 * This walks the candles that printed AFTER each one and fills in only the outcome columns:
 *   WIN      a take-profit filled before the stop
 *   LOSS     the stop filled first
 *   EXPIRED  neither by the horizon's deadline, or a limit/trigger that never reached its entry
 * The decision fields are never rewritten. A candle whose range holds both the stop and a target
 * counts as a LOSS — a ledger that flatters itself is worth nothing.
 *
 * Candles are requested in UTC, for the reason gold's are: without it the feed's exchange-local
 * times read hours late, and candles from before a read get graded as if they came after it.
 */
type Row = { datetime: string; open: string; high: string; low: string; close: string };

const MODE_IV: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };
const IV_MIN: Record<string, number> = { "5min": 5, "15min": 15, "1h": 60 };
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

/** Pure: grade one read against the candles after it. */
export function gradeRead(pair: FxPair, sig: Sig, rows: Row[], nowMs: number): Verdict {
  const isLong = String(sig.direction).toLowerCase().startsWith("bull");
  const entry = Number(sig.entry), stop = Number(sig.stop_loss);
  const risk = Math.abs(entry - stop);
  const tps = [sig.tp1, sig.tp2, sig.tp3].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (sig.entry == null || sig.stop_loss == null || !Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return OPEN;

  const issued = tsOf(sig.created_at);
  const expires = issued + (MODE_EXPIRY_MS[String(sig.mode)] ?? MODE_EXPIRY_MS.quick);
  // A "NOW" action is filled at once; a LIMIT or a WAIT must first trade into its entry.
  let armed = String(sig.action || "").toUpperCase().includes("NOW");
  const fwd = rows.filter((r) => tsOf(r.datetime) > issued).sort((a, b) => tsOf(a.datetime) - tsOf(b.datetime));
  if (!fwd.length) return OPEN;

  let mfe = 0, mae = 0;
  for (const c of fwd) {
    const hi = +c.high, lo = +c.low, ct = tsOf(c.datetime);
    if (!armed) { if (lo <= entry && entry <= hi) armed = true; else continue; }
    mfe = Math.max(mfe, (isLong ? hi - entry : entry - lo) / pair.pip);
    mae = Math.max(mae, (isLong ? entry - lo : hi - entry) / pair.pip);
    const stopHit = isLong ? lo <= stop : hi >= stop;
    let tpLevel = 0;
    for (let i = tps.length - 1; i >= 0; i--) { if (isLong ? hi >= tps[i] : lo <= tps[i]) { tpLevel = i + 1; break; } }
    if (stopHit) return { status: "LOSS", filled: true, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: true, mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1), minutes_to_tp: null, minutes_to_sl: Math.round((ct - issued) / 60000), directional_correct: mfe > mae };
    if (tpLevel > 0) return { status: "WIN", filled: true, tp1_hit: tpLevel >= 1, tp2_hit: tpLevel >= 2, tp3_hit: tpLevel >= 3, sl_hit: false, mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1), minutes_to_tp: Math.round((ct - issued) / 60000), minutes_to_sl: null, directional_correct: true };
  }
  if (nowMs >= expires) {
    if (!armed) return { ...OPEN, status: "EXPIRED", filled: false, mfe_pips: 0, mae_pips: 0, directional_correct: false };
    const lastClose = +fwd[fwd.length - 1].close;
    return { status: "EXPIRED", filled: true, tp1_hit: false, tp2_hit: false, tp3_hit: false, sl_hit: false, mfe_pips: +mfe.toFixed(1), mae_pips: +mae.toFixed(1), minutes_to_tp: null, minutes_to_sl: null, directional_correct: (isLong ? lastClose - entry : entry - lastClose) > 0 };
  }
  return OPEN;
}

/** Grade the reads that have no outcome yet. Called from the scanner; cheap when there is nothing open. */
export async function resolveGenfxOpen(mdKey: string, limit = 120): Promise<{ checked: number; resolved: number }> {
  const admin = createAdminClient();
  if (!admin || !mdKey) return { checked: 0, resolved: 0 };
  const nowMs = Date.now();
  const { data } = await admin.from("genfx_signals").select("id,created_at,pair,mode,action,direction,entry,stop_loss,tp1,tp2,tp3").is("outcome", null).order("created_at", { ascending: true }).limit(limit);
  const open = (data ?? []) as (Sig & { pair: string })[];
  if (!open.length) return { checked: 0, resolved: 0 };

  const groups = new Map<string, (Sig & { pair: string })[]>();
  for (const s of open) {
    const p = pairOf(s.pair);
    if (!p) continue;
    const k = `${p.key}|${MODE_IV[String(s.mode)] ?? "5min"}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  let checked = 0, resolved = 0;
  for (const [k, sigs] of groups) {
    const [pk, iv] = k.split("|");
    const pair = PAIRS[pk as keyof typeof PAIRS];
    const oldest = Math.min(...sigs.map((s) => tsOf(s.created_at)));
    const size = Math.max(60, Math.min(500, Math.ceil((nowMs - oldest) / ((IV_MIN[iv] ?? 5) * 60_000)) + 5));
    const rows = await series(pair.td, iv, size, mdKey, true, "UTC");
    if (rows === "ratelimit" || !Array.isArray(rows) || rows.length < 2) continue;
    for (const s of sigs) {
      checked++;
      const v = gradeRead(pair, s, rows as Row[], nowMs);
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
