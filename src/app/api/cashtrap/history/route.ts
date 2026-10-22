import { type NextRequest } from "next/server";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { signalFromRow } from "@/lib/cashtrap/supabaseStore";
import { isCashtrapSymbol } from "@/lib/cashtrap/symbols";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signal history, kept apart by what stands behind each record:
 *   reference-feed  — live signals, entry and settlement from the market-data feed
 *   simulated       — replay/backtest records (bar-open proxy)
 *   broker-verified — only with the broker's own entry and settlement data (none connected)
 * plus the armed setups and how each ended.
 */
export async function GET(req: NextRequest) {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const sp = new URL(req.url).searchParams;
  const symbol = sp.get("symbol");
  const limit = Math.min(500, Math.max(10, Number(sp.get("limit")) || 100));
  let sq = a.db.from("cashtrap_signals").select("*").order("published_at", { ascending: false }).limit(limit);
  let tq = a.db.from("cashtrap_setups").select("id, symbol, direction, exhaustion_t, armed_at, status, reason, ended_at, confirm_t, published, suppressed_reason, zone, strategy_version, config_version").order("exhaustion_t", { ascending: false }).limit(limit);
  if (symbol && isCashtrapSymbol(symbol)) { sq = sq.eq("symbol", symbol); tq = tq.eq("symbol", symbol); }
  const [sig, set, runs] = await Promise.all([sq, tq, a.db.from("cashtrap_replay_runs").select("id, status, params, report, signals, created_at, finished_at").eq("status", "done").order("created_at", { ascending: false }).limit(1)]);
  const signals = ((sig.data ?? []) as Array<Record<string, unknown>>).map(signalFromRow);
  return json({
    referenceFeed: signals.filter((s) => s.recordType === "reference-feed"),
    brokerVerified: signals.filter((s) => s.recordType === "broker-verified"),
    brokerNote: "Broker-verified records need the broker's own entry and settlement data. No broker is connected, so there are none.",
    simulated: ((runs.data ?? []) as Array<Record<string, unknown>>)[0] ?? null,
    setups: set.data ?? [],
  });
}
