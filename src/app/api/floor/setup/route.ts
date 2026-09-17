import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { series, livePrice } from "@/lib/marketData";
import { computeGenxRead, buildGenx, GOLD, MODES, type Mode } from "@/lib/genxCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * THE FLOOR — "GOLD SETUP" (Market Flow) panel data.
 *
 * Returns the LIVE GENX gold read — the same deterministic engine object the app
 * renders (projected path, entry zone, stop, targets, buyer/seller pressure,
 * bias, trigger condition, expected hold) — plus a candle series for the chart.
 *
 * It runs computeGenxRead + buildGenx directly (the pure engine, NO AI narrative)
 * and does NOT charge credits. An in-memory per-mode cache means many members with
 * The Floor open never multiply market-data usage: one compute per mode per cache
 * window, and the underlying series/price come from the shared community cache.
 *
 * PREVIOUS ANALYSIS (owner 09-17): every ~10 minutes the read + its candles are snapshotted to
 * floor_setup_history, so the panel can show the map exactly as it looked earlier in the day.
 *   ?history=1   -> the last snapshots for this mode (one line each)
 *   ?id=<uuid>   -> that snapshot's full map (frozen: its own read, candles and price)
 */

// Short cache so the Floor chart stays live. The underlying series/price come
// from the shared community cache (MD_CACHE_TTL ~30s), so a 15s payload cache
// refreshes as soon as new market data lands without adding upstream calls.
const TTL_MS = 15_000;
// One stored snapshot per mode per 10 minutes — enough to walk back through the day without bloat.
const SNAPSHOT_MS = 10 * 60_000;
const CACHE: Record<string, { at: number; body: Record<string, unknown> }> = {};

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const CHART_TF: Record<Mode, string> = { quick: "5min", intraday: "15min", swing: "1h" };

export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const admin = createAdminClient();

  // ── Previous analyses (list / replay) ──
  const histId = url.searchParams.get("id");
  const wantHistory = url.searchParams.get("history");
  if (histId || wantHistory) {
    if (!admin) return json({ past: [] });
    if (histId) {
      const { data } = await admin.from("floor_setup_history").select("id,at,mode,price,payload").eq("id", histId).maybeSingle();
      const row = data as { id: string; at: string; mode: string; price: number | null; payload: { g?: unknown; candles?: unknown[] } } | null;
      if (!row) return json({ error: "not_found" }, 404);
      return json({ past: true, id: row.id, at: row.at, mode: row.mode, price: row.price, g: row.payload?.g ?? null, candles: row.payload?.candles ?? [], frozen: true });
    }
    const hm = url.searchParams.get("mode");
    const listMode: Mode = hm === "quick" || hm === "swing" ? hm : "intraday";
    const { data } = await admin.from("floor_setup_history").select("id,at,mode,price,action,confidence").eq("mode", listMode).order("at", { ascending: false }).limit(24);
    return json({ past: data ?? [] });
  }

  const modeParam = url.searchParams.get("mode");
  const mode: Mode = modeParam === "quick" || modeParam === "swing" ? modeParam : "intraday";

  if (CACHE[mode] && Date.now() - CACHE[mode].at < TTL_MS) return json({ ...CACHE[mode].body, cached: true });

  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ g: null, candles: [], price: null, mode, error: "marketdata_not_configured" });

  const rr = await computeGenxRead({ mode, mdKey, fresh: false });
  if (!rr.ok) return json({ g: null, candles: [], price: null, mode, error: rr.error });

  const m = MODES[mode];
  const g = buildGenx(rr.read, {
    mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus,
    hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf,
    pip: GOLD.pip, dec: GOLD.dec, marketStory: [], volatility: rr.volatility, atr: rr.atr, m15: rr.m15,
  });

  // Clean candle series for the chart, matched to the mode's chart timeframe.
  let candles: { t: string; o: number; h: number; l: number; c: number }[] = [];
  const raw = await series("XAU/USD", CHART_TF[mode], 60, mdKey, false);
  if (Array.isArray(raw)) candles = raw.map((r) => ({ t: r.datetime, o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter((k) => Number.isFinite(k.c));
  const lp = await livePrice("XAU/USD", mdKey, false);
  const price = typeof lp === "number" ? lp : (candles.length ? candles[candles.length - 1].c : rr.price);

  const body = { g, candles, price, session: rr.session, mode, asOf: rr.nowIso };
  CACHE[mode] = { at: Date.now(), body };

  // Snapshot for "previous analysis" — at most one row per mode per SNAPSHOT_MS, best-effort.
  if (admin) {
    try {
      const { data: last } = await admin.from("floor_setup_history").select("at").eq("mode", mode).order("at", { ascending: false }).limit(1).maybeSingle();
      const lastAt = last ? Date.parse((last as { at: string }).at) : 0;
      if (!lastAt || Date.now() - lastAt > SNAPSHOT_MS) {
        await admin.from("floor_setup_history").insert({
          mode, price, action: g.action ?? null, confidence: g.confidence_score ?? null,
          payload: { g, candles: candles.slice(-60), session: rr.session, asOf: rr.nowIso },
        });
      }
    } catch { /* history is best-effort; never block the panel */ }
  }
  return json(body);
}
