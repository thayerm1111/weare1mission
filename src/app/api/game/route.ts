import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MISSION_XP } from "@/lib/gameData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Cross-device gamification state (live Supabase).
 * Degrades gracefully: if Supabase isn't configured, the user isn't signed in,
 * or the `game_state` table hasn't been created yet, returns { enabled:false }
 * and the client falls back to per-device localStorage. Once the table exists,
 * this becomes the single source of truth (shared + leaderboard-ready).
 */

function ymd(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function today() { return ymd(new Date()); }
function yesterday() { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return ymd(d); }

type Row = { xp: number; streak: number; best_streak: number; last_login: string | null; day_missions: Record<string, string[]> | null };

function shape(row: Row, t: string) {
  const dm = row.day_missions && typeof row.day_missions === "object" ? row.day_missions : {};
  return { xp: row.xp, streak: row.streak, best: row.best_streak, done: Array.isArray(dm[t]) ? dm[t] : [] };
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ enabled: false, reason: "unconfigured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ enabled: false, reason: "unauth" }, 200);

  const sel = await supabase.from("game_state").select("xp,streak,best_streak,last_login,day_missions").eq("user_id", user.id).maybeSingle();
  if (sel.error) return json({ enabled: false, reason: "nodb" }, 200); // table missing → fall back

  const t = today();
  let row = sel.data as Row | null;

  if (!row) {
    const ins = await supabase
      .from("game_state")
      .insert({ user_id: user.id, xp: 10, streak: 1, best_streak: 1, last_login: t, day_missions: {} })
      .select("xp,streak,best_streak,last_login,day_missions").single();
    if (ins.error) return json({ enabled: false, reason: "nodb" }, 200);
    row = ins.data as Row;
  } else if (row.last_login !== t) {
    const continues = row.last_login === yesterday();
    const streak = continues ? row.streak + 1 : 1;
    const upd = await supabase
      .from("game_state")
      .update({ xp: row.xp + 10, streak, best_streak: Math.max(row.best_streak, streak), last_login: t })
      .eq("user_id", user.id)
      .select("xp,streak,best_streak,last_login,day_missions").single();
    if (!upd.error) row = upd.data as Row;
  }

  return json({ enabled: true, state: shape(row, t) }, 200);
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ enabled: false, reason: "unconfigured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ enabled: false, reason: "unauth" }, 200);

  let body: { missionId?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const missionId = typeof body.missionId === "string" ? body.missionId : "";
  const xp = MISSION_XP[missionId];
  if (!xp) return json({ error: "bad_mission" }, 400);

  const sel = await supabase.from("game_state").select("xp,streak,best_streak,last_login,day_missions").eq("user_id", user.id).maybeSingle();
  if (sel.error || !sel.data) return json({ enabled: false, reason: "nodb" }, 200);
  const row = sel.data as Row;
  const t = today();
  const dm = row.day_missions && typeof row.day_missions === "object" ? row.day_missions : {};
  const done = Array.isArray(dm[t]) ? dm[t] : [];
  if (done.includes(missionId)) return json({ enabled: true, state: shape(row, t) }, 200); // idempotent

  // Keep only today's list to keep the jsonb tiny.
  const upd = await supabase
    .from("game_state")
    .update({ xp: row.xp + xp, day_missions: { [t]: [...done, missionId] } })
    .eq("user_id", user.id)
    .select("xp,streak,best_streak,last_login,day_missions").single();
  if (upd.error) return json({ enabled: false, reason: "nodb" }, 200);

  return json({ enabled: true, state: shape(upd.data as Row, t) }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
