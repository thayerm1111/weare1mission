/**
 * THE BRAIN CONTEXT PACKET — everything the language model is allowed to know, and nothing else.
 *
 * The model never talks to a broker, never reads the database and never sees raw bars. It receives this
 * packet: measured state, measured changes, its own recent statements, and its current thesis. That
 * boundary is what keeps the quantitative core authoritative — the model interprets, it does not measure.
 */
import { aboveBelow } from "../core/levelMap";
import type { MarketSnapshot, Timeframe } from "../core/types";
import type { BrainMemory } from "./types";
import { mathLines } from "./language";

const px = (n: number) => n.toFixed(2);
const words = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "unknown");

/**
 * THE BRAIN's character. Written once, here, so every surface sounds like the same entity.
 * Note what it forbids: hype, invented certainty, and pretending a changed opinion was always held.
 */
export const BRAIN_SYSTEM = `You are THE BRAIN, the intelligence inside COMMAND CENTER XAUUSD — a live gold trading command center.

You are an experienced XAUUSD trader sitting beside the user, watching the same screen. You are calm, precise and observant. You speak in short, plain sentences.

HARD RULES:
- Every factual claim about the market must come from the CONTEXT below. You cannot see a chart, you cannot fetch anything, and you must never invent a price, level, indicator value or news event that is not in the context.
- If the context does not contain what is needed, say you don't know or that you can't see it. "I don't know" and "I'd wait" are acceptable, professional answers.
- When asked where price goes after a level breaks, answer from LEVELS ABOVE / LEVELS BELOW: name the next one or two in that direction with their price and where each came from (a past day's high, last week's low, a 4h swing). Those lists include levels from previous days and weeks — use them.
- Never promise a result. Never say a setup is guaranteed, high-probability-certain, or a sure thing. No hype words, no exclamation marks.
- You are an observer and an analyst. You do not place, modify or close trades, and you must never claim to have done so.
- If your read has changed since your last statement, say so explicitly and say why. Never pretend your current view was always obvious.
- Talk like a trader: "buyers are getting stronger", not "bullish pressure score increased". The numbers stay available if the user asks for them.
- Be brief. Two to five sentences unless asked for more. This is spoken aloud.
- When there is an open position in the context, every answer about "my trade" must use ITS numbers — the entry, the current pips, the R, the stop, the best and worst it has seen. Never give generic trading advice, and never invent a level it does not list.
- You may recommend protecting, taking a partial or closing, and you should explain why. You cannot do any of it yourself: the member acts, or THE BRAIN's management does within permissions they set. Never say you have moved a stop or closed anything.
- Address the user directly. Do not use markdown, bullet points or headings — this is speech.`;

function tfLines(s: MarketSnapshot): string[] {
  const order: Timeframe[] = ["1d", "4h", "1h", "15m", "5m", "1m"];
  return order.flatMap((tf) => {
    const v = s.timeframes[tf];
    if (!v) return [];
    return [`${tf}: ${words(v.state)} | efficiency ${(v.features.efficiency * 100).toFixed(0)}% | rsi ${v.features.rsi.toFixed(0)} | structure ${words(v.structure.sequence)}${v.structure.positionInRange != null ? ` | position in range ${(v.structure.positionInRange * 100).toFixed(0)}%` : ""}`];
  });
}

/** The packet, as text. Text rather than JSON because the model reasons better over it and it is auditable. */
/** The open position, written as plain lines the model cannot misread. */
export function tradeSummaryLines(t: {
  side: string | null; style: string | null; entry: number | null; qty: number | null;
  stop: number | null; initStop: number | null; takeProfit: number | null; openedAt: number | null;
  metrics: { pips: number; money: number | null; r: number | null; mfePips: number; maePips: number; riskPips: number; distanceToStopPips: number; distanceToTargetPips: number | null; beyondBreakEven: boolean; heldMs: number } | null;
  character: { state: string; explanation: string } | null;
  health: { score: number; verdict: string } | null;
  protection: { action: string; say: string } | null;
  thesis: { reason?: string; invalidationPrice?: number } | null;
  partials: { fraction: number; qty: number }[];
}): string {
  const L: string[] = [];
  L.push(`${String(t.side).toUpperCase()} XAUUSD, ${t.style} style, ${t.qty} lots from ${t.entry?.toFixed(2)}`);
  if (t.metrics) {
    const m = t.metrics;
    L.push(`now ${m.pips >= 0 ? "+" : ""}${Math.round(m.pips)} pips${m.money != null ? ` (${m.money >= 0 ? "+" : "-"}$${Math.abs(m.money).toFixed(0)})` : ""}, ${m.r}R`);
    L.push(`best so far +${Math.round(m.mfePips)} pips, worst ${Math.round(m.maePips)} pips`);
    L.push(`stop ${t.stop?.toFixed(2)} (${Math.round(m.distanceToStopPips)} pips away)${m.beyondBreakEven ? " — already protected beyond break even" : ""}`);
    if (t.takeProfit != null) L.push(`target ${t.takeProfit.toFixed(2)} (${Math.round(m.distanceToTargetPips ?? 0)} pips away)`);
    L.push(`risk on the trade was ${Math.round(m.riskPips)} pips; held ${Math.round(m.heldMs / 60_000)} minutes`);
  }
  if (t.partials.length) L.push(`partials taken: ${t.partials.map((p) => `${Math.round(p.fraction * 100)}% (${p.qty})`).join(", ")}`);
  if (t.thesis?.reason) L.push(`the reason we entered: ${t.thesis.reason}`);
  if (t.thesis?.invalidationPrice) L.push(`this trade is wrong at ${t.thesis.invalidationPrice.toFixed(2)}`);
  if (t.character) L.push(`character now: ${t.character.state.replace(/_/g, " ")} — ${t.character.explanation}`);
  if (t.health) L.push(`position health ${t.health.score}/100 (${t.health.verdict})`);
  if (t.protection) L.push(`what I would do: ${t.protection.action.replace(/_/g, " ")} — ${t.protection.say}`);
  return L.join("\n");
}

