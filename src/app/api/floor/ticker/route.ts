import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * FLOOR MARKET RAIL — one batched TwelveData quote for the desk ticker, cached
 * in-memory (~45s) so the number of members with The Floor open does NOT multiply
 * market-data usage: at most ~1 upstream call per cache window regardless of
 * viewers. Auth-gated (protects the key). Returns only symbols that came back with
 * a real price — never a fabricated or stale-forever value.
 */
const SYMBOLS: { td: string; label: string; dp: number }[] = [
  { td: "XAU/USD", label: "XAUUSD", dp: 2 },
  { td: "EUR/USD", label: "EURUSD", dp: 5 },
  { td: "GBP/USD", label: "GBPUSD", dp: 5 },
  { td: "USD/JPY", label: "USDJPY", dp: 3 },
  { td: "BTC/USD", label: "BTCUSD", dp: 0 },
];

type Tick = { label: string; price: number; percent: number | null; dp: number };
let CACHE: { at: number; ticks: Tick[] } | null = null;
const TTL_MS = 45_000;

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  if (CACHE && Date.now() - CACHE.at < TTL_MS) return json({ ticks: CACHE.ticks, cached: true });

  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ ticks: CACHE?.ticks ?? [] });

  try {
    const syms = SYMBOLS.map((s) => s.td).join(",");
    const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(syms)}&apikey=${mdKey}`, { cache: "no-store" });
    const j = (await r.json()) as Record<string, unknown>;
    const ticks: Tick[] = [];
    for (const s of SYMBOLS) {
      // Batch responses key by symbol; a single-symbol response is the object itself.
      const q = (j && typeof j === "object" && s.td in j ? (j[s.td] as Record<string, unknown>) : (SYMBOLS.length === 1 ? j : null)) as Record<string, unknown> | null;
      if (!q) continue;
      const price = Number(q.close ?? q.price);
      if (!Number.isFinite(price)) continue;
      const percent = Number(q.percent_change);
      ticks.push({ label: s.label, price, percent: Number.isFinite(percent) ? percent : null, dp: s.dp });
    }
    if (ticks.length) CACHE = { at: Date.now(), ticks };
    return json({ ticks: CACHE?.ticks ?? ticks });
  } catch {
    return json({ ticks: CACHE?.ticks ?? [] });
  }
}
