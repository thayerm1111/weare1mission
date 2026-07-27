import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * XAUGHOST trade journal — per-user record of every gold call, its outcome and
 * the lesson learned. Feeds the engine's adaptive memory. RLS scopes all access.
 *   GET    -> list the user's tracked calls (newest first)
 *   POST   -> save/update one call
 *   DELETE -> remove one by ?id=<client id>
 */
type Incoming = { id?: unknown; asOf?: unknown; direction?: unknown; strategy?: unknown; regime?: unknown; entry?: unknown; stopLoss?: unknown; takeProfits?: unknown; confidence?: unknown; grade?: unknown; status?: unknown; payload?: unknown };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ trades: [] });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data, error } = await supabase
    .from("xaughost_trades")
    .select("client_id, as_of, direction, strategy, regime, entry, stop_loss, tp1, tp2, tp3, confidence, grade, status, hit_tp, outcome_at, lesson, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return json({ error: "db_error" }, 500);
  return json({ trades: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, note: "not_configured" });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  let body: { trade?: Incoming };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const t = body?.trade;
  if (!t || (typeof t.id !== "number" && typeof t.id !== "string")) return json({ error: "bad_request" }, 400);
  const tps = Array.isArray(t.takeProfits) ? (t.takeProfits as unknown[]).map(num) : [];
  const row = {
    user_id: user.id,
    client_id: String(t.id),
    as_of: typeof t.asOf === "string" ? t.asOf : null,
    direction: typeof t.direction === "string" ? t.direction : null,
    strategy: typeof t.strategy === "string" ? t.strategy : null,
    regime: typeof t.regime === "string" ? t.regime : null,
    entry: num(t.entry), stop_loss: num(t.stopLoss),
    tp1: tps[0] ?? null, tp2: tps[1] ?? null, tp3: tps[2] ?? null,
    confidence: num(t.confidence), grade: typeof t.grade === "string" ? t.grade : null,
    status: typeof t.status === "string" ? t.status : "open",
    payload: t.payload ?? null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("xaughost_trades").upsert(row, { onConflict: "user_id,client_id" });
  if (error) return json({ error: "db_error", detail: error.message }, 500);
  return json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return json({ error: "bad_request" }, 400);
  const { error } = await supabase.from("xaughost_trades").delete().eq("client_id", id);
  if (error) return json({ error: "db_error" }, 500);
  return json({ ok: true });
}
