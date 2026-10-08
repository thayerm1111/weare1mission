/**
 * HOW FLOW LOOKS AFTER AN OPEN TRADE — THE MEMBER'S THREE CHOICES (owner 10-08: "Let's change from AI
 * PIPs to picking breakeven, AI management (follow price and taking partials), giving the customer the
 * opportunity to tweak how they want the AI to trade").
 *
 *   Break-even    Off, or 20 / 30 / 40 / 50 pips. A gold trade's stop moves into profit once the trade is
 *                 that many pips up. Currency pairs keep their own rule, halfway to the target — a pip
 *                 count picked for gold would sit past the whole target on EUR/USD.
 *   Follow price  Off, Tight, Normal or Loose. Once break-even is set, the stop follows the best price,
 *                 and on gold it also snaps in when the market turns against a trade that has run 50+
 *                 pips. It needs break-even: with break-even off there is no protected trade to follow.
 *   Partials      Off, 25% or 50% of the trade, banked halfway to its target.
 *
 * WHERE EVERY ACCOUNT STARTS (owner: "exactly what they have today"). "AI Pips" on meant break-even at
 * the account's own pips, the reversal snap and the trail; off meant nothing was touched. So on →
 * break-even at the same pips, follow price Normal (the trail and the snap exactly as they ran) and no
 * partials; off → all three off. The migration writes exactly that onto every account, and a row this
 * file is handed without the new columns reads the same way.
 *
 * Pure, so the manager, the settings API and the tests all read one rule.
 */

export type FollowMode = "off" | "tight" | "normal" | "loose";
export const FOLLOW_MODES: readonly FollowMode[] = ["off", "tight", "normal", "loose"];
export type PartialPct = 0 | 25 | 50;
export const PARTIAL_CHOICES: readonly PartialPct[] = [0, 25, 50];
/** The break-even distances a member can pick (gold pips). */
export const BE_PIPS_CHOICES: readonly number[] = [20, 30, 40, 50];
/** A gold account that never picked a number breaks even here (owner 09-07: "30-35 pips into profit"). */
export const DEFAULT_GOLD_BE_PIPS = 30;

/** The columns of flow_broker_accounts that say how an open trade is looked after. */
export type MgmtRow = {
  manage_trades?: boolean | null;
  be_enabled?: boolean | null;
  gold_be_pips?: number | string | null;
  trail_mode?: string | null;
  partial_pct?: number | string | null;
};

export type Mgmt = {
  /** Anything at all is looked after. Off, the trade rides exactly the stop and target it was placed with —
   *  the manager does not even put back a stop or target the broker dropped (as with AI Pips off). */
  manage: boolean;
  breakEven: boolean;
  /** Gold break-even distance in pips. An account's own older number (10, 15, 35…) is kept until it picks another. */
  goldBePips: number;
  /** What runs: "off" whenever break-even is off. */
  follow: FollowMode;
  /** What the member picked. Kept while break-even is off, so it comes back when break-even does. */
  followChoice: FollowMode;
  partialPct: PartialPct;
};

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

export function goldPipsOf(v: unknown): number {
  const n = num(v);
  return n != null && n > 0 ? n : DEFAULT_GOLD_BE_PIPS;
}
/** A stored follow mode. Nothing stored (an account from before 10-08, or one connected since) is Normal — AI Pips on. */
export function followOf(v: unknown): FollowMode {
  const s = String(v ?? "").trim().toLowerCase();
  return (FOLLOW_MODES as readonly string[]).includes(s) ? (s as FollowMode) : "normal";
}
export function partialOf(v: unknown): PartialPct {
  const n = num(v);
  return n === 25 || n === 50 ? n : 0;
}

/** An account row → what the manager does with that account's open trades. A missing row reads as AI Pips on. */
export function resolveMgmt(row: MgmtRow | null | undefined): Mgmt {
  const r = row ?? {};
  // The old one switch (manage_trades) decides only for a row that has never been on these settings —
  // trail_mode unset — and there it is AI Pips, on or off. Once a row is on them (every row after the
  // migration's backfill, and any row a member has changed since), the three settings are the whole
  // truth and manage_trades is only their summary, kept for the readers that still look at it: a flag
  // left behind by two saves landing together can never switch a member's partial or break-even off.
  const master = r.trail_mode == null ? r.manage_trades !== false : true;
  // On such a row be_enabled is not read either: AI Pips never read it (27 accounts still carry a false
  // from before 09-22), and a member's change always stores trail_mode alongside the break-even it sets.
  const breakEven = master && (r.trail_mode == null || r.be_enabled !== false);
  // Nothing stored yet reads the way the migration fills it in: Normal under AI Pips on, off under off.
  const followChoice = r.trail_mode == null ? (master ? "normal" : "off") : followOf(r.trail_mode);
  const partialPct: PartialPct = master ? partialOf(r.partial_pct) : 0;
  return {
    manage: master && (breakEven || partialPct > 0),
    breakEven,
    goldBePips: goldPipsOf(r.gold_be_pips),
    follow: breakEven ? followChoice : "off",
    followChoice,
    partialPct,
  };
}

