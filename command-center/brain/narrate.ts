/**
 * NARRATING THE LIFE OF A POSITION.
 *
 * Before this file the intelligence stream carried a log: "health 78 → 84", "partial confirmed". True,
 * useful, and not what was asked for. What a member sitting in a trade actually wants is the thing a
 * professional beside them would say — "we're +1R and the breakout level held", "first resistance
 * reached", "momentum has slowed but I haven't called a change yet" — and, most of the time, nothing.
 *
 * THE RESTRAINT IS THE FEATURE. An intelligence that comments on every tick gets muted; one that says a
 * single sentence after forty quiet minutes gets listened to. So every line below has to earn its place:
 *
 *   • MILESTONES FIRE ONCE. Each note carries a key, and a key that has already been said is never said
 *     again for the life of the position. Crossing +1R is news; hovering either side of it is not.
 *
 *   • THE LADDER ONLY RATCHETS. Falling back under +1R does not re-arm the +1R line, which is what would
 *     turn a chopping trade into a system that shouts twelve times.
 *
 *   • ONE VOICE LINE AT A TIME. Everything else goes to the stream, where it can be read rather than
 *     heard. Only an invalidation is allowed to interrupt.
 *
 *   • NOTHING IS MANUFACTURED. If nothing happened, this returns an empty array. There is no path here
 *     that invents a comment to fill a silence.
 */
import type { MarketSnapshot } from "../core/types";
import { STYLE } from "../core/style";
import type { Channel } from "./types";
import type { CharacterRead, LivePosition, Protection, TradeHealth, TradeMetrics } from "./trade";

export type TradeNote = {
  /** Fires once per position. The dedupe key, not shown to anybody. */
  key: string;
  code: string;
  text: string;
  channel: Channel;
  /** Higher wins when several notes land on the same poll. */
  importance: number;
};

export type NarrateInput = {
  position: LivePosition;
  metrics: TradeMetrics;
  character: CharacterRead;
  health: TradeHealth;
  protection: Protection;
  snapshot: MarketSnapshot;
  /** Keys already said for this position, in any channel. */
  said: Set<string>;
  /** When THE BRAIN last spoke ALOUD about anything. */
  lastSpokeAt: number | null;
  now?: number;
};

/** How long between spoken lines while a position is open. Shorter than the market's, but not by much. */
const QUIET_MS = 100_000;
/** How long a healthy, uneventful trade goes before THE BRAIN offers one line of reassurance. */
const REASSURE_MS = 20 * 60_000;

/** The R ladder. Deliberately sparse: every quarter-R would be chatter dressed as precision. */
const R_LADDER = [1, 1.5, 2, 3, 4];

const HEALTH_BAND: Record<TradeHealth["verdict"], string> = {
  strong: "strong", healthy: "healthy", holding: "holding", weakening: "weakening", at_risk: "at risk",
};

