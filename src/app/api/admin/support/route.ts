import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPriorityEmail } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SUPPORT CHAT — the owner's side (owner 09-24).
 *
 *   GET                                 → threads with their messages, Claude's triage note, and any draft
 *   POST { action:"send", threadId, body } → approve (optionally edited) and send the reply to the member
 *   POST { action:"status", threadId, status }
 *
 * APPROVAL IS THE WHOLE POINT. Claude leaves replies as `visibility:'draft'`, which RLS keeps out of
 * the member's view. Sending is the one action that flips a draft to 'member' — and only this route,
 * behind the owner's own login, can do it. Nothing Claude writes reaches a member on its own.
 */
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function owner() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isPriorityEmail(user.email)) return null;
  return user;
}

type Msg = { id: string; thread_id: string; role: string; body: string; visibility: string; created_at: string };

export async function GET(req: NextRequest) {
  const me = await owner();
  if (!me) return json({ error: "forbidden" }, 403);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server" }, 200);

  const status = req.nextUrl.searchParams.get("status") || "active";
  let q = admin.from("support_threads")
    .select("id, user_id, subject, status, priority, topic, triage_note, created_at, updated_at, last_member_at, last_staff_at")
    .order("updated_at", { ascending: false }).limit(100);
  if (status === "active") q = q.in("status", ["open", "answered"]);
  else if (status !== "all") q = q.eq("status", status);
  const { data: threads } = await q;
  const rows = (threads ?? []) as { id: string; user_id: string }[];
  if (!rows.length) return json({ ok: true, threads: [] });

  const { data: msgs } = await admin.from("support_messages")
    .select("id, thread_id, role, body, visibility, created_at")
    .in("thread_id", rows.map((t) => t.id)).order("created_at", { ascending: true });
  const byThread = new Map<string, Msg[]>();
  for (const m of (msgs ?? []) as Msg[]) { const l = byThread.get(m.thread_id) ?? []; l.push(m); byThread.set(m.thread_id, l); }

  // Emails come from auth, which the browser cannot read for other users — resolve them here.
  const emails = new Map<string, string>();
  for (const uid of [...new Set(rows.map((t) => t.user_id))]) {
    try {
      const { data } = await admin.auth.admin.getUserById(uid);
      if (data?.user?.email) emails.set(uid, data.user.email);
    } catch { /* a deleted member just shows as unknown */ }
  }

  return json({
    ok: true,
    threads: rows.map((t) => {
      const all = byThread.get(t.id) ?? [];
      return {
        ...t,
        email: emails.get(t.user_id) ?? null,
        messages: all.filter((m) => m.visibility === "member"),
        draft: all.filter((m) => m.visibility === "draft").slice(-1)[0] ?? null,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const me = await owner();
  if (!me) return json({ error: "forbidden" }, 403);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server" }, 200);

  let b: { action?: string; threadId?: string; body?: string; status?: string } = {};
  try { b = await req.json(); } catch { /* */ }
  const threadId = String(b.threadId ?? "");
  if (!threadId) return json({ error: "bad_request" }, 400);

  if (b.action === "status") {
    const status = String(b.status ?? "");
    if (!["open", "answered", "resolved"].includes(status)) return json({ error: "bad_status" }, 400);
    await admin.from("support_threads").update({ status, updated_at: new Date().toISOString() }).eq("id", threadId);
    return json({ ok: true });
  }

  if (b.action === "send") {
    const body = String(b.body ?? "").trim().slice(0, 4000);
    if (!body) return json({ error: "empty" }, 400);
    // The sent reply is written fresh from what the owner actually approved, so an edit in the box is
    // what the member receives — never the original draft text.
    const { error } = await admin.from("support_messages").insert({
      thread_id: threadId, user_id: null, role: "staff", body,
      visibility: "member", approved_by: me.id, sent_at: new Date().toISOString(),
    });
    if (error) return json({ error: "server", detail: "Couldn't send." }, 200);
    // Retire any pending drafts on this thread so the same answer can't be sent twice.
    await admin.from("support_messages").update({ visibility: "used" }).eq("thread_id", threadId).eq("visibility", "draft");
    await admin.from("support_threads").update({ status: "answered", updated_at: new Date().toISOString() }).eq("id", threadId);
    return json({ ok: true });
  }

  return json({ error: "bad_action" }, 400);
}
