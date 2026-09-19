/**
 * WHAT MOVES GOLD.
 *
 * Durable domain knowledge about XAUUSD: mechanisms, not prices. It is here because THE BRAIN could
 * read the present precisely and could not hold a conversation about the instrument — asked how news
 * affects gold, or why the dollar matters, it had nothing to say, because every fact it was permitted
 * to use came from a live snapshot that contains no such thing.
 *
 * THE LINE THIS FILE MUST NOT CROSS, and the reason it is a separate file rather than more system
 * prompt: none of this is ever evidence about the current market. "Gold usually falls when real yields
 * rise" is a mechanism. "Gold is falling because real yields are rising" is a claim about right now,
 * and nothing in here licenses it — that would have to come from measured context. The two are
 * separated in the prompt as explicitly as they are separated here, because a model that blurs them
 * produces confident narration of things it cannot see, which is the exact failure this system is
 * built to avoid.
 *
 * Nor is any of it a forecast. Tendencies describe how the instrument has behaved, not what it will do,
 * and they are written without numbers that go stale — "a large move" rather than "sixty pips", because
 * a file that quietly ages into being wrong is worse than one that says less.
 */

export const GOLD_KNOWLEDGE = `
=== XAUUSD — WHAT THIS INSTRUMENT IS AND WHAT MOVES IT (general knowledge, NOT current data) ===

WHAT IT IS
Spot gold quoted in US dollars per troy ounce, traded over the counter, effectively 24 hours from
Sunday evening to Friday evening US time with a daily break. It is not a company and has no earnings,
no dividend and no yield. That single fact drives most of what follows: gold has no cash flow to
discount, so its price is largely a story about the alternatives to holding it.

THE FOUR THINGS THAT MOVE IT MOST

1. REAL INTEREST RATES — the most reliable relationship. Gold pays nothing, so it competes with
   inflation-protected government bonds. When real yields rise, holding gold costs more in forgone
   income and it tends to fall. When real yields fall, that cost drops and gold tends to rise. Watch
   the direction of change more than the level.

2. THE US DOLLAR — gold is priced in dollars, so a stronger dollar mechanically makes it more expensive
   in every other currency and usually weighs on the price. The inverse relationship is strong but not
   absolute: in genuine crises both can rise together, because both are being bought for safety, and a
   trader who treats the correlation as a law gets caught exactly when it matters most.

3. FEAR AND UNCERTAINTY — war, banking stress, sovereign risk, sharp equity drawdowns. These produce
   the fastest and least predictable moves in gold, they often ignore the yield and dollar relationships
   entirely, and they can reverse as quickly as they came when the fear fades.

4. CENTRAL BANK AND ETF DEMAND — slower and structural rather than intraday. Sustained official-sector
   buying supports price over months; ETF flows show investor positioning. These set the backdrop a
   trade happens inside, not the reason a five-minute candle moved.

THE RELEASES THAT MOVE IT, AND THROUGH WHICH MECHANISM
- FOMC decisions, statements and the dot plot, and the chair's press conference. The press conference
  frequently moves gold more than the decision, because the decision is usually priced and the tone is
  not. Expect the first move to be violent and often partly retraced.
- US CPI and PCE inflation. These move rate expectations, which move real yields, which move gold.
  The surprise versus consensus matters far more than the absolute number.
- Non-farm payrolls, the unemployment rate and average hourly earnings, monthly. Same channel.
  Strong labour data usually means higher-for-longer rates, which usually pressures gold.
- Fed speakers between meetings, which can shift expectations without any data at all.
- Geopolitical escalation, which arrives unscheduled and is the one category no calendar protects you
  from.

HOW A SCHEDULED RELEASE ACTUALLY BEHAVES
Liquidity thins in the minutes beforehand and spreads widen. The first move after the number is often
a spike that reverses within minutes — the real move frequently establishes itself some minutes later,
once the full detail is digested. Stops placed inside that first spike get taken out by moves that do
not survive. This is why the system refuses new entries inside a news window rather than trying to be
clever about it.

THE TRADING DAY
- Asian session: typically the quietest, narrower ranges, more respect for existing levels.
- London open: the first real expansion of range most days; liquidity arrives and overnight levels get
  tested.
- London/New York overlap: the highest-volume window and where the day's decisive move most often
  happens.
- New York afternoon: trends either extend or unwind into the close as positions are squared.
- The daily break and the Sunday open: gaps are possible, and the Sunday open can be erratic on thin
  liquidity.

STRUCTURAL BEHAVIOUR WORTH KNOWING
- Gold trends hard and retraces deeply. Shallow-pullback trend systems designed for indices tend to be
  stopped out by normal gold behaviour.
- Round numbers matter more than they should, and prior session highs and lows are tested routinely.
- Volatility clusters: a violent day is more likely to be followed by another violent day than by a
  quiet one, and position size has to acknowledge that.
- It can spike through a level, take the stops, and close back inside. Acceptance beyond a level — time
  spent there, not a single wick — is what separates a break from a raid.

WHAT THIS SECTION IS NOT
It is background, the kind of thing an experienced trader knows before the session starts. It is never
evidence about what is happening right now. Do not use it to explain a move, assert a correlation, or
state what any release did or will do. Any claim about the CURRENT market, any price, level, event or
date, must come from the measured context — and if the context does not have it, say so.
`.trim();

/**
 * Is this worth the extra tokens on this turn?
 *
 * The packet is not free, and "where is gold trading" does not need a paragraph about central bank
 * demand. It rides along when the question is about mechanism, schedule, context or education, which
 * is the only time it changes an answer.
 */
export function wantsDomainKnowledge(q: string): boolean {
  return /\b(news|calendar|event|fomc|fed|cpi|ppi|pce|inflation|nfp|payroll|jobs|unemployment|rate|yield|dollar|dxy|correlat|why does|what moves|what drives|how does|affect|impact|geopolit|war|central bank|etf|session|london|asian|new york|seasonal|typically|usually|explain|teach|understand|what is|history|historically)\b/i.test(q);
}
