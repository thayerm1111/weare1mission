/**
 * OPENING OM AI PLAYS WITH A MARKET, AND GENERATING FROM ANOTHER SCREEN (owner 11-21 brief §9, §12).
 *
 * Two different things, kept apart:
 *   prefill    /portal/signals?td=EUR%2FUSD&style=intraday — the market and style are filled in. Nothing is
 *              analysed and nothing is charged; the member presses Generate themselves.
 *   generate   the member pressed a button that said the price ("Generate the full play · 3 credits"). The
 *              button leaves a one-time intent in this tab's session storage and opens the same address with
 *              &generate=<nonce>. On arrival the play is generated once — only if the nonce matches the intent
 *              left moments ago for the same market — and the intent is used up.
 * A refresh, the Back button, a remount, a shared or bookmarked address, or an ordinary "Open" therefore
 * cannot make a second chargeable request: there is no intent left to match.
 */
const KEY = "om:plays:intent";
/** How long an intent waits for its page. A click and a page load, not a session. */
export const INTENT_TTL_MS = 2 * 60_000;

type Intent = { nonce: string; td: string; style: string; at: number };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The member asked, on a button that showed the price, to generate this play. Returns the nonce for the address. */
export function leaveGenerateIntent(store: Store, td: string, style: string, now = Date.now()): string {
  const nonce = `${Math.random().toString(36).slice(2, 10)}${now.toString(36)}`;
  store.setItem(KEY, JSON.stringify({ nonce, td, style, at: now } satisfies Intent));
  return nonce;
}

/** True once, for the matching nonce and market within INTENT_TTL_MS. Any answer uses the intent up. */
export function takeGenerateIntent(store: Store, nonce: string | null, td: string, now = Date.now()): boolean {
  if (!nonce) return false;
  let x: Intent | null = null;
  try { x = JSON.parse(store.getItem(KEY) ?? "null") as Intent | null; } catch { x = null; }
  if (!x || x.nonce !== nonce) return false;
  store.removeItem(KEY);
  return x.td === td && now >= x.at && now - x.at <= INTENT_TTL_MS;
}

/**
 * The address of OM AI Plays with a market and style filled in — with a nonce, the member's intent to generate;
 * without one, `open=1`, which says "fill in only" in BOTH views (the classic view otherwise generates on any
 * address with a market, for its own Market Pulse button — so a link from here must say it is not that).
 */
export function playsHref(td: string, style: string, nonce?: string): string {
  return `/portal/signals?td=${encodeURIComponent(td)}&style=${encodeURIComponent(style)}${nonce ? `&generate=${encodeURIComponent(nonce)}` : "&open=1"}`;
}
