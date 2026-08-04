/**
 * xGhost — ranking + correlated-exposure guard.
 *
 * Ranks the five analysed pairs, picks the single best tradeable setup, and only
 * allows a SECOND signal when it is (a) independently high quality and (b) NOT
 * the same USD trade expressed through another correlated pair. This is the
 * capital-protection rule that stops "EURUSD long + GBPUSD long + AUDUSD long"
 * from being sent as three independent trades when it is really one short-USD bet.
 */
import type { XCandidate } from "./engine";

const rankKey = (c: XCandidate): number => {
  // tradeable first, then developing signals, then watchlist, then no-trade — each by score
  const stateRank = c.execState === "ENTER_NOW" ? 5 : c.execState === "LIMIT_ENTRY" ? 4 : c.execState === "WAIT_FOR_CONFIRMATION" ? 3 : c.execState === "WATCHLIST" ? 2 : 1;
  return stateRank * 1000 + c.score;
};

export type RankResult = {
  ranked: XCandidate[];
  best: XCandidate | null;         // the single best tradeable OR developing setup
  second: XCandidate | null;       // an allowed, uncorrelated second signal (rare)
  suppressed: { symbol: string; reason: string }[];
  anyTradeable: boolean;
};

export function rankAndGuard(cands: XCandidate[]): RankResult {
  const ranked = [...cands].sort((a, b) => rankKey(b) - rankKey(a));
  const suppressed: { symbol: string; reason: string }[] = [];

  const tradeables = ranked.filter((c) => c.execState === "ENTER_NOW" || c.execState === "LIMIT_ENTRY" || c.execState === "WAIT_FOR_CONFIRMATION");
  const anyTradeable = tradeables.length > 0;
  const best = ranked[0] || null;
  const primary = tradeables[0] || null;

  let second: XCandidate | null = null;
  if (primary) {
    for (const c of tradeables.slice(1)) {
      if (c.score < 78) { suppressed.push({ symbol: c.symbol, reason: "below the independent-quality bar for a second trade" }); continue; }
      if (c.usdLeg && c.usdLeg === primary.usdLeg) {
        suppressed.push({ symbol: c.symbol, reason: `same ${c.usdLeg} exposure as ${primary.label} — correlated, not a second trade` });
        continue;
      }
      second = c; break;
    }
    // annotate correlated tradeables so the UI can warn even if not "second"
    for (const c of tradeables) {
      if (c !== primary && c.usdLeg && c.usdLeg === primary.usdLeg && c !== second) {
        if (!c.conflicting.includes("correlated")) c.conflicting.push(`Correlated ${c.usdLeg} exposure with ${primary.label} — treat as one dollar bet.`);
      }
    }
  }

  return { ranked, best: primary || best, second, suppressed, anyTradeable };
}
