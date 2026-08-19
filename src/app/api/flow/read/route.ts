import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildGenx, MODES, type Mode } from "@/lib/genxCompute";
import { decideEntry, type ConfirmSignal } from "@/lib/entryEngine";
import { flowRead, flowConfirm, type FlowConfirmState } from "@/lib/flowEngine";
import { getInstrument } from "@/lib/flow/instruments";
import { isPriorityEmail } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * FLOW — the multi-instrument execution/entry-timing desk (separate from GENX).
 * GET  → the pairs FLOW currently trades (from flow_instruments where enabled).
 * POST { symbol, mode } → the setup + FLOW Entry Engine decision for that pair.
 * Reuses the shared deterministic engine as a read; never modifies GENX.
 */

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function requireUser() {
  const supabase = createClient();
  if (!supabase) return { user: null, fresh: false };
  const { data: { user } } = await supabase.auth.getUser();
  return { user, fresh: isPriorityEmail(user?.email) };
}

export async function GET() {
  const { user } = await requireUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  let instruments: { canonical: string; label: string; assetClass: string }[] = [];
  if (admin) {
    const { data } = await admin.from("flow_instruments").select("canonical, display_name, asset_class").eq("enabled", true).order("asset_class", { ascending: true });
    instruments = (data ?? []).map((r) => ({ canonical: r.canonical as string, label: r.display_name as string, assetClass: r.asset_class as string }));
  }
  if (!instruments.length) instruments = [{ canonical: "XAUUSD", label: "Gold (XAU/USD)", assetClass: "gold" }];
  return json({ instruments });
}

export async function POST(req: NextRequest) {
  const { user, fresh } = await requireUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  let body: { symbol?: unknown; mode?: unknown } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const canonical = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "XAUUSD";
  const mode: Mode = body.mode === "intraday" || body.mode === "swing" ? body.mode : "quick";
  const m = MODES[mode];
  const inst = getInstrument(canonical);

  const rr = await flowRead({ canonical, mode, mdKey, fresh });
  if (!rr.ok) {
    if (rr.error === "ratelimit") return json({ error: "ratelimit", detail: "Market-data limit hit for a moment — give it a minute and run again." }, 429);
    if (rr.error === "insufficient_data") return json({ error: "insufficient_data", detail: `Not enough recent ${inst.displayName} candles to analyze right now — try again shortly.` }, 200);
    if (rr.error === "marketdata_error") return json({ error: "marketdata_error", detail: `Couldn't read a live ${inst.displayName} price right now — try again shortly.` }, 502);
    return json({ error: rr.error, detail: rr.detail }, rr.status ?? 500);
  }

  // Shared engine read → setup levels (buildGenx used purely as a read; GENX untouched).
  const g = buildGenx(rr.read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, pip: inst.pipSize, dec: inst.pricePrecision, marketStory: [], volatility: rr.volatility, atr: rr.atr, m15: rr.m15 });
  g.symbol = canonical; // buildGenx hardcodes XAUUSD — FLOW is multi-instrument.

  const side: "buy" | "sell" = g.directional_bias === "bearish" ? "sell" : "buy";
  let confirmState: ConfirmSignal = "NONE";
  let confirmDetail = "";
  try {
    if (g.entry_low != null && g.entry_high != null && g.invalidation_price != null && g.engine_state !== "NO_TRADE") {
      const conf = await flowConfirm({
        tdSymbol: rr.tdSymbol, pip: inst.pipSize, side,
        entryLow: g.entry_low as number, entryHigh: g.entry_high as number,
        watch: (g.entry as number) ?? (g.entry_low as number), invalidation: g.invalidation_price as number,
        mode, mdKey, fresh,
      });
      const map: Record<FlowConfirmState, ConfirmSignal> = { WAIT: "WAIT", AT_ZONE: "AT_ZONE", CONFIRMED: "CONFIRMED", INVALIDATED: "INVALIDATED", BUSY: "NONE", NO_DATA: "NONE" };
      confirmState = map[conf.state] ?? "NONE";
      confirmDetail = conf.detail;
    }
  } catch { /* confirm best-effort */ }

  const entry_engine = decideEntry({
    side, engineState: g.engine_state, action: g.action, edgeScore: g.confidence_score,
    preferredEntry: g.entry, entryLow: g.entry_low, entryHigh: g.entry_high,
    invalidation: g.invalidation_price, tp1: g.tp1, currentPrice: rr.price, atr: rr.atr,
    pip: inst.pipSize, dec: inst.pricePrecision, mode, triggerTf: m.triggerTf, nowMs: rr.nowMs,
    confirm: { state: confirmState, confirmedAtMs: confirmState === "CONFIRMED" ? rr.nowMs : null },
    regime: String(g.market_regime ?? ""), structure: String(g.market_structure ?? ""), momentum: String(g.momentum ?? ""),
  });

  return json({
    ok: true,
    symbol: canonical,
    instrument: { canonical, label: inst.displayName, assetClass: inst.assetClass, pipSize: inst.pipSize, pricePrecision: inst.pricePrecision },
    mode,
    price: rr.price,
    data_status: rr.dataStatus,
    session: rr.session,
    entry_engine,
    confirm: { state: confirmState, detail: confirmDetail },
    g: {
      symbol: canonical, directional_bias: g.directional_bias, action: g.action, engine_state: g.engine_state,
      confidence_score: g.confidence_score, entry: g.entry, entry_low: g.entry_low, entry_high: g.entry_high,
      stop_loss: g.stop_loss, tp1: g.tp1, tp2: g.tp2, tp3: g.tp3,
      stop_pips: g.stop_pips, tp1_pips: g.tp1_pips, tp2_pips: g.tp2_pips, tp3_pips: g.tp3_pips,
      market_regime: g.market_regime, session: g.session,
    },
  });
}