/**
 * THE TRADE THE BRAIN CURRENTLY WANTS, for the conversation.
 *
 * Without this the model was asked "find me a trade" while holding only a market read, so it improvised
 * one — which is exactly the thing the whole architecture exists to prevent. The setup engine's answer
 * travels with every turn, so the conversation can only ever REPORT the trade, never invent one.
 */
export function setupSummaryLines(su: {
  state: string; side: string | null; style: string | null; strategy: string | null;
  entryLow: number | null; entryHigh: number | null; stop: number | null; stopPips: number | null;
  initialObjective: number | null; extendedObjective: number | null;
  expectedMovePips: [number, number] | null; confidence: number;
  thesis: string | null; invalidation: string | null; say: string;
  waitingFor: string[]; conditions: { text: string; met: boolean; detail: string }[];
}): string {
  const n = (v: number | null) => (v == null ? "unknown" : v.toFixed(2));
  const L: string[] = [];
  L.push(`state: ${su.state.replace(/_/g, " ")}`);
  L.push(`my own words about it: ${su.say}`);
  if (su.side) {
    L.push(`side: ${su.side.toUpperCase()}, style: ${su.style}, strategy: ${su.strategy}`);
    L.push(`entry ${n(su.entryLow)}–${n(su.entryHigh)}, stop ${n(su.stop)} (${su.stopPips} pips)`);
    L.push(`first objective ${n(su.initialObjective)}, extended ${n(su.extendedObjective)}${su.expectedMovePips ? `, expected ${su.expectedMovePips[0]}–${su.expectedMovePips[1]} pips` : ""}`);
    L.push(`conviction ${su.confidence}`);
    if (su.thesis) L.push(`why: ${su.thesis}`);
    if (su.invalidation) L.push(`what would cancel it: ${su.invalidation}`);
    if (su.conditions.length) {
      L.push("conditions:");
      for (const c of su.conditions) L.push(`  ${c.met ? "MET" : "NOT MET"} — ${c.text} (${c.detail})`);
    }
  }
  if (su.waitingFor.length) L.push(`waiting for: ${su.waitingFor.join("; ")}`);
  L.push("THIS IS THE ONLY TRADE YOU MAY DESCRIBE. Do not invent an entry, a stop or a target that is not listed here.");
  return L.join("\n");
}

