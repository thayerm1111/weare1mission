/**
 * GENX REAL-TRADE RESULTS (owner 09-15) — the Floor's gold record, built ONLY from trades
 * GENX actually fired to real broker accounts (flow_managed_positions), grouped by how each
 * account handled the trade:
 *
 *   be_on       — break-even on (manager moved the stop)
 *   be_off      — break-even off
 *   self_manage — the member closed it by hand (outcome 'manual')
 *   play_out    — management off; the original stop/target played out
 *
 * Pips are the realized result on that account (result_pips, gold pip = 0.1). One GENX fire
 * lands on many accounts; a "fire" is a cluster of same-side entries within FIRE_GAP_MS.
 */
export type ManageStyle = "be_on" | "be_off" | "play_out";
export type Bucket = "be_on" | "be_off" | "self_manage" | "play_out";
export const BUCKETS: Bucket[] = ["be_on", "be_off", "self_manage", "play_out"];

export type RealRow = {
  side: string;
  outcome: string | null;
  result_pips: number | string | null;
  created_at: string;
  resolved_at: string | null;
  manage_style: string | null;
  status?: string | null;
};

export const FIRE_GAP_MS = 10 * 60 * 1000;

/** Which of the four results a trade counts toward. null = not countable (yet). */
export function bucketOf(r: Pick<RealRow, "outcome" | "manage_style">): Bucket | null {
  if (r.outcome === "excluded") return null;
  if (r.outcome === "manual") return "self_manage";
  if (r.manage_style === "be_on" || r.manage_style === "be_off" || r.manage_style === "play_out") return r.manage_style;
  return null;
}

export type BucketStats = { trades: number; fires: number; wins: number; losses: number; breakeven: number; winRate: number | null; avgPips: number | null; netPips: number };
const empty = () => ({ trades: 0, wins: 0, losses: 0, breakeven: 0, net: 0, fires: new Set<number>() });

/** Assign each row a fire index: same side, each entry within FIRE_GAP_MS of the previous one. */
export function clusterFires<T extends Pick<RealRow, "side" | "created_at">>(rows: T[]): { row: T; fire: number; firedAt: string; side: string }[] {
  const sorted = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const last = new Map<string, { t: number; fire: number; firedAt: string }>();
  let next = 0;
  return sorted.map((row) => {
    const side = String(row.side || "").toLowerCase();
    const t = new Date(row.created_at).getTime();
    const prev = last.get(side);
    let cur: { t: number; fire: number; firedAt: string };
    if (prev && t - prev.t <= FIRE_GAP_MS) cur = { t, fire: prev.fire, firedAt: prev.firedAt };
    else cur = { t, fire: next++, firedAt: row.created_at };
    last.set(side, cur);
    return { row, fire: cur.fire, firedAt: cur.firedAt, side };
  });
}

const pipsOf = (r: RealRow) => { const n = Number(r.result_pips); return Number.isFinite(n) ? n : 0; };
const closed = (r: RealRow) => r.outcome != null && r.outcome !== "excluded";

export type FireRec = { at: string; side: string; accounts: number; open: number; results: Partial<Record<Bucket, { trades: number; avgPips: number }>>; avgPips: number | null;
  /** Best realized result among the accounts that closed (null until one has). Additive: no existing number uses it. */
  bestPips: number | null;
  /** Any account on this fire closed at break-even (outcome "breakeven" or exactly 0 pips). */
  anyBreakeven: boolean;
  /** Every closed account on this fire hit its stop (nothing hand-closed, trailed or targeted). */
  allStops: boolean };

export function buildRealResults(rows: RealRow[]) {
  const tagged = clusterFires(rows);
  const acc = new Map<Bucket, ReturnType<typeof empty>>(BUCKETS.map((b) => [b, empty()]));
  const fires = new Map<number, { at: string; side: string; accounts: number; open: number; sum: number; n: number; best: number | null; be: boolean; stops: number; by: Map<Bucket, { sum: number; n: number }> }>();
  let open = 0;

  for (const { row, fire, firedAt, side } of tagged) {
    let f = fires.get(fire);
    if (!f) { f = { at: firedAt, side, accounts: 0, open: 0, sum: 0, n: 0, best: null, be: false, stops: 0, by: new Map() }; fires.set(fire, f); }
    f.accounts++;
    if (!closed(row)) { f.open++; open++; continue; }
    const b = bucketOf(row);
    if (!b) continue;
    const p = pipsOf(row);
    const t = acc.get(b)!;
    t.trades++; t.net += p; t.fires.add(fire);
    if (p > 0) t.wins++; else if (p < 0) t.losses++; else t.breakeven++;
    f.sum += p; f.n++;
    if (f.best == null || p > f.best) f.best = p;
    if (row.outcome === "breakeven" || p === 0) f.be = true;
    if (row.outcome === "stop") f.stops++;
    const fb = f.by.get(b) ?? { sum: 0, n: 0 }; fb.sum += p; fb.n++; f.by.set(b, fb);
  }

  const buckets = Object.fromEntries(BUCKETS.map((b) => {
    const t = acc.get(b)!;
    const decided = t.wins + t.losses;
    const s: BucketStats = {
      trades: t.trades, fires: t.fires.size, wins: t.wins, losses: t.losses, breakeven: t.breakeven,
      winRate: decided ? Math.round((t.wins / decided) * 100) : null,
      avgPips: t.trades ? Math.round(t.net / t.trades) : null,
      netPips: Math.round(t.net),
    };
    return [b, s];
  })) as Record<Bucket, BucketStats>;

  const fireList: FireRec[] = [...fires.values()].map((f) => ({
    at: f.at, side: f.side, accounts: f.accounts, open: f.open,
    avgPips: f.n ? Math.round(f.sum / f.n) : null,
    bestPips: f.best == null ? null : Math.round(f.best),
    anyBreakeven: f.be,
    allStops: f.n > 0 && f.stops === f.n,
    results: Object.fromEntries([...f.by.entries()].map(([b, v]) => [b, { trades: v.n, avgPips: Math.round(v.sum / v.n) }])),
  })).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const decidedFires = fireList.filter((f) => f.open === 0 && f.avgPips != null);
  const fireWins = decidedFires.filter((f) => (f.avgPips ?? 0) > 0).length;
  const fireLosses = decidedFires.filter((f) => (f.avgPips ?? 0) < 0).length;

  return {
    fires: fireList.length,
    openTrades: open,
    buckets,
    recentFires: fireList.slice(0, 16),
    recentFiresAll: fireList,
    // Desk-level summary: each fully-closed fire counts once, at the average realized result
    // across every account that took it.
    summary: {
      trades: decidedFires.length, wins: fireWins, losses: fireLosses,
      winRate: fireWins + fireLosses ? Math.round((fireWins / (fireWins + fireLosses)) * 100) : null,
      netPips: Math.round(decidedFires.reduce((a, f) => a + (f.avgPips ?? 0), 0)),
      grossWon: Math.round(decidedFires.reduce((a, f) => a + Math.max(0, f.avgPips ?? 0), 0)),
    },
  };
}
