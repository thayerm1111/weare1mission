import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runExecute } from "@/lib/flow/executor";
import { type Mode } from "@/lib/genxCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * FLOW manual/confirm execution — a MEMBER-INITIATED place-order tap.
 *   POST { symbol, mode, source: "confirm" | "manual" }
 *     "confirm" — the one-time first-order confirmation that proves the broker
 *                 path fills correctly (unlocks unattended auto afterwards)
 *     "manual"  — place the current setup now
 * Still runs the full guardrail stack in runExecute (arm switch, caps, dedupe,
 * live re-derivation of the signal). Only fires if the setup is still ENTER_NOW.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { symbol?: unknown; mode?: unknown; source?: unknown } = {};
  try { body = await req.json(); } catch { /* */ }
  const symbol = typeof body.symbol === "string" ? body.symbol : "XAUUSD";
  const mode = (body.mode === "intraday" || body.mode === "swing" ? body.mode : "quick") as Mode;
  // Only member-initiated sources are accepted here; the unattended scanner uses
  // its own secured cron route, never this one.
  const source = body.source === "confirm" ? "confirm" : "manual";

  const outcome = await runExecute({ userId: user.id, symbol, mode, source });
  const ok = outcome.status === "placed" || outcome.status === "dry";
  return json({ ok, outcome }, 200);
}
