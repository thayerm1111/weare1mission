/**
 * THE VOICE SESSION — speech as transport, never as the brain.
 *
 * The temptation with a hosted voice-agent product is to let it be the agent: its model, its persona,
 * its tools. That would hand the most important reasoning in this system to a generic assistant that has
 * never seen a market snapshot, and it is exactly what the specification forbids. So the provider here
 * does two jobs and no others — turn speech into text, and turn text into speech. Everything between
 * those two points is the BRAIN that already exists.
 *
 * THE ADAPTER BOUNDARY IS THE POINT. `VoiceProvider` is the whole surface. A different speech vendor, or
 * the browser's own recognition, satisfies the same three functions, and nothing upstream of this file
 * knows which one is in use.
 *
 * ADMIN ONLY, FOR NOW, AND DELIBERATELY. Speech is billed by the minute: an hour a day is roughly a
 * hundred and forty dollars a month PER PERSON. Opening that to a membership without a budget attached
 * is how a feature becomes a liability, so the gate and the meter are built first and the audience is
 * widened later as a policy change rather than a rewrite.
 */
import { randomBytes } from "node:crypto";
import { db } from "../adapters/db";

export type VoiceAvailability =
  | { ok: true; provider: "elevenlabs"; agentId: string }
  | { ok: false; reason: string; missing: string[] };

/**
 * Is a real voice session possible at all?
 *
 * Returns the missing pieces by name rather than a vague no, because every one of them is something a
 * person has to go and do in a dashboard, and "voice is unavailable" helps nobody do it.
 */
export function availability(): VoiceAvailability {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const missing: string[] = [];
  if (!key) missing.push("ELEVENLABS_API_KEY");
  if (!agentId) missing.push("ELEVENLABS_AGENT_ID");
  if (missing.length) {
    return {
      ok: false,
      missing,
      reason: `Voice is not configured on the server (${missing.join(" and ")} not set). The text console still works.`,
    };
  }
  return { ok: true, provider: "elevenlabs", agentId: agentId! };
}

/* ── budget ─────────────────────────────────────────────────────────────── */

/** Minutes one member may spend in a calendar month. A meter with no limit is not a meter. */
export const MONTHLY_MINUTE_BUDGET = Number(process.env.CC_VOICE_MONTHLY_MINUTES ?? 600);
/** How long a single unattended session may run before it is closed as abandoned. */
export const MAX_SESSION_MS = 60 * 60_000;
/** A session with no sign of life for this long is over, whatever the socket believes. */
export const STALE_SESSION_MS = 3 * 60_000;

export type Budget = { usedMinutes: number; budgetMinutes: number; remainingMinutes: number; exhausted: boolean };

export async function budgetFor(userId: string): Promise<Budget> {
  const c = db();
  const budgetMinutes = MONTHLY_MINUTE_BUDGET;
  if (!c) return { usedMinutes: 0, budgetMinutes, remainingMinutes: budgetMinutes, exhausted: false };

  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const { data } = await c.from("cc_voice_sessions")
    .select("minutes").eq("user_id", userId).gte("started_at", since.toISOString());
  const usedMinutes = ((data ?? []) as { minutes: number | null }[])
    .reduce((a, r) => a + (Number(r.minutes) || 0), 0);

  return {
    usedMinutes: +usedMinutes.toFixed(1),
    budgetMinutes,
    remainingMinutes: +Math.max(0, budgetMinutes - usedMinutes).toFixed(1),
    exhausted: usedMinutes >= budgetMinutes,
  };
}

/* ── sessions ───────────────────────────────────────────────────────────── */

export type VoiceSession = {
  id: string;
  token: string;
  expiresAt: number;
  agentId: string;
};

/** How long the callback token is good for. Long enough for a conversation, short enough to be useless later. */
const TOKEN_TTL_MS = 2 * 3600_000;

/**
 * Open a session and mint the token the provider will hand back to us.
 *
 * The token is the ONLY thing about this member that leaves our infrastructure, and it carries no
 * meaning on its own: it is a random string that this table can turn into a user id, and nothing else.
 */
