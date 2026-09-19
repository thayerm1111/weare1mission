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
  const secret = process.env.CC_VOICE_LLM_SECRET;
  const missing: string[] = [];
  if (!key) missing.push("ELEVENLABS_API_KEY");
  if (!secret) missing.push("CC_VOICE_LLM_SECRET");
  if (missing.length) {
    return {
      ok: false,
      missing,
      reason: `Voice is not configured on the server (${missing.join(" and ")} not set). The text console still works.`,
    };
  }
  /*
   * The AGENT is deliberately not an environment variable.
   *
   * Requiring one would mean a person has to go and create an agent in a dashboard, copy an identifier,
   * paste it into a settings page and redeploy — four manual steps to produce a value the server is
   * perfectly capable of producing itself. It is provisioned on first use instead, and the id is stored.
   */
  return { ok: true, provider: "elevenlabs", agentId: process.env.ELEVENLABS_AGENT_ID ?? "" };
}

/** Where the provider will call us back. Overridable, because a preview deploy is not production. */
export const callbackUrl = () =>
  `${(process.env.CC_PUBLIC_ORIGIN ?? "https://weare1mission.com").replace(/\/$/, "")}/api/command-center/voice/llm`;

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
  /*
   * A SESSION THAT IS OVER IS OVER.
   *
   * `ended_at` was read and never tested, which meant "End" did not end anything the provider could
   * still reach: the row was closed, the meter stopped, and the token kept resolving to this member's
   * account for the remaining two hours of its life. The same held for a session superseded by a
   * second window — the older one carried on reasoning about a live account nobody was watching.
   *
   * The token is the only thing about this member that leaves our infrastructure. Its lifetime must be
   * the session's lifetime, not a timer that happens to be running alongside it.
   */
  if (r.ended_at) return null;
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


/* ── provisioning the agent ─────────────────────────────────────────────── */

const API = "https://api.elevenlabs.io/v1";

/**
 * The agent's OWN prompt is deliberately almost empty.
 *
 * Every real instruction — who it is, what it can see, what it must never invent — arrives from our
 * reasoning endpoint on every single turn, together with the market snapshot and the position. Putting
 * a persona here as well would create a second, stale set of instructions that nobody maintains and
 * that quietly contradicts the first one the moment the real prompt changes.
 */
/**
 * The speech model.
 *
 * The provider rejects anything but turbo or flash v2 for an English agent — `eleven_turbo_v2_5` comes
 * back as a 400. Flash is the right one of the two here: it is the lower-latency model, and in a
 * conversation you can interrupt, latency is not a nicety. Overridable, because this is exactly the kind
 * of provider-side constraint that changes without warning.
 */
const TTS_MODEL = process.env.CC_VOICE_TTS_MODEL ?? "eleven_flash_v2";

/**
 * THE CONFIGURATION VERSION.
 *
 * Every provider-side setting this file sends is something that, when wrong, produces silence rather
 * than an error — a 404 nobody sees, a rejected override, a model name that is not allowed. An agent
 * created under an older understanding of that surface is not repaired by a deploy, because the agent
 * lives in their workspace, not in ours. So the shape has a version, it is stored beside the agent id,
 * and a change here re-applies the whole configuration on the next session instead of waiting for
 * somebody to remember.
 */
const AGENT_CONFIG_VERSION = 2;

const AGENT_PROMPT = [
  "You are a relay. Do not answer from your own knowledge.",
  "Every turn, the server you are configured to call returns the complete, authoritative answer,",
  "built from live market data and the trader's actual account. Speak what it returns.",
  "Never invent a price, a level, a position or a number.",
].join(" ");

export type Provisioned = { ok: true; agentId: string; created: boolean } | { ok: false; reason: string };

/**
 * Find the agent, or make one.
 *
 * Idempotent and cheap: the stored id is reused for the life of the workspace, and re-provisioning only
 * happens when the callback URL changes — which is the one change that would otherwise leave an agent
 * quietly pointed at an endpoint that has moved.
 */
export async function ensureAgent(): Promise<Provisioned> {
  const fromEnv = process.env.ELEVENLABS_AGENT_ID;
  if (fromEnv) return { ok: true, agentId: fromEnv, created: false };

  const c = db();
  const url = callbackUrl();

  if (c) {
    const { data } = await c.from("cc_voice_provider").select("*").eq("provider", "elevenlabs").maybeSingle();
    const row = data as { agent_id: string; callback_url: string | null; config_version?: number } | null;
    if (row?.agent_id && row.callback_url === url && (row.config_version ?? 0) === AGENT_CONFIG_VERSION) {
      return { ok: true, agentId: row.agent_id, created: false };
    }
  }

  return provisionAgent();
}

/**
 * Create the workspace secret and the agent, in that order.
 *
 * On failure this returns the provider's OWN error text rather than a friendly summary of it. The
 * custom-LLM request shape is not fully published, so if it is wrong the exact complaint is the single
 * most useful thing that can appear on the screen — a generic "could not configure voice" would leave
 * nobody any way to tell what to change.
 */
