/**
 * THE PLATFORM, AS ATLAS KNOWS IT (owner 11-21 brief §8).
 *
 * Seen on 11-21: asked "what is OM AI Plays?", ATLAS said it had no documentation for OM AI Plays, GENX or
 * Market Pulse — and the reply came wrapped in "market closed / not enough current data". A question about
 * the product owes nothing to the price of gold. This file is ATLAS's knowledge of the product, written
 * from the code that runs it, and the routing that answers product questions first, with or without a
 * market read.
 *
 * RULES THIS FILE KEEPS
 *   • Nothing here is marketing. Every tool, input, price and rule below is what the code does; a price is
 *     passed in from the platform's own settings (src/lib/creditConfig.ts), never typed here.
 *   • Help is not market analysis. A product answer carries no market read, no freshness line and no
 *     "market closed" label (the console draws it as help).
 *   • Explaining is free; generating is the member's own tap. A request to generate is answered with what
 *     it will cost and a button that says so — nothing is charged by asking (src/lib/plays/intent.ts).
 *   • What ATLAS cannot see, it says it cannot see — it does not guess a reason from a switch or a badge.
 *
 * Pure: no I/O. The chat route reads anything live (GENX's newest read, the member's window) and passes it in.
 */

export type PlatformCosts = {
  /** OM AI Plays, a play. */ play: number;
  /** A deep dive. */ deepdive: number;
  /** A Market Pulse scan. */ scan: number;
  /** A GENX read (Analyze gold). */ genx: number;
  /** The Command Center window: its price and length. */ cc: number; ccMinutes: number;
  /** The setup window on The Floor / GENX ("See the play"). */ setupMinutes: number;
};

export type HelpLink = {
  label: string;
  href: string;
  /** A generate button: the member's tap leaves a one-time intent, then opens the address with it. */
  generate?: { td: string; style: string };
};
export type HelpReply = { say: string; links: HelpLink[] };

export type PlatformTopic =
  | "overview" | "plays" | "first_play" | "genx" | "pulse" | "flow" | "connect" | "atlas" | "floor" | "credits"
  | "results" | "not_executed" | "generate_play" | "generate_atlas" | "open_in_flow" | "genx_now" | "pulse_last";

