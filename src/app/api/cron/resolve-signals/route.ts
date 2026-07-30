import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { series } from "@/lib/marketData";
import { autopsy, type SetupCtx } from "@/lib/learning";
import { recomputeAdjustments } from "@/lib/learningStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled resolver for the universal signal_log. Walks the candles that
 * printed AFTER each open signal was issued and grades it: win (which TP filled),
 * loss (stop hit first), expired (neither by the deadline), or unfilled (a limit
 * that never reached entry). Records realised R, and max adverse / favourable
 * excursion (MAE/MFE) in R. Runs on a Vercel Cron; protected by CRON_SECRET.
 *
 * Conservative intrabar rule: if a single candle's range contains BOTH the stop
 * and a target, we count it as a LOSS (assume the stop was hit first). This never
 * flatters the numbers — the correct posture for an audit-grade ledger.
 */

type Row = { datetime: string; open: string; high: string; low: string; close: string };

const IV_MIN: Record<string, number> = {
  "1min": 1, "5min": 5, "15min": 15, "30min": 30, "45min": 45,
  "1h": 60, "2h": 120, "4h": 240, "1day": 1440, "1week": 10080,
};

// Parse both timestamp shapes we see:
//  • Supabase created_at / expires_at — full ISO WITH a zone ("2026-07-30T07:17:52+00:00")
//  • Twelve Data candle datetimes — "2026-07-30 07:15:00" (a space, no zone → treat as UTC)
// The old version appended "Z" unconditionally, which turned the ISO created_at into an
// invalid "...+00:00Z" → NaN → NaN candle count → every fetch failed and nothing graded.
const tsOf = (dt: string): number => {
  const s = (dt || "").trim().replace(" ", "T");
  return /(z|[+-]\d{2}(:?\d{2})?)$/i.test(s) ? Date.parse(s) : Date.parse(s + "Z");
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Sig = {
  id: string; created_at: string; instrument: string; interval: string | null;
  direction: string; order_type: string | null; entry: number; stop: number;
  tp1: number | null; tp2: number | null; tp3: number | null; expires_at: string | null;
  session: string | null; regime: string | null; method: string | null;
  meta: { ctx?: SetupCtx; mode?: unknown } | null;
};

type Verdict = {
  status: "win" | "loss" | "expired" | "unfilled" | "open";
  hit_tp: number | null; exit_price: number | null; bars_to_resolve: number | null;
  realized_r: number | null; mae_r: number | null; mfe_r: number | null;
};

function grade(sig: Sig, rows: Row[], nowMs: number): Verdict {
  const isLong = sig.direction === "long";
  const entry = Number(sig.entry), stop = Number(sig.stop);
  const risk = Math.abs(entry - stop);
  const tps = [sig.tp1, sig.tp2, sig.tp3].map(Number).filter((n) => Number.isFinite(n)) as number[];
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) {
    return { status: "open", hit_tp: null, exit_price: null, bars_to_resolve: null, realized_r: null, mae_r: null, mfe_r: null };
  }
  const issued = tsOf(sig.created_at);
  const expires = sig.expires_at ? Date.parse(sig.expires_at) : issued + 96 * 3600 * 1000;
  const isMarket = (sig.order_type || "").toLowerCase() === "market";

  const rr = (px: number) => ((isLong ? px - entry : entry - px) / risk); // signed R at price px

  // Candles strictly after issue, in order.
  const fwd = rows.filter((r) => tsOf(r.datetime) > issued).sort((a, b) => tsOf(a.datetime) - tsOf(b.datetime));
  if (!fwd.length) return { status: "open", hit_tp: null, exit_price: null, bars_to_resolve: null, realized_r: null, mae_r: null, mfe_r: null };

  let armed = isMarket;               // market fills immediately; limit/stop must reach entry first
  let maeR = 0, mfeR = 0, bars = 0;

  for (const c of fwd) {
    const hi = +c.high, lo = +c.low;
    bars++;
    if (!armed) {
      // Fill when the candle's range reaches the entry price.
      if (lo <= entry && entry <= hi) armed = true;
      else continue;
    }
    // Update excursions (in R) once armed.
    const advR = isLong ? rr(lo) : rr(hi);   // worst-case R this bar
    const favR = isLong ? rr(hi) : rr(lo);   // best-case R this bar
    if (advR < maeR) maeR = advR;
    if (favR > mfeR) mfeR = favR;

    const stopHit = isLong ? lo <= stop : hi >= stop;
    // Highest target reached this bar (0 if none).
    let tpLevel = 0;
    for (let i = tps.length - 1; i >= 0; i--) {
      const t = tps[i];
      if (isLong ? hi >= t : lo <= t) { tpLevel = i + 1; break; }
    }
    if (stopHit) {
      // Conservative: stop wins ties within a bar.
      return { status: "loss", hit_tp: null, exit_price: stop, bars_to_resolve: bars,
               realized_r: +rr(stop).toFixed(3), mae_r: +maeR.toFixed(3), mfe_r: +mfeR.toFixed(3) };
    }
    if (tpLevel > 0) {
      const exit = tps[tpLevel - 1];
      return { status: "win", hit_tp: tpLevel, exit_price: exit, bars_to_resolve: bars,
               realized_r: +rr(exit).toFixed(3), mae_r: +maeR.toFixed(3), mfe_r: +mfeR.toFixed(3) };
    }
  }

  // Not resolved by any candle. Expire if past the deadline (mark-to-market on last close).
  if (nowMs >= expires) {
    if (!armed) {
      return { status: "unfilled", hit_tp: null, exit_price: null, bars_to_resolve: bars, realized_r: null, mae_r: null, mfe_r: null };
    }
    const lastClose = +fwd[fwd.length - 1].close;
    return { status: "expired", hit_tp: null, exit_price: lastClose, bars_to_resolve: bars,
             realized_r: +rr(lastClose).toFixed(3), mae_r: +maeR.toFixed(3), mfe_r: +mfeR.toFixed(3) };
  }
  return { status: "open", hit_tp: null, exit_price: null, bars_to_resolve: null, realized_r: null, mae_r: null, mfe_r: null };
}

