import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Per-user signal storage so a member's OM AI Plays sync across every device and
 * survive a cleared browser (localStorage is only a fast local cache now).
 * All access is scoped to the signed-in user by row-level security.
 *   GET    -> list the user's saved signals (newest first)
 *   POST   -> upsert one or many signals ({ signal } or { signals: [...] })
 *   DELETE -> remove one by ?id=<client id>
 */

type Incoming = { id?: unknown; status?: unknown; hitTp?: unknown; [k: string]: unknown };
type Row = { client_id: string; payload: Incoming; status: string; hit_tp: number | null };

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ signals: [] });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data, error } = await supabase
    .from("user_signals")
    .select("client_id, payload, status, hit_tp, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return json({ error: "db_error" }, 500);

  const signals = ((data ?? []) as Row[]).map((r) => {
    const idNum = Number(r.client_id);
    return {
      ...(r.payload || {}),
      id: Number.isFinite(idNum) ? idNum : r.client_id,
      status: r.status,
      hitTp: r.hit_tp == null ? undefined : r.hit_tp,
    };
  });
  return json({ signals });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, note: "not_configured" });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { signal?: Incoming; signals?: Incoming[] };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const list: Incoming[] = Array.isArray(body?.signals) ? body.signals : body?.signal ? [body.signal] : [];
  const rows = list
    .filter((r): r is Incoming => !!r && (typeof r.id === "number" || typeof r.id === "string"))
    .slice(0, 50)
    .map((r) => ({
      user_id: user.id,
      client_id: String(r.id),
      payload: r,
      status: typeof r.status === "string" ? r.status : "open",
      hit_tp: typeof r.hitTp === "number" ? r.hitTp : null,
      updated_at: new Date().toISOString(),
    }));
  if (!rows.length) return json({ ok: true, saved: 0 });

  const { error } = await supabase.from("user_signals").upsert(rows, { onConflict: "user_id,client_id" });
  if (error) return json({ error: "db_error", detail: error.message }, 500);
  return json({ ok: true, saved: rows.length });
}

export async function DELETE(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return json({ error: "bad_request" }, 400);
  const { error } = await supabase.from("user_signals").delete().eq("client_id", id);
  if (error) return json({ error: "db_error" }, 500);
  return json({ ok: true });
}
