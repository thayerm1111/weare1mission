import test from "node:test";
import assert from "node:assert/strict";
import {
  flowWinStreak, genxWinStreak, unavailableWinStreak,
  type FlowWinRow, type GenxWinRow,
} from "../src/lib/floor/winStreaks";

const SINCE = "2026-10-20T17:15:00Z";
const NOW = "2026-11-22T15:00:00Z";
const WINDOW = { since: SINCE, asOf: NOW, complete: true };
const ACCOUNT = { id: "mine", environment: "live" as const };
const at = (minute: number) => new Date(Date.parse("2026-11-22T12:00:00Z") + minute * 60_000).toISOString();
const flow = (id: string, minute: number, pips: unknown, extra: Partial<FlowWinRow> = {}): FlowWinRow => ({
  id, position_id: id, account_id: "mine", environment: "live", status: "closed", outcome: "target",
  created_at: at(minute - 10), resolved_at: at(minute), result_pips: pips, ...extra,
});
const call = (id: string, minute: number, pips: unknown, extra: Partial<GenxWinRow> = {}): GenxWinRow => ({
  id, dedupe_key: id, mode: "quick", side: "buy", state: "entered", outcome: Number(pips) < 0 ? "loss" : "win",
  created_at: at(minute - 10), enter_sent_at: at(minute - 9), resolved_at: at(minute), result_pips: pips, ...extra,
});

test("the current run resets silently: win, negative result, win counts the last win and its pips only", () => {
  const result = flowWinStreak([flow("first", 1, 40), flow("reset", 2, -20), flow("last", 3, 12.5)], ACCOUNT, WINDOW);
  assert.equal(result.state, "ready");
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 12.5);
  assert.equal(result.wins, 2);
  assert.equal(result.winningPips, 52.5);
  assert.equal(result.lastWinAt, at(3));
  assert.equal(result.period, "since_reset");
  assert.equal(result.since, SINCE);
  assert.equal(result.scope, "account");
  assert.doesNotMatch(JSON.stringify(result), /loss|negative|stop/);
});

test("a zero-profit break-even close adds no win or pips and does not erase the preceding wins", () => {
  const result = flowWinStreak([flow("a", 1, 8), flow("flat", 2, "0", { outcome: "breakeven" }), flow("b", 3, 7.25)], ACCOUNT, WINDOW);
  assert.equal(result.currentWins, 2);
  assert.equal(result.currentPips, 15.25);
  assert.equal(result.wins, 2);
  assert.equal(flowWinStreak([flow("flat", 2, 0)], ACCOUNT, WINDOW).currentWins, 0);
});

test("partial exits count once, at the final ledger result, only after the entire position closes", () => {
  const openPartial = flow("still-running", 3, 80, { status: "open", resolved_at: null });
  // The manager already blended the banked partial with the flat remainder into +13 recorded pips.
  const completed = flow("finished", 2, 13, { outcome: "breakeven" });
  const result = flowWinStreak([openPartial, completed, { ...completed, id: "duplicate-record" }], ACCOUNT, WINDOW);
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 13);
  assert.equal(result.winningPips, 13);
});

test("FLOW is this account and environment; a member's other accounts and future/pre-reset trades do not contribute", () => {
  const result = flowWinStreak([
    flow("mine", 1, 11), flow("other", 2, 1000, { account_id: "not-mine" }),
    flow("demo", 3, 2000, { environment: "demo" }),
    flow("old", 4, 3000, { created_at: "2026-10-19T00:00:00Z" }),
    flow("later", 5, 4000, { resolved_at: "2026-11-23T00:00:00Z" }),
  ], ACCOUNT, WINDOW);
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 11);
  assert.equal(flowWinStreak([flow("old-env", 1, 11, { environment: null })], ACCOUNT, WINDOW, false).state, "unavailable");
  assert.equal(flowWinStreak([flow("old-env", 1, 11, { environment: null })], ACCOUNT, WINDOW, true).currentWins, 1);
});

test("the run follows completion chronology, not trade-opening order or input order", () => {
  const earlierOpenLaterClose = flow("older", 20, -10, { created_at: at(-50) });
  const laterOpenEarlierClose = flow("newer", 10, 15, { created_at: at(-1) });
  const result = flowWinStreak([earlierOpenLaterClose, laterOpenEarlierClose], ACCOUNT, WINDOW);
  assert.equal(result.currentWins, 0);
  assert.equal(result.currentPips, 0);
  assert.equal(result.wins, 1);
  assert.equal(result.winningPips, 15);
});

