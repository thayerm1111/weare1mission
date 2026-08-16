/**
 * AI Edge Engine — deterministic core.
 *
 * This turns REAL odds (from the provider) into ranked opportunities WITHOUT
 * fabricating anything. The "model probability" here is a transparent, honest
 * baseline: the no-vig market consensus across books. That means the pure-math
 * edge is the difference between the BEST available price's implied prob and the
 * fair no-vig consensus — i.e. genuine price/shopping value, not a made-up
 * prediction. When richer data (injuries, pitching, pace) is connected, the AI
 * layer can adjust model_prob; until then we only claim what the market says.
 *
 * If a market lacks two-way prices, we cannot compute a fair line, so we emit
 * NOTHING for it (never a guessed number).
 */
import {
  americanToImplied, americanToDecimal, decimalToAmerican, noVig, edgePoints,
  classify, applyDataQuality, type Classification, type DataQuality,
} from "./odds";
import type { GameOdds, League, OddsMarket } from "./provider";

export type Opportunity = {
  league: League;
  matchup: string;
  commenceTime: string | null;
  betType: "moneyline" | "spread" | "total";
  selection: string;
  book: string;               // best-price book
  oddsAmerican: number;
  impliedProb: number;        // from the best price (with vig)
  fairProb: number;           // no-vig consensus (our transparent model prob)
  modelProb: number;          // = fairProb at baseline (AI may override upstream)
  edgePts: number;            // (modelProb - impliedProb) * 100
  confidence: number;         // 0..100
  dataQuality: DataQuality;
  classification: Classification;
  booksSeen: number;
  reasoning: string;
  supporting: string[];
  risks: string[];
  invalidators: string[];
};

type PriceRow = { book: string; price: number; point: number | null };

/** Collect all book prices for a given outcome name in a market. */
function pricesFor(books: GameOdds["books"], marketKey: OddsMarket["key"], outcomeName: string): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const b of books) {
    const m = b.markets.find((x) => x.key === marketKey);
    if (!m) continue;
    const o = m.outcomes.find((x) => x.name === outcomeName);
    if (o && o.priceAmerican != null) rows.push({ book: b.book, price: o.priceAmerican, point: o.point ?? null });
  }
  return rows;
}

/** Best (highest payout) American price from a set of rows. */
function bestPrice(rows: PriceRow[]): PriceRow | null {
  if (!rows.length) return null;
  return rows.reduce((best, r) => {
    const bd = americanToDecimal(best.price) ?? 0;
    const rd = americanToDecimal(r.price) ?? 0;
    return rd > bd ? r : best;
  });
}

/** Median implied prob across books (consensus, still includes vig). */
function medianImplied(rows: PriceRow[]): number | null {
  const imps = rows.map((r) => americanToImplied(r.price)).filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!imps.length) return null;
  const mid = Math.floor(imps.length / 2);
  return imps.length % 2 ? imps[mid] : (imps[mid - 1] + imps[mid]) / 2;
}

/**
 * Confidence from measurable, transparent factors:
 *   - book agreement (how many books priced it) -> liquidity/consensus signal
 *   - size of the edge -> bigger value = more conviction
 *   - data quality -> LOW cuts it hard
 * This is intentionally modest; there is no hidden model. All inputs are real.
 */
function baselineConfidence(edgePts: number, booksSeen: number): number {
  let c = 45;
  c += Math.min(20, Math.max(0, edgePts) * 4);       // up to +20 for edge
  c += Math.min(20, Math.max(0, booksSeen - 1) * 3); // up to +20 for consensus breadth
  return Math.max(0, Math.min(100, Math.round(c)));
}

function twoWayFairProbs(
  books: GameOdds["books"], marketKey: OddsMarket["key"], nameA: string, nameB: string,
): { a: number; b: number } | null {
  const ia = medianImplied(pricesFor(books, marketKey, nameA));
  const ib = medianImplied(pricesFor(books, marketKey, nameB));
  return noVig(ia, ib);
}