async function run(): Promise<Response> {
  const admin = createAdminClient();
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!admin) return json({ error: "no_admin_client" }, 500);
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  const nowMs = Date.now();

  const { data: openRows, error } = await admin
    .from("signal_log").select("id,created_at,instrument,interval,direction,order_type,entry,stop,tp1,tp2,tp3,expires_at,session,regime,method,meta")
    .eq("status", "open").order("created_at", { ascending: true }).limit(80);
  if (error) return json({ error: "query_failed", detail: error.message }, 500);
  const open = (openRows || []) as Sig[];
  if (!open.length) return json({ ok: true, checked: 0, resolved: 0, note: "no open signals" }, 200);

  // Group by instrument + interval so each candle series is fetched once.
  const groups = new Map<string, Sig[]>();
  for (const s of open) {
    const iv = s.interval || "1h";
    const k = `${s.instrument}|${iv}`;
    (groups.get(k) || groups.set(k, []).get(k)!).push(s);
  }

  let resolved = 0, checked = 0, rateLimited = 0, autopsied = 0;
  const summary: Record<string, number> = { win: 0, loss: 0, expired: 0, unfilled: 0, open: 0 };

  for (const [k, sigs] of groups) {
    const [instrument, iv] = k.split("|");
    const ivMin = IV_MIN[iv] ?? 60;
    const oldest = Math.min(...sigs.map((s) => tsOf(s.created_at)));
    const barsNeeded = Math.ceil((nowMs - oldest) / (ivMin * 60 * 1000)) + 5;
    const size = Math.max(50, Math.min(500, barsNeeded));
    const rows = await series(instrument, iv, size, mdKey, true); // fresh: accurate, un-throttled
    if (rows === "ratelimit") { rateLimited += sigs.length; continue; }
    if (!Array.isArray(rows) || rows.length < 2) continue;
    for (const s of sigs) {
      checked++;
      const v = grade(s, rows as Row[], nowMs);
      summary[v.status] = (summary[v.status] || 0) + 1;
      if (v.status === "open") continue;
      const update: Record<string, unknown> = {
        status: v.status, hit_tp: v.hit_tp, exit_price: v.exit_price, bars_to_resolve: v.bars_to_resolve,
        realized_r: v.realized_r, mae_r: v.mae_r, mfe_r: v.mfe_r, resolved_at: new Date(nowMs).toISOString(),
      };
      // Autopsy every losing trade: a stop-out, or an expiry that closed at a loss.
      const isLoss = v.status === "loss" || (v.status === "expired" && (v.realized_r ?? 0) < 0);
      if (isLoss) {
        const a = autopsy({ ctx: s.meta?.ctx || {}, realized_r: v.realized_r, mae_r: v.mae_r, mfe_r: v.mfe_r });
        update.failure_reasons = a.reasons;
        update.autopsy = a.detail;
        update.autopsied_at = new Date(nowMs).toISOString();
        autopsied++;
      }
      const { error: uerr } = await admin.from("signal_log").update(update).eq("id", s.id).eq("status", "open");
      if (!uerr) resolved++;
    }
  }

  // Continuous learning: rebuild the bounded, penalty-only scoring adjustments
  // from the rolling window of graded trades (only worth it if anything resolved).
  let activeAdjustments = 0;
  if (resolved > 0) activeAdjustments = await recomputeAdjustments(admin);

  return json({ ok: true, checked, resolved, autopsied, active_adjustments: activeAdjustments, still_open: summary.open, rate_limited: rateLimited, breakdown: summary }, 200);
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // must be configured
  const hdr = req.headers.get("authorization") || "";
  if (hdr === `Bearer ${secret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("key") === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  try { return await run(); } catch (e) { return json({ error: "resolver_failed", detail: String(e).slice(0, 200) }, 500); }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  try { return await run(); } catch (e) { return json({ error: "resolver_failed", detail: String(e).slice(0, 200) }, 500); }
}
