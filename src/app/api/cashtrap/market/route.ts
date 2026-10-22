import { type NextRequest } from "next/server";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { effectiveConfig } from "@/lib/cashtrap/config";
import { dmiStatus } from "@/lib/cashtrap/dmi";
import { chartPoints, currentZones } from "@/lib/cashtrap/chart";
import { isCashtrapSymbol, SYMBOL_SPECS } from "@/lib/cashtrap/symbols";
import { signalFromRow, decisionFromRow } from "@/lib/cashtrap/supabaseStore";
import { M5 } from "@/lib/cashtrap/candles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The selected market: chart candles with BB/RSI/Stochastic/DMI as the engine computed them, zones, setups, signals. */
export async function GET(req: NextRequest) {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const sp = new URL(req.url).searchParams;
  const symbol = sp.get("symbol") ?? "";
  if (!isCashtrapSymbol(symbol)) return json({ error: "unknown symbol" }, 400);
  const n = Math.min(288, Math.max(30, Number(sp.get("n")) || 120));
  const cfg = effectiveConfig(a.settings.assumptions);
  const dmi = dmiStatus(a.settings.dmiMode, a.settings.dmiFeedVerified);
  const history = await a.store.loadCandles(symbol, n + cfg.assumptions.data.windowCandles);
  const manual = await a.store.manualZones(symbol);
  const from = history.length ? history[Math.max(0, history.length - n)].t : Date.now() - n * M5;
  const events = a.settings.dmiMode === "event-feed" ? await a.store.dmiEvents(symbol, from - 3 * M5, Date.now()) : undefined;
  const points = chartPoints(symbol, history, n, cfg, manual, { mode: a.settings.dmiMode, available: dmi.available, events });
  const zones = currentZones(symbol, history, cfg, manual).filter((z) => z.invalidatedAt == null || z.invalidatedAt >= from);
  const [setups, signals, decision, snap] = await Promise.all([
    a.db.from("cashtrap_setups").select("id, direction, exhaustion_t, status, reason, ended_at, confirm_t, published, zone").eq("symbol", symbol).gte("exhaustion_t", new Date(from).toISOString()).order("exhaustion_t", { ascending: true }).limit(100),
    a.db.from("cashtrap_signals").select("*").eq("symbol", symbol).gte("setup_candle_t", new Date(from).toISOString()).order("published_at", { ascending: true }).limit(100),
    a.db.from("cashtrap_decisions").select("*").eq("symbol", symbol).order("candle_t", { ascending: false }).limit(1),
    a.store.snapshot(symbol),
  ]);
  return json({
    symbol, spec: SYMBOL_SPECS[symbol], points, zones,
    setups: setups.data ?? [], signals: ((signals.data ?? []) as Array<Record<string, unknown>>).map(signalFromRow),
    decision: ((decision.data ?? []) as Array<Record<string, unknown>>).map(decisionFromRow)[0] ?? null,
    snapshot: snap, dmi, serverNow: Date.now(),
  });
}
