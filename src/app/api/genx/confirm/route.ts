import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPriorityEmail } from "@/lib/marketData";
import { confirmEntry } from "@/lib/genxConfirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * GENX LIVE ENTRY CONFIRMATION — the deterministic "is it time to enter yet?"
 * check for a WAIT setup. Lightweight and FREE (no credit charge). The actual
 * rule lives in @/lib/genxConfirm (confirmEntry) so the in-app banner and the
 * Telegram scanner fire ENTER on exactly the same closed-candle rule.
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

  let b: { side?: unknown; entryLow?: unknown; entryHigh?: unknown; watch?: unknown; invalidation?: unknown; mode?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const side: "buy" | "sell" = b.side === "sell" ? "sell" : "buy";
  const inv = Number(b.invalidation);
  const watch = Number(b.watch);
  let zoneLo = Number(b.entryLow), zoneHi = Number(b.entryHigh);
  if (!numOk(zoneLo) || !numOk(zoneHi)) { zoneLo = watch; zoneHi = watch; }
  if (!numOk(inv) || (!numOk(zoneLo) && !numOk(watch))) return json({ state: "NO_DATA", detail: "Missing setup levels." }, 200);

  const result = await confirmEntry({
    side, entryLow: zoneLo, entryHigh: zoneHi, watch, invalidation: inv,
    mode: String(b.mode), mdKey, fresh: isPriorityEmail(email),
  });
  return json(result, 200);
}
