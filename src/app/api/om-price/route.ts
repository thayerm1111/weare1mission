import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reserveMarketData } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Lightweight live-price lookup for an open signal card.
 * Returns the current market price for a Twelve Data symbol so the signal
 * "alert" can show a live, refreshing price. Auth-gated to protect the key.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "not_configured" }, 200);

  const td = req.nextUrl.searchParams.get("td") || "";
  if (!td) return json({ error: "bad_request" }, 400);

  const md = await reserveMarketData(1);
  if (!md.ok) return json({ error: "system_busy" }, 429);

  try {
    const r = await fetch(
      `https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${mdKey}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    const price = Number(j?.price);
    if (!Number.isFinite(price)) return json({ error: "unavailable" }, 200);
    return json({ price }, 200);
  } catch {
    return json({ error: "unavailable" }, 200);
  }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
