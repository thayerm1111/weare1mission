/**
 * WHAT IT KNOWS ABOUT THE ACCOUNT IT IS TRADING.
 *
 * Asked "look at my account and tell me whether I should lower my risk", ATLAS said gold was
 * closed. The account has nothing to do with whether the market is open: the balance, the risk
 * setting, the permissions and the authorisation state are all facts about the member's own
 * configuration, and a system that cannot discuss them is not a trading partner.
 *
 * WHAT IS DELIBERATELY NOT HERE. No credentials, no tokens, no account NUMBER — the language model
 * has no use for any of them and every one of them is a liability the moment a transcript is shared.
 * It gets the shape of the account and the rules it operates under, which is everything needed to
 * answer a question about risk and nothing that could be used to reach the broker.
 *
 * AND IT NEVER IMPLIES AUTHORITY IT DOES NOT HAVE. The permissions below are the actual gates the
 * execution path enforces. Printing them lets the model say "you have not allowed me to close, so
 * that one is yours to do" instead of inventing either a capability or a restriction.
 */
import type { TradingProfile } from "../engines/profile";

export type AccountFacts = {
  connected: boolean;
  name: string | null;
  isLive: boolean;
  currency: string | null;
  balance: number | null;
  equity: number | null;
  openPl: number | null;
  marginAvailable: number | null;
  stateAt: string | null;
  autoTrading: boolean;
  liveAuthorized: boolean;
  permissions: Record<string, boolean>;
  instrumentReady: boolean;
};

const money = (n: number | null, ccy: string | null) =>
  n == null ? "unknown" : `${n < 0 ? "-" : ""}${ccy === "USD" || !ccy ? "$" : ""}${Math.abs(n).toFixed(2)}${ccy && ccy !== "USD" ? ` ${ccy}` : ""}`;

const PERMISSION_WORDS: Record<string, string> = {
  manual_execute: "place a trade you approve",
  ai_break_even: "move the stop to break-even by itself",
  ai_protect_stop: "tighten the stop to protect profit by itself",
  ai_partial: "take a partial by itself",
  ai_close: "close the position entirely by itself",
};

/**
 * The account and the rules, as lines the model may quote.
 *
 * Staleness is stated rather than smoothed over. A balance read forty minutes ago is not the balance,
 * and an answer about risk built on a stale equity figure is worse than an answer that says so.
 */
export function accountLines(a: AccountFacts | null, p: TradingProfile): string[] {
  const L = ["=== THE MEMBER'S ACCOUNT AND THEIR RULES ==="];

  if (!a || !a.connected) {
    L.push("No broker account is connected. You can still discuss the market and their settings, but there is no balance, no equity and no position to reason about — say so rather than inventing one.");
  } else {
    const age = a.stateAt ? Math.round((Date.now() - Date.parse(a.stateAt)) / 60_000) : null;
    L.push(`${a.isLive ? "LIVE" : "DEMO"} account${a.name ? ` "${a.name}"` : ""}${a.isLive && !a.liveAuthorized ? " — live trading is NOT authorised, so nothing can be sent to it" : ""}`);
    L.push(`balance ${money(a.balance, a.currency)}, equity ${money(a.equity, a.currency)}, open P&L ${money(a.openPl, a.currency)}, margin available ${money(a.marginAvailable, a.currency)}`);
    if (age != null) L.push(age > 10 ? `NOTE: those figures were last read ${age} minutes ago and may be stale. Say so if the question turns on them.` : `read ${age} minute${age === 1 ? "" : "s"} ago`);
    if (!a.instrumentReady) L.push("the gold instrument has not been resolved on this account yet, so an order could not be routed right now");
    L.push(`automatic trading is ${a.autoTrading ? "ON" : "OFF"}`);

    const allowed = Object.entries(a.permissions).filter(([, v]) => v).map(([k]) => PERMISSION_WORDS[k] ?? k);
    const denied = Object.entries(a.permissions).filter(([, v]) => !v).map(([k]) => PERMISSION_WORDS[k] ?? k);
    L.push(allowed.length ? `you are permitted to: ${allowed.join("; ")}` : "you are permitted to do nothing automatically on this account");
    if (denied.length) L.push(`you are NOT permitted to: ${denied.join("; ")} — if one of those is the right move, recommend it and let them do it`);
  }

  /*
   * THE RULES THEY SET, which are the real answer to "should I lower my risk".
   *
   * Risk is a number they chose, and the useful reply compares it with what it means in their own
   * currency on their own balance — not a lecture about position sizing in the abstract.
   */
  L.push("", "their trading rules:");
  L.push(`risk per trade ${p.riskPct}% ${a?.balance != null ? `(about ${money((a.balance * p.riskPct) / 100, a.currency)} on the current balance)` : "(no balance known, so the cash amount is unknown)"}`);
  L.push(`styles allowed: ${[p.allowQuick && "QUICK", p.allowHold && "HOLD", p.allowSwing && "SWING"].filter(Boolean).join(", ") || "none"}`);
  L.push(`minimum confidence to act ${p.minConfidence}; daily loss limit ${p.maxDailyLossPct}%; max open risk ${p.maxOpenRiskPct}%; stop after ${p.maxConsecutiveLosses} losses in a row; news lockout ${p.newsLockoutMinutes} minutes`);
  L.push(`entries are ${p.autoEntry ? "automatic" : "approved by them each time"}; management is ${p.autoManagement ? "automatic" : "theirs unless a permission above says otherwise"}`);
  if (!p.configured) L.push("NOTE: they have never saved a profile, so these are the defaults rather than choices they made. Worth mentioning if they ask about risk.");

  L.push("", "Answer questions about the account from THESE numbers. Never invent a balance, a position or a permission, and never say you have changed a setting — you cannot.");
  return L;
}

/**
 * Is the member asking about their account, their risk or their permissions?
 *
 * Needs its own route for the same reason history did: none of it depends on the market being open,
 * and answering "gold is closed" to "should I lower my risk" is a router failure rather than an
 * honest limitation.
 */
export function asksAboutAccount(q: string): boolean {
  return /\b(my|the) (account|balance|equity|risk|size|sizing|margin|settings?|permissions?|profile|leverage)\b|\b(risk per trade|lower my risk|raise my risk|how much (am i|do i) (risk|risking)|risking per trade|position siz|am i (connected|authoris|authoriz)|auto[- ]?trading|which account|what account)\b/i.test(q);
}
