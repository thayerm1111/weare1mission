import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Read-only tick bridge for authenticated Floor members.
 * The Railway worker writes actual streamed ticks to this RLS-protected table.
 * The service key stays server-side. No artificial interpolation or price
 * animation is performed; receipt timestamps let the client flag stale feeds.
 */
const SYMBOLS = ["XAU/USD", "EUR/USD", "GBP/JPY", "USD/JPY"];
type Tick = { symbol: string; price: number; receivedAt: string; providerAt: string | null };
let cached: { at: number; ticks: Tick[] } | null = null;
const TTL_MS = 800;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured", ticks: [] }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS)
    return json({ ticks: cached.ticks, serverAt: new Date(now).toISOString() });
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured", ticks: [] }, 503);
  try {
    const { data, error } = await admin.from("market_live_ticks")
      .select("symbol,price,received_at,tick_at").in("symbol", SYMBOLS);
    if (error) return json({ error: "unavailable", ticks: cached?.ticks ?? [] }, 503);
    const ticks: Tick[] = [];
    for (const row of data ?? []) {
      const symbol = String(row.symbol ?? "");
      const price = Number(row.price);
      const receivedAt = String(row.received_at ?? "");
      if (!SYMBOLS.includes(symbol) || !Number.isFinite(price) || price <= 0 ||
          !Number.isFinite(Date.parse(receivedAt))) continue;
      const at = typeof row.tick_at === "string" && Number.isFinite(Date.parse(row.tick_at)) ? row.tick_at : null;
      ticks.push({ symbol, price, receivedAt, providerAt: at });
    }
    cached = { at: Date.now(), ticks };
    return json({ ticks, serverAt: new Date().toISOString() });
  } catch {
    return json({ error: "unavailable", ticks: cached?.ticks ?? [] }, 503);
  }
}
