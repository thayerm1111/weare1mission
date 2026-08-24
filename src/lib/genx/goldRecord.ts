/**
 * GENX gold track-record math — the single source of truth for turning raw
 * `genx_signals` rows into a desk record.
 *
 * Two corrections live here so every surface (FLOW stats, follower, genx-stats)
 * reads the SAME honest numbers:
 *
 *  1. DEDUPE FAN-OUT. One market call is copied to every credited member, so the
 *     ledger holds many byte-identical rows (same direction/entry/stop/tp1) for a
 *     single signal. Counting all of them multiplies the record by the member
 *     count. We collapse to ONE row per signal — the desk record is per-CALL, not
 *     per-member. (Same dedupe the forex track record already applies.)
 *
 *  2. PRICE-DERIVED PIPS. Banked pips come from the actual filled price vs entry at
 *     the standard gold pip (0.1), so a row with a hit flag but a missing *_pips
 *     value is still scored correctly (falls back to the stored pips only if a
 *     price is unavailable).
 */

export const GOLD_PIP = 0.1;

export type GoldSig = {
  created_at?: string; resolved_at?: string | null; direction: string | null; outcome: string | null;
  entry?: number | null; stop_loss?: number | null; tp1?: number | null; tp2?: number | null; tp3?: number | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  tp1_hit: boolean | null; tp2_hit: boolean | null; tp3_hit: boolean | null;
  mfe_pips?: number | null; // max favorable excursion (pips) reached before the trade closed
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// MANAGED-RECORD RULE. With manage mode on, the stop moves to breakeven once a trade is
// up ~half its risk (+0.5R). So a signal that FIRST ran to +0.5R and only later returned
// to its original stop would, on a managed account, have exited flat at breakeven — it is
// NOT a loss. We reclassify those as a WIN worth ~0 pips (a scratch), using the max
// favorable excursion the resolver already recorded. A signal that ran straight to the
// stop without ever reaching +0.5R stays a loss.
const BE_TRIGGER_R = 0.5;   // matches the trade-manager's breakeven trigger
const BE_MIN_PIPS = 8;      // gold floor (matches BE_MIN_PIPS * gold pip)

/** True when the trade's favorable excursion reached the breakeven trigger before closing. */
export function reachedBreakeven(s: GoldSig): boolean {
  const e = num(s.entry), st = num(s.stop_loss), mfe = num(s.mfe_pips ?? null);
  if (e == null || st == null || mfe == null) return false;
  const rPips = Math.abs(e - st) / GOLD_PIP;
  const trigger = Math.max(BE_TRIGGER_R * rPips, BE_MIN_PIPS);
  return mfe >= trigger;
}

/** Is this signal a win? A real target OR a stop that was first saved at breakeven. */
export function goldIsWin(s: GoldSig): boolean {
  if (s.outcome === "WIN") return true;
  if (s.outcome === "LOSS" && reachedBreakeven(s)) return true;
  return false;
}

/** Signed pips for a signal under the managed record: a target win banks its filled pips,
 *  a breakeven-saved trade banks ~0 (scratch), a genuine loss loses the stop distance. */
export function goldOutcomePips(s: GoldSig): number {
  if (s.outcome === "WIN") return goldWinPips(s);
  if (s.outcome === "LOSS" && reachedBreakeven(s)) return 0;
  return -goldLossPips(s);
}

/** Pips banked on a win — highest FILLED target's price vs entry (pip 0.1),
 *  falling back to the stored pips only when a price is missing. */
export function goldWinPips(s: GoldSig): number {
  const e = num(s.entry);
  const lvl = (s.tp3_hit && num(s.tp3) != null) ? num(s.tp3)
    : (s.tp2_hit && num(s.tp2) != null) ? num(s.tp2)
    : (s.tp1_hit && num(s.tp1) != null) ? num(s.tp1) : num(s.tp1);
  if (e != null && lvl != null) return Math.round(Math.abs(lvl - e) / GOLD_PIP);
  if (s.tp3_hit && s.tp3_pips) return s.tp3_pips;
  if (s.tp2_hit && s.tp2_pips) return s.tp2_pips;
  if (s.tp1_hit && s.tp1_pips) return s.tp1_pips;
  return s.tp1_pips ?? 0;
}

/** Pips lost on a stop — stop price vs entry (pip 0.1), falling back to stored pips. */
export function goldLossPips(s: GoldSig): number {
  const e = num(s.entry), st = num(s.stop_loss);
  if (e != null && st != null) return Math.round(Math.abs(st - e) / GOLD_PIP);
  return s.stop_pips ?? 0;
}

/** Collapse fan-out: keep one row per distinct signal (direction + entry + stop +
 *  tp1). Byte-identical copies across members share this key; genuinely different
 *  signals (different price levels) never do. WIN/LOSS only, order preserved. */
export function dedupeGold<T extends GoldSig>(rows: T[]): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const r of rows) {
    if (r.outcome !== "WIN" && r.outcome !== "LOSS") continue;
    const key = `${String(r.direction || "").toLowerCase()}|${num(r.entry) ?? "?"}|${num(r.stop_loss) ?? "?"}|${num(r.tp1) ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(r);
  }
  return out;
}

export type GoldTally = {
  wins: number; losses: number; trades: number;
  grossWon: number; grossLost: number; net: number;
  best: number; worst: number; winRate: number | null;
};

/** Deduped, price-derived desk tally from raw genx_signals rows. */
export function goldTally(rows: GoldSig[]): GoldTally {
  const ded = dedupeGold(rows);
  let wins = 0, losses = 0, grossWon = 0, grossLost = 0, best = 0, worst = 0;
  for (const s of ded) {
    if (goldIsWin(s)) {
      // Target win banks its filled pips; a breakeven-saved trade banks ~0 (scratch).
      const p = s.outcome === "WIN" ? goldWinPips(s) : 0;
      wins++; grossWon += p; if (p > best) best = p;
    } else {
      const p = goldLossPips(s); losses++; grossLost += p; if (-p < worst) worst = -p;
    }
  }
  const trades = wins + losses;
  return {
    wins, losses, trades,
    grossWon: Math.round(grossWon), grossLost: Math.round(grossLost), net: Math.round(grossWon - grossLost),
    best: Math.round(best), worst: Math.round(worst),
    winRate: trades ? Math.round((wins / trades) * 100) : null,
  };
}