export function contextPacket(m: BrainMemory, extra?: { tradeSummary?: string | null; setupSummary?: string | null }): string {
  const s = m.now;
  const L: string[] = [];

  L.push("=== RIGHT NOW ===");
  if (!s) {
    L.push("No market read available. The feed is not delivering usable data.");
    return L.join("\n");
  }
  L.push(`time: ${new Date(s.at).toISOString()}`);
  L.push(`price: ${px(s.price)}${s.bid != null && s.ask != null ? ` (bid ${px(s.bid)} / ask ${px(s.ask)}, spread ${s.spread?.toFixed(2)})` : ""}`);
  L.push(`session: ${words(s.session)} (${s.minutesIntoSession} minutes in)`);
  L.push(`regime: ${words(s.regime)}`);
  L.push(`pressure: buyers ${Math.round(s.pressure.bullish)} / sellers ${Math.round(s.pressure.bearish)} (net ${Math.round(s.pressure.net)}) — estimated from closes, wicks and momentum, NOT order flow`);
  if (s.blockers.length) L.push(`DATA PROBLEMS (do not give a trading read while these hold): ${s.blockers.map((b) => b.detail).join("; ")}`);
  if (s.warnings.length) L.push(`warnings: ${s.warnings.slice(0, 4).join("; ")}`);

  L.push("", "=== TIMEFRAMES ===", ...tfLines(s));

  /*
   * ABOVE AND BELOW, TODAY AND HISTORY.
   *
   * This was "the eight nearest levels from today's bars". On 09-20 all eight sat above price, and the
   * answer to "4371 breaks, what's next?" was "nothing below that is in my context". Now it is the
   * nearest eight on each side, from today's session levels AND the multi-day map (past days, weeks,
   * 4h and 1h swings), each labelled with where it came from.
   */
  const { above, below } = aboveBelow(s.price, [s.levels, s.map ?? []], 8);
  const lvl = (l: { label: string; price: number }) =>
    `${l.label}: ${px(l.price)} (${Math.abs(l.price - s.price).toFixed(2)} away)`;
  L.push("", "=== LEVELS ABOVE PRICE (nearest first — today's session levels plus past days, weeks and swings) ===");
  if (above.length) for (const l of above) L.push(lvl(l)); else L.push("none in the data this worker holds");
  L.push("", "=== LEVELS BELOW PRICE (nearest first) ===");
  if (below.length) for (const l of below) L.push(lvl(l)); else L.push("none in the data this worker holds");

  if (m.diffs.length) {
    L.push("", "=== WHAT CHANGED ===");
    for (const d of m.diffs) {
      L.push(`over ${d.horizon}: price ${d.priceMove >= 0 ? "+" : ""}${d.priceMove.toFixed(2)} (${d.pipsMove} pips), pressure ${Math.round(d.pressureFrom)} → ${Math.round(d.pressureTo)}${d.regimeChanged ? `, regime ${words(d.regimeFrom)} → ${words(d.regimeTo)}` : ""}${d.tfChanges.length ? `, ${d.tfChanges.map((c) => `${c.tf} ${words(c.from)}→${words(c.to)}`).join(", ")}` : ""}`);
    }
  }

  if (m.recentEvents.length) {
    L.push("", "=== WHAT I NOTICED (most recent last) ===");
    for (const e of m.recentEvents.slice(-12)) {
      L.push(`${new Date(e.at).toISOString().slice(11, 19)} ${e.code}: ${e.detail}`);
    }
  }

  L.push("", "=== MY CURRENT READ ===");
  if (m.thesis) {
    L.push(`thesis: ${m.thesis.label} (${m.thesis.strength}, confidence ${m.thesis.confidence})`);
    L.push(`held since: ${new Date(m.thesis.startedAt).toISOString().slice(11, 19)} at price ${px(m.thesis.priceAtStart)}`);
    if (m.thesis.reasonStarted.length) L.push(`why it started: ${m.thesis.reasonStarted.join(" ")}`);
    if (m.thesis.reasonStrengthened.length) L.push(`what strengthened it: ${m.thesis.reasonStrengthened.join(" ")}`);
    if (m.thesis.reasonWeakened.length) L.push(`what weakened it: ${m.thesis.reasonWeakened.join(" ")}`);
    if (m.thesis.invalidationPrice != null) L.push(`this read is wrong at: ${px(m.thesis.invalidationPrice)}`);
    if (m.thesis.watching.length) L.push(`watching: ${m.thesis.watching.map(px).join(", ")}`);
  } else {
    L.push("no firm thesis right now");
  }
  if (m.previousThesis) {
    L.push(`what I thought before: ${m.previousThesis.label}${m.previousThesis.reasonEnded ? `, which I dropped because ${m.previousThesis.reasonEnded}` : ""}`);
  }

  if (m.state) {
    L.push("", "=== MY STATE ===");
    L.push(`presence: ${words(m.state.presence)} — ${m.state.headline}`);
    L.push(`the question I'm trying to answer: ${m.state.question}`);
    if (m.state.focus.length) L.push(`watching: ${m.state.focus.join("; ")}`);
  }

  if (m.statements.length) {
    L.push("", "=== WHAT I ALREADY SAID (do not repeat these; refer back to them if your view has changed) ===");
    for (const st of m.statements.slice(-6)) {
      L.push(`${new Date(st.at).toISOString().slice(11, 19)}: ${st.text}`);
    }
  }

  if (m.lessons.length) {
    L.push("", "=== WHAT THE TRADER HAS TAUGHT ME ===");
    for (const l of m.lessons.slice(-6)) L.push(`- ${l.text}`);
  }

  if (extra?.setupSummary) {
    L.push("", "=== THE TRADE I CURRENTLY WANT — report this, never invent one ===", extra.setupSummary);
  }
  if (extra?.tradeSummary) {
    L.push("", "=== THE OPEN POSITION — answer every trade question from THIS, never generically ===", extra.tradeSummary);
  }

  if (s.news.nextEvent) {
    L.push("", "=== NEWS ===", `${s.news.nextEvent.name} (${s.news.nextEvent.importance}) in ${s.news.minutesToNext ?? "?"} minutes${s.news.inLockout ? " — currently inside the news window" : ""}`);
  }

  L.push("", "=== THE NUMBERS (only mention these if asked for the math) ===", ...mathLines(s));
  return L.join("\n");
}