/**
 * One broker account can sit on more than one row — the same login connected twice (a dozen members
 * have it). The manager has always read every row for the account and let OFF win: AI Pips off on any
 * row meant the account's trades were left alone, and the gold pips were the last row that set one. So
 * the rows combine the same way: break-even, follow price and partials are on only where every row has
 * them on (partials at the smallest share, follow price Normal if the rows disagree on how tight), and
 * the gold pips are the last row's own number.
 */
export function mergeMgmt(rows: ReadonlyArray<MgmtRow>): Mgmt {
  if (!rows.length) return resolveMgmt(null);
  const each = rows.map(resolveMgmt);                // each row already reads as all-off under the old switch off
  const breakEven = each.every((m) => m.breakEven);
  const partialPct = Math.min(...each.map((m) => m.partialPct)) as PartialPct;
  let pips = DEFAULT_GOLD_BE_PIPS;
  for (const r of rows) { const n = num(r.gold_be_pips); if (n != null && n > 0) pips = n; }
  const choices = each.map((m) => m.followChoice);
  const followChoice: FollowMode = choices.includes("off") ? "off" : choices.every((c) => c === choices[0]) ? choices[0] : "normal";
  return { manage: breakEven || partialPct > 0, breakEven, goldBePips: pips, follow: breakEven ? followChoice : "off", followChoice, partialPct };
}

/** What AI Pips did, for the record and the tests: on = break-even + the snap + the trail; off = nothing. */
export function legacyAiPips(row: { manage_trades?: boolean | null; gold_be_pips?: number | string | null }): Mgmt {
  const on = row.manage_trades !== false;
  return { manage: on, breakEven: on, goldBePips: goldPipsOf(row.gold_be_pips), follow: on ? "normal" : "off", followChoice: on ? "normal" : "off", partialPct: 0 };
}

/** The migration's backfill, row by row (supabase/migrations/20261008010000_flow_trade_management.sql). */
export function backfilled<T extends MgmtRow>(row: T): T {
  if (row.trail_mode != null) return row;            // already on the new settings — never reset a choice
  const on = row.manage_trades !== false;
  return { ...row, be_enabled: on, trail_mode: on ? "normal" : "off", partial_pct: 0 };
}

/* ── a member's change ──────────────────────────────────────────────────────────────────────────── */

/** `breakEven: "on"` (turn it back on at the pips the account already has) is only for the older screens'
 *  switches; the settings screen always sends a number. */
export type MgmtPatch = { breakEven?: "off" | "on" | number; follow?: FollowMode; partials?: PartialPct };

const choice = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN);

/** Reads `breakEven` ("off" | 20 | 30 | 40 | 50), `followPrice` and `partials` (0 | 25 | 50) from a request. Anything else is refused, with a line a member can read. */
export function parseMgmtPatch(body: Record<string, unknown>): { ok: true; patch: MgmtPatch } | { ok: false; detail: string } {
  const patch: MgmtPatch = {};
  if (body.breakEven !== undefined) {
    const v = body.breakEven;
    if (v === "off" || v === false) patch.breakEven = "off";
    else {
      const n = choice(v);
      if (!BE_PIPS_CHOICES.includes(n)) return { ok: false, detail: "Break-even is Off, 20, 30, 40 or 50 pips." };
      patch.breakEven = n;
    }
  }
  if (body.followPrice !== undefined) {
    const s = typeof body.followPrice === "string" ? body.followPrice.trim().toLowerCase() : "";
    if (!(FOLLOW_MODES as readonly string[]).includes(s)) return { ok: false, detail: "Follow price is Off, Tight, Normal or Loose." };
    patch.follow = s as FollowMode;
  }
  if (body.partials !== undefined) {
    const n = choice(body.partials);
    if (!(PARTIAL_CHOICES as readonly number[]).includes(n)) return { ok: false, detail: "Partials are Off, 25% or 50%." };
    patch.partials = n as PartialPct;
  }
  if (!Object.keys(patch).length) return { ok: false, detail: "Nothing to change." };
  return { ok: true, patch };
}

/**
 * The columns a change writes: only what the member changed, plus manage_trades worked out from the
 * whole — so two quick changes sent together cannot write over each other's setting. One exception: a
 * row the old one switch still governs (never on these settings, AI Pips off) gets break-even and
 * partials written whole, so it cannot come back on with a stale setting from underneath that switch.
 */
