import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GEN FX PLAY HISTORY — every read a member runs is kept in genfx_signals; this hands it back.
 *   GET            -> the member's last 20 reads, newest first (one line each)
 *   GET ?id=<uuid> -> that read's FULL original readout, exactly as it was presented
 * A member only ever sees their own reads.
 */
type Row = { id: string; created_at: string; pair: string | null; mode: string | null; action: string | null; direction: string | null; confidence: number | null; entry: number | null; entry_low: number | null; entry_high: number | null; stop_loss: number | null; tp1: number | null; setup_type: string | null; outcome?: string | null; reasoning?: unknown; market_snapshot?: Record<string, unknown> | null };

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ plays: [] });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ plays: [] });

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const { data } = await admin.from("genfx_signals")
      .select("id,created_at,pair,mode,action,direction,confidence,entry,entry_low,entry_high,stop_loss,tp1,setup_type,reasoning,market_snapshot")
      .eq("user_id", user.id).eq("id", id).maybeSingle();
    const r = data as Row | null;
    if (!r) return json({ error: "not_found" }, 404);
    const snap = (r.market_snapshot ?? {}) as { price?: number; session?: string; data_status?: string; asOf?: string };
    return json({
      play: {
        id: r.id, at: r.created_at, pair: r.pair, mode: r.mode, genfx: r.reasoning,
        price: snap.price ?? null, session: snap.session ?? null, data_status: snap.data_status ?? null, asOf: snap.asOf ?? r.created_at,
      },
    });
  }

  const { data } = await admin.from("genfx_signals")
    .select("id,created_at,pair,mode,action,direction,confidence,entry,entry_low,entry_high,stop_loss,tp1,setup_type,outcome")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
  const plays = ((data ?? []) as Row[]).map((r) => ({
    id: r.id, at: r.created_at, pair: r.pair, mode: r.mode, action: r.action, direction: r.direction, confidence: r.confidence,
    entry: r.entry, entryLow: r.entry_low, entryHigh: r.entry_high, stop: r.stop_loss, tp1: r.tp1, setup: r.setup_type, outcome: r.outcome ?? null,
  }));
  return json({ plays });
}
