import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Evaluate whether a called signal has hit a take-profit (win) or SL (loss)
 * since it was generated, using real candles. Reports the HIGHEST take-profit
 * reached (hitTp = 1|2|3) so the card can show exactly which target filled.
 * Conservative: if a single candle spans a TP and the SL before any TP has yet
 * banked, it's counted as a loss (SL priority within a bar).
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ status: "open", note: "marketdata not connected" }, 200);

  let b: { td?: unknown; interval?: unknown; since?: unknown; direction?: unknown; entry?: unknown; sl?: unknown; tp1?: unknown; tps?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const td = typeof b.td === "string" ? b.td : "";
  const interval = typeof b.interval === "string" ? b.interval : "1h";
  const since = typeof b.since === "string" ? b.since : "";
  const direction = b.direction === "LONG" || b.direction === "SHORT" ? b.direction : "";
  const sl = Number(b.sl);
  // Accept the full ladder (tps: [tp1, tp2, tp3]); fall back to a lone tp1.
  const tps = (Array.isArray(b.tps) ? b.tps.map(Number) : [Number(b.tp1)]).filter(numOk);
  if (!td || !since || !direction || !numOk(sl) || tps.length === 0) return json({ status: "open" }, 200);

  let rows: { datetime: string; high: string; low: string }[] = [];
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=500&start_date=${encodeURIComponent(since)}&apikey=${mdKey}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    if (Array.isArray(j.values)) rows = [...j.values].reverse(); // chronological
  } catch { return json({ status: "open" }, 200); }

  // Highest take-profit level reached, in order, so we can report TP3 > TP2 > TP1.
  const ladder = tps.map((p, i) => ({ n: i + 1, p })).sort((a, b2) => (direction === "LONG" ? a.p - b2.p : b2.p - a.p));
  let maxTp = 0, hitAt = "";

  // Skip the candle at `since` itself; evaluate what happened after.
  for (const c of rows) {
    if (c.datetime <= since) continue;
    const hi = +c.high, lo = +c.low;
    // SL takes priority within a bar (conservative): a stop before any TP banks is a loss.
    if (direction === "LONG" ? lo <= sl : hi >= sl) {
      if (maxTp >= 1) return json({ status: "win", hitTp: maxTp, at: hitAt }, 200);
      return json({ status: "loss", at: c.datetime }, 200);
    }
    for (const t of ladder) {
      const reached = direction === "LONG" ? hi >= t.p : lo <= t.p;
      if (reached && t.n > maxTp) { maxTp = t.n; hitAt = c.datetime; }
    }
  }
  if (maxTp >= 1) return json({ status: "win", hitTp: maxTp, at: hitAt }, 200);
  return json({ status: "open" }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
