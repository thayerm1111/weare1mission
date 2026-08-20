import { buildGenx, MODES, type Mode } from "@/lib/genxCompute";
import { decideEntry, type ConfirmSignal, type EntryDecision } from "@/lib/entryEngine";
import { flowRead, flowConfirm, type FlowConfirmState } from "@/lib/flowEngine";
import { getInstrument } from "@/lib/flow/instruments";

/**
 * FLOW decision (server-only) — the SAME setup→confirm→entry-engine pipeline the
 * /api/flow/read route runs for the app, factored out so the auto-executor fires
 * on EXACTLY the rule the member sees on screen. Never fetches broker data; pure
 * market-data + deterministic engines.
 */
export type FlowDecision = {
  ok: true;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  dataStatus: string;
  entry: EntryDecision;
  levels: { entryLow: number | null; entryHigh: number | null; stop: number | null; tp1: number | null; invalidation: number | null };
  engineState: string;
  confirm: { state: ConfirmSignal; detail: string };
} | { ok: false; error: string };

export async function flowDecision(opts: { canonical: string; mode?: Mode; mdKey: string; fresh: boolean }): Promise<FlowDecision> {
  const canonical = String(opts.canonical || "XAUUSD").toUpperCase();
  const mode: Mode = opts.mode === "intraday" || opts.mode === "swing" ? opts.mode : "quick";
  const m = MODES[mode];
  const inst = getInstrument(canonical);

  const rr = await flowRead({ canonical, mode, mdKey: opts.mdKey, fresh: opts.fresh });
  if (!rr.ok) return { ok: false, error: rr.error };

  const g = buildGenx(rr.read, {
    mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus,
    hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf,
    pip: inst.pipSize, dec: inst.pricePrecision, marketStory: [],
    volatility: rr.volatility, atr: rr.atr, m15: rr.m15,
  });
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
        mode, mdKey: opts.mdKey, fresh: opts.fresh,
      });
      const map: Record<FlowConfirmState, ConfirmSignal> = { WAIT: "WAIT", AT_ZONE: "AT_ZONE", CONFIRMED: "CONFIRMED", INVALIDATED: "INVALIDATED", BUSY: "NONE", NO_DATA: "NONE" };
      confirmState = map[conf.state] ?? "NONE";
      confirmDetail = conf.detail;
    }
  } catch { /* confirm best-effort */ }

  const entry = decideEntry({
    side, engineState: g.engine_state, action: g.action, edgeScore: g.confidence_score,
    preferredEntry: g.entry, entryLow: g.entry_low, entryHigh: g.entry_high,
    invalidation: g.invalidation_price, tp1: g.tp1, currentPrice: rr.price, atr: rr.atr,
    pip: inst.pipSize, dec: inst.pricePrecision, mode, triggerTf: m.triggerTf, nowMs: rr.nowMs,
    confirm: { state: confirmState, confirmedAtMs: confirmState === "CONFIRMED" ? rr.nowMs : null },
    regime: String(g.market_regime ?? ""), structure: String(g.market_structure ?? ""), momentum: String(g.momentum ?? ""),
  });

  return {
    ok: true,
    symbol: canonical,
    side,
    price: rr.price,
    dataStatus: rr.dataStatus,
    entry,
    levels: {
      entryLow: (g.entry_low as number) ?? null, entryHigh: (g.entry_high as number) ?? null,
      stop: (g.stop_loss as number) ?? null, tp1: (g.tp1 as number) ?? null,
      invalidation: (g.invalidation_price as number) ?? null,
    },
    engineState: String(g.engine_state ?? ""),
    confirm: { state: confirmState, detail: confirmDetail },
  };
}
