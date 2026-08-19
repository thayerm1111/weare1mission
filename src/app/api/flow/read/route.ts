import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeGenxRead, buildGenx, GOLD, MODES, type Mode } from "@/lib/genxCompute";
import { confirmEntry } from "@/lib/genxConfirm";
import { decideEntry, type ConfirmSignal } from "@/lib/entryEngine";
import { isPriorityEmail } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * FLOW — the execution/entry-timing desk (separate from GENX).
 *
 * FLOW reuses the SHARED deterministic engine (computeGenxRead + buildGenx) purely
 * as a read — it does not modify GENX. On top of the setup it layers the FLOW
 * Entry Engine (entryEngine.decideEntry) + live confirmation to answer the one
 * question FLOW exists for: "should I enter NOW, wait, or has it been missed?".
 */

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const supabase = createClient();
  let fresh = false;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    fresh = isPriorityEmail(user.email);
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  let body: { mode?: unknown } = {};
  try { body = await req.json(); } catch { /* default quick */ }
  const mode: Mode = body.mode === "intraday" || body.mode === "swing" ? body.mode : "quick";
  const m = MODES[mode];

  const rr = await computeGenxRead({ mode, mdKey, fresh });
  if (!rr.ok) {
    if (rr.error === "ratelimit") return json({ error: "ratelimit", detail: "Gold market-data limit hit for a moment — give it a minute and run again." }, 429);
    if (rr.error === "insufficient_data") return json({ error: "insufficient_data", detail: "Not enough recent Gold candles to analyze right now — try again shortly." }, 200);
    if (rr.error === "marketdata_error") return json({ error: "marketdata_error", detail: "Couldn't read a live Gold price right now — try again shortly." }, 502);
    return json({ error: rr.error, detail: rr.detail }, rr.status ?? 500);
  }

  // Shared engine read (GENX code untouched — buildGenx used purely as a read).
  const g = buildGenx(rr.read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, pip: GOLD.pip, dec: GOLD.dec, marketStory: [], volatility: rr.volatility, atr: rr.atr, m15: rr.m15 });

  const side: "buy" | "sell" = g.directional_bias === "bearish" ? "sell" : "buy";
  let confirmState: ConfirmSignal = "NONE";
  let confirmDetail = "";
  try {
    if (g.entry_low != null && g.entry_high != null && g.invalidation_price != null && g.engine_state !== "NO_TRADE") {
      const conf = await confirmEntry({
        side, entryLow: g.entry_low as number, entryHigh: g.entry_high as number,
        watch: (g.entry as number) ?? (g.entry_low as number), invalidation: g.invalidation_price as number,
        mode, mdKey, fresh,
      });
      const map: Record<string, ConfirmSignal> = { WAIT: "WAIT", AT_ZONE: "AT_ZONE", CONFIRMED: "CONFIRMED", INVALIDATED: "INVALIDATED", BUSY: "NONE", NO_DATA: "NONE" };
      confirmState = map[conf.state] ?? "NONE";
      confirmDetail = conf.detail;
    }
  } catch { /* confirm best-effort */ }

  const entry_engine = decideEntry({
    side, engineState: g.engine_state, action: g.action, edgeScore: g.confidence_score,
    preferredEntry: g.entry, entryLow: g.entry_low, entryHigh: g.entry_high,
    invalidation: g.invalidation_price, tp1: g.tp1, currentPrice: rr.price, atr: rr.atr,
    pip: GOLD.pip, dec: GOLD.dec, mode, triggerTf: m.triggerTf, nowMs: rr.nowMs,
    confirm: { state: confirmState, confirmedAtMs: confirmState === "CONFIRMED" ? rr.nowMs : null },
  });

  return json({
    ok: true,
    symbol: "XAUUSD",
    mode,
    price: rr.price,
    data_status: rr.dataStatus,
    session: rr.session,
    entry_engine,
    confirm: { state: confirmState, detail: confirmDetail },
    g: {
      symbol: "XAUUSD", directional_bias: g.directional_bias, action: g.action, engine_state: g.engine_state,
      confidence_score: g.confidence_score, entry: g.entry, entry_low: g.entry_low, entry_high: g.entry_high,
      stop_loss: g.stop_loss, tp1: g.tp1, tp2: g.tp2, tp3: g.tp3,
      stop_pips: g.stop_pips, tp1_pips: g.tp1_pips, tp2_pips: g.tp2_pips, tp3_pips: g.tp3_pips,
      market_regime: g.market_regime, session: g.session,
    },
  });
}