const has = (s: string, re: RegExp) => re.test(s);
const T = {
  plays: /\b(om ?ai plays?|ai plays?|plays?|signal generator)\b/,
  genx: /\bgen ?x\b/,
  pulse: /\b(market pulse|pulse|scanner|scan)\b/,
  flow: /\bflow\b/,
  atlas: /\b(atlas|command cent(er|re))\b/,
  floor: /\bthe floor\b/,
};
const ASK = /\b(what('s| is| are| does| do)|explain|tell me (about|what)|how (does|do|is|are)|difference|compare|versus|vs\.?|which (one|tool)|what can you|help me understand|walk me through)\b/;

/** The markets OM AI Plays can analyse, by the names people use for them → the generator's own symbol. */
const MARKET_WORDS: [RegExp, string][] = [
  [/\b(eur ?\/? ?usd|euro ?dollar|fiber)\b/, "EUR/USD"], [/\b(gbp ?\/? ?usd|cable|pound ?dollar)\b/, "GBP/USD"], [/\b(usd ?\/? ?jpy|dollar ?yen)\b/, "USD/JPY"],
  [/\b(aud ?\/? ?usd|aussie)\b/, "AUD/USD"], [/\b(usd ?\/? ?cad|loonie)\b/, "USD/CAD"], [/\b(nzd ?\/? ?usd|kiwi)\b/, "NZD/USD"], [/\b(usd ?\/? ?chf|swissy)\b/, "USD/CHF"],
  [/\b(eur ?\/? ?jpy)\b/, "EUR/JPY"], [/\b(gbp ?\/? ?jpy|gopher|guppy)\b/, "GBP/JPY"], [/\b(aud ?\/? ?jpy)\b/, "AUD/JPY"], [/\b(eur ?\/? ?gbp)\b/, "EUR/GBP"],
  [/\b(eur ?\/? ?aud)\b/, "EUR/AUD"], [/\b(gbp ?\/? ?aud)\b/, "GBP/AUD"],
  [/\b(xau ?\/? ?usd|gold)\b/, "XAU/USD"], [/\b(xag ?\/? ?usd|silver)\b/, "XAG/USD"], [/\b(xpt ?\/? ?usd|platinum)\b/, "XPT/USD"], [/\b(wti|oil|crude)\b/, "WTI/USD"],
  [/\b(btc|bitcoin)\b/, "BTC/USD"], [/\b(eth|ethereum)\b/, "ETH/USD"], [/\b(sol|solana)\b/, "SOL/USD"], [/\b(xrp|ripple)\b/, "XRP/USD"], [/\b(doge|dogecoin)\b/, "DOGE/USD"],
  [/\b(nas ?100|nasdaq|us ?100|ndx)\b/, "NAS100"], [/\b(spy|s&p|sp ?500|us ?500)\b/, "SPY"], [/\b(dia|dow|us ?30)\b/, "DIA"],
  [/\b(aapl|apple)\b/, "AAPL"], [/\b(nvda|nvidia)\b/, "NVDA"], [/\b(tsla|tesla)\b/, "TSLA"], [/\b(msft|microsoft)\b/, "MSFT"], [/\b(amzn|amazon)\b/, "AMZN"],
];

/** A market named in the message, as the generator spells it — or null. */
export function marketIn(message: string): string | null {
  const s = ` ${message.toLowerCase()} `;
  for (const [re, td] of MARKET_WORDS) if (re.test(s)) return td;
  return null;
}
/** A style named in the message — or null, which is asked for, never assumed. */
export function styleIn(message: string): "scalp" | "intraday" | "swing" | null {
  const s = message.toLowerCase();
  if (/\bscalp/.test(s)) return "scalp";
  if (/\b(intraday|intra-day|day ?trade)\b/.test(s)) return "intraday";
  if (/\bswing\b/.test(s)) return "swing";
  return null;
}

/**
 * A question that is (at least partly) about the market itself — answered from the read, not from here.
 * Deliberately narrow: "what is GENX?" mentions gold's engine without asking where gold is.
 */
export function asksMarket(message: string): boolean {
  const s = message.toLowerCase();
  return /\b(what('s| is) (gold|the market|price|xau)( \w+)? doing|where('s| is) gold|gold (right )?now|price of gold|gold price|explain this candle|this candle|current (read|price)|your read|the read now|should i (buy|sell)|is it a buy|is it a sell|bullish|bearish|support|resistance|liquidity)\b/.test(s);
}

/** What kind of product question this is — or null for one that is not about the product. */
export function platformTopic(message: string): PlatformTopic | null {
  const s = ` ${message.toLowerCase().replace(/[’']/g, "'")} `;
  const tools = (Object.keys(T) as (keyof typeof T)[]).filter((k) => has(s, T[k]));
  const generate = /\b(generate|make|create|build|run|give me|get me|find me)\b/.test(s);

  if (generate && /\batlas\b/.test(s) && /\b(gold|setup|idea|trade)\b/.test(s) && !has(s, T.plays)) return "generate_atlas";
  if (generate && (has(s, T.plays) || (/\b(play|signal|setup|trade)\b/.test(s) && marketIn(s) && marketIn(s) !== "XAU/USD"))) return "generate_play";
  if (/\bopen (this|the|my|that) (play|signal|trade)\b.*\bflow\b/.test(s)) return "open_in_flow";
  if (has(s, T.genx) && /\b(wait|waiting|trigger|invalidat|cancel|read|seeing|doing|state|when was|made)\b/.test(s) && !/\bwhat('s| is) gen ?x\b(?!\s+(waiting|doing|seeing|reading|watching|showing))|\bdifference\b/.test(s)) return "genx_now";
  if (has(s, T.pulse) && /\b(latest|last|candidates|how old|when|top|show|results|ranked)\b/.test(s) && !/\bwhat is\b|\bdifference\b/.test(s)) return "pulse_last";
  if (/\b(why|how come)\b[^?]*\b(not|n't|never)\b[^?]*\b(execut|place|fill|open|take|taken|enter|trade)/.test(s)) return "not_executed";
  if (/\b(balance|equity)\b/.test(s) && (ASK.test(s) || /\bflow results\b|\bmean\b/.test(s))) return "results";
  if (/\b(walk me through|first (ai )?play|how (do|can|would) i (generate|make|create|get) (a |an |my )?(first )?(om ai )?(play|signal))\b/.test(s)) return "first_play";
  if (/\b(connect|link|add|hook up)\b[^?]*\b(account|broker|tradelocker|flow)\b/.test(s)) return "connect";
  if (/\b(credits?|flow pass|how much|what does it cost|price of)\b/.test(s) && (tools.length || /\bcredits?\b/.test(s))) return "credits";
  if (tools.length >= 2 && ASK.test(s)) return "overview";
  if (/\bwhat (can you do|tools|is this (platform|site|app))\b|\bhow does (this|the platform|one mission) work\b/.test(s)) return "overview";
  if (tools.length === 1 && ASK.test(s)) return tools[0] === "plays" ? "plays" : tools[0];
  return null;
}

const STYLE_WORDS = "Scalp (read on the 5, 15 and 30-minute charts), Intraday (the 1-hour chart) or Swing (the daily chart)";
const credits = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

/** The plain-language answer to a product question, with the links that act on it. */
export function platformReply(topic: PlatformTopic, message: string, c: PlatformCosts, live: { genx?: string | null } = {}): HelpReply {
  const L = {
    plays: { label: "Open OM AI Plays", href: "/portal/signals" },
    genx: { label: "Open GENX", href: "/portal/genx" },
    pulse: { label: "Open Market Pulse", href: "/portal/trading?view=pulse" },
    flow: { label: "Open FLOW", href: "/portal/trading?view=flow" },
    floor: { label: "Open The Floor", href: "/portal/trading" },
    credits: { label: "Credits", href: "/portal/credits" },
  };
  switch (topic) {
    case "overview":
      return {
        say: [
          "Here is how the tools fit together:",
          `• OM AI Plays builds a trade setup on a market you choose — forex, metals, crypto, indices or stocks — from live candles. You pick the market and a style; it says whether there is a setup, an idea that is not confirmed yet, or nothing to do, with the entry, stop and targets when it is valid. ${credits(c.play)} a play, included with the FLOW Pass.`,
          `• GENX is the gold engine. It reads XAU/USD on its own fixed rules for Quick, Intraday or Swing, and keeps a public record of its trades. Analyze gold is ${credits(c.genx)}, included with the FLOW Pass.`,
          `• Market Pulse scans the supported markets and ranks them by how many confirmations line up, so you can see where to look. A scan is ${credits(c.scan)}; the list keeps the time it was made.`,
          "• FLOW connects your broker accounts. It is where you decide which accounts take GENX trades, whether FLOW runs on its own (Auto-run), the risk per trade and how open trades are managed — and where your own account's results are.",
          `• Atlas — me — is the gold Command Center: the chart, my read of gold, scenarios and conversation. The Command Center opens for ${c.ccMinutes} minutes for ${credits(c.cc)}.`,
          "GENX's results are the engine's own trades on gold. My FLOW results are what actually happened on your account. They are different numbers on purpose.",
        ].join("\n"),
        links: [L.plays, L.genx, L.pulse, L.flow],
      };
    case "plays":
      return {
        say: `OM AI Plays builds a trade setup on a market you choose, from live market data. Pick the market and a style — ${STYLE_WORDS} — and press Generate. The answer is one of three: a setup with its entry, stop and targets and their reward to risk; an idea it has not confirmed yet, with what it is waiting for; or no setup, which is a real answer. Under Method you can choose Institutional or Accelerator, the analysis method, the confirmations and Limit or Market entry. A play is ${credits(c.play)}, included with the FLOW Pass, and charged only when a play is made. Every play is saved; Check result and Get update are free.`,
        links: [L.plays],
      };
    case "first_play":
      return {
        say: [
          "Your first play, in three steps:",
          "1. Open OM AI Plays and choose a market — search for it, or tap one of the suggestions.",
          `2. Choose a style: ${STYLE_WORDS}.`,
          `3. Press Generate. It is ${credits(c.play)} (included with the FLOW Pass), charged only when a play is made.`,
          "The play opens on the right: what the engine concluded, the chart with its levels, and what to do next. It is saved under Saved plays, where Check result later tells you whether price reached a target or the stop. Placing it on an account is a separate step, on its ticket, with a confirmation.",
        ].join("\n"),
        links: [L.plays],
      };
    case "genx":
      return {
        say: `GENX is the platform's gold engine. It reads XAU/USD on fixed, deterministic rules for three horizons — Quick, Intraday and Swing — and says what it is doing: watching, a setup forming, or an entry live, with what it waits for and what would cancel it. The Floor shows its current state for free; the full plan opens with the setup window, and Analyze gold in GENX makes a fresh read for ${credits(c.genx)} (included with the FLOW Pass). GENX results are the engine's own record on gold — not any account's. Which of your accounts take GENX trades is set in FLOW.`,
        links: [L.genx, L.flow],
      };
    case "pulse":
      return {
        say: `Market Pulse scans the supported markets and ranks them by how many confirmations line up, most first. Tap a market for its reasons and the levels of a take-it-now read. A scan is ${credits(c.scan)} and is made only when you press Scan markets; the list always shows when it was made, and an old scan is labelled as one. From a market you can generate the full play in OM AI Plays (${credits(c.play)}), open OM AI Plays with it filled in (free), deep-dive it (${credits(c.deepdive)}) or ask me.`,
        links: [L.pulse],
      };
    case "flow":
      return {
        say: "FLOW connects your TradeLocker accounts and runs the trades you allow. Per account: Trading (takes GENX trades, FLOW's own forex and index trades while Auto-run is on, and tickets you place) and Follow every GENX signal. Auto-run FLOW is the switch for all your accounts. You also set risk per trade and how open trades are managed — break-even, follow price, partials and the safety mode. FLOW shows the selected account's Balance and Equity, its positions, history and results. Pausing new entries does not close anything: open trades keep being managed.",
        links: [L.flow],
      };
    case "connect":
      return {
        say: "To connect an account: open FLOW, choose Demo or Live, and sign in with your TradeLocker server, email and password — your login goes to the broker and is stored encrypted. A new account starts with Trading on, so check its switches under Manage execution, where you can switch Trading off. Connecting on its own is not the same as automation: Auto-run FLOW is a separate switch. The Command Center connects to the broker separately, from the broker bar on this screen.",
        links: [L.flow],
      };
    case "atlas":
      return {
        say: `I'm Atlas, the gold Command Center: the chart, my read of gold, the scenarios I'm watching, alerts, my journal, a recorded replay and conversation by text or voice. I explain what the engine measured — I don't invent levels. The Command Center opens for ${c.ccMinutes} minutes for ${credits(c.cc)}. I can also answer questions about the rest of the platform, and open the right tool for you.`,
        links: [L.floor],
      };
    case "floor":
      return {
        say: "The Floor is the first screen: your selected account's Balance and Equity, gold with GENX's current state, me (Atlas), GENX's results, your own FLOW results, and the other markets at a glance. Choosing an account there changes what you see, not what any account trades.",
        links: [L.floor],
      };
    case "credits":
      return {
        say: `What things cost: a play in OM AI Plays is ${credits(c.play)}; a GENX read (Analyze gold) is ${credits(c.genx)}; a Market Pulse scan is ${credits(c.scan)}; a deep dive is ${credits(c.deepdive)}; the Command Center is ${credits(c.cc)} for ${c.ccMinutes} minutes. OM AI Plays and GENX are included with the FLOW Pass. FLOW running on its own uses 1 credit when a setup starts forming and 5 when a trade is placed — once each, however many accounts — and nothing with the FLOW Pass. Explaining things here costs nothing.`,
        links: [L.credits],
      };
    case "results":
      return {
        say: "Balance is your account's cash as your broker reports it — it changes when a trade closes. Equity is the balance plus or minus the trades still open, so it moves with the market. My FLOW results are the trades FLOW placed on that account in the period you choose: the realized result of closed trades, how many are open, and the history. Deposits and withdrawals change the balance but are not trading results. GENX results are different again: the engine's own record on gold, not your account.",
        links: [L.floor, L.flow],
      };
    case "not_executed":
      return {
        say: "I can't see the delivery record for a signal on your account from here yet, so I won't guess why it did not execute. What decides whether a trade reaches an account: Trading must be on for that account (or Follow every GENX signal, for GENX), and for automated trades Auto-run FLOW must not be switched off. FLOW's checks can also skip an account when it places — for example no equity reading from the broker, a size below the broker's minimum, or the safety mode after two losses in a row. Your account's own trades and history are in FLOW.",
        links: [L.flow],
      };
    case "open_in_flow":
      return {
        say: "A play is placed from its own ticket in OM AI Plays: open the play, and the ticket below it shows every account it would go to with its own size, then asks you to confirm. Nothing is placed until you do. FLOW is where you choose which accounts take trades.",
        links: [L.plays, L.flow],
      };
    case "generate_atlas":
      return {
        say: "Press GENERATE at the top of this screen: I'll give you my trade idea on gold from the current read, with where to enter, the stop and the targets — or say there is no trade, which is a real answer. It costs nothing extra while the Command Center is open. Nothing is placed by generating.",
        links: [],
      };
    case "generate_play": {
      const td = marketIn(message);
      const style = styleIn(message);
      if (!td) {
        return { say: `Which market should the play be on? OM AI Plays covers forex, metals, crypto, indices and stocks. Name it — EUR/USD, say — and a style: ${STYLE_WORDS}.`, links: [L.plays] };
      }
      const href = (st: string) => `/portal/signals?td=${encodeURIComponent(td)}&style=${st}`;
      if (!style) {
        return {
          say: `An OM AI Play on ${td} is ${credits(c.play)} (included with the FLOW Pass), charged only when a play is made. Which style? ${STYLE_WORDS}.`,
          links: (["scalp", "intraday", "swing"] as const).map((st) => ({ label: `${st[0].toUpperCase()}${st.slice(1)} · ${credits(c.play)}`, href: href(st), generate: { td, style: st } })),
        };
      }
      return {
        say: `Ready: ${/^[aeiou]/.test(style) ? "an" : "a"} ${style} OM AI Play on ${td}, with your saved method. It is ${credits(c.play)} (included with the FLOW Pass), charged only when the play is made. It is made in OM AI Plays, saved with your other plays, and opens there — press the button to confirm.`,
        links: [{ label: `Generate · ${credits(c.play)}`, href: href(style), generate: { td, style } }, { label: "Open without generating", href: href(style) }],
      };
    }
    case "genx_now":
      return { say: live.genx ?? "I can't find a GENX read to report just now. GENX's current state is on The Floor and in GENX.", links: [L.genx] };
    case "pulse_last":
      return { say: "Your last Market Pulse scan is kept in this browser, and none was sent with the question. Market Pulse shows it with the time it was made.", links: [L.pulse] };
  }
}

/** The product, for the language model when a question mixes the product and the market. */
export function platformGuide(c: PlatformCosts): string {
  return [
    "=== THE PLATFORM (answer product questions from this; it owes nothing to the market) ===",
    `OM AI Plays: a trade setup on a market the member chooses (forex, metals, crypto, indices, stocks) from live candles. Styles: ${STYLE_WORDS}. Method: Institutional or Accelerator; Best, Smart Money or Structure; confirmations; Limit or Market entry. Outcomes: a setup, an unconfirmed idea, or no setup. ${credits(c.play)} a play, included with the FLOW Pass, charged only when made. Saved plays; Check result and Get update are free; a deep dive is ${credits(c.deepdive)}.`,
    `GENX: the gold engine, deterministic, horizons Quick, Intraday, Swing; states watching, forming, live. Analyze gold is ${credits(c.genx)}, included with the FLOW Pass. GENX results are the engine's record, not an account's.`,
    `Market Pulse: ranks supported markets by confirmations lined up. A scan is ${credits(c.scan)}, only on Scan markets; results keep their scan time.`,
    "FLOW: connects TradeLocker accounts. Per account: Trading, Follow every GENX signal; Auto-run FLOW for all accounts; risk per trade; trade management. Balance, Equity and My FLOW results are the selected account's own.",
    `Atlas / Command Center: gold chart, read, scenarios, alerts, journal, replay, chat and voice; ${credits(c.cc)} for ${c.ccMinutes} minutes.`,
    "Never claim to have generated, placed or changed anything. Never present engine results as the member's account results.",
  ].join("\n");
}