export function applyMgmtPatch(current: MgmtRow | null | undefined, patch: MgmtPatch): Record<string, unknown> {
  const cur = resolveMgmt(current);
  let be = cur.breakEven;
  let partial: PartialPct = cur.partialPct;
  const out: Record<string, unknown> = {};
  if (patch.breakEven !== undefined) {
    if (patch.breakEven === "off") be = false;
    else if (patch.breakEven === "on") be = true;
    else { be = true; out.gold_be_pips = patch.breakEven; }
    out.be_enabled = be;
  }
  if (patch.follow !== undefined) out.trail_mode = patch.follow;
  // A row with no follow choice stored yet (an account connected since the migration) gets the one it is
  // running on, so the migration's backfill — which fills rows without one — can never reset its choices.
  else if (current?.trail_mode == null) out.trail_mode = cur.followChoice;
  if (patch.partials !== undefined) { partial = patch.partials; out.partial_pct = partial; }
  if (current?.manage_trades === false && current?.trail_mode == null) { out.be_enabled = be; out.partial_pct = partial; }
  out.manage_trades = be || partial > 0;
  return out;
}

/** What the settings screens are sent. The first five keep the names older screens already read. */
export function mgmtView(row: MgmtRow | null | undefined) {
  const own = num(row?.gold_be_pips);
  return viewOf(resolveMgmt(row), own != null && own > 0 ? own : null);
}

/** The same for one broker account on several rows: what the manager runs for it (mergeMgmt), shown on each. */
export function mgmtViewMerged(rows: ReadonlyArray<MgmtRow>) {
  if (rows.length <= 1) return mgmtView(rows[0]);
  let own: number | null = null;
  for (const r of rows) { const n = num(r.gold_be_pips); if (n != null && n > 0) own = n; }
  return viewOf(mergeMgmt(rows), own);
}

function viewOf(m: Mgmt, own: number | null) {
  return {
    manageTrades: m.manage,
    beEnabled: m.breakEven,
    partialsEnabled: m.partialPct > 0,
    profitGuard: m.follow !== "off",
    goldBePips: own,
    breakEvenPips: m.goldBePips,
    followPrice: m.followChoice,
    followActive: m.follow !== "off",
    partialPct: m.partialPct,
  };
}

/* ── follow price ───────────────────────────────────────────────────────────────────────────────── */

/**
 * How far behind the best price the stop rides, as a share of the trade's risk (R). `near` is the
 * manager's own call that the trade is close to its target or its halfway mark.
 *
 *   Normal  0.6R, tightening to 0.25R near the target — the trail exactly as it ran before 10-08.
 *   Tight   0.15R from the first move past break-even: keeps more of a move, and a normal pullback
 *           can close the trade. Always at least as close as Normal.
 *   Loose   half as much room again as Normal (0.9R / 0.375R): rides pullbacks, gives back more.
 *
 * Tight is a flat 0.15R on purpose. FLOW parks a gold take-profit about half a risk away (nearTarget.ts),
 * so a trail that only tightens "near the target" — measured to GENX's far 1.9R plan — almost never
 * tightens on gold before the take-profit fills. A member who asks for tight has to feel it there.
 */
export const FOLLOW_GIVEBACK_R: Record<Exclude<FollowMode, "off">, { far: number; near: number }> = {
  tight: { far: 0.15, near: 0.15 },
  normal: { far: 0.6, near: 0.25 },
  loose: { far: 0.9, near: 0.375 },
};

export function followGivebackR(mode: FollowMode, near: boolean): number | null {
  if (mode === "off") return null;
  const g = FOLLOW_GIVEBACK_R[mode];
  return near ? g.near : g.far;
}

/* ── partials ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * The target a trade will actually close at, for "halfway to the target": the broker's own take-profit
 * when it is readable and on the winning side (it is what will fill, and it is the member's if they
 * moved it), else the near target FLOW parks for gold, else the plan's own target. The first candidate
 * on the winning side of the entry wins; null when there is none.
 */
export function targetInForce(side: string, entry: number, candidates: ReadonlyArray<number | null | undefined>): number | null {
  const long = String(side).toLowerCase() === "buy";
  for (const c of candidates) {
    if (c != null && Number.isFinite(c) && c > 0 && (long ? c > entry : c < entry)) return c;
  }
  return null;
}

/** Halfway from the entry to the target in force. */
export function partialTriggerPrice(entry: number, target: number | null): number | null {
  return target == null || !Number.isFinite(target) ? null : (entry + target) / 2;
}

/** A database without a column (the code running before its migration) — the one read failure that is
 *  answered by reading fewer columns. Anything else (a timeout, a server error) is not "the old settings". */
export function missingColumn(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  return e.code === "42703" || e.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(String(e.message ?? ""));
}
