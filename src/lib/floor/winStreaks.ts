/**
 * Floor win runs are display-only readings of two different records. FLOW is one member's selected
 * broker account; GENX is the published callout ledger, never a sum of its followers' fills. Nothing
 * here grades a trade, changes a ledger, or supplies a trading/risk gate.
 */
export type WinStreakScope = "account" | "genx_calls";
export type WinStreakUnavailableReason = "read_unavailable" | "ungraded_callout" | "ambiguous_order";
export type WinStreakMetrics = {
  state: "ready" | "unavailable" | "no_account";
  /** Optional explanation only; it never supplies a missing result or changes the run. */
  reason?: WinStreakUnavailableReason;
  scope: WinStreakScope;
  period: "since_reset";
  since: string | null;
  asOf: string;
  currentWins: number | null;
  /** Positive recorded pips from the completed wins in the current run only. */
  currentPips: number | null;
  /** Whole-period totals are unknown when an earlier result is missing, even if the current run is known. */
  wins: number | null;
  winningPips: number | null;
  lastWinAt: string | null;
};
export type WinStreakAccount = { id: string; environment: "live" | "demo"; name: string };
export type FloorWinStreaks = {
  asOf: string;
  account: WinStreakAccount | null;
  flow: WinStreakMetrics;
  genx: WinStreakMetrics;
};
export type WinStreakWindow = { since: string; asOf: string; complete: boolean };
export type FlowWinRow = {
  id?: unknown; position_id?: unknown; account_id?: unknown; environment?: unknown;
  status?: unknown; outcome?: unknown; result_pips?: unknown; created_at?: unknown; resolved_at?: unknown;
};
export type GenxWinRow = {
  id?: unknown; dedupe_key?: unknown; mode?: unknown; side?: unknown; state?: unknown;
  outcome?: unknown; result_pips?: unknown; created_at?: unknown; resolved_at?: unknown; enter_sent_at?: unknown;
};

export function unavailableWinStreak(
  scope: WinStreakScope, since: string | null, asOf: string, state: "unavailable" | "no_account" = "unavailable",
  reason?: WinStreakUnavailableReason,
): WinStreakMetrics {
  return { state, ...(state === "unavailable" && reason ? { reason } : {}), scope, period: "since_reset", since, asOf, currentWins: null, currentPips: null, wins: null, winningPips: null, lastWinAt: null };
}

const text = (v: unknown): string => typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const time = (v: unknown): number | null => { const n = typeof v === "string" && v.trim() ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; };
const number = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const round = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
type Result = { key: string; at: number | null; pips: number | null; ungradedCallout?: boolean };

/**
 * Duplicate rows for one broker position/call do not create additional wins. Agreeing records use the
 * first recorded close; conflicting results become an unknown boundary at the latest recorded close.
 * Neither "best account" nor a favorable duplicate is ever picked to make a win.
 */
function dedupe(rows: Result[]): Result[] {
  const out = new Map<string, Result>();
  for (const r of rows) {
    const prev = out.get(r.key);
    if (!prev) { out.set(r.key, { ...r }); continue; }
    if (prev.at == null || r.at == null) prev.at = null;
    else prev.at = prev.pips != null && prev.pips === r.pips ? Math.min(prev.at, r.at) : Math.max(prev.at, r.at);
    if (prev.pips !== r.pips) prev.pips = null;
    // Conflicting copies are not proof that this call has no outcome; keep that case generic.
    prev.ungradedCallout = prev.ungradedCallout === true && r.ungradedCallout === true;
  }
  return [...out.values()];
}

function fold(scope: WinStreakScope, input: Result[], window: WinStreakWindow, invalid = false): WinStreakMetrics {
  const unknown = (reason?: WinStreakUnavailableReason) => unavailableWinStreak(scope, window.since, window.asOf, "unavailable", reason);
  const from = time(window.since), until = time(window.asOf);
  if (!window.complete) return unknown("read_unavailable");
  if (invalid || from == null || until == null) return unknown();
  const rows = dedupe(input);
  if (rows.some((r) => r.at == null || !r.key)) return unknown();
  rows.sort((a, b) => a.at! - b.at!);
  let currentWins = 0, currentPips = 0, wins = 0, winningPips = 0;
  let known = true, totalsKnown = true, lastWinAt: string | null = null;
  let reason: WinStreakUnavailableReason | undefined;
  for (let i = 0; i < rows.length;) {
    const at = rows[i].at!;
    let positive = 0, pips = 0, reset = false, gap = false, ungradedCallout = false;
    // A timestamp cannot establish an order between two different outcomes. A mixed batch is unknown,
    // rather than using an arbitrary id ordering that might turn the same batch into a winning run.
    while (i < rows.length && rows[i].at === at) {
      const row = rows[i++], p = row.pips;
      if (p == null) { gap = true; totalsKnown = false; ungradedCallout ||= row.ungradedCallout === true; }
      else if (p < 0) reset = true;
      else if (p > 0) { positive++; pips += p; wins++; winningPips += p; lastWinAt = new Date(at).toISOString(); }
      // A real zero is a flat close: it neither increments nor resets the run.
    }
    if (gap && positive === 0) lastWinAt = null; // the missing result may have been a more recent win
    if (gap || (reset && positive > 0)) {
      known = false;
      reason = gap ? (ungradedCallout ? "ungraded_callout" : undefined) : "ambiguous_order";
    }
    else if (reset) { known = true; reason = undefined; currentWins = 0; currentPips = 0; }
    else if (known) { currentWins += positive; currentPips += pips; }
  }
  if (!known) return unknown(reason);
  if (!Number.isFinite(currentPips) || !Number.isFinite(winningPips)) return unknown();
  return {
    state: "ready", scope, period: "since_reset", since: window.since, asOf: window.asOf,
    currentWins, currentPips: round(currentPips), wins: totalsKnown ? wins : null,
    winningPips: totalsKnown ? round(winningPips) : null, lastWinAt,
  };
}