test("missing results, non-finite values and incomplete pages never become zero or a claimed streak", () => {
  for (const missing of [null, undefined, "", "NaN", true, Infinity]) {
    const result = flowWinStreak([flow("a", 1, 30), flow("unknown", 2, missing), flow("b", 3, 15)], ACCOUNT, WINDOW);
    assert.equal(result.state, "unavailable");
    assert.equal(result.currentWins, null);
    assert.equal(result.currentPips, null);
  }
  const short = flowWinStreak([flow("a", 1, 30)], ACCOUNT, { ...WINDOW, complete: false });
  assert.equal(short.state, "unavailable");
  assert.equal(short.reason, "read_unavailable");
  assert.equal(short.wins, null);
  assert.equal(short.winningPips, null);
  assert.equal(flowWinStreak([], ACCOUNT, WINDOW).currentWins, 0, "a fully read empty ledger really is zero");
});

test("a later known reset establishes a new run after an old ungraded result, while period totals stay unknown", () => {
  const result = flowWinStreak([
    flow("a", 1, 30), flow("gap", 2, null), flow("reset", 3, -10), flow("last", 4, 8),
  ], ACCOUNT, WINDOW);
  assert.equal(result.state, "ready");
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 8);
  assert.equal(result.wins, null);
  assert.equal(result.winningPips, null);
  assert.equal(flowWinStreak([flow("retired", 1, null, { outcome: "excluded" }), flow("later", 2, 20)], ACCOUNT, WINDOW).state, "unavailable");
  const afterGapReset = flowWinStreak([flow("a", 1, 30), flow("gap", 2, null), flow("reset", 3, -10)], ACCOUNT, WINDOW);
  assert.equal(afterGapReset.currentWins, 0);
  assert.equal(afterGapReset.lastWinAt, null, "an ungraded later result may have been the last win");
});

test("agreeing duplicates do not add a win, and conflicting duplicates cannot supply a favorable result", () => {
  const original = flow("same", 1, 10);
  const result = flowWinStreak([original, { ...original, id: "other-row", resolved_at: at(2) }], ACCOUNT, WINDOW);
  assert.equal(result.currentWins, 1);
  assert.equal(result.lastWinAt, at(1));
  const conflict = flowWinStreak([original, { ...original, id: "other-row", result_pips: -10, resolved_at: at(2) }], ACCOUNT, WINDOW);
  assert.equal(conflict.state, "unavailable");
  assert.equal(conflict.currentWins, null);
});

test("mixed outcomes with the same completion timestamp cannot acquire a favorable arbitrary order", () => {
  const tied = [flow("a", 1, 10), flow("b", 1, -10)];
  assert.equal(flowWinStreak(tied, ACCOUNT, WINDOW).state, "unavailable");
  assert.equal(flowWinStreak([...tied].reverse(), ACCOUNT, WINDOW).state, "unavailable");
  assert.equal(flowWinStreak([...tied, flow("reset", 2, -1), flow("next", 3, 7)], ACCOUNT, WINDOW).currentWins, 1);
});

test("GENX counts each actual callout once, separately from member fills, and resets on its own recorded outcomes", () => {
  const one = call("quick:one", 1, 60);
  const result = genxWinStreak([one, { ...one, id: "duplicate" }, call("pd:reset", 2, -30), call("zone:next", 3, 22)], WINDOW);
  assert.equal(result.scope, "genx_calls");
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 22);
  assert.equal(result.wins, 2);
  assert.equal(result.winningPips, 82);
  assert.doesNotMatch(JSON.stringify(result), /loss|negative|stop/);
});

test("GENX excludes forming, merely armed, expired-unentered and still-running setups", () => {
  const result = genxWinStreak([
    call("a", 1, 10), call("forming", 2, 100, { state: "forming", enter_sent_at: null }),
    call("armed", 3, 200, { state: "forming" }), call("never-entered", 4, 300, { state: "expired", enter_sent_at: null }),
    call("open", 5, null, { outcome: null, resolved_at: null }),
  ], WINDOW);
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 10);
});

