import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Evaluate whether a called signal has hit TP1 (win) or SL (loss) since it was
 * generated, using real candles. Conservative: if a single candle spans both
 * TP1 and SL, it's counted as a loss.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ status: "open", note: "marketdata not connected" }, 200);

  let b: { td?: unknown; interval?: unknown; since?: unknown; direction?: unknown; entry?: unknown; sl?: unknown; tp1?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const td = typeof b.td === "string" ? b.td : "";
  const interval = typeof b.interval === "string" ? b.interval : "1h";
  const since = typeof b.since === "string" ? b.since : "";
  const direction = b.direction === "LONG" || b.direction === "SHORT" ? b.direction : "";
  const sl = Number(b.sl), tp1 = Number(b.tp1);
  if (!td || !since || !direction || !numOk(sl) || !numOk(tp1)) return json({ status: "open" }, 200);

  let rows: { datetime: string; high: string; low: string }[] = [];
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=500&start_date=${encodeURIComponent(since)}&apikey=${mdKey}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    if (Array.isArray(j.values)) rows = [...j.values].reverse(); // chronological
  } catch { return json({ status: "open" }, 200); }

  // Skip the candle at `since` itself; evaluate what happened after.
  for (const c of rows) {
    if (c.datetime <= since) continue;
    const hi = +c.high, lo = +c.low;
    if (direction === "LONG") {
      if (lo <= sl) return json({ status: "loss", at: c.datetime }, 200);
      if (hi >= tp1) return json({ status: "win", at: c.datetime }, 200);
    } else {
      if (hi >= sl) return json({ status: "loss", at: c.datetime }, 200);
      if (lo <= tp1) return json({ status: "win", at: c.datetime }, 200);
    }
  }
  return json({ status: "open" }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
