/**
 * xGhost — self-contained outcome resolver for the paper-logged signals.
 *
 * Walks the candles that printed AFTER each open xGhost signal and grades it:
 * win (which TP filled), loss (stop first), expired (neither by the deadline), or
 * unfilled (a limit that never reached entry). Records realised R and MAE/MFE.
 *
 * This is deliberately INDEPENDENT of the platform-wide cron resolver so the admin
 * dashboard can grade xGhost on demand (when the admin opens it) without any
 * scheduled job, and without touching the shared resolver's code path.
 *
 * Conservative intrabar rule: if one candle's range contains BOTH the stop and a
 * target, it counts as a LOSS. An audit-grade ledger never flatters itself.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { series } from "@/lib/marketData";

type Row = { datetime: string; open: string; high: string; low: string; close: string };

const IV_MIN: Record<string, number> = {
  "1min": 1, "5min": 5, "15min": 15, "30min": 30, "45min": 45,
  "1h": 60, "2h": 120, "4h": 240, "1day": 1440,
};

const tsOf = (dt: string): number => {
  const s = (dt || "").trim().replace(" ", "T");
  return /(z|[+-]\d{2}(:?\d{2})?)$/i.test(s) ? Date.parse(s) : Date.parse(s + "Z");
};

type Sig = {
  id: string; created_at: string; instrument: string; interval: string | null;
  direction: string; order_type: string | null; entry: number; stop: number;
  tp1: number | null; tp2: number | null; tp3: number | null; expires_at: string | null;
};

type Verdict = {
  status: "win" | "loss" | "expired" | "unfilled" | "open";
  hit_tp: number | null; exit_price: number | null; bars_to_resolve: number | null;
  realized_r: number | null; mae_r: number | null; mfe_r: number | null;
};

const OPEN: Verdict = { status: "open", hit_tp: null, exit_price: null, bars_to_resolve: null, realized_r: null, mae_r: null, mfe_r: null };

function grade(sig: Sig, rows: Row[], nowMs: number): Verdict {
  const isLong = sig.direction === "long";
  const entry = Number(sig.entry), stop = Number(sig.stop);
  const risk = Math.abs(entry - stop);
  const tps = [sig.tp1, sig.tp2, sig.tp3].map(Number).filter((n) => Number.isFinite(n)) as number[];
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return OPEN;

  const issued = tsOf(sig.created_at);
  const expires = sig.expires_at ? Date.parse(sig.expires_at) : issued + 24 * 3600 * 1000;
  const isMarket = (sig.order_type || "").toLowerCase() === "market";
  const rr = (px: number) => (isLong ? px - entry : entry - px) / risk;

  const fwd = rows.filter((r) => tsOf(r.datetime) > issued).sort((a, b) => tsOf(a.datetime) - tsOf(b.datetime));
  if (!fwd.length) return OPEN;

  let armed = isMarket;
  let maeR = 0, mfeR = 0, bars = 0;

  for (const c of fwd) {
    const hi = +c.high, lo = +c.low;
    bars++;
    if (!armed) {
      if (lo <= entry && entry <= hi) armed = true;
      else continue;
    }
    const advR = isLong ? rr(lo) : rr(hi);
    const favR = isLong ? rr(hi) : rr(lo);
    if (advR < maeR) maeR = advR;
    if (favR > mfeR) mfeR = favR;

    const stopHit = isLong ? lo <= stop : hi >= stop;
    let tpLevel = 0;
    for (let i = tps.length - 1; i >= 0; i--) {
      const t = tps[i];
      if (isLong ? hi >= t : lo <= t) { tpLevel = i + 1; break; }
    }
    if (stopHit) {
      return { status: "loss", hit_tp: null, exit_price: stop, bars_to_resolve: bars,
        realized_r: +rr(stop).toFixed(3), mae_r: +maeR.toFixed(3), mfe_r: +mfeR.toFixed(3) };
    }
    if (tpLevel > 0) {
      const exit = tps[tpLevel - 1];
      return { status: "win", hit_tp: tpLevel, exit_price: exit, bars_to_resolve: bars,
        realized_r: +rr(exit).toFixed(3), mae_r: +maeR.toFixed(3), mfe_r: +mfeR.toFixed(3) };
    }
  }

  if (nowMs >= expires) {
    if (!armed) return { status: "unfilled", hit_tp: null, exit_price: null, bars_to_resolve: bars, realized_r: null, mae_r: null, mfe_r: null };
    const lastClose = +fwd[fwd.length - 1].close;
    return { status: "expired", hit_tp: null, exit_price: lastClose, bars_to_resolve: bars,
      realized_r: +rr(lastClose).toFixed(3), mae_r: +maeR.toFixed(3), mfe_r: +mfeR.toFixed(3) };
  }
  return OPEN;
}

export async function resolveXghostOpen(mdKey: string, limit = 120): Promise<{ checked: number; resolved: number; breakdown: Record<string, number> }> {
  const admin = createAdminClient();
  if (!admin || !mdKey) return { checked: 0, resolved: 0, breakdown: {} };
  const nowMs = Date.now();

  const { data: openRows } = await admin
    .from("signal_log")
    .select("id,created_at,instrument,interval,direction,order_type,entry,stop,tp1,tp2,tp3,expires_at")
    .eq("engine", "xghost").eq("status", "open")
    .order("created_at", { ascending: true }).limit(limit);
  const open = (openRows || []) as Sig[];
  if (!open.length) return { checked: 0, resolved: 0, breakdown: {} };

  const groups = new Map<string, Sig[]>();
  for (const s of open) {
    const iv = s.interval || "5min";
    const k = `${s.instrument}|${iv}`;
    (groups.get(k) || groups.set(k, []).get(k)!).push(s);
  }

  let checked = 0, resolved = 0;
  const breakdown: Record<string, number> = {};
  for (const [k, sigs] of groups) {
    const [instrument, iv] = k.split("|");
    const ivMin = IV_MIN[iv] ?? 5;
    const oldest = Math.min(...sigs.map((s) => tsOf(s.created_at)));
    const barsNeeded = Math.ceil((nowMs - oldest) / (ivMin * 60 * 1000)) + 5;
    const size = Math.max(50, Math.min(500, barsNeeded));
    const rows = await series(instrument, iv, size, mdKey, true);
    if (rows === "ratelimit" || !Array.isArray(rows) || rows.length < 2) continue;
    for (const s of sigs) {
      checked++;
      const v = grade(s, rows as Row[], nowMs);
      breakdown[v.status] = (breakdown[v.status] || 0) + 1;
      if (v.status === "open") continue;
      const { error } = await admin.from("signal_log").update({
        status: v.status, hit_tp: v.hit_tp, exit_price: v.exit_price, bars_to_resolve: v.bars_to_resolve,
        realized_r: v.realized_r, mae_r: v.mae_r, mfe_r: v.mfe_r, resolved_at: new Date(nowMs).toISOString(),
      }).eq("id", s.id).eq("status", "open");
      if (!error) resolved++;
    }
  }
  return { checked, resolved, breakdown };
}