export async function openSession(userId: string, accountRowId: string | null, agentId: string): Promise<VoiceSession | null> {
  const c = db();
  if (!c) return null;

  // One live session per member. A second tab must not quietly start a second meter.
  await c.from("cc_voice_sessions")
    .update({ ended_at: new Date().toISOString(), end_reason: "superseded" })
    .eq("user_id", userId).is("ended_at", null);

  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const { data, error } = await c.from("cc_voice_sessions").insert({
    user_id: userId,
    account_row_id: accountRowId,
    token,
    token_expires_at: new Date(expiresAt).toISOString(),
    agent_id: agentId,
  }).select("id").single();
  if (error || !data) return null;

  return { id: (data as { id: string }).id, token, expiresAt, agentId };
}

/** Turn a callback token back into the member it belongs to. Expired tokens resolve to nothing. */
export async function resolveToken(token: string): Promise<{ userId: string; sessionId: string; accountRowId: string | null } | null> {
  const c = db();
  if (!c || !token) return null;
  const { data } = await c.from("cc_voice_sessions")
    .select("id, user_id, account_row_id, token_expires_at, ended_at")
    .eq("token", token).maybeSingle();
  if (!data) return null;
  const r = data as { id: string; user_id: string; account_row_id: string | null; token_expires_at: string; ended_at: string | null };
  if (Date.parse(r.token_expires_at) < Date.now()) return null;
  return { userId: r.user_id, sessionId: r.id, accountRowId: r.account_row_id };
}

/**
 * Record that the session is alive and how long it has run.
 *
 * Minutes are computed from the session's own start rather than accumulated per turn, so a dropped
 * heartbeat cannot double-count and a silent session still bills for the time it held the line open.
 */
export async function touch(sessionId: string, turns = 0): Promise<void> {
  const c = db();
  if (!c) return;
  const { data } = await c.from("cc_voice_sessions").select("started_at, turns").eq("id", sessionId).maybeSingle();
  if (!data) return;
  const r = data as { started_at: string; turns: number };
  const minutes = Math.ceil((Date.now() - Date.parse(r.started_at)) / 60_000);
  await c.from("cc_voice_sessions").update({
    last_seen_at: new Date().toISOString(),
    minutes,
    turns: (r.turns ?? 0) + turns,
  }).eq("id", sessionId);
}

export async function closeSession(userId: string, reason = "ended"): Promise<void> {
  const c = db();
  if (!c) return;
  const { data } = await c.from("cc_voice_sessions")
    .select("id, started_at").eq("user_id", userId).is("ended_at", null).maybeSingle();
  if (!data) return;
  const r = data as { id: string; started_at: string };
  await c.from("cc_voice_sessions").update({
    ended_at: new Date().toISOString(),
    end_reason: reason.slice(0, 80),
    minutes: Math.ceil((Date.now() - Date.parse(r.started_at)) / 60_000),
  }).eq("id", r.id);
}

/** Close sessions nobody is attending. Called from the worker, because a browser cannot be trusted to. */
export async function reapAbandoned(): Promise<number> {
  const c = db();
  if (!c) return 0;
  const staleBefore = new Date(Date.now() - STALE_SESSION_MS).toISOString();
  const tooOld = new Date(Date.now() - MAX_SESSION_MS).toISOString();
  const { data } = await c.from("cc_voice_sessions")
    .select("id, started_at, last_seen_at").is("ended_at", null)
    .or(`last_seen_at.lt.${staleBefore},started_at.lt.${tooOld}`);
  const rows = (data ?? []) as { id: string; started_at: string }[];
  for (const r of rows) {
    await c.from("cc_voice_sessions").update({
      ended_at: new Date().toISOString(),
      end_reason: "abandoned",
      minutes: Math.ceil((Date.now() - Date.parse(r.started_at)) / 60_000),
    }).eq("id", r.id);
  }
  return rows.length;
}

/* ── the provider ───────────────────────────────────────────────────────── */

const SIGNED_URL = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";

/**
 * Ask the provider for a signed WebSocket URL.
 *
 * Done SERVER-SIDE, always. The provider's own documentation is blunt about this and it is right: an API
 * key in a browser is an API key in everybody's browser. What the client receives is a URL with a
 * short-lived token in it and no key anywhere.
 */
export async function signedUrl(agentId: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, reason: "No speech key configured on the server." };
  try {
    const r = await fetch(`${SIGNED_URL}?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, reason: `The speech provider refused the session (${r.status}). ${body.slice(0, 160)}` };
    }
    const j = (await r.json()) as { signed_url?: string };
    if (!j.signed_url) return { ok: false, reason: "The speech provider did not return a session URL." };
    return { ok: true, url: j.signed_url };
  } catch (e) {
    return { ok: false, reason: `Could not reach the speech provider: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` };
  }
}
