import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Learn From the Greats — per-member state. Every member reads/writes ONLY their
 * own rows (RLS on all greats_* tables).
 *
 *   GET  → { progress, notes, favorites, quiz, workbook, state, challenge }
 *   POST → one action, discriminated by { kind }:
 *     progress  { masterclassId, lessonId, completed }   (toggles a lesson; bumps PD streak)
 *     note      { lessonId, masterclassId?, body }
 *     favorite  { itemType:'masterclass'|'lesson', itemId, on }
 *     quiz      { lessonId, score, total }
 *     workbook  { workbookId, answers }                  (full jsonb map)
 *     touch     {}                                       (records study activity → streak)
 *     lastLesson{ masterclassId, lessonId }              (Continue Learning pointer)
 *     challenge { challengeId?, goal?, start?, dayDone?, active? }
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }
function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function me() {
  const supabase = createClient();
  if (!supabase) return { supabase: null, uid: null as string | null };
  const { data: { user } } = await supabase.auth.getUser();
  return { supabase, uid: user?.id ?? null };
}

type SB = NonNullable<Awaited<ReturnType<typeof me>>["supabase"]>;

/** Record a day of study: advance the personal-development streak once per UTC day. */
async function bumpStreak(supabase: SB, uid: string) {
  const { data: st } = await supabase.from("greats_state").select("streak, longest, total_days, last_active").eq("user_id", uid).maybeSingle();
  const today = todayUTC();
  if (st && st.last_active === today) return; // already counted today
  let streak = 1;
  if (st && st.last_active === yesterdayUTC()) streak = (st.streak || 0) + 1;
  const longest = Math.max(st?.longest || 0, streak);
  const total = (st?.total_days || 0) + 1;
  await supabase.from("greats_state").upsert(
    { user_id: uid, streak, longest, total_days: total, last_active: today, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
}

export async function GET(_req: NextRequest) {
  const { supabase, uid } = await me();
  if (!supabase) return json({ error: "not_configured" }, 500);
  if (!uid) return json({ error: "unauthorized" }, 401);

  const [prog, notes, favs, quiz, wb, state, chal, prof] = await Promise.all([
    supabase.from("greats_progress").select("masterclass_id, lesson_id, completed_at").eq("user_id", uid),
    supabase.from("greats_notes").select("lesson_id, masterclass_id, body, updated_at").eq("user_id", uid),
    supabase.from("greats_favorites").select("item_type, item_id").eq("user_id", uid),
    supabase.from("greats_quiz").select("lesson_id, score, total, taken_at").eq("user_id", uid),
    supabase.from("greats_workbook").select("workbook_id, answers, updated_at").eq("user_id", uid),
    supabase.from("greats_state").select("last_lesson, streak, longest, total_days, last_active").eq("user_id", uid).maybeSingle(),
    supabase.from("greats_challenge").select("challenge_id, goal, start_date, days_done, active, updated_at").eq("user_id", uid),
    supabase.from("profiles").select("role, full_name").eq("id", uid).maybeSingle(),
  ]);

  const notesMap: Record<string, string> = {};
  for (const n of notes.data ?? []) notesMap[n.lesson_id] = n.body;
  const quizMap: Record<string, { score: number; total: number }> = {};
  for (const q of quiz.data ?? []) quizMap[q.lesson_id] = { score: q.score, total: q.total };
  const wbMap: Record<string, Record<string, string>> = {};
  for (const w of wb.data ?? []) wbMap[w.workbook_id] = (w.answers as Record<string, string>) ?? {};

  return json({
    ok: true,
    progress: (prog.data ?? []).map((p) => ({ masterclassId: p.masterclass_id, lessonId: p.lesson_id, at: p.completed_at })),
    notes: notesMap,
    favorites: (favs.data ?? []).map((f) => ({ type: f.item_type, id: f.item_id })),
    quiz: quizMap,
    workbook: wbMap,
    state: state.data ?? { last_lesson: null, streak: 0, longest: 0, total_days: 0, last_active: null },
    challenge: chal.data ?? [],
    role: prof.data?.role ?? "member",
    name: prof.data?.full_name ?? null,
  }, 200);
}

export async function POST(req: NextRequest) {
  const { supabase, uid } = await me();
  if (!supabase) return json({ error: "not_configured" }, 500);
  if (!uid) return json({ error: "unauthorized" }, 401);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const kind = String(b.kind || "");
  const S = (v: unknown, n = 400) => String(v ?? "").slice(0, n);

  try {
    if (kind === "progress") {
      const lessonId = S(b.lessonId, 80);
      const masterclassId = S(b.masterclassId, 80);
      if (!lessonId) return json({ error: "missing_lesson" }, 400);
      if (b.completed === false) {
        await supabase.from("greats_progress").delete().eq("user_id", uid).eq("lesson_id", lessonId);
      } else {
        await supabase.from("greats_progress").upsert(
          { user_id: uid, masterclass_id: masterclassId, lesson_id: lessonId, completed: true, completed_at: new Date().toISOString() },
          { onConflict: "user_id,lesson_id" }
        );
        await bumpStreak(supabase, uid);
      }
      return json({ ok: true }, 200);
    }

    if (kind === "note") {
      const lessonId = S(b.lessonId, 80);
      if (!lessonId) return json({ error: "missing_lesson" }, 400);
      await supabase.from("greats_notes").upsert(
        { user_id: uid, lesson_id: lessonId, masterclass_id: S(b.masterclassId, 80) || null, body: S(b.body, 8000), updated_at: new Date().toISOString() },
        { onConflict: "user_id,lesson_id" }
      );
      return json({ ok: true }, 200);
    }

    if (kind === "favorite") {
      const itemType = b.itemType === "masterclass" ? "masterclass" : "lesson";
      const itemId = S(b.itemId, 80);
      if (!itemId) return json({ error: "missing_item" }, 400);
      if (b.on === false) {
        await supabase.from("greats_favorites").delete().eq("user_id", uid).eq("item_type", itemType).eq("item_id", itemId);
      } else {
        await supabase.from("greats_favorites").upsert(
          { user_id: uid, item_type: itemType, item_id: itemId }, { onConflict: "user_id,item_type,item_id" }
        );
      }
      return json({ ok: true }, 200);
    }

    if (kind === "quiz") {
      const lessonId = S(b.lessonId, 80);
      if (!lessonId) return json({ error: "missing_lesson" }, 400);
      await supabase.from("greats_quiz").upsert(
        { user_id: uid, lesson_id: lessonId, score: Math.max(0, Number(b.score) || 0), total: Math.max(0, Number(b.total) || 0), taken_at: new Date().toISOString() },
        { onConflict: "user_id,lesson_id" }
      );
      await bumpStreak(supabase, uid);
      return json({ ok: true }, 200);
    }

    if (kind === "workbook") {
      const workbookId = S(b.workbookId, 80);
      if (!workbookId) return json({ error: "missing_workbook" }, 400);
      const answers = (b.answers && typeof b.answers === "object") ? b.answers : {};
      // clamp each answer to a sane size
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(answers as Record<string, unknown>)) clean[k.slice(0, 80)] = String(v ?? "").slice(0, 6000);
      await supabase.from("greats_workbook").upsert(
        { user_id: uid, workbook_id: workbookId, answers: clean, updated_at: new Date().toISOString() },
        { onConflict: "user_id,workbook_id" }
      );
      return json({ ok: true }, 200);
    }

    if (kind === "touch") {
      await bumpStreak(supabase, uid);
      return json({ ok: true }, 200);
    }

    if (kind === "lastLesson") {
      const val = `${S(b.masterclassId, 80)}/${S(b.lessonId, 80)}`;
      await supabase.from("greats_state").upsert(
        { user_id: uid, last_lesson: val, updated_at: new Date().toISOString() }, { onConflict: "user_id" }
      );
      return json({ ok: true }, 200);
    }

    if (kind === "challenge") {
      const challengeId = S(b.challengeId, 80) || "strangest-secret-30";
      const { data: cur } = await supabase.from("greats_challenge").select("goal, start_date, days_done, active").eq("user_id", uid).eq("challenge_id", challengeId).maybeSingle();
      const days = new Set<number>(Array.isArray(cur?.days_done) ? (cur!.days_done as number[]) : []);
      if (typeof b.dayDone === "number" && b.dayDone >= 1 && b.dayDone <= 30) days.add(Math.floor(b.dayDone));
      const row: Record<string, unknown> = {
        user_id: uid, challenge_id: challengeId,
        goal: b.goal !== undefined ? S(b.goal, 500) : (cur?.goal ?? null),
        start_date: b.start !== undefined ? (S(b.start, 10) || null) : (cur?.start_date ?? (b.dayDone ? todayUTC() : null)),
        days_done: Array.from(days).sort((a, z) => a - z),
        active: b.active !== undefined ? !!b.active : (cur?.active ?? true),
        updated_at: new Date().toISOString(),
      };
      await supabase.from("greats_challenge").upsert(row, { onConflict: "user_id,challenge_id" });
      if (typeof b.dayDone === "number") await bumpStreak(supabase, uid);
      return json({ ok: true }, 200);
    }

    return json({ error: "unknown_kind" }, 400);
  } catch (e) {
    return json({ error: "save_failed", detail: String(e).slice(0, 200) }, 500);
  }
}
