/**
 * ATLAS'S REPLY — the answer the console receives, from the model or, when there is none, from the read.
 *
 * The deterministic voice used to be a narrator that knew the thesis but not the shape of an answer. It
 * now answers from the READ — lean, evidence, what it is waiting for, what would make it wrong — in the
 * same contract the model fills, so the console renders one thing whichever engine spoke. Which engine
 * did is still disclosed (`source`).
 *
 * Pure: no I/O.
 */
import { LEAN_LABEL, levelIdOf, type AtlasRead, type ChartAction, type FeedState, type Scenario } from "../core/atlasContract";
import type { BrainResponse, PerceptionEvent, UiAction } from "./types";
import { ATLAS_PROMPT_VERSION } from "./prompt";
import {
  actionForRef, answerReadOf, chartActionsToUi, contradictsLean, dedupeActions, extractUiMarkers, itemsFromRead,
  markersToChartActions, parseAtlasReply, sentences, ungroundedPrices, validateAtlasAnswer, validateRef, withFreshnessCaveat,
  type AnswerContext, type AtlasAnswer, type AtlasChatMeta,
} from "./answer";
import type { AtlasIntent, FollowUp, SinceChanges } from "./conversation";

const TF_NAME: Record<string, string> = { "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
const period = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const lc = (s: string) => s.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

/** The intents an answer about the read serves. Everything else is a question about something else. */
export const READ_INTENTS = new Set<AtlasIntent["kind"]>(["lean", "why", "waiting", "breakout", "change_mind", "timeframe", "since_last", "scenarios", "levels"]);

/* ── the deterministic answer ──────────────────────────────────────────────────────────────────────── */

export type DeterministicInput = {
  message: string;
  intent: AtlasIntent;
  read: AtlasRead;
  feed: FeedState;
  freshness: string;
  scenarios: Scenario[];
  ctx: AnswerContext;
  since: SinceChanges | null;
  followUp: FollowUp;
  events?: PerceptionEvent[];
  nowMs: number;
  /** The setup engine's "waiting for" list — what would turn the lean into a trade. */
  waitingFor?: string[];
  /** The narrator's answer, for questions that are not about the read (a trade, the setup, the math). */
  narrator?: { text: string; ui: UiAction[] } | null;
  /** One sentence in front of a general read — "Gold is at 4384.30." for "talk to me". */
  opener?: string | null;
};

/** "Bearish lean, clear, on the intraday picture (1h)." */
export function leanLine(r: AtlasRead): string {
  switch (r.lean) {
    case "insufficient_data": return period(r.summary || "Not enough current data for a lean");
    case "balanced": return `Balanced — no lean worth acting on, on the intraday picture (${r.horizonTf}).`;
    case "transitioning": return `Transitioning — the intraday lean (${r.horizonTf}) is changing, and I'm not leaning on it yet.`;
    default: return `${LEAN_LABEL[r.lean]}${r.strength ? `, ${r.strength}` : ""}, on the intraday picture (${r.horizonTf}).`;
  }
}

const topFor = (r: AtlasRead, n: number) => [...r.evidenceFor].sort((a, b) => b.weight - a.weight).slice(0, n);
const topAgainst = (r: AtlasRead, n: number) => [...r.evidenceAgainst].sort((a, b) => b.weight - a.weight).slice(0, n);

/** The chart action for a read reference, if the reference still points at something real. */
function act(ref: AtlasRead["evidenceFor"][number]["ref"] | undefined, ctx: AnswerContext, label: string): ChartAction | null {
  if (!ref) return null;
  const v = validateRef(ref, ctx);
  return v ? actionForRef(v, ctx, label) : null;
}

const BREAK_EVENTS = new Set([
  "FAILED_BREAKOUT", "LEVEL_REJECTION", "RETEST_FAILING", "LIQUIDITY_SWEEP",
  "BREAKOUT_CONFIRMED", "LEVEL_ACCEPTANCE", "RETEST_HOLDING",
  "BREAKOUT_ATTEMPT", "BREAKOUT_WEAKENING",
]);

/**
 * Answer from the read alone. Every sentence is built from measured state: the lean and its horizon, the
 * strongest evidence, the condition it is waiting for, and what would make it wrong.
 */
export function deterministicAnswer(i: DeterministicInput): { answer: AtlasAnswer; markers: UiAction[] } {
  const r = i.read;
  const actions: (ChartAction | null)[] = [];
  const next = r.nextWatch?.text ?? null;
  const wrong = r.invalidation?.text ?? null;
  const reason = topFor(r, 1)[0]?.text ?? null;
  let say: string;

  switch (i.intent.kind) {
    case "why": {
      const ev = topFor(r, 3);
      const against = topAgainst(r, 1)[0];
      say = [
        leanLine(r),
        ev.length ? ev.map((e) => period(e.text)).join(" ") : "The evidence behind it is thin.",
        against ? `Against it: ${period(lc(against.text))}` : "",
      ].filter(Boolean).join(" ");
      for (const e of ev) actions.push(act(e.ref, i.ctx, e.text));
      break;
    }
    case "waiting": {
      // The read's next condition first; the setup's own conditions are what a TRADE would also need.
      const forTrade = (i.waitingFor ?? []).filter((w) => w && w !== next).slice(0, 1);
      say = [
        leanLine(r),
        next ? `What I'm waiting for: ${period(lc(next))}` : "There's nothing specific I'm waiting for yet — the read hasn't given me a trigger.",
        forTrade.length ? `For a trade I'd also need ${period(lc(forTrade[0]))}` : "",
        r.setupStage === "ready" ? "The setup is complete — it's on the trade card for you to take or pass." : "Until then, the lean is not an entry.",
      ].filter(Boolean).join(" ");
      actions.push(act(r.nextWatch?.ref, i.ctx, next ?? "Next"));
      break;
    }
    case "breakout": {
      const ev = [...(i.events ?? [])].filter((e) => BREAK_EVENTS.has(e.code) && i.nowMs - e.at <= 30 * 60_000).sort((a, b) => b.at - a.at)[0];
      if (!ev) {
        say = `I don't see a break in progress — price isn't through a level I track right now. ${leanLine(r)}${next ? ` What would matter: ${period(lc(next))}` : ""}`;
        actions.push(act(r.nextWatch?.ref, i.ctx, next ?? "Next"));
      } else {
        const fake = ["FAILED_BREAKOUT", "LEVEL_REJECTION", "RETEST_FAILING", "LIQUIDITY_SWEEP"].includes(ev.code);
        const real = ["BREAKOUT_CONFIRMED", "LEVEL_ACCEPTANCE", "RETEST_HOLDING"].includes(ev.code);
        const verdict = fake ? "It's reading as a fakeout so far" : real ? "It's holding as a breakout so far" : "Too early to call";
        say = `${verdict}: ${period(lc(ev.detail))}${!fake && !real ? " It needs acceptance — closes beyond the level that hold — before I'd call it real." : ""} ${leanLine(r)}`;
        if (ev.level) actions.push(act({ kind: "level", levelId: levelIdOf(ev.level), price: ev.level.price }, i.ctx, ev.level.label));
      }
      break;
    }
    case "change_mind": {
      const vc = i.scenarios.find((s) => s.role === "view_change" && s.status !== "invalidated" && s.status !== "expired");
      say = [
        wrong ? period(wrong) : r.lean === "balanced" ? "A clean break of the range with pressure behind it." : "I don't have a single level that settles it — the read would have to stop agreeing with itself.",
        vc ? `The view-change case is ${period(lc(vc.title))} It triggers on ${period(lc(vc.trigger.text))}` : "",
        `Until then: ${lc(leanLine(r))}`,
      ].filter(Boolean).join(" ");
      actions.push(act(r.invalidation?.ref, i.ctx, wrong ?? "Invalidation"));
      if (vc) actions.push({ type: "scenario", scenarioId: vc.id });
      break;
    }
    case "timeframe": {
      const tf = i.intent.tf;
      const horizon = `My lean is about the intraday picture (${r.horizonTf}): ${LEAN_LABEL[r.lean]}${r.strength ? `, ${r.strength}` : ""}.`;
      say = tf === "5m" || tf === "15m"
        ? `On the ${TF_NAME[tf]} now. ${horizon} The ${TF_NAME[tf]} is for timing, not a new forecast.`
        : `On the ${TF_NAME[tf]} now — the bigger picture. ${horizon}`;
      actions.push({ type: "timeframe", tf });
      break;
    }
    case "since_last": {
      if (i.since) {
        say = i.since.lines.slice(0, 4).join(" ");
        if (i.since.material && next) say += ` What matters now: ${period(lc(next))}`;
      } else {
        say = `I can't tell when you last looked, so here is the read as it stands. ${leanLine(r)}${reason ? ` ${period(reason)}` : ""}`;
      }
      break;
    }
    case "scenarios": {
      const base = i.scenarios.find((s) => s.role === "base");
      const alt = i.scenarios.find((s) => s.role === "alternative");
      if (base) {
        say = [
          `Base case: ${period(lc(base.title))} Trigger: ${period(lc(base.trigger.text))}`,
          alt ? `Alternative: ${period(lc(alt.title))}` : "",
          wrong ? `What changes the view: ${period(lc(wrong))}` : "",
        ].filter(Boolean).join(" ");
        actions.push({ type: "scenario", scenarioId: base.id });
      } else {
        say = [leanLine(r), next ? `Base case is the lean playing out: ${period(lc(next))}` : "", wrong ? `What changes the view: ${period(lc(wrong))}` : ""].filter(Boolean).join(" ");
      }
      break;
    }
    case "levels": {
      const p = i.ctx.price;
      const above = p == null ? [] : i.ctx.levels.filter((l) => l.price > p).sort((a, b) => a.price - b.price).slice(0, 2);
      const below = p == null ? [] : i.ctx.levels.filter((l) => l.price <= p).sort((a, b) => b.price - a.price).slice(0, 2);
      const name = (l: { label: string; price: number }) => `${l.label} ${l.price.toFixed(2)}`;
      say = [
        above.length ? `Above: ${above.map(name).join(", ")}.` : "Nothing mapped close above.",
        below.length ? `Below: ${below.map(name).join(", ")}.` : "Nothing mapped close below.",
        next ? `The one that matters: ${period(lc(next))}` : "",
      ].filter(Boolean).join(" ");
      actions.push(act(r.nextWatch?.ref, i.ctx, next ?? "Next"));
      break;
    }
    case "lean":
    default: {
      if (i.intent.kind === "other" && i.narrator?.text) { say = i.narrator.text; break; }
      say = [i.opener ?? "", leanLine(r), reason ? period(reason) : "", next ? `What matters next: ${period(lc(next))}` : ""].filter(Boolean).join(" ");
      if (i.intent.kind === "lean") actions.push(act(r.nextWatch?.ref, i.ctx, next ?? "Next"));
    }
  }

  const aboutRead = READ_INTENTS.has(i.intent.kind) || !i.narrator?.text;
  const markers = i.intent.kind === "other" ? i.narrator?.ui ?? [] : [];
  const answer: AtlasAnswer = {
    say: withFreshnessCaveat(say.replace(/\s{2,}/g, " ").trim(), i.feed).say,
    read: answerReadOf(r),
    evidence: aboutRead ? itemsFromRead(r.evidenceFor, i.ctx, 3) : [],
    against: aboutRead ? itemsFromRead(r.evidenceAgainst, i.ctx, 2) : [],
    next: aboutRead ? next : null,
    invalidation: aboutRead ? wrong : null,
    freshness: i.freshness,
    actions: dedupeActions([...actions.filter((a): a is ChartAction => !!a), ...markersToChartActions(markers, i.ctx)], 4),
  };
  return { answer, markers };
}

/* ── composing the model's reply ───────────────────────────────────────────────────────────────────── */

export type ComposeInput = DeterministicInput & {
  /** The model's raw reply. Null when there was no model, or it failed. */
  modelText: string | null;
};

export type Composed = {
  answer: AtlasAnswer;
  markers: UiAction[];
  structured: boolean;
  source: "llm" | "narrator";
  dropped: string[];
};

/**
 * The model's reply, made into the contract. JSON is validated field by field; plain text is shown as
 * text with the engine's read beside it; nothing usable falls back to the deterministic answer. When the
 * question asked for something on the chart and the model forgot, the read's own references are used.
 */
export function composeAnswer(i: ComposeInput): Composed {
  const det = deterministicAnswer(i);
  if (i.modelText == null) return { ...det, structured: false, source: "narrator", dropped: [] };
  const parsed = parseAtlasReply(i.modelText);
  if (parsed.kind === "empty") return { ...det, structured: false, source: "narrator", dropped: ["model:unusable"] };

  const wantsChart = (a: ChartAction[]): ChartAction[] => {
    if (i.intent.kind === "timeframe" && !a.some((x) => x.type === "timeframe")) return [{ type: "timeframe", tf: i.intent.tf }, ...a];
    if (["why", "breakout", "change_mind", "waiting", "levels"].includes(i.intent.kind) && !a.length) return det.answer.actions;
    return a;
  };

  if (parsed.kind === "json") {
    const v = validateAtlasAnswer({
      value: parsed.value, ctx: i.ctx, read: i.read, feed: i.feed, freshness: i.freshness,
      fillFromRead: READ_INTENTS.has(i.intent.kind), fallbackSay: det.answer.say,
    });
    // When none of the model's own words survived, the answer is the deterministic one — and says so.
    const replaced = v.dropped.includes("say:replaced") || v.dropped.includes("say:missing");
    return { answer: { ...v.answer, actions: dedupeActions(wantsChart(v.answer.actions), 4) }, markers: v.markers, structured: true, source: replaced ? "narrator" : "llm", dropped: v.dropped };
  }

  // Plain prose: checked sentence by sentence exactly as `say` would be.
  const dropped: string[] = [parsed.salvaged ? "model:truncated_json" : "model:not_json"];
  const { clean, markers } = extractUiMarkers(parsed.text);
  const kept = sentences(clean).filter((s) => {
    if (ungroundedPrices(s, i.ctx).length) { dropped.push("say:ungrounded_price"); return false; }
    if (contradictsLean(s, i.read.lean)) { dropped.push("say:contradicts_lean"); return false; }
    return true;
  });
  const own = kept.join(" ").trim();
  if (!own) dropped.push("say:replaced");
  const say = withFreshnessCaveat(own || det.answer.say, i.feed).say;
  const actions = dedupeActions(wantsChart(markersToChartActions(markers, i.ctx)), 4);
  return { answer: { ...det.answer, say, actions }, markers, structured: false, source: own ? "llm" : "narrator", dropped };
}

/* ── the response ──────────────────────────────────────────────────────────────────────────────────── */

export type AtlasChatResponse = BrainResponse & AtlasChatMeta & { notice?: string };

/** A short confirmation (a watch, an unwatch, no market) in the same contract. */
export function simpleAnswer(say: string, i: { read: AtlasRead | null; feed: FeedState; freshness: string; actions?: ChartAction[] }): AtlasAnswer {
  return {
    say, read: i.read ? answerReadOf(i.read) : null, evidence: [], against: [], next: null, invalidation: null,
    freshness: i.freshness, actions: dedupeActions(i.actions ?? [], 4),
  };
}

/**
 * Everything the console needs, plus every field older clients read (`spokenText`, `uiActions`, `source`,
 * `notice`) — the installed app and the classic console keep working unchanged.
 */
export function chatResponse(i: {
  answer: AtlasAnswer;
  markers: UiAction[];
  source: "llm" | "narrator";
  structured: boolean;
  dropped?: string[];
  feed: FeedState;
  snapshotId: number | null;
  analysisAt: number | null;
  requestId: string | null;
  legacy: Omit<BrainResponse, "spokenText" | "uiActions" | "source">;
  notice?: string | null;
  answeredAt?: number;
}): AtlasChatResponse {
  const ui: UiAction[] = [];
  for (const u of [...i.markers, ...chartActionsToUi(i.answer.actions)]) {
    if (!ui.some((x) => x.name === u.name && x.arg === u.arg)) ui.push(u);
  }
  return {
    ...i.legacy,
    spokenText: i.answer.say,
    uiActions: ui.slice(0, 3),
    source: i.source,
    answer: i.answer,
    snapshotId: i.snapshotId,
    analysisAt: i.analysisAt,
    answeredAt: i.answeredAt ?? Date.now(),
    feed: i.feed,
    promptVersion: ATLAS_PROMPT_VERSION,
    structured: i.structured,
    requestId: i.requestId,
    dropped: i.dropped ?? [],
    ...(i.notice ? { notice: i.notice } : {}),
  };
}
