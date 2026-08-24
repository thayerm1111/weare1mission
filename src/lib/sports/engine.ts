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
import { modelBlendWeight, blendSide, type GameModel } from "./model";

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
  onPreferredBook: boolean;               // true if the evaluated price is your book (e.g. Bovada)
  betterElsewhere: { book: string; price: number } | null; // a sharper price at another book, if any
  market: OddsMarket["key"];              // 'h2h' | 'spreads' | 'totals' (for grading)
  side: string;                           // team name or 'Over'/'Under' (for grading)
  point: number | null;                   // spread/total line (for grading)
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

/**
 * Build opportunities for a single game's odds. Only emits real, priced picks.
 *
 * preferredBook (e.g. "bovada"): when set, we evaluate the EXACT price at that
 * book — the line you can actually bet — and compute the edge on it. If the book
 * hasn't posted that market, we fall back to the best available price and flag
 * it. Either way we still surface whether a sharper price exists elsewhere, as
 * line-shopping context only. Never fabricates a number.
 */
export function analyzeGame(g: GameOdds, preferredBook?: string | null, model?: GameModel): Opportunity[] {
  const out: Opportunity[] = [];
  const matchup = `${g.awayTeam} @ ${g.homeTeam}`;
  // Provider gives no injuries/lineups here -> data quality is capped at MEDIUM.
  const dq: DataQuality = "MEDIUM";
  const pref = preferredBook ? preferredBook.toLowerCase() : null;
  // Model win probabilities (from real ESPN context) apply to the MONEYLINE only in v1.
  const modelW = model ? modelBlendWeight(model) : 0;
  const modelApplied = !!model?.applied && modelW > 0;

  const consider = (
    betType: Opportunity["betType"], marketKey: OddsMarket["key"],
    selName: string, oppName: string, label: string,
  ) => {
    const rows = pricesFor(g.books, marketKey, selName);
    if (!rows.length) return; // no real price -> emit nothing
    const best = bestPrice(rows);
    if (!best) return;
    // The price we EVALUATE: your book's actual line if it posted one, else best available.
    const prefRow = pref ? rows.find((r) => r.book.toLowerCase() === pref) : null;
    const primary = prefRow || best;
    const onPreferredBook = !!prefRow;
    const implied = americanToImplied(primary.price);
    const fair = twoWayFairProbs(g.books, marketKey, selName, oppName);
    if (implied == null || !fair) return;
    // MODEL: on the moneyline, blend the AI's OWN win prob (built from real ESPN context) toward
    // the market fair line so the edge reflects genuine model-vs-market disagreement. Other
    // markets stay on the market-consensus baseline until the model is extended to margins (v1).
    const usingModel = modelApplied && betType === "moneyline" && model != null;
    const rawModelSide = usingModel ? (selName === g.homeTeam ? model!.pHome : model!.pAway) : null;
    const modelProb = usingModel ? blendSide(rawModelSide!, fair.a, modelW) : fair.a;
    const edge = edgePoints(modelProb, implied);
    if (edge == null) return;
    const base = baselineConfidence(edge, rows.length);
    // OUTLIER GUARD: a real market almost never leaves a huge price gap vs the consensus, so a
    // giant MARKET-only edge is a likely stale/limited line. A MODEL edge is a real disagreement,
    // so its distrust bar is higher (12 vs 8 pts) before we downgrade it.
    const OUTLIER_PTS = usingModel ? 12 : 8;
    const isOutlier = edge >= OUTLIER_PTS;
    // Data quality: the model's own quality when it drove the number; else the market baseline.
    const dqEff: DataQuality = isOutlier ? "LOW" : (usingModel ? model!.dataQuality : dq);
    const confidence = isOutlier ? Math.min(applyDataQuality(base, dqEff), 32) : applyDataQuality(base, dqEff);
    const classification = classify(edge, confidence);
    const pointStr = primary.point != null ? ` ${primary.point > 0 ? "+" : ""}${primary.point}` : "";
    // Is there a meaningfully better number elsewhere? (context only — you bet your book.)
    const betterElsewhere = best.book.toLowerCase() !== primary.book.toLowerCase()
      && (americanToDecimal(best.price) ?? 0) > (americanToDecimal(primary.price) ?? 0)
      ? { book: best.book, price: best.price } : null;
    const bookLabel = onPreferredBook ? primary.book : `${primary.book} (best avail.)`;

    const supporting = [
      `${rows.length} book(s) priced this market (consensus breadth).`,
      usingModel
        ? `Model win prob ${(modelProb * 100).toFixed(1)}% (blended ${Math.round(modelW * 100)}% model / ${Math.round((1 - modelW) * 100)}% market) vs your priced ${(implied * 100).toFixed(1)}%.`
        : `No-vig fair prob ${(modelProb * 100).toFixed(1)}% vs your priced ${(implied * 100).toFixed(1)}%.`,
    ];
    if (usingModel && model) for (const f of model.factors) supporting.push(`Model: ${f}`);
    if (betterElsewhere) supporting.push(`A sharper price exists at ${betterElsewhere.book} (${betterElsewhere.price > 0 ? "+" : ""}${betterElsewhere.price}) — context only.`);

    const risks = [
      usingModel
        ? "Model uses real records, MLB starters and injuries — but not full lineups or advanced metrics — and is blended with the market. Treat it as a data-informed lean, not certainty."
        : "Model prob here is market-consensus only; no injury/lineup/situational data is baked into this number.",
      "Odds move — verify the price is still live at your book before betting.",
    ];
    if (isOutlier) {
      risks.unshift(
        `⚠ OUTLIER PRICE: this ${edge.toFixed(1)}-pt gap vs the market is almost certainly a stale or limited line — not free money. ` +
        `Real markets don't leave value this big. Confirm the number is actually bettable at real limits and isn't a bad/old line before trusting it.`,
      );
    }

    out.push({
      league: g.league,
      matchup,
      commenceTime: g.commenceTime,
      betType,
      selection: `${label}${pointStr}`,
      book: primary.book,
      oddsAmerican: primary.price,
      impliedProb: implied,
      fairProb: fair.a,
      modelProb,
      edgePts: edge,
      confidence,
      dataQuality: dqEff,
      classification,
      booksSeen: rows.length,
      onPreferredBook,
      betterElsewhere,
      market: marketKey,
      side: selName,
      point: primary.point,
      reasoning:
        `${bookLabel} price ${primary.price > 0 ? "+" : ""}${primary.price} implies ${(implied * 100).toFixed(1)}%, vs ` +
        (usingModel
          ? `the AI model's ${(modelProb * 100).toFixed(1)}% win prob (real records/starters/injuries, blended with the market) `
          : `a no-vig market consensus of ${(modelProb * 100).toFixed(1)}% `) +
        `across ${rows.length} book(s). ` +
        (isOutlier
          ? `That is a ${edge.toFixed(1)}-pt gap — implausibly large, so treat it as a likely stale/limited line, NOT a real edge.`
          : edge > 0
            ? `That is a ${edge.toFixed(1)}-pt ${usingModel ? "model" : "value"} edge on the line you can bet.`
            : `No positive edge at this price — not a value spot.`) +
        (prefRow ? "" : pref ? ` (${pref} hasn't posted this market; showing best available.)` : ""),
      supporting,
      risks,
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

/** Analyze many games and rank by statistical edge (not by favorite). `models` (keyed by game
 *  id) injects the AI win-probability model per game; omit it to run pure market-consensus. */
export function rankOpportunities(games: GameOdds[], preferredBook?: string | null, models?: Map<string, GameModel>): Opportunity[] {
  const all = games.flatMap((g) => analyzeGame(g, preferredBook, models?.get(g.gameId)));
  return all.sort((a, b) => {
    // Rank by edge first, then confidence — never by "biggest favorite".
    if (b.edgePts !== a.edgePts) return b.edgePts - a.edgePts;
    return b.confidence - a.confidence;
  });
}

/** Best moneylines ranked by edge (not by shortest price). */
export function bestMoneylines(games: GameOdds[], preferredBook?: string | null, models?: Map<string, GameModel>): Opportunity[] {
  return rankOpportunities(games, preferredBook, models).filter((o) => o.betType === "moneyline");
}

export { decimalToAmerican };
