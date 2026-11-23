import { createClient } from "@/lib/supabase/server";
import { series, livePrice, livePriceSane, type Row } from "@/lib/marketData";
import { isOpen } from "@/lib/cashtrap/marketHours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 18;

/**
 * USD/JPY market WATCH for the Floor, not a GENX/GEN FX callout. The existing
 * GEN FX engine supports EUR/USD and GBP/JPY. This watch describes only
 * observed market structure and has no trade entry, stop, target or execution
 * authority. For a full USD/JPY signal use the existing OM AI Plays engine.
 */
type Mode = "quick" | "intraday" | "swing";
type Candle = { t: string; o: number; h: number; l: number; c: number };
type Watch = { bias: "bullish" | "bearish" | "neutral"; summary: string; momentum: string;
  high: number; low: number; evidence: string[] };
type Answer = { symbol: "USDJPY"; mode: Mode; candles: Candle[]; candlesTz: "UTC"; price: number;
  asOf: string; watch: Watch; marketClosed: boolean };
let cache = new Map<Mode, { at: number; data: Answer }>();
const TTL_MS = 20_000;
const INTERVAL: Record<Mode, string> = { quick: "5min", intraday: "15min", swing: "1h" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function candle(r: Row): Candle | null {
  const b = { t: r.datetime, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close) };
  return typeof b.t === "string" && [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0)
    && b.h >= Math.max(b.o, b.c, b.l) && b.l <= Math.min(b.o, b.c, b.h) ? b : null;
}
const avg = (v: number[]) => v.reduce((sum, n) => sum + n, 0) / Math.max(1, v.length);
function watchFor(bars: Candle[], mode: Mode): Watch {
  const last = bars[bars.length - 1], closes = bars.map((b) => b.c);
  const ma20 = avg(closes.slice(-20)), ma50 = avg(closes.slice(-50));
  const bias: Watch["bias"] = last.c > ma20 && ma20 > ma50 ? "bullish"
    : last.c < ma20 && ma20 < ma50 ? "bearish" : "neutral";
  const prev = bars.slice(-21, -1);
  const high = Math.max(...prev.map((b) => b.h)), low = Math.min(...prev.map((b) => b.l));
  const move = last.c - closes[closes.length - 5];
  const momentum = Math.abs(move) < Math.max(0.001, (high - low) * 0.05) ? "Flat"
    : move > 0 ? "Rising" : "Falling";
  const interval = INTERVAL[mode];
  const summary = last.c > high
    ? "Price is testing above the previous range. Watch for a sustained close and retest."
    : last.c < low
      ? "Price is testing below the previous range. Watch for follow-through or a failed break."
      : "Price remains inside its recent range. No confirmed trade from this watch.";
  const fmt = (price: number) => price.toFixed(3);
  return { bias, summary, momentum, high, low,
    evidence: [
      interval + " structure: " + (bias === "neutral" ? "mixed" : bias) + " moving-average alignment.",
      "Recent four-candle momentum: " + momentum.toLowerCase() + ".",
      "Previous 20-candle range: " + fmt(low) + " to " + fmt(high) + ".",
    ],
  };
}

export async function GET(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const modeParam = new URL(req.url).searchParams.get("mode");
  const mode: Mode = modeParam === "quick" || modeParam === "swing" ? modeParam : "intraday";
  const old = cache.get(mode);
  if (old && Date.now() - old.at < TTL_MS)
    return json({ ...old.data, marketClosed: !isOpen("fx", Date.now()), cached: true });
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return json({ error: "marketdata_not_configured" }, 503);
  const rows = await series("USD/JPY", INTERVAL[mode], 120, key, false, "UTC");
  if (rows === "ratelimit") return json({ error: "feed_busy" }, 429);
  const candles = Array.isArray(rows) ? rows.map(candle).filter((b): b is Candle => b !== null) : [];
  if (candles.length < 55) return json({ error: "data_unavailable" }, 503);
  const close = candles[candles.length - 1].c;
  const quote = await livePrice("USD/JPY", key, false);
  const price = quote != null && livePriceSane(quote, Array.isArray(rows) ? rows : null).ok ? quote : close;
  const body: Answer = {
    symbol: "USDJPY", mode, candles, candlesTz: "UTC", price,
    asOf: new Date().toISOString(), watch: watchFor(candles, mode), marketClosed: !isOpen("fx", Date.now()),
  };
  cache.set(mode, { at: Date.now(), data: body });
  return json(body);
}
