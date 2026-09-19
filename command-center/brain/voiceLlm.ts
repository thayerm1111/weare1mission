import { liveMemory } from "../engines/live";
import { tradeState } from "../engines/tradeLive";
import { BRAIN_SYSTEM, contextPacket, setupSummaryLines, tradeSummaryLines } from "./context";
import { findSetup } from "../engines/setup";
import { getProfile, asSetupProfile } from "../engines/profile";
import { marketOpen } from "../core/sessions";
import { answer as narrate } from "./language";
import { armedFor, parseWatch, arm } from "../engines/watch";
import { resolveToken, touch } from "../engines/voice";
import { classify } from "./language";


/**
 * THE REASONING ENDPOINT THE SPEECH PROVIDER CALLS.
 *
 * This is the file that keeps the architecture honest. A hosted voice-agent product would very happily
 * supply its own model, and then the thing talking to a member about their open gold position would be a
 * general-purpose assistant that has never seen a snapshot, cannot read the account, and will invent a
 * level if asked for one. That is not an acceptable voice for a system that can send live orders.
 *
 * So the provider is configured to call HERE for every turn. The shape is OpenAI's chat-completions SSE,
 * because that is the only dialect it speaks — but behind that shape is the same BRAIN the screen uses:
 * the same market snapshot, the same setup engine, the same position, the same monitoring instructions.
 * Speech in, speech out; the thinking never leaves this system.
 *
 * WHO IS TALKING? The request arrives from the provider's servers with no cookie on it. The session
 * token minted when the line was opened travels with the conversation and comes back here, and that —
 * not a voice, not a name — is what identifies the account. A familiar-sounding voice is not
 * authentication and is never treated as any.
 */

/*
 * WHY THIS IS A MODULE AND NOT A ROUTE.
 *
 * The provider treats the configured custom-LLM URL as an OpenAI BASE url and appends
 * `/chat/completions` to it before calling. Configured at `.../voice/llm`, every single turn was
 * therefore a POST to `.../voice/llm/chat/completions` — a 404, answered by nothing, which at the
 * microphone is indistinguishable from an agent that simply never speaks. Twenty-two seconds of
 * silence and not one error anywhere.
 *
 * So the handler lives here and two routes mount it: the base path, which is what a human tests by
 * hand, and the OpenAI path, which is what the provider actually calls.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type ChatMessage = { role: string; content: unknown };
type ChatRequest = {
  messages?: ChatMessage[];
  model?: string;
  user_id?: string;
  user?: string;
  elevenlabs_extra_body?: Record<string, unknown>;
  extra_body?: Record<string, unknown>;
  voice_token?: string;
  stream?: boolean;
};

/** Server-sent events, the only response shape the provider understands. */
function sse(chunks: () => AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const c of chunks()) controller.enqueue(encoder.encode(c));
      } catch {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta("I lost my footing there. Say that again."))}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  });
}

const delta = (text: string) => ({
  id: "cc", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
  model: "command-center-xauusd",
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});

