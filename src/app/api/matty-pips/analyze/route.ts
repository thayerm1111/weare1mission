import { type NextRequest } from "next/server";
import { getProfile } from "@/lib/auth";
import { isPriorityEmail } from "@/lib/marketData";
import { runEngine } from "@/lib/matty-pips/engine";
import { isMpMarket, MP_MARKETS } from "@/lib/matty-pips/pips";
import { saveAnalysis, logDecision } from "@/lib/matty-pips/audit";
import type { Mode } from "@/lib/matty-pips/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MATTY PIPS — FIND ME A TRADE (on-demand full market read).
 *
 * ISOLATED: lives under /api/matty-pips/*, touches only matty_pips_* tables
 * (best-effort), and READS shared infra (auth, market data) without changing
 * any FLOW/GENX behavior. This route never places, modifies, or closes trades.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function handle(symbol: string, modeRaw: string | null): Promise<Response> {
  const profile = await getProfile();
  if (!profile) return json({ ok: false, error: "unauthorized" }, 401);
  if (profile.status === "suspended") return json({ ok: false, error: "account_paused" }, 403);

  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ ok: false, error: "no_market_data_key" }, 500);

  const sym = String(symbol || "XAUUSD").toUpperCase();
  if (!isMpMarket(sym)) return json({ ok: false, error: "unknown_market", markets: MP_MARKETS.map((m) => m.canonical) }, 400);
  const mode: Mode = modeRaw === "aggressive" ? "aggressive" : "conservative";

  const res = await runEngine({ symbol: sym, mode, mdKey, fresh: isPriorityEmail(profile.email) });
  if (res.ok) {
    // Best-effort archive + audit (works even before the tables exist).
    void saveAnalysis(profile.id, res);
    void logDecision({ userId: profile.id, symbol: sym, kind: "analyze", detail: { mode, status: res.status, score: res.score.total, trade: !!res.trade } });
  }
  return json(res, res.ok ? 200 : 200);
}

export async function POST(req: NextRequest) {
  let body: { symbol?: string; mode?: string } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  return handle(body.symbol ?? "XAUUSD", body.mode ?? null);
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  return handle(sp.get("symbol") ?? "XAUUSD", sp.get("mode"));
}
