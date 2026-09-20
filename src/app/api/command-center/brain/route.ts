import { createClient } from "@/lib/supabase/server";
import { liveMemory } from "../../../../../command-center/engines/live";
import { BRAIN_SYSTEM, contextPacket, setupSummaryLines, tradeSummaryLines } from "../../../../../command-center/brain/context";
import { findSetup } from "../../../../../command-center/engines/setup";
import { getProfile, asSetupProfile } from "../../../../../command-center/engines/profile";
import { marketOpen } from "../../../../../command-center/core/sessions";
import { classify } from "../../../../../command-center/brain/language";
import { lookBack, retrospectiveLines, isRetrospective } from "../../../../../command-center/engines/history";
import { GOLD_KNOWLEDGE, wantsDomainKnowledge } from "../../../../../command-center/brain/gold";
import { PRODUCT_MAP, asksHowTo, howToTarget } from "../../../../../command-center/brain/howto";
import { upcoming, calendarLines } from "../../../../../command-center/adapters/calendar";
import { recordCall, extractClaim, trackRecord, trackRecordLines } from "../../../../../command-center/engines/record";
import { accountLines, asksAboutAccount, type AccountFacts } from "../../../../../command-center/brain/account";
import { parseWatch, arm, armedFor, cancelAll } from "../../../../../command-center/engines/watch";
import { selectedAccount } from "../../../../../command-center/engines/broker";
import { tradeState } from "../../../../../command-center/engines/tradeLive";
import { answer as narrate, scenarioOf, marketRead } from "../../../../../command-center/brain/language";
import { saveStatement } from "../../../../../command-center/adapters/db";
import type { BrainResponse, UiAction, UiActionName } from "../../../../../command-center/brain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * TALK TO THE BRAIN.
 *
 * The conversation is always grounded: the latest MarketSnapshot, what changed, what THE BRAIN has
 * already said and what it currently believes are attached to every single turn. The user never has to
 * tell it the price of gold.
 *
 * Two engines, and which one answered is always disclosed in `source`:
 *   • the language model, when one is configured — it INTERPRETS the measured state;
 *   • the deterministic narrator otherwise — plainer, but built from exactly the same state.
 * Neither is allowed to invent a number. The model is told, in its system prompt, that it cannot see a
 * chart and must not fabricate a level, and the narrator structurally cannot.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The ONLY UI actions THE BRAIN may take. Anything it emits outside this list is discarded silently. */
const ALLOWED: UiActionName[] = [
  "FOCUS_TIMEFRAME", "FOCUS_PRICE_RANGE", "SHOW_LEVEL", "SHOW_SESSION",
  "SHOW_SCENARIO", "SHOW_EVENT", "SHOW_TRADE", "SHOW_METRICS", "MARK_CHART",
  // Navigation: a member who asks where a setting is gets taken there, not just told.
  "OPEN_SETTINGS", "OPEN_BROKER",
];

/**
 * Parse the model's UI requests from a strict trailing syntax and validate every one against the
 * whitelist. The model never gets arbitrary control of the page — it gets a vocabulary.
 */
function extractActions(text: string): { clean: string; actions: UiAction[] } {
  const actions: UiAction[] = [];
  const clean = text.replace(/\[\[UI:\s*([A-Z_]+)(?:\s+([^\]]+))?\]\]/g, (_m, name: string, arg?: string) => {
    const n = name.trim() as UiActionName;
    if (ALLOWED.includes(n)) {
      const raw = (arg ?? "").trim();
      const num = Number(raw);
      actions.push({ name: n, arg: raw === "" ? null : Number.isFinite(num) ? num : raw });
    }
    return "";
  }).replace(/\s{2,}/g, " ").trim();
  return { clean, actions: actions.slice(0, 3) };
}

const UI_INSTRUCTIONS = `
If the user asks you to show or focus something on the screen, end your reply with at most one marker on its own, using exactly this syntax and nothing else:
[[UI: SHOW_LEVEL 4387.20]] or [[UI: FOCUS_TIMEFRAME 15m]] or [[UI: SHOW_SCENARIO bull]] or [[UI: SHOW_METRICS]] or [[UI: SHOW_TRADE]] or [[UI: OPEN_SETTINGS]] or [[UI: OPEN_BROKER]]
Only use a marker when the user actually asked to see something. Never explain the marker.`;

type Turn = { role: "user" | "assistant"; content: string };

/** One sentence, wrapped in the response shape the client expects. */
const fallbackShape = (text: string): BrainResponse => ({
  spokenText: text, shortSummary: text.slice(0, 80), marketRead: text,
  changes: [], focus: [], watchedLevels: [], scenario: null, tradeRead: null,
  uiActions: [], urgency: "normal", voiceEligible: true, source: "narrator",
});

