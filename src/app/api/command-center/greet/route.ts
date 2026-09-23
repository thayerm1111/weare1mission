import { randomBytes } from "crypto";
import { createClient as adminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { hasPassOrPreview } from "@/lib/ccPass";
import { ensureAgent, signedUrl, availability } from "../../../../../command-center/engines/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * ATLAS'S SPOKEN WELCOME (owner 09-21).
 *
 * When a member opens the Command Center and pays for a window, ATLAS greets them BY NAME, tells them
 * where their accounts stand, and gives the gold update — out loud, once. Renewing the 30-minute
 * window doesn't replay it; opening again two hours or more after the last welcome does, and so does
 * opening it after signing out and back in.
 *
 * GET  → { eligible, name, accounts }   the member's first name and their FLOW account balances
 * POST → { url }                         a one-time line to the voice agent; the browser sends the
 *                                        welcome as the agent's first message, plays it, and hangs up
 *
 * The welcome is recorded as a zero-minute, already-ended voice session so the two-hour rule holds
 * across devices and never touches the member's voice-minute allowance.
 */
const REPLAY_AFTER_MS = 2 * 60 * 60_000;

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && sk ? adminClient(url, sk, { auth: { persistSession: false } }) : null;
}

async function who() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

/** ?replay=1 lets an ADMIN hear the welcome again inside the two hours (screen recordings, testing). */
async function adminReplay(req: Request, userId: string): Promise<boolean> {
  if (new URL(req.url).searchParams.get("replay") !== "1") return false;
  const c = admin(); if (!c) return false;
  const { data } = await c.from("profiles").select("role").eq("id", userId).maybeSingle();
  return (data as { role?: string } | null)?.role === "admin";
}

async function lastWelcome(userId: string): Promise<number | null> {
  const c = admin(); if (!c) return null;
  const { data } = await c.from("cc_voice_sessions").select("started_at")
    .eq("user_id", userId).eq("end_reason", "welcome").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const at = (data as { started_at?: string } | null)?.started_at;
  return at ? Date.parse(at) : null;
}

/**
 * Is a welcome due? Yes when they have never had one, when the last was two hours ago or more, or when
 * they have SIGNED IN since the last one (owner 09-21: "if I log out and log back in it'll play the
 * animation again"). A token refresh does not move last_sign_in_at — only a real sign-in does.
 */
function welcomeDue(user: { last_sign_in_at?: string | null }, last: number | null): boolean {
  if (last == null || Date.now() - last >= REPLAY_AFTER_MS) return true;
  const signedIn = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN;
  return Number.isFinite(signedIn) && signedIn > last;
}

