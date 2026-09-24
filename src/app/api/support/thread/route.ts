import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SUPPORT CHAT — the member's side (owner 09-24).
 *
 *   GET  → this member's thread and its visible messages
 *   POST { body } → send a message (opens a thread on the first one)
 *
 * NOTE the path. /api/support is the EXISTING streaming AI assistant and must not be disturbed; this
 * is the human thread that reaches the owner, so it lives at /api/support/thread. The two are
 * complementary: the assistant answers "how do credits work" instantly, this one is for "something is
 * wrong with MY account", which needs a person and a look at their data.
 *
 * The member NEVER sees a draft reply: the RLS policy on support_messages filters `visibility` at the
 * database, so even a mistake in this file cannot leak an unapproved answer. Reads therefore go
 * through the member's own client (RLS on), and only the write path touches the admin client — and
 * only to create the thread row, never to read one back.
 */
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MAX_BODY = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;          // messages per minute — stops a stuck client flooding the desk

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: thread } = await supabase
    .from("support_threads").select("id, status, created_at, updated_at, last_staff_at")
    .eq("user_id", user.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!thread) return json({ ok: true, thread: null, messages: [] });

  const { data: messages } = await supabase
    .from("support_messages").select("id, role, body, created_at")
    .eq("thread_id", (thread as { id: string }).id).order("created_at", { ascending: true }).limit(200);

  return json({ ok: true, thread, messages: messages ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let b: { body?: string } = {};
  try { b = await req.json(); } catch { /* */ }
  const body = String(b.body ?? "").trim().slice(0, MAX_BODY);
  if (!body) return json({ error: "empty" }, 400);

  const admin = createAdminClient();
  if (!admin) return json({ error: "server" }, 200);

  // Rate limit on the member's own recent messages.
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count } = await admin.from("support_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("role", "member").gte("created_at", since);
  if ((count ?? 0) >= RATE_MAX) return json({ error: "slow_down", detail: "Give us a moment to read the last few." }, 429);

  // Reuse the member's live thread so support stays one continuous conversation rather than a pile
  // of one-line tickets. A resolved thread starts a fresh one.
  const { data: existing } = await admin.from("support_threads")
    .select("id").eq("user_id", user.id).in("status", ["open", "answered"])
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();

  let threadId = (existing as { id: string } | null)?.id ?? null;
  if (!threadId) {
    const { data: created, error } = await admin.from("support_threads")
      .insert({ user_id: user.id, subject: body.slice(0, 80), status: "open" })
      .select("id").single();
    if (error || !created) return json({ error: "server", detail: "Couldn't open a conversation." }, 200);
    threadId = (created as { id: string }).id;
  }

  const { error: msgErr } = await admin.from("support_messages")
    .insert({ thread_id: threadId, user_id: user.id, role: "member", body, visibility: "member" });
  if (msgErr) return json({ error: "server", detail: "Couldn't send that." }, 200);

  return json({ ok: true, threadId });
}
