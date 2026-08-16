/**
 * Grading + calibration — the "learning" core.
 *
 *  - gradeBet: settles a logged call against the REAL final score (win/loss/
 *    push). Pure math on the actual result — never invented.
 *  - buildCalibration: rolls graded calls into per-segment performance and, for
 *    the league×bet-type segment, derives a calibration_factor (actual hit rate
 *    vs the model's expected hit rate, shrunk by sample size). The data route
 *    multiplies future confidence by that factor, so segments that historically
 *    under-perform get quieter and over-performers get a nudge. That's the
 *    honest feedback loop: it learns from outcomes, transparently.
 */
import { americanToDecimal } from "./odds";

function norm(s: string): string { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

export type GradeInput = { market: string; side: string; point: number | null; matchup: string };
export type Grade = "win" | "loss" | "push" | null;

/** Settle a bet given the real final scores. null if we can't determine it. */
export function gradeBet(g: GradeInput, finalHome: number | null, finalAway: number | null): Grade {
  if (finalHome == null || finalAway == null) return null;
  const parts = (g.matchup || "").split(" @ ");
  const away = (parts[0] || "").trim();
  const home = (parts[1] || "").trim();

  if (g.market === "totals") {
    if (g.point == null) return null;
    const total = finalHome + finalAway;
    if (total === g.point) return "push";
    const over = total > g.point;
    const side = (g.side || "").toLowerCase();
    if (side === "over") return over ? "win" : "loss";
    if (side === "under") return over ? "loss" : "win";
    return null;
  }

  // Team-based (moneyline h2h or spreads).
  const sideIsHome = norm(g.side) === norm(home);
  const sideIsAway = norm(g.side) === norm(away);
  if (!sideIsHome && !sideIsAway) return null;
  const my = sideIsHome ? finalHome : finalAway;
  const opp = sideIsHome ? finalAway : finalHome;
  const pt = g.market === "spreads" ? (g.point ?? 0) : 0;
  const adj = my + pt;
  if (adj === opp) return "push";
  return adj > opp ? "win" : "loss";
}

export type CalRec = {
  league: string; bet_type: string; classification: string | null;
  confidence: number | null; model_prob: number | null; odds_american: number | null;
  result: string; clv_pct: number | null;
};

export type CalRow = {
  bucket_type: string; bucket_key: string; bets: number; wins: number; losses: number; pushes: number;
  roi_pct: number | null; avg_clv_pct: number | null; net_units: number;
  expected_win_rate: number | null; actual_win_rate: number | null; calibration_factor: number;
};

/** Roll graded calls into performance buckets + calibration factors. */
export function buildCalibration(recs: CalRec[]): CalRow[] {
  const groups = new Map<string, { bt: string; bk: string; rows: CalRec[] }>();
  const add = (bt: string, bk: string, r: CalRec) => {
    const k = `${bt}::${bk}`;
    if (!groups.has(k)) groups.set(k, { bt, bk, rows: [] });
    groups.get(k)!.rows.push(r);
  };
  for (const r of recs) {
    if (!["win", "loss", "push"].includes(r.result)) continue;
    add("league_bettype", `${r.league}|${r.bet_type}`, r);
    add("classification", r.classification || "—", r);
    add("league", r.league, r);
    add("bet_type", r.bet_type, r);
    const c = r.confidence;
    const band = c == null ? "—" : `${Math.floor(c / 10) * 10}-${Math.floor(c / 10) * 10 + 9}`;
    add("confidence_band", band, r);
  }

  const out: CalRow[] = [];
  for (const { bt, bk, rows } of groups.values()) {
    let wins = 0, losses = 0, pushes = 0, net = 0, clvSum = 0, clvN = 0, expSum = 0, expN = 0, staked = 0;
    for (const r of rows) {
      const dec = americanToDecimal(r.odds_american) ?? 1;
      if (r.result === "win") { wins++; net += dec - 1; staked += 1; }
      else if (r.result === "loss") { losses++; net += -1; staked += 1; }
      else if (r.result === "push") { pushes++; }
      if (r.clv_pct != null) { clvSum += r.clv_pct; clvN++; }
      if (r.model_prob != null) { expSum += r.model_prob; expN++; }
    }
    const decided = wins + losses;
    const actual = decided ? wins / decided : null;
    const expected = expN ? expSum / expN : null;

    // Calibration factor only for the segment we actually feed back, and only
    // with a real sample. Shrunk toward 1 so small samples barely move it.
    let factor = 1;
    if (bt === "league_bettype" && actual != null && expected && expected > 0 && decided >= 8) {
      const raw = actual / expected;
      const shrink = Math.min(1, decided / 30);
      factor = Math.max(0.6, Math.min(1.4, 1 + (raw - 1) * shrink));
    }

    out.push({
      bucket_type: bt, bucket_key: bk, bets: rows.length, wins, losses, pushes,
      roi_pct: staked ? +((net / staked) * 100).toFixed(1) : null,
      avg_clv_pct: clvN ? +(clvSum / clvN).toFixed(2) : null,
      net_units: +net.toFixed(2),
      expected_win_rate: expected != null ? +(expected * 100).toFixed(1) : null,
      actual_win_rate: actual != null ? +(actual * 100).toFixed(1) : null,
      calibration_factor: +factor.toFixed(3),
    });
  }
  return out;
}

/** Look up the feedback factor for a league×bet-type from stored cal rows. */
export function calibrationFactor(cal: { bucket_type: string; bucket_key: string; calibration_factor: number }[], league: string, betType: string): number {
  const row = cal.find((c) => c.bucket_type === "league_bettype" && c.bucket_key === `${league}|${betType}`);
  return row ? row.calibration_factor : 1;
}
