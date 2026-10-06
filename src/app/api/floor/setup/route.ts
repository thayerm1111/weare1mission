import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { series, livePrice } from "@/lib/marketData";
import { computeGenxRead, buildGenx, GOLD, MODES, type Mode } from "@/lib/genxCompute";
import { computeGenfxRead, genfxOf } from "@/lib/genfx/compute";
import { PAIRS, type FxPair } from "@/lib/genfx/pairs";
import { floorInstrument, fxPairKey, setupCacheKey } from "@/lib/floor/setupInstruments";
import { hasPlay, lockSetup, type SetupBody } from "@/lib/setupLock";
import { setupAccess, genfxIsFree, OPEN_UNMETERED, OPEN_FREE } from "@/lib/setupAccess";

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
 * and charges nothing itself. An in-memory per-mode cache means many members with
 * The Floor open never multiply market-data usage: one compute per mode per cache
 * window, and the underlying series/price come from the shared community cache.
 *
 * WHO IS SENT THE PLAY (owner 10-05: "Make them use credits to view"). The read is computed once and
 * cached for everyone, as before; what differs per member is what leaves here. A member whose window
 * is open (setupAccess.ts) gets the map. Anyone else gets the chart, the price and how far along the
 * setup is — and no read at all (setupLock.ts). The same goes for the earlier maps: a map from ten
 * minutes ago is the same trade. Opening the window is not done here (/api/setups/pass).
 *
 * PREVIOUS ANALYSIS (owner 09-17): every ~10 minutes the read + its candles are snapshotted to
 * floor_setup_history, so the panel can show the map exactly as it looked earlier in the day.
 *   ?history=1   -> the last snapshots for this mode (one line each)
 *   ?id=<uuid>   -> that snapshot's full map (frozen: its own read, candles and price)
 *
 * THE OTHER TWO INSTRUMENTS (owner 10-04: "page through here to GBPJPY, and EURUSD as well … just like
 * the GENX"). `?symbol=EURUSD` or `?symbol=GBPJPY` returns the same payload from the GEN FX engine for
 * that pair: the same pure read (computeGenfxRead + genfxOf, no AI narrative, nothing charged here —
 * as gold's is), its own cache entry and its own history rows (floor_setup_history.instrument). No symbol,
 * or anything else, is gold, served exactly as before: a request without `symbol` cannot tell this
 * change happened.
 */

// Short cache so the Floor chart stays live. The underlying series/price come
// from the shared community cache (MD_CACHE_TTL ~30s), so a 15s payload cache
// refreshes as soon as new market data lands without adding upstream calls.
const TTL_MS = 15_000;
// One stored snapshot per mode per 10 minutes — enough to walk back through the day without bloat.
const SNAPSHOT_MS = 10 * 60_000;
const CACHE: Record<string, { at: number; body: SetupBody }> = {};

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const CHART_TF: Record<Mode, string> = { quick: "5min", intraday: "15min", swing: "1h" };

type Candle = { t: string; o: number; h: number; l: number; c: number };
/** The read as the card receives it. Only two of its fields are read here, for the history row. */
type Read = { action?: unknown; confidence_score?: unknown } & Record<string, unknown>;
type Built =
  | { ok: true; g: Read; candles: Candle[]; price: number; session: string; asOf: string }
  | { ok: false; error: string };

const toCandles = (raw: unknown): Candle[] =>
  Array.isArray(raw)
    ? (raw as { datetime: string; open: string; high: string; low: string; close: string }[])
        .map((r) => ({ t: r.datetime, o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter((k) => Number.isFinite(k.c))
    : [];

/** Gold — the GENX read. Unchanged from before the card could show anything else. */
async function goldSetup(mode: Mode, mdKey: string): Promise<Built> {
  const rr = await computeGenxRead({ mode, mdKey, fresh: false });
  if (!rr.ok) return { ok: false, error: rr.error };

  const m = MODES[mode];
  const g = buildGenx(rr.read, {
    mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus,
    hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf,
    pip: GOLD.pip, dec: GOLD.dec, marketStory: [], volatility: rr.volatility, atr: rr.atr, m15: rr.m15,
  });

  // Clean candle series for the chart, matched to the mode's chart timeframe.
  const candles = toCandles(await series("XAU/USD", CHART_TF[mode], 60, mdKey, false));
  const lp = await livePrice("XAU/USD", mdKey, false);
  const price = typeof lp === "number" ? lp : (candles.length ? candles[candles.length - 1].c : rr.price);
  return { ok: true, g: g as unknown as Read, candles, price, session: rr.session, asOf: rr.nowIso };
}

/**
 * A currency pair — the GEN FX read, built the way the GEN FX page builds it, minus the story.
 * The price on the map is the read's own: computeGenfxRead has already checked the live quote against
 * the recent closes and fallen back to them when it was off, and the levels were drawn from that price.
 */
async function fxSetup(pair: FxPair, mode: Mode, mdKey: string): Promise<Built> {
  const rr = await computeGenfxRead({ pair, mode, mdKey, fresh: false });
  if (!rr.ok) return { ok: false, error: rr.error };

  const m = MODES[mode];
  const g = genfxOf(pair, rr.read, {
    mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus,
    hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf,
    marketStory: [], volatility: rr.volatility, atr: rr.atr,
  });
  // The chart is drawn from the candles the read was made on: the engine hands back its trigger
  // timeframe's last 48, which is this horizon's chart timeframe (MODES[mode].tf.m15 === CHART_TF[mode])
  // and more than the 44 the card draws. Asked for again only if the engine returned too few.
  const own = (Array.isArray(rr.candles) ? (rr.candles as Candle[]) : []).filter((k) => k && typeof k.t === "string" && [k.o, k.h, k.l, k.c].every((n) => Number.isFinite(n)));
  const candles = own.length >= 44 ? own : toCandles(await series(pair.td, CHART_TF[mode], 60, mdKey, false));
  return { ok: true, g: g as unknown as Read, candles, price: rr.price, session: rr.session, asOf: rr.nowIso };
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  let userId: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    userId = user.id;
  }

  const url = new URL(req.url);
  const admin = createAdminClient();
  const inst = floorInstrument(url.searchParams.get("symbol"));
  const pairKey = fxPairKey(inst.key);
  const pair = pairKey ? PAIRS[pairKey] : null;

  // Is this member's window open? Asked at most once per request, and not at all for a live map
  // that carries no play. `fresh=1` is the card's first look after arriving, switching or paying:
  // that one is never answered from memory (setupAccess.ts).
  const fresh = url.searchParams.get("fresh") === "1";
  let asked: ReturnType<typeof setupAccess> | null = null;
  // A pair's map is GEN FX's: while the owner has GEN FX billing switched off it costs nothing to
  // read, so it is not kept back here either. Gold's is never free this way. `fx` says whose map is
  // being asked for — the market on the request, or, for a stored map, the market it was stored under.
  const windowFor = async (fx: boolean) => (!userId ? OPEN_UNMETERED : fx && await genfxIsFree(admin) ? OPEN_FREE : setupAccess(admin, userId, { fresh }));
  const myWindow = () => (asked ??= windowFor(!!pair));
  /** What this member is sent: the map, or — when it carries a play their window does not cover — its outline. */
  const shown = async (body: SetupBody) => {
    if (!hasPlay(body.g)) return body;
    const gate = await myWindow();
    return { ...(gate.open ? body : lockSetup(body)), setups: gate };
  };

  // ── Previous analyses (list / replay) ──
  const histId = url.searchParams.get("id");
  const wantHistory = url.searchParams.get("history");
  if (histId || wantHistory) {
    if (!admin) return json({ past: [] });
    // An earlier map is the same trade a few minutes younger: it opens with the window, like the live one.
    if (histId) {
      // Whose window decides is the STORED map's market, not whatever market the request names: a
      // gold map asked for "as EUR/USD" is still gold's. So the row is found first, and nothing of it
      // is sent unless the window for its own market is open.
      const { data } = await admin.from("floor_setup_history").select("id,at,mode,price,payload,instrument").eq("id", histId).maybeSingle();
      const row = data as { id: string; at: string; mode: string; price: number | null; instrument: string | null; payload: { g?: unknown; candles?: unknown[] } } | null;
      const gate = await windowFor(!!row?.instrument);
      if (!gate.open) return json({ error: "locked", setups: gate }, 402);
      if (!row) return json({ error: "not_found" }, 404);
      return json({ past: true, id: row.id, at: row.at, mode: row.mode, price: row.price, symbol: row.instrument ?? "XAUUSD", g: row.payload?.g ?? null, candles: row.payload?.candles ?? [], frozen: true });
    }
    const gate = await myWindow();
    if (!gate.open) return json({ past: [], setups: gate });
    const hm = url.searchParams.get("mode");
    const listMode: Mode = hm === "quick" || hm === "swing" ? hm : "intraday";
    // Gold's rows have no instrument; a pair's carry its key. Each lists only its own.
    const list = admin.from("floor_setup_history").select("id,at,mode,price,action,confidence").eq("mode", listMode);
    const { data } = await (pair ? list.eq("instrument", pair.key) : list.is("instrument", null)).order("at", { ascending: false }).limit(24);
    return json({ past: data ?? [] });
  }

  const modeParam = url.searchParams.get("mode");
  const mode: Mode = modeParam === "quick" || modeParam === "swing" ? modeParam : "intraday";

  const ck = setupCacheKey(inst.key, mode);
  if (CACHE[ck] && Date.now() - CACHE[ck].at < TTL_MS) return json(await shown({ ...CACHE[ck].body, cached: true }));

  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ g: null, candles: [], price: null, mode, symbol: inst.key, error: "marketdata_not_configured" });

  const built = pair ? await fxSetup(pair, mode, mdKey) : await goldSetup(mode, mdKey);
  if (!built.ok) return json({ g: null, candles: [], price: null, mode, symbol: inst.key, error: built.error });
  const { g, candles, price, session, asOf } = built;

  const body = { g, candles, price, session, mode, asOf, symbol: inst.key };
  CACHE[ck] = { at: Date.now(), body };

  // Snapshot for "previous analysis" — at most one row per instrument per mode per SNAPSHOT_MS, best-effort.
  if (admin) {
    try {
      const latest = admin.from("floor_setup_history").select("at").eq("mode", mode);
      const { data: last, error: lastErr } = await (pair ? latest.eq("instrument", pair.key) : latest.is("instrument", null)).order("at", { ascending: false }).limit(1).maybeSingle();
      const lastAt = last ? Date.parse((last as { at: string }).at) : 0;
      // "When was the last one?" could not be read: that is not "there has never been one". Without
      // this, a read that keeps failing would store a snapshot on every recompute instead of every ten minutes.
      if (!lastErr && (!lastAt || Date.now() - lastAt > SNAPSHOT_MS)) {
        await admin.from("floor_setup_history").insert({
          mode, price, action: g.action ?? null, confidence: g.confidence_score ?? null,
          payload: { g, candles: candles.slice(-60), session, asOf },
          ...(pair ? { instrument: pair.key } : {}),
        });
      }
    } catch { /* history is best-effort; never block the panel */ }
  }
  return json(await shown(body));
}