/**
 * One finalized managed position is one result. Its recorded result_pips already includes the manager's
 * partial-exit weighting; summing partial events or recomputing from the last exit would double count or
 * discard that banked result. Open positions (including partially closed ones) are not completed wins.
 * A positive finalized net result is a win even when the remainder closed at break-even; a zero is not.
 */
export function flowWinStreak(
  rows: FlowWinRow[], account: Pick<WinStreakAccount, "id" | "environment">,
  window: WinStreakWindow, allowLegacyEnvironment = true,
): WinStreakMetrics {
  const results: Result[] = [];
  const from = time(window.since), until = time(window.asOf);
  let invalid = false;
  for (const r of rows) {
    if (text(r.account_id) !== account.id) continue;
    const env = text(r.environment).toLowerCase();
    if (env && env !== account.environment) continue;
    if (text(r.status) !== "closed") continue;
    const created = time(r.created_at);
    if (created != null && from != null && until != null && (created < from || created > until)) continue;
    if (created == null || (!env && !allowLegacyEnvironment)) { invalid = true; continue; }
    const at = time(r.resolved_at);
    if (at != null && until != null && at > until) continue;
    const key = text(r.position_id) || (text(r.id) ? `row:${text(r.id)}` : "");
    // A retired position has no reliable result. It cannot silently bridge a run across a possible
    // reset. A later known reset can establish a new run without rewriting that missing history.
    const pips = text(r.outcome) === "excluded" ? null : number(r.result_pips);
    results.push({ key, at: at != null && at >= created ? at : null, pips });
  }
  return fold("account", results, window, invalid);
}

/**
 * Only entered, graded GENX callouts are wins. A forming/armed/zone setup never becomes one merely
 * because it carries a target. enter_sent_at can also mean "armed" in the watcher, so state matters.
 * fee_key is a billing alias, not a call identity, and is intentionally not used to merge real calls.
 */
export function genxWinStreak(rows: GenxWinRow[], window: WinStreakWindow): WinStreakMetrics {
  const results: Result[] = [];
  const from = time(window.since), until = time(window.asOf);
  let invalid = false;
  for (const r of rows) {
    if (text(r.state) !== "entered") continue;
    const created = time(r.created_at);
    if (created != null && from != null && until != null && (created < from || created > until)) continue;
    const outcome = text(r.outcome).toLowerCase();
    if (!outcome && r.resolved_at == null) continue; // the call is still running, not a completed result
    if (created == null) { invalid = true; continue; }
    const at = time(r.resolved_at), entered = time(r.enter_sent_at);
    if (at != null && until != null && at > until) continue;
    const key = text(r.dedupe_key) || (text(r.id) ? `row:${text(r.id)}` : "");
    const p = number(r.result_pips);
    const coherent = (outcome === "win" && p != null && p >= 0) || (outcome === "loss" && p != null && p <= 0)
      || ((outcome === "breakeven" || outcome === "be") && p === 0);
    // Immediate-entry writers stamp enter_sent_at before INSERT; the database's default created_at
    // can consequently be a few milliseconds later. The recorded entry must precede the resolution,
    // but requiring it to follow that insert timestamp would discard real immediate callouts.
    const validEntry = entered != null && at != null && entered <= at;
    results.push({
      key, at: at != null && at >= created ? at : null, pips: coherent && validEntry ? p : null,
      // The grader's entered expirations have no recorded result. A malformed win, missing entry,
      // or conflicting duplicate needs a generic explanation instead of claiming an ungraded call.
      ungradedCallout: validEntry && p == null && (outcome === "expired" || !outcome),
    });
  }
  return fold("genx_calls", results, window, invalid);
}
