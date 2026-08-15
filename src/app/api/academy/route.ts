import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Affiliate Academy progress + tools state. Signed-in member reads/writes their
 * OWN row only — enforced by RLS on academy_state / academy_activity.
 *   GET  → { state, activity } (defaults if no row yet)
 *   POST → upsert a partial patch of state and/or this week's activity.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const STATE_FIELDS = ["completed_lessons", "level", "why", "prospects", "launch", "daily", "roleplay", "saved_scripts"];
const ACT_FIELDS = ["conversations", "invites", "presentations", "followups", "enrollments", "events", "training_days"];

function mondayUTC(d: Date): string {
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const diff = (day === 0 ? -6 : 1) - day; // back to Monday
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return m.toISOString().slice(0, 10);
}

async function me() {
  const supabase = createClient();
  if (!supabase) return { supabase: null, uid: null as string | null };
  const { data: { user } } = await supabase.auth.getUser();
  return { supabase, uid: user?.id ?? null };
}

export async function GET(_req: NextRequest) {
  const { supabase, uid } = await me();
  if (!supabase) return json({ error: "not_configured" }, 500);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const week = mondayUTC(new Date());
  const [{ data: state }, { data: activity }] = await Promise.all([
    supabase.from("academy_state").select("*").eq("user_id", uid).maybeSingle(),
    supabase.from("academy_activity").select("*").eq("user_id", uid).eq("week_start", week).maybeSingle(),
  ]);

  return json({
    ok: true,
    state: state ?? { completed_lessons: [], level: 1, why: null, prospects: null, launch: null, daily: null, roleplay: null, saved_scripts: [] },
    activity: activity ?? { week_start: week, conversations: 0, invites: 0, presentations: 0, followups: 0, enrollments: 0, events: 0, training_days: 0 },
  }, 200);
}

export async function POST(req: NextRequest) {
  const { supabase, uid } = await me();
  if (!supabase) return json({ error: "not_configured" }, 500);
  if (!uid) return json({ error: "unauthorized" }, 401);

  let body: { patch?: Record<string, unknown>; activity?: Record<string, unknown> } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  // ── state patch (whitelist) ──
  if (body.patch && typeof body.patch === "object") {
    const patch: Record<string, unknown> = { user_id: uid };
    for (const k of STATE_FIELDS) if (k in body.patch) patch[k] = (body.patch as Record<string, unknown>)[k];
    const { error } = await supabase.from("academy_state").upsert(patch, { onConflict: "user_id" });
    if (error) return json({ error: "save_failed", detail: error.message }, 500);
  }

  // ── weekly activity patch (whitelist) ──
  if (body.activity && typeof body.activity === "object") {
    const week = mondayUTC(new Date());
    const row: Record<string, unknown> = { user_id: uid, week_start: week };
    for (const k of ACT_FIELDS) if (k in body.activity) row[k] = Math.max(0, Number((body.activity as Record<string, unknown>)[k]) || 0);
    const { error } = await supabase.from("academy_activity").upsert(row, { onConflict: "user_id,week_start" });
    if (error) return json({ error: "save_failed", detail: error.message }, 500);
  }

  return json({ ok: true }, 200);
}
