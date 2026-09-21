import { randomBytes } from "crypto";
import { createClient as adminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { hasPass } from "@/lib/ccPass";
import { ensureAgent, signedUrl, availability } from "../../../../../command-center/engines/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * ATLAS'S SPOKEN WELCOME (owner 09-21).
 *
 * When a member opens the Command Center and pays for a window, ATLAS greets them BY NAME, tells them
 * where their accounts stand, and gives the gold update — out loud, once. Renewing the 30-minute
 * window doesn't replay it; opening again two hours or more after the last welcome does.
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

async function lastWelcome(userId: string): Promise<number | null> {
  const c = admin(); if (!c) return null;
  const { data } = await c.from("cc_voice_sessions").select("started_at")
    .eq("user_id", userId).eq("end_reason", "welcome").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const at = (data as { started_at?: string } | null)?.started_at;
  return at ? Date.parse(at) : null;
}

export async function GET() {
  const user = await who();
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!(await hasPass(user.id))) return json({ eligible: false, reason: "pass_required" });
  const c = admin(); if (!c) return json({ eligible: false, reason: "not_configured" });

  const last = await lastWelcome(user.id);
  const eligible = last == null || Date.now() - last >= REPLAY_AFTER_MS;

  // Their name, as they gave it — never a default.
  const { data: prof } = await c.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const full = String((prof as { full_name?: string } | null)?.full_name ?? "").trim();
  const name = full ? full.split(/\s+/)[0].replace(/^./, (x) => x.toUpperCase()) : null;

  // Their accounts, from the balances FLOW keeps current.
  const { data: accts } = await c.from("flow_broker_accounts").select("environment, balance, updated_at").eq("user_id", user.id);
  const rows = ((accts ?? []) as { environment: string; balance: number | null; updated_at: string | null }[])
    .filter((r) => r.balance != null && Number.isFinite(Number(r.balance)));
  const live = rows.filter((r) => r.environment === "live"), demo = rows.filter((r) => r.environment !== "live");
  const sum = (a: typeof rows) => a.reduce((t, r) => t + Number(r.balance), 0);
  const newest = rows.map((r) => (r.updated_at ? Date.parse(r.updated_at) : 0)).reduce((a, b) => Math.max(a, b), 0);
  return json({
    eligible,
    name,
    voice: availability().ok,
    accounts: rows.length ? {
      liveCount: live.length, liveTotal: Math.round(sum(live) * 100) / 100,
      demoCount: demo.length, demoTotal: Math.round(sum(demo) * 100) / 100,
      asOf: newest ? new Date(newest).toISOString() : null,
    } : null,
  });
}

export async function POST() {
  const user = await who();
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!(await hasPass(user.id))) return json({ ok: false, reason: "pass_required" }, 402);
  const last = await lastWelcome(user.id);
  if (last != null && Date.now() - last < REPLAY_AFTER_MS) return json({ ok: false, reason: "already_welcomed" });
  if (!availability().ok) return json({ ok: false, reason: "voice_not_configured" });

  const agent = await ensureAgent();
  if (!agent.ok) return json({ ok: false, reason: "agent_unavailable" });
  const s = await signedUrl(agent.agentId);
  if (!s.ok) return json({ ok: false, reason: "no_line" });

  const c = admin();
  if (c) {
    const nowIso = new Date().toISOString();
    await c.from("cc_voice_sessions").insert({
      user_id: user.id, token: randomBytes(16).toString("hex"), token_expires_at: nowIso,
      provider: "elevenlabs", agent_id: agent.agentId, started_at: nowIso, ended_at: nowIso,
      last_seen_at: nowIso, minutes: 0, turns: 0, end_reason: "welcome",
    });
  }
  return json({ ok: true, url: s.url });
}