export function narrateTrade(i: NarrateInput): TradeNote[] {
  const now = i.now ?? Date.now();
  const { position: p, metrics: m, character: ch, health: h, protection: prot, snapshot: s } = i;
  const pol = STYLE[p.style];
  const long = p.side === "buy";
  const out: TradeNote[] = [];

  const add = (key: string, code: string, text: string, channel: Channel, importance: number) => {
    if (i.said.has(key)) return;
    out.push({ key, code, text, channel, importance });
  };

  /* 1 — INVALIDATION. The only thing allowed to interrupt, and it is said the moment it is true. */
  if (ch.state === "invalidated") {
    add("char:invalidated", "TRADE_THESIS_INVALIDATED",
      `${ch.explanation} ${m.pips > 0 ? `You're still ${Math.round(m.pips)} pips up — I would take that rather than wait for the stop.` : "I would take this loss here rather than the full stop."}`,
      "urgent", 100);
  }

  /* 2 — CHARACTER. Only the transitions that a trader would act differently on. */
  if (ch.state === "character_change") {
    add("char:character_change", "TRADE_THESIS_WEAKENING",
      `Character changed. ${ch.explanation}`, "voice", 92);
  } else if (ch.state === "thesis_weakening") {
    add("char:thesis_weakening", "TRADE_THESIS_WEAKENING",
      `${ch.explanation} Nothing has broken yet, so I'm not acting — I'm watching this more closely than I was.`,
      "voice", 80);
  } else if (ch.state === "momentum_slowdown") {
    add("char:momentum_slowdown", "MOMENTUM_EXHAUSTION",
      `Momentum has stopped accelerating${m.mfePips > 0 ? `, with the best at ${Math.round(m.mfePips)} pips` : ""}. Structure is still intact, so I am not calling a change of character.`,
      "stream", 62);
  } else if (ch.state === "healthy_retest") {
    add("char:healthy_retest", "RETEST_HOLDING",
      `The retest held. ${long ? "Buyers" : "Sellers"} defended the level this trade was built on.`, "voice", 74);
  }

  /* 3 — THE R LADDER. Ratcheting, and each rung fires once for the life of the position. */
  const r = m.r ?? 0;
  for (const rung of R_LADDER) {
    if (r >= rung) {
      add(`r:${rung}`, "TRADE_THESIS_STRENGTHENING",
        rung === 1
          ? `We're +1R — ${Math.round(m.pips)} pips${m.money != null ? `, ${m.money >= 0 ? "+" : "-"}$${Math.abs(m.money).toFixed(0)}` : ""}. ${m.beyondBreakEven ? "The stop is already protected." : "The risk is still on the table."}`
          : `We're +${rung}R now, ${Math.round(m.pips)} pips.`,
        rung === 1 ? "voice" : "stream", 70 + rung * 3);
    }
  }

  /* 4 — REACHING SOMETHING THE BRAIN WAS WATCHING. Real levels only; the label is the broker's own. */
  const atr = s.timeframes[pol.decisive[0]]?.features.atr ?? s.timeframes["5m"]?.features.atr ?? 0;
  if (atr > 0 && m.pips > 0) {
    const reached = s.levels
      .filter((l) => (long ? l.price > p.entry : l.price < p.entry))
      .filter((l) => Math.abs(s.price - l.price) <= atr * 0.25)
      .sort((a, b) => Math.abs(a.price - s.price) - Math.abs(b.price - s.price))[0];
    if (reached) {
      add(`level:${reached.price.toFixed(2)}`, "LEVEL_TOUCH",
        `We've reached ${reached.label} at ${reached.price.toFixed(2)} — the first area I was watching ahead of this trade. ${
          ch.state === "intact" ? "Momentum is still with us, so I'm letting it work." : "I'm watching how it behaves here."
        }`,
        "voice", 76);
    }
  }

  /* 5 — THE STOP IS PROTECTED. Worth saying exactly once: it changes what the trade IS. */
  if (m.beyondBreakEven) {
    add("protected", "TRADE_THESIS_STRENGTHENING",
      `Your stop is protected at ${p.curStop.toFixed(2)}. This position cannot lose money now, so the rest is upside.`,
      "voice", 84);
  }

  /* 6 — HANDING BACK THE BEST OF IT. The number profit protection actually cares about. */
  if (m.mfePips > pol.noiseFloorPips * 2 && m.giveBackFraction >= pol.giveBackFraction && m.pips > 0) {
    add("giveback", "MOMENTUM_EXHAUSTION",
      `The best this saw was ${Math.round(m.mfePips)} pips and we're at ${Math.round(m.pips)}. It's handing back more than I'd like.${
        prot.action !== "hold" ? ` ${prot.say}` : ""
      }`,
      "voice", 86);
  }

  /* 7 — HEALTH BANDS, not health points. "78 → 84" is a log line; "weakening" is information. */
  add(`health:${h.verdict}`, "TRADE_THESIS_WEAKENING",
    `Position health is ${HEALTH_BAND[h.verdict]} at ${h.score}.${h.drivers[0] ? ` Mostly ${h.drivers[0].label}.` : ""}`,
    h.verdict === "at_risk" || h.verdict === "weakening" ? "voice" : "stream",
    h.verdict === "at_risk" ? 88 : h.verdict === "weakening" ? 72 : 44);

  /* 8 — NEWS, but only while there is profit to lose to it. */
  if (s.news.nextEvent && (s.news.minutesToNext ?? 999) <= 15 && m.pips > pol.noiseFloorPips) {
    add(`news:${s.news.nextEvent.name}`, "NEWS_APPROACHING",
      `${s.news.nextEvent.name} is about ${Math.round(s.news.minutesToNext ?? 0)} minutes away and you're ${Math.round(m.pips)} pips up. I'd rather protect this before the number than after it.`,
      "voice", 90);
  }

  /* 9 — SILENCE IS EVIDENCE. A setup that has done nothing for its own style's patience has told you
         something, and that is worth one line. */
  if (m.heldMs > pol.stallMs && Math.abs(m.pips) < pol.noiseFloorPips) {
    add("stall", "PRICE_DECELERATION",
      `This has been open ${Math.round(m.heldMs / 60_000)} minutes and gone nowhere. For a ${pol.label} trade, that is itself a reason to lose interest in it.`,
      "voice", 70);
  }

  /* 10 — REASSURANCE. The hardest line to earn, because "nothing has changed" is only worth hearing
          when somebody has been sitting in a trade wondering. Once, after a long quiet stretch. */
  if (
    (ch.state === "intact" || ch.state === "healthy_retest") &&
    m.heldMs > REASSURE_MS &&
    (i.lastSpokeAt == null || now - i.lastSpokeAt > REASSURE_MS)
  ) {
    const bucket = Math.floor(m.heldMs / REASSURE_MS);
    add(`healthy:${bucket}`, "TRADE_THESIS_STRENGTHENING",
      `Trade still looks healthy${m.pips > 0 ? ` at ${Math.round(m.pips)} pips` : ""}. Nothing needs changing.`,
      "voice", 40);
  }

  /*
   * ROUTING. Everything worth recording is recorded; at most ONE line is allowed to be spoken, and only
   * if enough quiet has passed. A line that loses that contest is not dropped — it is demoted to the
   * stream, where the member can read it without being interrupted.
   */
  out.sort((a, b) => b.importance - a.importance);
  const canSpeak = i.lastSpokeAt == null || now - i.lastSpokeAt >= QUIET_MS;
  let spoken = false;
  for (const n of out) {
    if (n.channel === "urgent") { spoken = true; continue; }      // urgent always interrupts
    if (n.channel !== "voice") continue;
    if (!spoken && canSpeak) { spoken = true; continue; }
    n.channel = "stream";
  }
  return out;
}
