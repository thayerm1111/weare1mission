/**
 * THE MEMBER'S OWN TRADE — the one they took, not the one ATLAS took.
 *
 * 09-21, owner: "I asked it if I should pull out of the trade I was in at 4369 and price was at 4362
 * and wasn't breaking 4359, which was a support." ATLAS only knew about positions it opened itself, so
 * a GENX fill or a hand-placed trade was invisible to it and the question got a generic answer.
 *
 * Two sources, both facts rather than guesses:
 *   1. What the member SAID in this conversation — "I'm short from 4369, stop 4374". Parsed from their
 *      own words (latest mention wins), sanity-checked against the live price, and labelled as stated.
 *   2. What FLOW/GENX actually holds for them — open gold rows in the managed ledger, with the entry,
 *      stop and target the system placed.
 *
 * Both become plain lines in the context packet, with the arithmetic already done (pips now, distance
 * to their stop and to the nearest levels on each side), so the answer is about THEIR trade at THEIR
 * numbers. ATLAS still only advises: the member decides and acts.
 */
import { db } from "../adapters/db";

export type StatedTrade = {
  side: "buy" | "sell";
  entry: number;
  stop: number | null;
  target: number | null;
  said: string;
};

const PRICE = String.raw`(\d{4}(?:\.\d{1,2})?)`;

/**
 * "forty-three sixty-nine" often arrives as "43 69" or "43, 69" — rejoin those into 4369.
 *
 * 09-21, owner: "I'm in a sell at 43.43, take profit at 43.21, stop at 43.50" — the transcriber wrote the
 * spoken "forty-three forty-three" as 43.43, nothing parsed, and ATLAS did the pip maths in its head and got
 * it wrong. When the live price is known, "HH.MM" whose first two digits match the price's handle
 * (43 for 43xx) is read the way a gold trader says it: 43.43 → 4343, 43.21 → 4321, 43.50 → 4350.
 */
function normaliseNumbers(t: string, ref: number | null = null): string {
  const handle = ref != null && ref >= 1000 && ref < 10000 ? String(Math.floor(ref)).slice(0, 2) : null;
  if (handle) t = t.replace(/(^|[^\d.])(\d{2})\.(\d{2})(?!\d|\.\d)/g, (m, pre: string, a: string, b: string) => (a === handle ? `${pre}${a}${b}` : m));
  return t
    .replace(/\b(3\d|4\d|5\d)[\s,]+(\d{2})(\.\d{1,2})?\b/g, (_m, a: string, b: string, c: string | undefined) => `${a}${b}${c ?? ""}`)
    .replace(/(\d),(\d{3})/g, "$1$2");
}

function sideOf(t: string): "buy" | "sell" | null {
  if (/\b(short|shorted|shorting|sell|sold|selling)\b/.test(t)) return "sell";
  if (/\b(long|longed|buy|bought|buying)\b/.test(t)) return "buy";
  return null;
}