export async function GET(req: Request) {
  const user = await who();
  if (!user) return json({ error: "unauthorized" }, 401);
  const access = await hasPassOrPreview(user.id);
  if (!access.ok) return json({ eligible: false, reason: "pass_required" });
  const c = admin(); if (!c) return json({ eligible: false, reason: "not_configured" });

  // A free preview always gets its welcome — that is the point of it.
  const last = await lastWelcome(user.id);
  const eligible = access.preview || welcomeDue(user, last) || (await adminReplay(req, user.id));

  // Their name, as they gave it — never a default.
  const { data: prof } = await c.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const full = String((prof as { full_name?: string } | null)?.full_name ?? "").trim();
  const name = full ? full.split(/\s+/)[0].replace(/^./, (x) => x.toUpperCase()) : null;

  /*
   * ONE ACCOUNT, NOT A TOTAL (owner 09-23, about to go live on Zoom: "The recap said the balance of
   * all my accounts together. I just want it to tell my balance of one of the accounts").
   *
   * The welcome used to add every connected account together and say "your 3 live accounts are at
   * $X combined" — a number that is on no screen anywhere and that a member cannot check against
   * their platform. It now speaks the ONE account ATLAS is set to: the selected account in the
   * Command Center, which is the same account its trade panel and its answers use. Its equity comes
   * from ATLAS's own account state, so the figure matches the one on the member's broker screen.
   *
   * Fallback, in order: the ATLAS-selected account → the ATLAS account with the largest balance →
   * the FLOW account with the largest balance (a member who has connected FLOW but never opened the
   * Command Center). No account anywhere → no account line at all, rather than a made-up zero.
   */
  type CcAcct = { account_id: string | null; is_live: boolean | null; is_selected: boolean | null; equity: number | null; balance: number | null; state_at: string | null; updated_at: string | null };
  const { data: ccData } = await c.from("cc_broker_accounts")
    .select("account_id, is_live, is_selected, equity, balance, state_at, updated_at").eq("user_id", user.id);
  const ccRows = ((ccData ?? []) as CcAcct[])
    .map((r) => ({ ...r, amount: r.equity != null && Number.isFinite(Number(r.equity)) ? Number(r.equity) : (r.balance != null && Number.isFinite(Number(r.balance)) ? Number(r.balance) : null) }))
    .filter((r) => r.amount != null);
  const pickedCc = ccRows.find((r) => r.is_selected === true)
    ?? [...ccRows].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))[0]
    ?? null;

  let one: { amount: number; isLive: boolean; asOf: string | null } | null = pickedCc
    ? { amount: pickedCc.amount as number, isLive: pickedCc.is_live !== false, asOf: pickedCc.state_at ?? pickedCc.updated_at ?? null }
    : null;

  if (!one) {
    const { data: accts } = await c.from("flow_broker_accounts").select("environment, balance, updated_at").eq("user_id", user.id);
    const rows = ((accts ?? []) as { environment: string; balance: number | null; updated_at: string | null }[])
      .filter((r) => r.balance != null && Number.isFinite(Number(r.balance)));
    const biggest = [...rows].sort((a, b) => Number(b.balance) - Number(a.balance))[0];
    if (biggest) one = { amount: Number(biggest.balance), isLive: biggest.environment === "live", asOf: biggest.updated_at ?? null };
  }

  return json({
    eligible,
    preview: access.preview,
    name,
    voice: availability().ok,
    // The shape stays as it was so the welcome script needs no change: one account, counted once.
    accounts: one ? {
      liveCount: one.isLive ? 1 : 0, liveTotal: one.isLive ? Math.round(one.amount * 100) / 100 : 0,
      demoCount: one.isLive ? 0 : 1, demoTotal: one.isLive ? 0 : Math.round(one.amount * 100) / 100,
      asOf: one.asOf,
    } : null,
  });
}

export async function POST(req: Request) {
  const user = await who();
  if (!user) return json({ error: "unauthorized" }, 401);
  const access = await hasPassOrPreview(user.id);
  if (!access.ok) return json({ ok: false, reason: "pass_required" }, 402);
  const last = await lastWelcome(user.id);
  if (!access.preview && !welcomeDue(user, last) && !(await adminReplay(req, user.id))) return json({ ok: false, reason: "already_welcomed" });
  if (!availability().ok) return json({ ok: false, reason: "voice_not_configured" });

  const agent = await ensureAgent();
  if (!agent.ok) return json({ ok: false, reason: "agent_unavailable" });
  const s = await signedUrl(agent.agentId);
  if (!s.ok) return json({ ok: false, reason: "no_line" });

  const c = admin();
  if (c && !access.preview) { // the preview's own row already records it
    const nowIso = new Date().toISOString();
    await c.from("cc_voice_sessions").insert({
      user_id: user.id, token: randomBytes(16).toString("hex"), token_expires_at: nowIso,
      provider: "elevenlabs", agent_id: agent.agentId, started_at: nowIso, ended_at: nowIso,
      last_seen_at: nowIso, minutes: 0, turns: 0, end_reason: "welcome",
    });
  }
  return json({ ok: true, url: s.url });
}
