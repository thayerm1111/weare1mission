import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { series, livePrice } from "@/lib/marketData";
import { sessionNow } from "@/lib/genxCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * THE FLOOR — "SETUP FORMING" panel data.
 *
 * Returns the CURRENT GENX gold setup (levels, side, readiness, live conditions)
 * plus a recent XAUUSD candle series for the chart. READ-ONLY and it does NOT
 * charge credits: it reads the setup the scanner already computed (genx_alerts)
 * and pulls candles from the shared, community-cached market-data feed
 * (fresh=false). An in-memory cache means many members with The Floor open never
 * multiply market-data usage — at most one upstream refresh per cache window.
 */

type Candle = { t: string; o: number; h: number; l: number; c: number };
type Setup = {
  side: "buy" | "sell"; state: string; mode: string;
  entry: number | null; entryLow: number | null; entryHigh: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  breakLevel: number | null; readiness: number; createdAt: string;
};
type Payload = {
  setup: Setup | null; candles: Candle[]; price: number | null; session: string;
  conditions: { label: string; met: boolean }[]; statusText: string;
};

let CACHE: { at: number; body: Payload } | null = null;
const TTL_MS = 30_000;

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const numOr = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  if (CACHE && Date.now() - CACHE.at < TTL_MS) return json({ ...CACHE.body, cached: true });

  const mdKey = process.env.TWELVEDATA_API_KEY;
  const admin = createAdminClient();

  // Latest actionable GENX gold setup the scanner has on the books (free — no compute).
  let setup: Setup | null = null;
  if (admin) {
    try {
      const { data } = await admin.from("genx_alerts")
        .select("side, action, state, mode, entry, entry_low, entry_high, stop, tp1, tp2, tp3, invalidation, watch, confidence, created_at")
        .in("state", ["forming", "entered"])
        .not("entry_low", "is", null)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      if (data) {
        const d = data as Record<string, unknown>;
        setup = {
          side: String(d.side) === "sell" ? "sell" : "buy",
          state: String(d.state || "forming"), mode: String(d.mode || "intraday"),
          entry: numOr(d.entry), entryLow: numOr(d.entry_low), entryHigh: numOr(d.entry_high),
          stop: numOr(d.stop), tp1: numOr(d.tp1), tp2: numOr(d.tp2), tp3: numOr(d.tp3),
          breakLevel: numOr(d.watch) ?? numOr(d.invalidation),
          readiness: Math.round(numOr(d.confidence) ?? 0),
          createdAt: String(d.created_at || ""),
        };
      }
    } catch { /* no setup → chart shows a clean scanning state */ }
  }

  // Candles + live price from the shared cached feed (never multiplies usage).
  let candles: Candle[] = [];
  let price: number | null = null;
  if (mdKey) {
    const raw = await series("XAU/USD", "15min", 48, mdKey, false);
    if (Array.isArray(raw)) candles = raw.map((r) => ({ t: r.datetime, o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter((k) => Number.isFinite(k.c));
    const lp = await livePrice("XAU/USD", mdKey, false);
    price = typeof lp === "number" ? lp : (candles.length ? candles[candles.length - 1].c : null);
  }

  const session = sessionNow(new Date());

  // Live conditions checklist — deterministic from live price vs the setup levels.
  const conditions: { label: string; met: boolean }[] = [];
  let statusText = "Scanning for a setup";
  if (setup && price != null) {
    const buy = setup.side === "buy";
    const brk = setup.breakLevel;
    const inZone = setup.entryLow != null && setup.entryHigh != null && price >= setup.entryLow - 0.5 && price <= setup.entryHigh + 0.5;
    const last = candles.length >= 1 ? candles[candles.length - 1] : null;
    const mom = last ? (buy ? last.c >= last.o : last.c <= last.o) : false;
    const broke = brk != null ? (buy ? price > brk : price < brk) : false;
    conditions.push({ label: brk != null ? `Break ${brk.toFixed(2)}` : "Break level", met: broke });
    conditions.push({ label: "Retest holds", met: inZone });
    conditions.push({ label: "Momentum confirms", met: mom });
    statusText = setup.state === "entered" ? "Live — entry triggered" : "Waiting for confirmation";
  }

  const body: Payload = { setup, candles, price, session, conditions, statusText };
  CACHE = { at: Date.now(), body };
  return json(body);
}
