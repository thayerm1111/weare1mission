import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPriorityEmail } from "@/lib/marketData";
import { pairOf } from "@/lib/genfx/pairs";
import { confirmFxEntry } from "@/lib/genfx/confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * GEN FX LIVE ENTRY CONFIRMATION — "is it time to enter yet?" for a setup that is waiting. Free.
 * The rule lives in @/lib/genfx/confirm, so the banner on the page and the scanner fire ENTER on
 * exactly the same closed candle.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export async function POST(req: NextRequest) {
  const supabase = createClient();
  let email: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    email = user.email ?? null;
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ state: "NO_DATA", detail: "Market data isn't configured." }, 200);

  let b: { pair?: unknown; side?: unknown; entryLow?: unknown; entryHigh?: unknown; watch?: unknown; invalidation?: unknown; mode?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const pair = pairOf(b.pair);
  if (!pair) return json({ error: "bad_request" }, 400);

  const side: "buy" | "sell" = b.side === "sell" ? "sell" : "buy";
  const inv = Number(b.invalidation);
  const watch = Number(b.watch);
  let zoneLo = Number(b.entryLow), zoneHi = Number(b.entryHigh);
  if (!numOk(zoneLo) || !numOk(zoneHi)) { zoneLo = watch; zoneHi = watch; }
  if (!numOk(inv) || (!numOk(zoneLo) && !numOk(watch))) return json({ state: "NO_DATA", detail: "Missing setup levels." }, 200);

  const result = await confirmFxEntry({ pair, side, entryLow: zoneLo, entryHigh: zoneHi, watch, invalidation: inv, mode: String(b.mode), mdKey, fresh: isPriorityEmail(email) });
  return json(result, 200);
}
