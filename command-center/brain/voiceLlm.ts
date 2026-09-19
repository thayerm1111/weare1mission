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
import { lookBack, retrospectiveLines, isRetrospective } from "../engines/history";
import { GOLD_KNOWLEDGE, wantsDomainKnowledge } from "./gold";
import { upcoming, calendarLines } from "../adapters/calendar";
import { recordCall, extractClaim, trackRecord, trackRecordLines } from "../engines/record";


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

/**
 * Answer from a context packet, streaming.
 *
 * Extracted so the no-live-market path is a REAL answer rather than a second-class apology. History
 * and background do not need a tick, and routing them through the same model call with the same rules
 * is what stops "gold is closed" from being the answer to every question asked at the weekend.
 *
 * `fallback` is what gets said if the model is unreachable — deliberately passed in, because the
 * deterministic narrator needs a live snapshot and there isn't one on that path.
 */
function streamAnswer(packet: string, question: string, fallback: string): Response {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return sse(async function* () { yield `data: ${JSON.stringify(delta(fallback))}\n\n`; });

  return sse(async function* () {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 400, stream: true,
        system: `${BRAIN_SYSTEM}\n${VOICE_RULES}`,
        messages: [{ role: "user", content: `CONTEXT — everything you can see right now:\n\n${packet}\n\n----\nThe trader says: ${question}` }],
      }),
    });
    if (!r.ok || !r.body) { yield `data: ${JSON.stringify(delta(fallback))}\n\n`; return; }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
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
            yield `data: ${JSON.stringify(delta(evt.delta.text.replace(/\[\[UI:[^\]]*\]\]/g, "")))}\n\n`;
          }
        } catch { /* a partial frame; the next read completes it */ }
      }
    }
  });
}

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

  /*
   * A DEAD MICROPHONE STILL PRODUCES TURNS.
   *
   * Speech recognition does not hand back an empty string for silence — it hands back "..." or "uh",
   * which is a turn, which gets a full market brief spoken back at somebody who never said anything.
   * It happened twice in a row on a silent input and cost real minutes both times. A turn containing
   * no letters and no digits is not a question, and answering it is worse than saying nothing.
   */
  const saidSomething = /[\p{L}\p{N}]/u.test(question);
  if (!question || !saidSomething) {
    return sse(async function* () {
      yield `data: ${JSON.stringify(delta(question ? "I didn't catch that." : "I'm here."))}\n\n`;
    });
  }

  /* ── the same context the screen is built from ───────────────────────── */

  const memory = await liveMemory();
  const [trade, profile, watches] = await Promise.all([
    tradeState(session.userId, memory.now),
    getProfile(session.userId),
    armedFor(session.userId),
  ]);

  /*
   * INSTRUCTIONS ARE HANDLED BEFORE THE MODEL, exactly as they are in the text console.
   *
   * "Watch the London high and tell me if the retest fails" must register a real backend task. If it
   * went through the model, the model could agree out loud to watch something nobody wrote down — and a
   * spoken promise is the easiest of all to believe and the hardest to check.
   */
  const intent = classify(question).intent;
  if (intent === "watch") {
    /*
     * HANDLED BEFORE ANY OTHER ROUTING, including the no-live-market answer below.
     *
     * "Watch the London high" is an instruction, and an instruction must reach the backend whatever
     * else the question might also look like. Left further down, a request to watch a level got
     * classified as a question about the London session and answered with background reading —
     * a promise the member would reasonably believe, and nothing written down anywhere.
     */
    const parsed = parseWatch(question, memory.now);
    const spoken = !parsed
      ? (memory.now
          ? "I couldn't tell which level you meant. Give me a price, or name it — the London high, yesterday's low."
          : "I can't arm that without a live read on the market — name an exact price and ask me again when gold reopens.")
      : (await arm({
          userId: session.userId, said: question, parsed,
          accountRowId: session.accountRowId, positionId: trade.active ? trade.positionId : null,
          authority: "informational",
        }))
        ? `${parsed.confirm} It's registered, so it survives you closing this.`
        : "I could not register that, so I'm not going to tell you I'm watching it.";
    return sse(async function* () { yield `data: ${JSON.stringify(delta(spoken))}\n\n`; });
  }

  /*
   * WHAT DOES THIS QUESTION ACTUALLY NEED?
   *
   * Everything used to be answered out of one live snapshot, so a closed market silenced the whole
   * system. Asked what gold did last week — a question about finished history that needs no tick at
   * all — it replied that the market was shut. Twice. That is not a limitation of the market; it is a
   * router that never asked what was being requested.
   *
   * Three sources, gathered independently: measured history for a question about the past, domain
   * knowledge for a question about mechanism, and the live snapshot for a question about now. A missing
   * live read removes only the third.
   */
  const [history, needsBackground, calendar, record] = await Promise.all([
    isRetrospective(question) ? lookBack(question) : Promise.resolve(null),
    Promise.resolve(wantsDomainKnowledge(question)),
    /*
     * The calendar is fetched whatever the question is, and it is cheap because it is cached for five
     * minutes. A release fifteen minutes away changes the answer to "should I take this" even when
     * nobody asked about news, and a system that only mentions the calendar when prompted will stay
     * silent through exactly the moment it mattered.
     */
    upcoming().catch(() => null),
    trackRecord().catch(() => null),
  ]);

  if (!memory.now && !history && !needsBackground) {
    /*
     * Nothing live, nothing historical, nothing conceptual — and only NOW is a refusal honest.
     *
     * A closed market is normal and is said as such; a feed missing during trading hours is not, and
     * is said plainly too. Neither invents a price to fill the gap.
     */
    const open = marketOpen(Date.now());
    const line = open
      ? "I can't see the market right now — the live read isn't coming through, and I won't guess at a price. Everything already running on the server is unaffected."
      : "Gold is closed right now, so there's nothing live to read. Ask me about last week, or about what moves gold, and I can still help.";
    return sse(async function* () {
      yield `data: ${JSON.stringify(delta(line))}\n\n`;
    });
  }

  if (!memory.now) {
    /*
     * THE INTERESTING CASE: no live market, but a real answer available anyway.
     *
     * History and mechanism do not need a tick. What they do need is for the absence of a live read to
     * be stated rather than papered over, so that nothing measured last Tuesday is mistaken for a
     * quote from this second.
     */
    const open = marketOpen(Date.now());
    const preamble = open
      ? "The live feed isn't reaching me at the moment, so nothing below is a current price."
      : "Gold is closed right now, so nothing below is a current price.";
    return streamAnswer([
      preamble,
      ...(history ? retrospectiveLines(history) : []),
      ...(calendar ? ["", ...calendarLines(calendar)] : []),
      ...(needsBackground ? ["", GOLD_KNOWLEDGE] : []),
    ].join("\n"), question, preamble);
  }

  const setup = findSetup({
    snapshot: memory.now,
    diffs: memory.diffs,
    profile: asSetupProfile(profile),
    marketOpen: marketOpen(Date.now()),
    thesisBias: memory.thesis?.bias ?? null,
    thesisConfidence: memory.thesis?.confidence ?? null,
  });


  const packet = contextPacket(memory, {
    tradeSummary: trade.active ? tradeSummaryLines(trade) : null,
    setupSummary: setupSummaryLines(setup),
  });

  const watchLines = watches.length
    ? `\n\n=== WHAT THEY ASKED YOU TO WATCH (still armed) ===\n${watches.map((w) => `- ${w.said} (${w.kind}${w.levelPrice != null ? ` at ${w.levelPrice.toFixed(2)}` : ""})`).join("\n")}`
    : "";

  /*
   * HISTORY AND BACKGROUND RIDE ALONG WHEN THE QUESTION EARNED THEM.
   *
   * Both are attached here rather than folded into the snapshot, because they are a different KIND of
   * fact and the difference has to survive into the prompt. The measured window is arithmetic over real
   * bars and may be quoted precisely. The background is mechanism, and may never be used to explain
   * what is happening right now. A packet that mixed them would invite exactly the confident narration
   * this system exists to prevent.
   */
  const pastLines = history ? `\n\n${retrospectiveLines(history).join("\n")}` : "";
  const backgroundLines = needsBackground ? `\n\n${GOLD_KNOWLEDGE}` : "";
  const calendarBlock = calendar ? `\n\n${calendarLines(calendar).join("\n")}` : "";
  /*
   * ITS OWN RECORD, handed back as measured fact.
   *
   * This is the whole of what "learning" honestly means here: no weights change, but the evidence
   * about itself does. A read it has got wrong three times this month is a read it should hesitate
   * over, and it can only hesitate if somebody wrote the three times down.
   */
  const recordBlock = record ? `\n\n${trackRecordLines(record).join("\n")}` : "";

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // The deterministic narrator is real, grounded output — not a stub pretending to be a model.
    const fallback = narrate(question, memory, { setup });
    const spoken = trade.active && trade.read && /trade|position|protect|partial|break even|how.?s/i.test(question)
      ? trade.read
      : fallback.spokenText;
    return sse(async function* () { yield `data: ${JSON.stringify(delta(speakable(spoken)))}\n\n`; });
  }

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
          { role: "user", content: `CONTEXT — everything you can see right now:\n\n${packet}${watchLines}${calendarBlock}${pastLines}${recordBlock}${backgroundLines}\n\n----\nThe trader says: ${question}` },
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
    /*
     * THE ANSWER IS KEPT AS IT STREAMS, so it can be written to the journal once it is complete.
     *
     * Accumulated here rather than reconstructed afterwards because this is the only place the whole
     * answer exists — the provider gets it in pieces and never gives it back.
     */
    let spokenSoFar = "";
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
            const clean = evt.delta.text.replace(/\[\[UI:[^\]]*\]\]/g, "");
            spokenSoFar += clean;
            if (speakable(evt.delta.text)) yield `data: ${JSON.stringify(delta(clean))}\n\n`;
          }
        } catch { /* a partial frame; the next read completes it */ }
      }
    }

    /*
     * WRITTEN DOWN AFTER IT WAS SAID, never before.
     *
     * A claim recorded before the answer finished streaming could be a claim the answer went on to
     * withdraw, and the journal has to record what was actually said out loud. Not awaited: the
     * conversation is over by this point and a slow insert must not hold the socket open.
     */
    const claim = extractClaim(spokenSoFar);
    void recordCall({
      userId: session.userId, channel: "voice", question, answer: spokenSoFar,
      priceAt: memory.now?.price ?? null, snapshotId: null,
      direction: claim.direction, horizonMin: claim.horizonMin,
      regime: memory.now?.regime ?? null, sessionName: memory.now?.session ?? null,
      thesisId: memory.thesis?.id ?? null, setupState: setup?.state ?? null,
    });
  });
}
