/**
 * WHERE THINGS ARE, AND HOW TO GET THERE.
 *
 * A member asked THE BRAIN "where do I set that up?" and was told gold was closed. That is the same
 * router failure that has already produced wrong refusals about the account, the record and last week,
 * and it is the worst version of it: the member was not asking about the market at all. They were
 * asking how to use the product, and the product is the one subject THE BRAIN should never have to
 * look at a price to discuss.
 *
 * So the map lives here, as text, written from what the interface actually contains. It owes nothing
 * to a feed, a session, or a connected account. Two rules keep it honest:
 *
 *   NOTHING IN THIS FILE IS A GUESS. Every control named below exists, with that label, on that
 *   screen. If a setting is moved or renamed, this file is wrong and must be changed with it — a
 *   confidently wrong direction is worse than "I don't know where that is".
 *
 *   IT DESCRIBES, IT DOES NOT PROMISE. Telling somebody where the risk setting is does not change
 *   their risk, and THE BRAIN must never imply it has set something on their behalf.
 */

export const PRODUCT_MAP = `
=== WHERE SETTINGS LIVE (answer navigation questions from this, never from the market) ===

There are TWO separate places settings live, because FLOW and COMMAND CENTER connect to the broker
separately and keep their own settings. Say which one you mean; do not blend them.

FLOW — The Floor, FLOW tab.
  Route: The Floor -> FLOW. Everything below is per connected account, one card each.
  - "Risk" — chips: Default, 0.25%, 0.5%, 1%, 1.5%, 2%, 3%, 5%.
  - "Default risk per trade" — account-wide chips: 0.5%, 1%, 2%, 3%.
  - "Trade styles" — Rapid (fastest, tightest stops), Normal (held through a session),
    Swing (held for days, overnight). At least one must stay on.
  - "Break even" — on by default.
  - "Partials" — on by default.
  - "Profit guard" — off by default, opt in.
  - "Safety mode" — Conservative or Aggressive.
  - "Break-even trigger pips" — a number, or blank to let the engine choose.
  - "Trading" — the master switch for that account. Off means the account sits out.
  - "Auto-run FLOW" — account-wide. This is the switch that places trades without asking.

COMMAND CENTER — this screen. The sheet is headed "THE BRAIN · TRADING PROFILE".
  - "Risk per trade" — 0.25%, 0.50%, 0.75%, 1.00%.
  - "Trades I may look for" — QUICK, HOLD, SWING. NOTE: these are the SAME three holding periods
    FLOW calls Rapid, Normal and Swing. The two screens use different words for the same thing, so
    name the words that appear on the screen you are describing and never mix the two sets.
  - "What I may do to an open trade" — Move to break even, Take partials, Protect profit,
    Close the whole position, Manage without asking.
  - "Limits for the day" — Max daily loss, Max losses in a row.
  - "Enter trades without asking" — at the bottom of that same sheet.
  - Per-account permissions: the broker bar at the top of this screen, under
    "What THE BRAIN may do here" — Break even, Protect stop, Partials, Close.
  - Live accounts: "Authorise live trading" must be done first; automatic entry cannot be switched
    on for a live account until it is.

CONNECTING AN ACCOUNT: The Floor -> FLOW for FLOW, or the broker bar on this screen for COMMAND
CENTER. Both ask for environment (demo or live), server, email and password — it is a broker sign-in,
not a one-click authorisation.

TWO THINGS THAT ARE NOT THE SAME: an account being CONNECTED, and automation being ON. Connecting
does nothing on its own. Something has to be switched on afterwards, by the member, every time.

PAUSING: switching automation off stops NEW entries. Positions already open keep being managed and
protected. Never say pausing closes anything.

IF THE SETTING BEING ASKED ABOUT IS NOT IN THIS LIST, say you are not sure where it is rather than
guessing at a screen. Never claim to have changed a setting — you can say where it is, and the
interface can be opened for them, but the member sets it.
`.trim();

/**
 * A question about using the product, not about the market.
 *
 * Deliberately generous: a member who cannot find something asks in a dozen shapes, and the cost of
 * answering a market question with a product map is a mildly odd reply, while the cost of answering a
 * product question with "gold is closed" is a member who concludes the thing cannot help them.
 */
export function asksHowTo(q: string): boolean {
  const s = (q || "").toLowerCase();
  if (!s.trim()) return false;

  /*
   * SOME SHAPES NEED NO SUBJECT AT ALL.
   *
   * "Where do I set that up?" was the question that exposed this, and it names nothing — the subject
   * was in the previous sentence. A question about setting something up is a question about the
   * product whether or not the thing is named in the same breath, so these route on their own.
   */
  const selfEvident =
    /\b(where|how)\b[^?.!]{0,30}\bset\b[^?.!]{0,12}\bup\b/.test(s) ||
    /\bset (that|this|it|them|these|those|mine) up\b/.test(s) ||
    /\bhow (do|would) i (set|change|turn|switch|enable|find|get to)\b/.test(s) ||
    /\b(take|bring|send) me (to|there)\b/.test(s) ||
    /\bwhere (do|can) i (do|find|change|set) (that|this|it|them)\b/.test(s);
  if (selfEvident) return true;

  const shape =
    /\b(where|how)\s+(do|can|would|should)?\s*(i|you|we)?\b/.test(s) ||
    /\bwhere('s| is| are|s)\b/.test(s) ||
    /\bshow me (where|how)\b/.test(s) ||
    /\bhow (do i|to)\b/.test(s) ||
    /\bi (can't|cannot|cant|couldn't|couldnt) find\b/.test(s) ||
    /\bthere('s| is|s) (nowhere|no way|nothing)\b/.test(s) ||
    /\bnowhere to\b/.test(s) ||
    /\bwhat (screen|page|tab|menu|section)\b/.test(s);

  const subject =
    /\b(setting|settings|configure|configuration|set up|setup|risk|lot|size|sizing|permission|permissions|style|styles|rapid|normal|swing|break ?even|partial|partials|profit guard|safety mode|auto[- ]?run|automation|automatic|connect|connected|broker|tradelocker|account|authorise|authorize|enable|turn (on|off)|switch (on|off)|pause|kill switch|trade styles)\b/.test(s);

  return shape && subject;
}

/** The UI action that opens the right panel, when the question points clearly at one. */
export function howToTarget(q: string): "OPEN_SETTINGS" | "OPEN_BROKER" | null {
  const s = (q || "").toLowerCase();
  if (/\b(connect|broker|tradelocker|authorise|authorize|live account|which account)\b/.test(s)) return "OPEN_BROKER";
  if (/\b(risk|permission|setting|settings|break ?even|partial|profit guard|automation|auto[- ]?run|enter trades)\b/.test(s)) return "OPEN_SETTINGS";
  return null;
}