function num(t: string, re: RegExp): number | null {
  const m = t.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse one utterance. Needs a side AND an entry — "should I get out" alone is not a trade.
 * `ref` is the live price: a number more than 5% away from it is not a gold entry and is ignored.
 */
export function parseStatedTrade(said: string, ref: number | null): StatedTrade | null {
  const t = normaliseNumbers(said.toLowerCase(), ref);
  const side = sideOf(t);
  if (!side) return null;
  const entry =
    num(t, new RegExp(String.raw`(?:entered|entry|filled|got in|in at|in from|from|at|@)\s*(?:price\s*)?(?:of|is|was|at)?\s*\$?${PRICE}`)) ??
    num(t, new RegExp(String.raw`(?:short|sell|sold|long|buy|bought)\w*\s+(?:gold\s+|xau\w*\s+)?\$?${PRICE}`));
  if (entry == null) return null;
  const near = (v: number | null) => v != null && (ref == null || Math.abs(v - ref) / ref < 0.05);
  if (!near(entry)) return null;
  const stop = num(t, new RegExp(String.raw`(?:stop(?:\s*loss)?|sl)\s*(?:is|at|of|was)?\s*\$?${PRICE}`));
  const target = num(t, new RegExp(String.raw`(?:target|tp|take\s*profit)\s*(?:is|at|of|was)?\s*\$?${PRICE}`));
  return { side, entry, stop: near(stop) ? stop : null, target: near(target) ? target : null, said: said.slice(0, 200) };
}

/** The latest trade the member described anywhere in the conversation (newest message wins). */
export function statedTradeFrom(userTexts: string[], ref: number | null): StatedTrade | null {
  for (let i = userTexts.length - 1; i >= 0; i--) {
    const p = parseStatedTrade(userTexts[i], ref);
    if (p) {
      // A stop or target given in a later message without restating the trade still belongs to it.
      for (let j = i + 1; j < userTexts.length; j++) {
        const t = normaliseNumbers(userTexts[j].toLowerCase(), ref);
        const s = num(t, new RegExp(String.raw`(?:stop(?:\s*loss)?|sl)\s*(?:is|at|of|was)?\s*\$?${PRICE}`));
        const g = num(t, new RegExp(String.raw`(?:target|tp|take\s*profit)\s*(?:is|at|of|was)?\s*\$?${PRICE}`));
        if (s != null) p.stop = s;
        if (g != null) p.target = g;
      }
      return p;
    }
  }
  return null;
}

type Lvl = { price: number; label?: string | null };

/** Plain lines for the packet: the trade at its numbers, with the arithmetic done. */
export function tradeGuidanceLines(
  src: string,
  t: { side: "buy" | "sell"; entry: number; stop: number | null; target: number | null; qty?: number | null },
  price: number,
  above: Lvl[],
  below: Lvl[],
): string[] {
  const dir = t.side === "sell" ? -1 : 1;
  const pips = ((price - t.entry) * dir) / 0.1;
  const L: string[] = [];
  L.push(`${src}: ${t.side === "sell" ? "SHORT (sold)" : "LONG (bought)"} XAUUSD from ${t.entry.toFixed(2)}${t.qty ? `, ${t.qty} lots` : ""}`);
  const p1 = (x: number) => (Math.abs(x) < 10 ? x.toFixed(1) : String(Math.round(x)));
  L.push(`price now ${price.toFixed(2)} → ${pips >= 0 ? "+" : ""}${p1(pips)} pips ${pips >= 0 ? "IN PROFIT" : "AGAINST THEM"} (1 pip = $0.10; a ${t.side === "sell" ? "sell profits when price is BELOW entry" : "buy profits when price is ABOVE entry"})`);
  if (t.stop != null) {
    const toStop = Math.abs(price - t.stop) / 0.1;
    const risk = Math.abs(t.entry - t.stop) / 0.1;
    L.push(`their stop ${t.stop.toFixed(2)} — ${p1(toStop)} pips from price; the trade risked ${Math.round(risk)} pips, so it is at ${(pips / Math.max(1, risk)).toFixed(2)}R`);
  } else {
    L.push("they have not told you a stop — ask where it is if the answer depends on it");
  }
  if (t.target != null) L.push(`their target ${t.target.toFixed(2)} — ${p1(Math.abs(t.target - price) / 0.1)} pips away`);
  // In the trade's direction first: that is what it needs to break for the trade to pay.
  const fav = t.side === "sell" ? below : above;
  const adv = t.side === "sell" ? above : below;
  const fmt = (l: Lvl) => `${l.price.toFixed(2)}${l.label ? ` (${l.label})` : ""} ${Math.round(Math.abs(l.price - price) / 0.1)} pips away`;
  if (fav.length) L.push(`in the trade's favour, next levels it must break: ${fav.slice(0, 3).map(fmt).join("; ")}`);
  if (adv.length) L.push(`against the trade, levels that would hurt: ${adv.slice(0, 3).map(fmt).join("; ")}`);
  return L;
}

/** Open FLOW/GENX gold positions the system placed for this member. Empty on any read failure. */
export async function ledgerPositions(userId: string): Promise<{ side: "buy" | "sell"; entry: number; stop: number | null; target: number | null; qty: number | null; openedAt: string }[]> {
  const c = db();
  if (!c) return [];
  try {
    const { data } = await c.from("flow_managed_positions")
      .select("side, entry, cur_stop, init_stop, tp1, qty, created_at")
      .eq("user_id", userId).eq("status", "open").in("symbol", ["XAUUSD", "GOLD"])
      .order("created_at", { ascending: false }).limit(5);
    return ((data ?? []) as { side: string; entry: number; cur_stop: number | null; init_stop: number | null; tp1: number | null; qty: number | null; created_at: string }[])
      .filter((r) => (r.side === "buy" || r.side === "sell") && Number.isFinite(Number(r.entry)))
      .map((r) => ({
        side: r.side as "buy" | "sell", entry: Number(r.entry),
        stop: r.cur_stop != null ? Number(r.cur_stop) : r.init_stop != null ? Number(r.init_stop) : null,
        target: r.tp1 != null ? Number(r.tp1) : null, qty: r.qty != null ? Number(r.qty) : null, openedAt: r.created_at,
      }));
  } catch { return []; }
}

export const TRADE_COACH_RULES = `
WHEN THE TRADER ASKS ABOUT A TRADE THEY TOOK (the "THEIR OWN TRADE" block):
- USE THE PIP NUMBERS IN THAT BLOCK EXACTLY. Never work out pips, distances or profit/loss yourself — the block has them. If they described a trade and there is NO "THEIR OWN TRADE" block, you could not read their numbers: say the entry, stop and target back to them as prices and ask them to confirm, instead of guessing the maths.
- Treat it exactly like an open position: use its entry, the pips now, their stop, and the levels on each side from that block and from LEVELS ABOVE / LEVELS BELOW.
- Give a clear lean — hold, take some off, tighten, or get out — and the ONE price that would change it ("if it closes back above 4364 I'd be out"). Say what the level is (yesterday's low, a 4h swing) so they can see it.
- Say whether price is respecting or rejecting the level they mention, using the live read (pressure, structure, the last candles) — not a guess.
- It is their decision and their money: say "I'd…" rather than "you must", and never promise the outcome.`;
