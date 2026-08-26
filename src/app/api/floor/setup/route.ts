import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
 */

const TTL_MS = 45_000;
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

  const modeParam = new URL(req.url).searchParams.get("mode");
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
  return json(body);
}