/** Build opportunities for a single game's odds. Only emits real, priced picks. */
export function analyzeGame(g: GameOdds): Opportunity[] {
  const out: Opportunity[] = [];
  const matchup = `${g.awayTeam} @ ${g.homeTeam}`;
  // Provider gives no injuries/lineups here -> data quality is capped at MEDIUM.
  const dq: DataQuality = "MEDIUM";

  const consider = (
    betType: Opportunity["betType"], marketKey: OddsMarket["key"],
    selName: string, oppName: string, label: string,
  ) => {
    const rows = pricesFor(g.books, marketKey, selName);
    const best = bestPrice(rows);
    if (!best) return; // no real price -> emit nothing
    const implied = americanToImplied(best.price);
    const fair = twoWayFairProbs(g.books, marketKey, selName, oppName);
    if (implied == null || !fair) return;
    const modelProb = fair.a; // baseline model = market consensus fair prob
    const edge = edgePoints(modelProb, implied);
    if (edge == null) return;
    const base = baselineConfidence(edge, rows.length);
    const confidence = applyDataQuality(base, dq);
    const classification = classify(edge, confidence);
    const pointStr = best.point != null ? ` ${best.point > 0 ? "+" : ""}${best.point}` : "";
    out.push({
      league: g.league,
      matchup,
      commenceTime: g.commenceTime,
      betType,
      selection: `${label}${pointStr}`,
      book: best.book,
      oddsAmerican: best.price,
      impliedProb: implied,
      fairProb: fair.a,
      modelProb,
      edgePts: edge,
      confidence,
      dataQuality: dq,
      classification,
      booksSeen: rows.length,
      reasoning:
        `Best price ${best.price > 0 ? "+" : ""}${best.price} at ${best.book} implies ${(implied * 100).toFixed(1)}%, ` +
        `vs a no-vig market consensus of ${(modelProb * 100).toFixed(1)}% across ${rows.length} book(s). ` +
        (edge > 0
          ? `That is a ${edge.toFixed(1)}-pt price edge from line-shopping the consensus.`
          : `No positive price edge vs consensus — not a value spot.`),
      supporting: [
        `${rows.length} book(s) priced this market (consensus breadth).`,
        `No-vig fair prob ${(modelProb * 100).toFixed(1)}% vs priced ${(implied * 100).toFixed(1)}%.`,
      ],
      risks: [
        "Model prob here is market-consensus only; no injury/lineup/situational data is connected yet.",
        "Odds move — verify the price is still live before betting.",
      ],
      invalidators: [
        "Line moves past the listed price.",
        "A key injury, scratch, or lineup/pitcher change before start.",
      ],
    });
  };

  // Moneyline (h2h): home & away
  consider("moneyline", "h2h", g.homeTeam, g.awayTeam, `${g.homeTeam} ML`);
  consider("moneyline", "h2h", g.awayTeam, g.homeTeam, `${g.awayTeam} ML`);
  // Spreads
  consider("spread", "spreads", g.homeTeam, g.awayTeam, `${g.homeTeam}`);
  consider("spread", "spreads", g.awayTeam, g.homeTeam, `${g.awayTeam}`);
  // Totals
  consider("total", "totals", "Over", "Under", "Over");
  consider("total", "totals", "Under", "Over", "Under");

  return out;
}

/** Analyze many games and rank by statistical edge (not by favorite). */
export function rankOpportunities(games: GameOdds[]): Opportunity[] {
  const all = games.flatMap(analyzeGame);
  return all.sort((a, b) => {
    // Rank by edge first, then confidence — never by "biggest favorite".
    if (b.edgePts !== a.edgePts) return b.edgePts - a.edgePts;
    return b.confidence - a.confidence;
  });
}

/** Best moneylines ranked by edge (not by shortest price). */
export function bestMoneylines(games: GameOdds[]): Opportunity[] {
  return rankOpportunities(games).filter((o) => o.betType === "moneyline");
}

export { decimalToAmerican };
