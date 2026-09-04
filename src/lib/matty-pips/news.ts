/**
 * MATTY PIPS — event-aware news layer. READS the platform's econ calendar
 * (fails open) and produces an EVENT-RISK ASSESSMENT — it never guesses the
 * released number and it NEVER simply disables trading. Major news can also
 * CREATE trades: the reaction engine classifies the post-release behavior
 * (sweep of the weekly high that closes back under → FAILED_BREAK sell; break
 * that closes above, retests and holds → BREAKOUT RUNNER buy).
 */
import { assessNews } from "@/lib/econCalendar";
import { getInstrument } from "./pips";
import type { NewsRead } from "./types";

export async function newsRead(o: {
  symbol: string;
  atLevel: boolean;               // is price sitting at/near a major level right now?
  volatilityExpanding: boolean;   // recent 15M ranges expanding vs ATR
  hasOpenPosition: boolean;       // future auto-trade input; false in Phase 1/2
}): Promise<NewsRead> {
  const td = getInstrument(o.symbol).twelveDataSymbol;
  const nowMs = Date.now();
  const risk = await assessNews(td, nowMs);

  const mins = risk.minutes_to;
  const postEventWindow = risk.screened && mins != null && mins < 0 && mins >= -45;

  let action: NewsRead["action"] = "NORMAL_SETUP";
  let note = risk.note;

  if (!risk.screened) {
    action = "NORMAL_SETUP";
  } else if (o.hasOpenPosition && risk.level === "high" && mins != null && mins >= 0 && mins <= 45) {
    action = "PROTECT_EXISTING_POSITION";
    note = `High-impact "${risk.next_event}" in ${mins}m with a position open — tighten/protect rather than add risk.`;
  } else if (risk.level === "high" && mins != null && mins >= 0 && mins <= 20 && o.atLevel) {
    // Right at a major level, minutes before a high-impact print, setup would hold
    // through the release → let the event reveal the reaction first.
    action = "WAIT_FOR_EVENT";
    note = `High-impact "${risk.next_event}" in ${mins}m while price sits at a major level — let the release show its hand; the reaction itself may create the trade.`;
  } else if (risk.level === "high" || (risk.level === "medium" && (o.volatilityExpanding || o.atLevel))) {
    action = "REDUCED_CONFIDENCE";
    note = `${risk.next_event ? `"${risk.next_event}" ${mins != null && mins >= 0 ? `in ${mins}m` : "just released"}` : "News window"} — setups stay valid at reduced confidence; manage around the event.`;
  } else if (postEventWindow) {
    action = "NORMAL_SETUP";
    note = `Post-release window (${Math.abs(mins as number)}m after "${risk.next_event}") — reading the ACTUAL reaction: sweeps, breaks and retests here are tradeable, not guessed.`;
  }

  return {
    action, note,
    nextEvent: risk.next_event,
    minutesTo: mins,
    postEventWindow,
    screened: risk.screened,
  };
}