test("GENX expired/ungraded entered calls are unknown boundaries, never wins, flat closes or invented pips", () => {
  const unknown = call("expired", 2, null, { outcome: "expired" });
  assert.equal(genxWinStreak([call("first", 1, 10), unknown, call("last", 3, 5)], WINDOW).state, "unavailable");
  const recovered = genxWinStreak([unknown, call("reset", 3, -10), call("last", 4, 9)], WINDOW);
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.currentWins, 1);
  assert.equal(recovered.currentPips, 9);
  assert.equal(recovered.winningPips, null);
  assert.equal(recovered.reason, undefined, "an old ungraded call does not explain a later verified run");
  assert.equal(genxWinStreak([call("bad", 1, 10, { outcome: "loss" })], WINDOW).state, "unavailable");
  assert.equal(genxWinStreak([call("bad-entry", 1, 10, { enter_sent_at: null })], WINDOW).state, "unavailable");
});

test("entered expirations after a definite reset explain an unverified GENX run without replacing null counts", () => {
  const rows = [call("first", 1, 20), call("reset", 2, -10),
    call("expired-a", 3, null, { outcome: "expired" }), call("expired-b", 4, null, { outcome: "expired" })];
  const before = JSON.stringify(rows);
  const result = genxWinStreak(rows, WINDOW);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "ungraded_callout");
  for (const field of ["currentWins", "currentPips", "wins", "winningPips", "lastWinAt"] as const) assert.equal(result[field], null);
  assert.equal(JSON.stringify(rows), before, "explaining a record never rewrites it");
  assert.doesNotMatch(JSON.stringify(result), /loss|negative|stop/);
  assert.equal(genxWinStreak([...rows, call("later-win", 5, 8)], WINDOW).reason, "ungraded_callout", "a later win cannot bridge the unknown boundary");
  assert.equal(genxWinStreak(rows, { ...WINDOW, complete: false }).reason, "read_unavailable", "a partial read cannot establish the source explanation");
});

test("GENX distinguishes tied completion order from an ungraded call without inventing entry order", () => {
  const tied = [call("first-entered", 2, 10), call("later-entered", 2, -5, { created_at: at(0), enter_sent_at: at(1) })];
  for (const rows of [tied, [...tied].reverse()]) {
    const result = genxWinStreak(rows, WINDOW);
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "ambiguous_order");
    assert.equal(result.currentWins, null);
    assert.equal(result.currentPips, null);
  }
  const recovered = genxWinStreak([...tied, call("reset", 3, -1), call("next", 4, 7)], WINDOW);
  assert.equal(recovered.currentWins, 1);
  assert.equal(recovered.currentPips, 7);
  assert.equal(recovered.reason, undefined);
});

test("malformed or conflicting records do not acquire a misleading ungraded-callout explanation", () => {
  const expired = call("same", 2, null, { outcome: "expired" });
  for (const rows of [
    [call("bad-pips", 1, null)],
    [call("bad-direction", 1, 10, { outcome: "loss" })],
    [{ ...expired, enter_sent_at: null }],
    [expired, call("same", 3, 10, { id: "conflicting-copy" })],
  ]) {
    const result = genxWinStreak(rows, WINDOW);
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, undefined);
    assert.equal(result.currentWins, null);
  }
});

test("an immediate call's entry timestamp can precede the database insert timestamp without invalidating its real result", () => {
  const immediate = call("pd:immediate", 2, 30, { created_at: at(1), enter_sent_at: new Date(Date.parse(at(1)) - 120).toISOString() });
  const result = genxWinStreak([immediate], WINDOW);
  assert.equal(result.state, "ready");
  assert.equal(result.currentWins, 1);
  assert.equal(result.currentPips, 30);
});

test("missing clocks or close chronology do not become a dated current run", () => {
  assert.equal(flowWinStreak([flow("bad", 1, 10, { resolved_at: null })], ACCOUNT, WINDOW).state, "unavailable");
  assert.equal(flowWinStreak([flow("bad", 1, 10, { resolved_at: at(-30) })], ACCOUNT, WINDOW).state, "unavailable");
  assert.equal(genxWinStreak([call("bad", 1, 10)], { ...WINDOW, since: "bad date" }).state, "unavailable");
  const absent = unavailableWinStreak("account", SINCE, NOW, "no_account");
  assert.equal(absent.state, "no_account");
  assert.equal(absent.currentWins, null);
  assert.equal(absent.currentPips, null);
});