export async function provisionAgent(): Promise<Provisioned> {
  const key = process.env.ELEVENLABS_API_KEY;
  const callbackSecret = process.env.CC_VOICE_LLM_SECRET;
  if (!key || !callbackSecret) return { ok: false, reason: "Speech credentials are not configured on the server." };

  const url = callbackUrl();
  const headers = { "xi-api-key": key, "content-type": "application/json" };

  try {
    /*
     * 1 — a secret the agent presents to us, so our reasoning endpoint is not an open door.
     *
     * REUSED, not re-minted. The first version created a fresh secret on every attempt, so each failed
     * provisioning left an orphan behind in the workspace — three tries, three dead secrets nobody would
     * ever clean up. The id is stored the moment it exists, BEFORE the agent call that might fail.
     */
    const c0 = db();
    let secretId: string | null = null;
    if (c0) {
      const { data } = await c0.from("cc_voice_provider").select("secret_id").eq("provider", "elevenlabs").maybeSingle();
      secretId = (data as { secret_id?: string } | null)?.secret_id ?? null;
    }

    if (!secretId) {
      const secretRes = await fetch(`${API}/convai/secrets`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "new", name: "CC_BRAIN_CALLBACK", value: callbackSecret }),
      });
      if (secretRes.ok) {
        const j = (await secretRes.json()) as { secret_id?: string };
        secretId = j.secret_id ?? null;
        if (c0 && secretId) {
          await c0.from("cc_voice_provider").upsert({
            provider: "elevenlabs", agent_id: "", secret_id: secretId,
            callback_url: url, updated_at: new Date().toISOString(),
          });
        }
      } else {
        const body = await secretRes.text().catch(() => "");
        return { ok: false, reason: `Could not store the callback secret with the speech provider (${secretRes.status}). ${body.slice(0, 300)}` };
      }
    }

    // 2 — the agent itself, pointed at THE BRAIN.
    const body = {
      name: "COMMAND CENTER XAUUSD — THE BRAIN",
      conversation_config: {
        agent: {
          first_message: "",
          language: "en",
          prompt: {
            prompt: AGENT_PROMPT,
            llm: "custom-llm",
            temperature: 0.3,
            max_tokens: -1,
            tools: [],
            custom_llm: {
              url,
              model_id: "command-center-xauusd",
              api_key: { secret_id: secretId },
            },
          },
        },
        asr: { quality: "high", user_input_audio_format: "pcm_16000" },
        tts: { model_id: TTS_MODEL, agent_output_audio_format: "pcm_16000" },
        turn: { turn_timeout: 10 },
        conversation: {
          max_duration_seconds: 1800,
          client_events: ["audio", "interruption", "user_transcript", "agent_response", "agent_response_correction"],
        },
      },
      /*
       * PERMISSION TO BE TOLD WHO IS TALKING.
       *
       * The session token is the only thing about the member that leaves our infrastructure, and it
       * travels as `custom_llm_extra_body` — the single field the provider forwards to our reasoning
       * endpoint. An agent refuses that field unless it has been configured to accept it, and the
       * refusal is not a message on the socket: it is a close frame mid-sentence. Everything else here
       * stays off. This is permission to carry one opaque token, not permission to rewrite the agent
       * from a browser.
       */
      platform_settings: {
        overrides: { custom_llm_extra_body: true },
      },
    };

    /*
     * UPDATE IN PLACE WHEN WE ALREADY HAVE ONE.
     *
     * Re-provisioning used to mean a brand new agent, which left the old one behind in the workspace
     * still answering to any signed URL minted before the switch. An agent is a long-lived object with
     * an id other things remember; only its configuration is ours to change.
     */
    const existing = c0
      ? ((await c0.from("cc_voice_provider").select("agent_id").eq("provider", "elevenlabs").maybeSingle())
          .data as { agent_id?: string } | null)?.agent_id || null
      : null;

    const res = existing
      ? await fetch(`${API}/convai/agents/${existing}`, { method: "PATCH", headers, body: JSON.stringify(body) })
      : await fetch(`${API}/convai/agents/create`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const reason = `The speech provider refused the agent (${res.status}). ${text.slice(0, 500)}`;
      const c = db();
      if (c) {
        await c.from("cc_voice_provider").upsert({
          provider: "elevenlabs", agent_id: existing ?? "", secret_id: secretId,
          callback_url: url, last_error: reason.slice(0, 900), updated_at: new Date().toISOString(),
        });
      }
      return { ok: false, reason };
    }

    const j = (await res.json()) as { agent_id?: string };
    const agentId = j.agent_id || existing;
    if (!agentId) return { ok: false, reason: "The speech provider created an agent but returned no identifier." };

    const c = db();
    if (c) {
      await c.from("cc_voice_provider").upsert({
        provider: "elevenlabs",
        agent_id: agentId,
        secret_id: secretId,
        callback_url: url,
        config_version: AGENT_CONFIG_VERSION,
        last_error: null,
        updated_at: new Date().toISOString(),
      });
    }
    return { ok: true, agentId, created: !existing };
  } catch (e) {
    return { ok: false, reason: `Could not reach the speech provider: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}` };
  }
}
