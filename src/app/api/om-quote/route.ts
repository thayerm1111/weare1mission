import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Live quote for the member Watchlist — returns current price plus the day's
 * change so cards can show green/red movement. Auth-gated to protect the key.
 * (Kept separate from /api/om-price so the signal live-price stays untouched.)
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

  try {
    const r = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(td)}&apikey=${mdKey}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    const price = Number(j?.close ?? j?.price);
    if (!Number.isFinite(price)) return json({ error: "unavailable" }, 200);
    const percent = Number(j?.percent_change);
    const change = Number(j?.change);
    const isOpen = j?.is_market_open;
    return json({
      price,
      percent: Number.isFinite(percent) ? percent : null,
      change: Number.isFinite(change) ? change : null,
      isOpen: typeof isOpen === "boolean" ? isOpen : null,
    }, 200);
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
