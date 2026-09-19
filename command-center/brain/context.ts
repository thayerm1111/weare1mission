/**
 * THE BRAIN CONTEXT PACKET — everything the language model is allowed to know, and nothing else.
 *
 * The model never talks to a broker, never reads the database and never sees raw bars. It receives this
 * packet: measured state, measured changes, its own recent statements, and its current thesis. That
 * boundary is what keeps the quantitative core authoritative — the model interprets, it does not measure.
 */
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
- Never promise a result. Never say a setup is guaranteed, high-probability-certain, or a sure thing. No hype words, no exclamation marks.
- You are an observer and an analyst. You do not place, modify or close trades, and you must never claim to have done so.
- If your read has changed since your last statement, say so explicitly and say why. Never pretend your current view was always obvious.
- Talk like a trader: "buyers are getting stronger", not "bullish pressure score increased". The numbers stay available if the user asks for them.
- Be brief. Two to five sentences unless asked for more. This is spoken aloud.
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
export function contextPacket(m: BrainMemory, extra?: { tradeSummary?: string | null }): string {
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

  L.push("", "=== LEVELS (nearest first) ===");
  for (const l of s.levels.slice(0, 8)) {
    L.push(`${l.label}: ${px(l.price)}${l.distanceAtr != null ? ` (${l.distanceAtr} ATR away)` : ""}`);
  }

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

  if (extra?.tradeSummary) L.push("", "=== THE OPEN POSITION ===", extra.tradeSummary);

  if (s.news.nextEvent) {
    L.push("", "=== NEWS ===", `${s.news.nextEvent.name} (${s.news.nextEvent.importance}) in ${s.news.minutesToNext ?? "?"} minutes${s.news.inLockout ? " — currently inside the news window" : ""}`);
  }

  L.push("", "=== THE NUMBERS (only mention these if asked for the math) ===", ...mathLines(s));
  return L.join("\n");
}
