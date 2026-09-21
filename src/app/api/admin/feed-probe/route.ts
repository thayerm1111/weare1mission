import { type NextRequest } from "next/server";
import { gateAdmin } from "@/lib/sports/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WHICH SYMBOLS DOES THIS DATA PLAN ACTUALLY SERVE?
 *
 * Owner-only diagnostics. The Command Center's Global Context panel must never invent a value or quietly
 * swap one instrument for another, so before wiring a symbol in, this asks the provider what it will
 * really return for it. Read-only: it fetches quotes and reports the answer.
 *
 *   GET /api/admin/feed-probe?symbols=DXY,DX,USDX,UUP
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function GET(req: NextRequest) {
  if (!(await gateAdmin()).ok) return json({ error: "not_found" }, 404);
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return json({ error: "TWELVEDATA_API_KEY missing" }, 500);

  const symbols = (new URL(req.url).searchParams.get("symbols") ?? "DXY").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const out: Record<string, unknown> = {};
  for (const sym of symbols) {
    try {
      const u = new URL("https://api.twelvedata.com/quote");
      u.searchParams.set("symbol", sym);
      const r = await fetch(u.toString(), { headers: { Authorization: `apikey ${key}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      out[sym] = j.status === "error"
        ? { ok: false, message: String(j.message ?? "").slice(0, 200), code: j.code ?? null }
        : { ok: true, name: j.name ?? null, exchange: j.exchange ?? null, type: j.type ?? null, close: j.close ?? null, percent_change: j.percent_change ?? null, datetime: j.datetime ?? null, is_market_open: j.is_market_open ?? null };
    } catch (e) {
      out[sym] = { ok: false, message: e instanceof Error ? e.message.slice(0, 160) : "network" };
    }
  }
  return json({ ok: true, probed: out });
}