export async function POST(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { message?: string; history?: Turn[]; spoken?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const message = (body.message ?? "").toString().trim().slice(0, 2000);
  if (!message) return json({ error: "empty" }, 400);

  const memory = await liveMemory();
  // The open position travels with EVERY turn, so "how's my trade?" is answered from the actual trade
  // and the member never has to tell THE BRAIN what they are in.
  const trade = await tradeState(user.id, memory.now);
  const tradeSummary = trade.active ? tradeSummaryLines(trade) : null;

  // THE TRADE THE BRAIN CURRENTLY WANTS travels with every turn as well, computed by the same engine the
  // screen and the executor use. "Find me a trade" is then a question the conversation can only REPORT
  // the answer to — it has no path to improvising an entry, a stop or a target of its own.
  const profile = await getProfile(user.id);
  const setup = findSetup({
    snapshot: memory.now,
    diffs: memory.diffs,
    profile: asSetupProfile(profile),
    marketOpen: marketOpen(Date.now()),
    thesisBias: memory.thesis?.bias ?? null,
    thesisConfidence: memory.thesis?.confidence ?? null,
  });
  const setupSummary = setupSummaryLines(setup);

  // No market read at all is not a conversation topic to improvise around — say so and stop.
  if (!memory.now) {
    const r: BrainResponse = {
      spokenText: "I can't see the market right now — there's no live read coming through. I'd rather tell you that than make something up.",
      shortSummary: "No market data", marketRead: "No market data", changes: [], focus: [], watchedLevels: [],
      scenario: null, tradeRead: null, uiActions: [], urgency: "normal", voiceEligible: true, source: "narrator",
    };
    return json(r);
  }

  /*
   * MONITORING INSTRUCTIONS ARE HANDLED BEFORE THE MODEL SEES THE TURN.
   *
   * "Watch the London high and tell me if the retest fails" is an instruction, not a conversation. It is
   * parsed, written to the database, and only then confirmed — and if the write fails the member is told
   * it failed. Routing it through the model first would mean the model could agree to watch something
   * that was never registered, which is the exact failure this design exists to prevent.
   */
  const intent = classify(message).intent;

  if (intent === "unwatch") {
    const n = await cancelAll(user.id);
    const text = n
      ? `Cleared ${n} thing${n === 1 ? "" : "s"} I was watching for you.`
      : "I wasn't watching anything for you.";
    return json({ ...fallbackShape(text), uiActions: [] });
  }

  // Same guard as the spoken path: "let me know if I should lower my risk" is a question about the
  // account, not a request to monitor a price level, and arming one would write down a promise the
  // member never made.
  if (intent === "watch" && !asksAboutAccount(message)) {
    const parsed = parseWatch(message, memory.now);
    if (!parsed) {
      return json(fallbackShape("I couldn't tell which level you meant. Give me a price, or name it — the London high, yesterday's low, today's high."));
    }
    const account = await selectedAccount(user.id);
    const watch = await arm({
      userId: user.id,
      said: message,
      parsed,
      accountRowId: account?.id ?? null,
      positionId: trade.active ? trade.positionId : null,
      // A spoken request only ever creates an INFORMATIONAL watch. Turning a watch into something that
      // can act is a separate, authenticated decision — conversation must never widen authority.
      authority: "informational",
    });
    if (!watch) {
      return json(fallbackShape("I could not register that, so I'm not going to tell you I'm watching it. Try again in a moment."));
    }
    const armed = await armedFor(user.id);
    return json({
      ...fallbackShape(`${parsed.confirm} It's registered, so it survives you closing this${armed.length > 1 ? `. That's ${armed.length} things I'm watching now` : ""}.`),
      uiActions: parsed.levelPrice != null ? [{ name: "SHOW_LEVEL", arg: parsed.levelPrice }] : [],
    });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  const fallback = narrate(message, memory, { setup });

  if (!key) {
    // Honest degradation: the narrator is real, grounded output — not a stub pretending to be a model.
    if (trade.active && trade.read && /trade|position|protect|partial|break even|drawdown|how.?s my/i.test(message)) {
      const r = { ...fallback, spokenText: trade.read, tradeRead: trade.read };
      await saveStatement({ at: Date.now(), kind: "answer", text: trade.read, channel: "text", priceAt: memory.now.price, thesisId: memory.thesis?.id ?? null });
      return json({ ...r, notice: "Conversational model not configured — this is THE BRAIN's deterministic voice." });
    }
    await saveStatement({ at: Date.now(), kind: "answer", text: fallback.spokenText, channel: "text", priceAt: memory.now.price, thesisId: memory.thesis?.id ?? null });
    return json({ ...fallback, notice: "Conversational model not configured — this is THE BRAIN's deterministic voice." });
  }

  const packet = contextPacket(memory, { tradeSummary, setupSummary });

  /*
   * THE SAME TWO EXTRA SOURCES THE SPOKEN PATH GETS.
   *
   * The typed console and the voice line are two surfaces onto one intelligence, so a question about
   * last week must not be answerable in one and refused in the other. Both are attached only when the
   * question earned them: a retrospective costs a market-data call, and the background packet costs
   * tokens on every turn that does not need it.
   */
  const [past, background, calendar, record, acct] = await Promise.all([
    isRetrospective(message) ? lookBack(message) : Promise.resolve(null),
    Promise.resolve(wantsDomainKnowledge(message)),
    upcoming().catch(() => null),
    trackRecord().catch(() => null),
    selectedAccount(user.id).catch(() => null),
  ]);

  // The account rides along on every turn, for the same reason it does on the spoken path: "is this
  // worth taking" is a question about their balance and their risk rule, not only about the chart.
  const accountFacts: AccountFacts | null = acct ? {
    connected: true, name: acct.name, isLive: acct.is_live, currency: acct.currency,
    balance: acct.balance, equity: acct.equity, openPl: acct.open_pl,
    marginAvailable: acct.margin_available, stateAt: acct.state_at,
    autoTrading: acct.auto_trading, liveAuthorized: !!acct.live_authorized_at,
    permissions: acct.permissions ?? {}, instrumentReady: !!acct.instrument_id,
  } : null;
  const extra = [
    `\n\n${accountLines(accountFacts, profile).join("\n")}`,
    calendar ? `\n\n${calendarLines(calendar).join("\n")}` : "",
    past ? `\n\n${retrospectiveLines(past).join("\n")}` : "",
    record ? `\n\n${trackRecordLines(record).join("\n")}` : "",
    background ? `\n\n${GOLD_KNOWLEDGE}` : "",
    // Where a control lives owes nothing to the market. A member asking how to use the product gets
    // the map, on any turn, open or closed.
    asksHowTo(message) ? `\n\n${PRODUCT_MAP}` : "",
  ].join("");

  const history = (body.history ?? []).slice(-8).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string");
  const messages = [
    ...history.map((t) => ({ role: t.role, content: t.content.slice(0, 1500) })),
    { role: "user" as const, content: `CONTEXT — everything you can see right now:\n\n${packet}${extra}\n\n----\nThe trader says: ${message}` },
  ];

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: `${BRAIN_SYSTEM}\n${UI_INSTRUCTIONS}`,
        messages,
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      return json({ ...fallback, notice: "THE BRAIN's language model is unavailable — this is its deterministic voice." });
    }
    const text: string = Array.isArray(j?.content)
      ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("").trim()
      : "";
    if (!text) return json({ ...fallback, notice: "Empty reply from the model — falling back to the deterministic voice." });

    const { clean, actions } = extractActions(text);
    const response: BrainResponse = {
      spokenText: clean,
      shortSummary: memory.state?.headline ?? marketRead(memory),
      marketRead: marketRead(memory),
      changes: fallback.changes,
      focus: memory.state?.focus ?? [],
      watchedLevels: memory.watchedLevels.map((l) => l.price),
      scenario: scenarioOf(memory),
      tradeRead: trade.active ? trade.read : null,
      uiActions: actions.length ? actions : fallback.uiActions,
      urgency: fallback.urgency,
      voiceEligible: true,
      source: "llm",
    };
    // Its own words go into memory, so five minutes from now it knows what it already told you.
    await saveStatement({ at: Date.now(), kind: "answer", text: clean, channel: "text", priceAt: memory.now.price, thesisId: memory.thesis?.id ?? null });
    /*
     * And into the journal, where it will be scored.
     *
     * Not awaited: an answer must not wait on bookkeeping. `extractClaim` records `none` for most
     * answers, which is correct — a system that invents a position it never took so it can score a
     * win is worse than one with no record at all.
     */
    const claim = extractClaim(clean);
    void recordCall({
      userId: user.id, channel: "text", question: message, answer: clean,
      priceAt: memory.now.price, snapshotId: null,
      direction: claim.direction, horizonMin: claim.horizonMin,
      regime: memory.now.regime ?? null, sessionName: memory.now.session ?? null,
      thesisId: memory.thesis?.id ?? null, setupState: setup?.state ?? null,
    });
    return json(response);
  } catch {
    return json({ ...fallback, notice: "THE BRAIN's language model could not be reached — this is its deterministic voice." });
  }
}
