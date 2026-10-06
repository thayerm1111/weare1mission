/**
 * WHAT THE TELEGRAM CHANNEL IS TOLD (owner 10-05).
 *
 * The channel has free subscribers. It used to carry the whole trade — direction, entry zone, stop,
 * targets, the price it triggered at — which is the product, given away to anyone who had joined:
 * "There's customers in there that are getting free signals … make the customer have to go use
 * credits in order to see."
 *
 * So a post now says only THAT something is happening, on which market and which horizon, and where
 * to read it. The play itself is on the site, where a run of GENX (or GEN FX) is paid for in credits.
 *
 * NOTHING HERE IS HANDED A SIDE OR A PRICE. The builders take a title, a market name and the tool to
 * open — so nothing built from them can print a direction or a level, whatever a caller has in
 * scope. That is the guarantee, and tests/public-signal.test.ts holds every sender to it.
 *
 * AND A POST ONLY SENDS PEOPLE TO A PLAY THAT IS THERE. "Run GENX to see the play" is said for the
 * calls a GENX run shows (the scanner's reads and the page's zones, which are the same engine). A
 * call from another machine is posted with deskPost, which does not promise that.
 *
 * A win is different: it is posted after the trade is over, when its levels are a result rather than
 * a signal. Those posts are not built here and still say what was called.
 */
export const SITE_URL = "https://weare1mission.com";

/** A tool on the site where the play can be read. */
export type PlayTool = { name: string; path: string };
export const GENX_TOOL: PlayTool = { name: "GENX", path: "/portal/genx" };
export const GENFX_TOOL: PlayTool = { name: "GEN FX", path: "/portal/genfx" };
/** How gold is named in a post. (GEN FX names its pairs from pairs.ts.) */
export const GOLD_MARKET = "Gold (XAU/USD)";

const FOOT = `<i>Educational, not financial advice.</i>`;
const open = (tool: PlayTool): string => `<a href="${SITE_URL}${tool.path}">Open ${tool.name} →</a>`;
const lines = (...l: (string | null | undefined)[]): string => l.filter(Boolean).join("\n");

/** A setup is forming. `title` is the engine and horizon ("GENX 1.0 SWING"), `market` what it is on. */
export function formingPost(title: string, market: string, tool: PlayTool): string {
  return lines(
    `⏳ <b>${title} — setup forming</b>`,
    market,
    `A setup is taking shape. Run ${tool.name} to see the play.`,
    `You'll get an <b>ENTER NOW</b> here the moment it triggers.`,
    open(tool),
    FOOT,
  );
}

/** It is time to enter. */
export function enterPost(title: string, market: string, tool: PlayTool): string {
  return lines(
    `✅ <b>${title} — ENTER NOW</b>`,
    market,
    `The setup just triggered. Run ${tool.name} now to get the play.`,
    open(tool),
    FOOT,
  );
}

/**
 * A call the desk is taking that is NOT a read on the GENX page: a previous-day break-and-retest
 * scalp, a range fade, one of the owner's own levels. Running GENX would not show it, so this post
 * does not say it would — a member who spent credits to look would find something else. It says
 * that the call fired and where it is being taken. `headline` is the whole first line as it should
 * read ("GENX 1.0 SCALP — ENTER NOW").
 */
export function deskPost(icon: string, headline: string, market: string): string {
  return lines(
    `${icon} <b>${headline}</b>`,
    market,
    `FLOW is taking this one on connected accounts.`,
    FOOT,
  );
}

/** The setup is off — said for the people who went and read it. */
export function cancelledPost(title: string, market: string): string {
  return lines(
    `❌ <b>${title} — setup cancelled</b>`,
    market,
    `This one is off. Don't take it.`,
  );
}

/** Words and numbers that would give a play away: a direction, or anything shaped like a price. */
const TELLS = /\b(buy|buys|buying|buyers?|sell|sells|selling|sellers?|long|short|bullish|bearish|support|resistance|higher|lower|above|below|floor|ceiling|top|bottom|rally|pullback)\b|\d{3,}(?:\.\d+)?|\d\.\d{3,}/i;
/** Does this text give away a direction or a level? Used by the hold notes below, and by the tests. */
export const givesPlayAway = (text: string): boolean => TELLS.test(text);

const HOLD_GENERIC = "A desk safeguard is holding this entry back.";

/**
 * WHY THE DESK HELD AN ENTRY, AS THE CHANNEL MAY READ IT. The desk's own reason says which way the
 * trade was and where ("Not taking a SELL against it", "price is 12% up the 4120.00–4160.00 range"):
 * right for the desk's log, a free signal in the channel. This keeps the KIND of safeguard and drops
 * the rest. A reason it does not recognise, or one that would still give something away, becomes the
 * plain line — it fails closed.
 */
export function publicHoldReason(reason: string | null | undefined): string {
  const r = String(reason ?? "").trim();
  let out = HOLD_GENERIC;
  if (/^Change of character/i.test(r)) out = "Change of character: the market's structure just flipped against this entry. Accounts wait for it to settle.";
  else if (/^Range guard/i.test(r)) out = "Range guard: price is at the wrong edge of its range for this entry.";
  else if (/^Desk breaker/i.test(r)) out = r;
  else if (/^(Weekend-close|Daily-reopen) blackout/i.test(r)) out = r.replace(/\bno new (?:BUY|SELL) entries\b/i, "no new entries");
  return givesPlayAway(out) ? HOLD_GENERIC : out;
}