/** Words out loud are not words on a screen: markers and markdown are stripped before speaking. */
const speakable = (t: string) =>
  t.replace(/\[\[UI:[^\]]*\]\]/g, "").replace(/[*_`#]/g, "").replace(/\s{2,}/g, " ").trim();

const textOf = (c: unknown): string =>
  typeof c === "string" ? c
  : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ")
  : "";

export async function handleVoiceLlm(req: Request) {
  // The provider authenticates with a shared secret it holds as its "API key". Without it, this endpoint
  // is a public door into a member's account context.
  const secret = process.env.CC_VOICE_LLM_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  let body: ChatRequest;
  try { body = (await req.json()) as ChatRequest; } catch { body = {}; }

  const messages = (body.messages ?? []).filter((m) => m && (m.role === "user" || m.role === "assistant"));
  const last = [...messages].reverse().find((m) => m.role === "user");
  const question = speakable(textOf(last?.content)).slice(0, 2000);

  /*
   * WHERE THE TOKEN COMES FROM.
   *
   * `elevenlabs_extra_body` is the documented one — what the client sends as `custom_llm_extra_body`
   * arrives here under that name. The rest are cheap insurance: this is a provider-shaped payload whose
   * shape is not fully published, and the failure mode of losing the token is not an error message but
   * THE BRAIN politely declining to discuss the member's own position, which reads like a bug in the
   * reasoning rather than a missing field.
   */
  const extra = { ...(body.extra_body ?? {}), ...(body.elevenlabs_extra_body ?? {}) };
  const token = String(
    extra.voice_token ?? extra.voiceToken ?? body.voice_token ?? body.user_id ?? body.user ?? "",
  );
  const session = await resolveToken(token);

  if (!session) {
    return sse(async function* () {
      yield `data: ${JSON.stringify(delta("I can't tell which account this session belongs to, so I'm not going to answer questions about a position. Start the session again from the Command Center."))}\n\n`;
    });
  }

  void touch(session.sessionId, 1);

  if (!question) {
    return sse(async function* () {
      yield `data: ${JSON.stringify(delta("I'm here."))}\n\n`;
    });
  }

  /* ── the same context the screen is built from ───────────────────────── */

  const memory = await liveMemory();
  const [trade, profile, watches] = await Promise.all([
    tradeState(session.userId, memory.now),
    getProfile(session.userId),
    armedFor(session.userId),
  ]);

  if (!memory.now) {
    /*
     * NO SNAPSHOT HAS TWO CAUSES AND THEY ARE NOT THE SAME SENTENCE.
     *
     * Gold is shut most of the weekend; saying "there's no live read coming through" then describes a
     * closed market as a broken one, and the person hearing it goes looking for a fault that does not
     * exist. A closed market is normal and is said as such. A missing feed during trading hours is not,
     * and is said plainly too — in both cases without inventing a price to fill the gap.
     */
    const open = marketOpen(Date.now());
    const line = open
      ? "I can't see the market right now — the live read isn't coming through, and I won't guess at a price. Everything already running on the server is unaffected."
      : "Gold is closed right now, so there's nothing live to read. I'll pick it up when the market reopens.";
    return sse(async function* () {
      yield `data: ${JSON.stringify(delta(line))}\n\n`;
    });
  }

  const setup = findSetup({
    snapshot: memory.now,
    diffs: memory.diffs,
    profile: asSetupProfile(profile),
    marketOpen: marketOpen(Date.now()),
    thesisBias: memory.thesis?.bias ?? null,
    thesisConfidence: memory.thesis?.confidence ?? null,
  });

  /*
   * INSTRUCTIONS ARE HANDLED BEFORE THE MODEL, exactly as they are in the text console.
   *
   * "Watch the London high and tell me if the retest fails" must register a real backend task. If it
   * went through the model, the model could agree out loud to watch something nobody wrote down — and a
   * spoken promise is the easiest of all to believe and the hardest to check.
   */
  const intent = classify(question).intent;
  if (intent === "watch") {
    const parsed = parseWatch(question, memory.now);
    const spoken = !parsed
      ? "I couldn't tell which level you meant. Give me a price, or name it — the London high, yesterday's low."
      : (await arm({
          userId: session.userId, said: question, parsed,
          accountRowId: session.accountRowId, positionId: trade.active ? trade.positionId : null,
          authority: "informational",
        }))
        ? `${parsed.confirm} It's registered, so it survives you closing this.`
        : "I could not register that, so I'm not going to tell you I'm watching it.";
    return sse(async function* () { yield `data: ${JSON.stringify(delta(spoken))}\n\n`; });
  }

  const packet = contextPacket(memory, {
    tradeSummary: trade.active ? tradeSummaryLines(trade) : null,
    setupSummary: setupSummaryLines(setup),
  });

  const watchLines = watches.length
    ? `\n\n=== WHAT THEY ASKED YOU TO WATCH (still armed) ===\n${watches.map((w) => `- ${w.said} (${w.kind}${w.levelPrice != null ? ` at ${w.levelPrice.toFixed(2)}` : ""})`).join("\n")}`
    : "";

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // The deterministic narrator is real, grounded output — not a stub pretending to be a model.
    const fallback = narrate(question, memory, { setup });
    const spoken = trade.active && trade.read && /trade|position|protect|partial|break even|how.?s/i.test(question)
      ? trade.read
      : fallback.spokenText;
    return sse(async function* () { yield `data: ${JSON.stringify(delta(speakable(spoken)))}\n\n`; });
  }

  /*
   * SPOKEN ANSWERS ARE SHORT. A written answer can afford a list; a spoken one that reads a dashboard
   * aloud is unbearable, and a member will stop the session rather than sit through it.
   */
  const VOICE_RULES = `
You are speaking OUT LOUD to a trader who can see the screen. Rules for this channel:
- Two or three sentences by default. Expand only when asked to.
- Never read a dashboard aloud. Never list more than three things.
- Say numbers the way a person says them: "forty-two eighty-three", not "4283.00".
- No markdown, no bullet points, no UI markers — every character is spoken.
- If they interrupt, answer the new question and drop the old one.`;

  return sse(async function* () {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        stream: true,
        system: `${BRAIN_SYSTEM}\n${VOICE_RULES}`,
        messages: [
          ...messages.slice(-6).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: speakable(textOf(m.content)).slice(0, 1200) || "..." })),
          { role: "user", content: `CONTEXT — everything you can see right now:\n\n${packet}${watchLines}\n\n----\nThe trader says: ${question}` },
        ],
      }),
    });

    if (!r.ok || !r.body) {
      const fallback = narrate(question, memory, { setup });
      yield `data: ${JSON.stringify(delta(speakable(fallback.spokenText)))}\n\n`;
      return;
    }

    // Re-stream Claude's tokens as OpenAI-shaped chunks so the provider starts speaking immediately
    // rather than waiting for a complete answer.
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: { type?: string; text?: string } };
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
            const t = speakable(evt.delta.text);
            if (t) yield `data: ${JSON.stringify(delta(evt.delta.text.replace(/\[\[UI:[^\]]*\]\]/g, "")))}\n\n`;
          }
        } catch { /* a partial frame; the next read completes it */ }
      }
    }
  });
}
