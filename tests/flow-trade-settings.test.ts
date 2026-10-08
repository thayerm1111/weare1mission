/*
 * THE MEMBER'S THREE TRADE SETTINGS (owner 10-08: "change from AI PIPs to picking breakeven, AI management
 * (follow price and taking partials)"). The rules live in src/lib/flow/manageSettings.ts; these tests pin
 * the choices he made, and that every account starts exactly where AI Pips left it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveMgmt, mergeMgmt, legacyAiPips, backfilled, parseMgmtPatch, applyMgmtPatch, mgmtView,
  followGivebackR, FOLLOW_GIVEBACK_R, targetInForce, partialTriggerPrice,
  BE_PIPS_CHOICES, FOLLOW_MODES, PARTIAL_CHOICES, DEFAULT_GOLD_BE_PIPS, type MgmtRow,
} from "../src/lib/flow/manageSettings";

/* ── the choices are the ones he picked ─────────────────────────────────────────────────────────── */

test("the choices on offer are exactly the owner's: break-even off/20/30/40/50, follow off/tight/normal/loose, partials off/25/50", () => {
  assert.deepEqual([...BE_PIPS_CHOICES], [20, 30, 40, 50]);
  assert.deepEqual([...FOLLOW_MODES], ["off", "tight", "normal", "loose"]);
  assert.deepEqual([...PARTIAL_CHOICES], [0, 25, 50]);
  assert.equal(DEFAULT_GOLD_BE_PIPS, 30);
});

/* ── every account starts where it is today ─────────────────────────────────────────────────────── */

// Every combination the live table holds (10-08: 490 rows, 40 distinct mixes of these five columns),
// plus nulls everywhere a column can be null.
const LIVE_MIXES: MgmtRow[] = [];
for (const manage_trades of [true, false, null])
  for (const be_enabled of [true, false, null])
    for (const gold_be_pips of [null, 8, 10, 15, 20, 25, 30, 35, 40, 42, 50, 100, "10", "35"] as const)
      LIVE_MIXES.push({ manage_trades, be_enabled, gold_be_pips });

test("exactly what they have today: after the backfill, every live combination resolves to what AI Pips ran", () => {
  for (const row of LIVE_MIXES) {
    const now = legacyAiPips(row);
    const after = resolveMgmt(backfilled(row));
    assert.deepEqual(after, now, JSON.stringify(row));
  }
});

test("a row read before the new columns exist (or with them missing) is also AI Pips — never 'off'", () => {
  for (const row of LIVE_MIXES) {
    // what the manager's fallback read sees: no be_enabled, no trail_mode, no partial_pct
    const { be_enabled: _drop, ...older } = row;
    assert.deepEqual(resolveMgmt(older), legacyAiPips(row), JSON.stringify(row));
  }
  assert.deepEqual(resolveMgmt(null), legacyAiPips({}), "no row at all reads as AI Pips on");
});

test("AI Pips on → break-even at its own pips, follow Normal, no partials; off → all three off", () => {
  assert.deepEqual(resolveMgmt(backfilled({ manage_trades: true, gold_be_pips: 10 })), { manage: true, breakEven: true, goldBePips: 10, follow: "normal", followChoice: "normal", partialPct: 0 });
  assert.deepEqual(resolveMgmt(backfilled({ manage_trades: true, gold_be_pips: null })), { manage: true, breakEven: true, goldBePips: 30, follow: "normal", followChoice: "normal", partialPct: 0 });
  assert.deepEqual(resolveMgmt(backfilled({ manage_trades: false, gold_be_pips: 35 })), { manage: false, breakEven: false, goldBePips: 35, follow: "off", followChoice: "off", partialPct: 0 });
});

test("the backfill never touches an account that is already on the new settings", () => {
  const chosen = { manage_trades: true, be_enabled: false, gold_be_pips: 20, trail_mode: "tight", partial_pct: 50 };
  assert.deepEqual(backfilled(chosen), chosen);
});

test("a row not yet on these settings is AI Pips exactly — its stale be_enabled is not read", () => {
  // what the site shows, and the manager runs, in the minutes between the code going live and the migration
  assert.equal(resolveMgmt({ manage_trades: true, be_enabled: false, gold_be_pips: 10 }).breakEven, true);
  assert.equal(resolveMgmt({ manage_trades: true, be_enabled: false, gold_be_pips: 10 }).follow, "normal");
  assert.equal(resolveMgmt({ manage_trades: false, be_enabled: true }).breakEven, false);
  for (const row of LIVE_MIXES) assert.deepEqual(resolveMgmt(row), legacyAiPips(row), JSON.stringify(row));
});

test("the stale be_enabled=false left on 27 AI-Pips-on accounts does not switch their break-even off", () => {
  // 09-22 stopped reading be_enabled; the backfill rewrites it from the one switch before anything reads it again.
  const stale = { manage_trades: true, be_enabled: false, partials_enabled: true, profit_guard: false, gold_be_pips: null };
  assert.equal(resolveMgmt(backfilled(stale)).breakEven, true);
  assert.equal(resolveMgmt(backfilled(stale)).follow, "normal");
  assert.equal(resolveMgmt(backfilled(stale)).partialPct, 0, "the old partials switch stays retired");
});

test("the SQL migrations do what backfilled() does, in the safe order, and come undone", () => {
  const strip = (f: string) => readFileSync(f, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");
  const acct = strip("supabase/migrations/20261008010000_flow_trade_management.sql");
  assert.match(acct, /update public\.flow_broker_accounts set be_enabled = \(manage_trades is distinct from false\), trail_mode = case when manage_trades is false then 'off' else 'normal' end, partial_pct = 0 where trail_mode is null/);
  assert.match(acct, /check \(trail_mode is null or trail_mode in \('off', ?'tight', ?'normal', ?'loose'\)\)/);
  assert.match(acct, /check \(partial_pct is null or partial_pct in \(0, ?25, ?50\)\)/);
  assert.ok(!/flow_managed_positions/.test(acct), "never holds the busy positions table's lock alongside");
  const pos = strip("supabase/migrations/20261008005900_flow_partial_record.sql");
  assert.match(pos, /add column if not exists partial_px numeric/);
  assert.match(pos, /add column if not exists partial_frac numeric/);
  assert.ok(!/flow_broker_accounts/.test(pos));
  // the recording columns sort (and are applied) before the setting that can produce a partial
  assert.ok("20261008005900" < "20261008010000");
  for (const sql of [acct, pos]) {
    assert.match(sql, /^ ?set lock_timeout = '5s';/, "gives up rather than stall the trade manager — in a transaction or not");
    assert.match(sql, /reset lock_timeout; ?$/);
  }
  const downA = readFileSync("supabase/migrations/20261008010000_flow_trade_management_down.sql", "utf8");
  for (const c of ["trail_mode", "partial_pct"]) assert.match(downA, new RegExp(`drop column if exists ${c}`));
  const downP = readFileSync("supabase/migrations/20261008005900_flow_partial_record_down.sql", "utf8");
  for (const c of ["partial_px", "partial_frac"]) assert.match(downP, new RegExp(`drop column if exists ${c}`));
});

test("a change to an account with no follow choice stored yet stores the one it runs on, so the backfill can never reset it", () => {
  const fresh = { manage_trades: true, be_enabled: null, gold_be_pips: null, trail_mode: null, partial_pct: null };   // connected after the migration
  const write = applyMgmtPatch(fresh, { partials: 50 });
  assert.equal(write.trail_mode, "normal");
  const after = { ...fresh, ...write };
  assert.deepEqual(backfilled(after), after, "the backfill leaves it alone");
  assert.equal(resolveMgmt(backfilled(after)).partialPct, 50);
  // an AI-Pips-off account connected since: off is what it runs on, and off is what is stored
  assert.equal(applyMgmtPatch({ manage_trades: false, trail_mode: null }, { partials: 25 }).trail_mode, "off");
});

/* ── the rules themselves ───────────────────────────────────────────────────────────────────────── */

test("follow price needs break-even: off when break-even is off, and the member's pick comes back with it", () => {
  const r = { manage_trades: true, be_enabled: false, trail_mode: "tight", partial_pct: 0 };
  assert.equal(resolveMgmt(r).follow, "off");
  assert.equal(resolveMgmt(r).followChoice, "tight");
  assert.equal(resolveMgmt({ ...r, be_enabled: true }).follow, "tight");
});

test("partials alone keep the account managed; everything off leaves the trade alone", () => {
  assert.equal(resolveMgmt({ manage_trades: true, be_enabled: false, trail_mode: "off", partial_pct: 25 }).manage, true);
  assert.equal(resolveMgmt({ manage_trades: true, be_enabled: false, trail_mode: "normal", partial_pct: 0 }).manage, false, "a follow choice without break-even is not management");
  // the old one switch still governs a row that has never been on these settings
  assert.equal(resolveMgmt({ manage_trades: false, be_enabled: true, trail_mode: null, partial_pct: 50 }).manage, false);
  assert.equal(resolveMgmt({ manage_trades: false, be_enabled: true, trail_mode: null, partial_pct: 50 }).partialPct, 0);
  // once a row is on them, manage_trades is only a summary: a stale "off" left by two saves landing at
  // once cannot switch a member's partial off
  assert.equal(resolveMgmt({ manage_trades: false, be_enabled: false, trail_mode: "off", partial_pct: 50 }).partialPct, 50);
  assert.equal(resolveMgmt({ manage_trades: false, be_enabled: false, trail_mode: "off", partial_pct: 50 }).manage, true);
  assert.equal(resolveMgmt({ manage_trades: true, be_enabled: false, trail_mode: "off", partial_pct: 0 }).manage, false, "nor a stale 'on'");
});

test("junk in a column reads as the safe default, not as a crash", () => {
  assert.equal(resolveMgmt({ trail_mode: "warp" }).follow, "normal");
  assert.equal(resolveMgmt({ partial_pct: 33 }).partialPct, 0);
  assert.equal(resolveMgmt({ partial_pct: "50" }).partialPct, 50);
  assert.equal(resolveMgmt({ gold_be_pips: -4 }).goldBePips, 30);
  assert.equal(resolveMgmt({ gold_be_pips: 0 }).goldBePips, 30, "0 is not a distance: it would park the stop on the entry");
  assert.equal(resolveMgmt({ gold_be_pips: "abc" }).goldBePips, 30);
  assert.equal(resolveMgmt({ trail_mode: " Loose " }).follow, "loose");
});

test("one broker account on two rows: off on either row wins, as the manager always read it", () => {
  const on = backfilled({ manage_trades: true, gold_be_pips: 15 });
  const off = backfilled({ manage_trades: false, gold_be_pips: null });
  assert.deepEqual(mergeMgmt([off, on]), mergeMgmt([on, off]));
  assert.equal(mergeMgmt([off, on]).manage, false);
  assert.equal(mergeMgmt([off, on]).breakEven, false);
  // gold pips: the last row that set one (the old loop's Map.set)
  assert.equal(mergeMgmt([backfilled({ manage_trades: true, gold_be_pips: null }), backfilled({ manage_trades: true, gold_be_pips: 40 })]).goldBePips, 40);
  assert.equal(mergeMgmt([backfilled({ manage_trades: true, gold_be_pips: 30 }), backfilled({ manage_trades: true, gold_be_pips: null })]).goldBePips, 30);
  assert.equal(mergeMgmt([backfilled({ manage_trades: true, gold_be_pips: 10 }), backfilled({ manage_trades: true, gold_be_pips: 40 })]).goldBePips, 40, "two numbers: the later row's");
  assert.equal(mergeMgmt([backfilled({ manage_trades: true, gold_be_pips: 40 }), backfilled({ manage_trades: true, gold_be_pips: 10 })]).goldBePips, 10);
  // partials at the smaller share; follow Normal when the rows disagree; off if any row is off
  const a = { manage_trades: true, be_enabled: true, trail_mode: "tight", partial_pct: 50 };
  const b = { manage_trades: true, be_enabled: true, trail_mode: "loose", partial_pct: 25 };
  assert.equal(mergeMgmt([a, b]).partialPct, 25);
  assert.equal(mergeMgmt([a, b]).follow, "normal");
  assert.equal(mergeMgmt([a, { ...b, trail_mode: "off" }]).follow, "off");
  assert.equal(mergeMgmt([a, { ...b, partial_pct: 0 }]).partialPct, 0);
  assert.deepEqual(mergeMgmt([]), resolveMgmt(null));
});

test("one row merges to exactly what it resolves to", () => {
  const rows: MgmtRow[] = [];
  for (const manage_trades of [true, false, null]) for (const be_enabled of [true, false, null]) for (const trail_mode of [null, "off", "tight", "normal", "loose", "x"])
    for (const partial_pct of [null, 0, 25, 50, 7]) for (const gold_be_pips of [null, 10, 40]) rows.push({ manage_trades, be_enabled, trail_mode, partial_pct, gold_be_pips });
  for (const r of rows) assert.deepEqual(mergeMgmt([r]), resolveMgmt(r), JSON.stringify(r));
});

/* ── a member's change ──────────────────────────────────────────────────────────────────────────── */

test("only the offered values are accepted, each with a line a member can read", () => {
  assert.deepEqual(parseMgmtPatch({ breakEven: 20 }), { ok: true, patch: { breakEven: 20 } });
  assert.deepEqual(parseMgmtPatch({ breakEven: "40" }), { ok: true, patch: { breakEven: 40 } });
  assert.deepEqual(parseMgmtPatch({ breakEven: "off" }), { ok: true, patch: { breakEven: "off" } });
  assert.deepEqual(parseMgmtPatch({ followPrice: "Tight" }), { ok: true, patch: { follow: "tight" } });
  assert.deepEqual(parseMgmtPatch({ partials: 50 }), { ok: true, patch: { partials: 50 } });
  assert.deepEqual(parseMgmtPatch({ partials: "0" }), { ok: true, patch: { partials: 0 } });
  for (const bad of [{ breakEven: 35 }, { breakEven: 10 }, { breakEven: 0 }, { breakEven: null }, { breakEven: "20.5" }, { breakEven: 100000 }]) {
    const r = parseMgmtPatch(bad as Record<string, unknown>);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match((r as { detail: string }).detail, /Off, 20, 30, 40 or 50/);
  }
  for (const bad of [{ followPrice: "fast" }, { followPrice: 1 }, { followPrice: null }]) assert.equal(parseMgmtPatch(bad as Record<string, unknown>).ok, false);
  for (const bad of [{ partials: 75 }, { partials: 100 }, { partials: -25 }, { partials: true }, { partials: null }, { partials: "" }]) assert.equal(parseMgmtPatch(bad as Record<string, unknown>).ok, false, JSON.stringify(bad));
  assert.equal(parseMgmtPatch({}).ok, false);
  assert.equal(parseMgmtPatch({ action: "management" }).ok, false);
});

test("a change writes only what changed, and works manage_trades out from the whole", () => {
  const today = backfilled({ manage_trades: true, gold_be_pips: 10 });
  assert.deepEqual(applyMgmtPatch(today, { breakEven: 40 }), { gold_be_pips: 40, be_enabled: true, manage_trades: true });
  assert.deepEqual(applyMgmtPatch(today, { breakEven: "off" }), { be_enabled: false, manage_trades: false });
  assert.deepEqual(applyMgmtPatch(today, { breakEven: "on" }), { be_enabled: true, manage_trades: true }, "an older screen's switch keeps the account's own pips");
  assert.deepEqual(applyMgmtPatch(today, { follow: "loose" }), { trail_mode: "loose", manage_trades: true });
  assert.deepEqual(applyMgmtPatch(today, { partials: 25 }), { partial_pct: 25, manage_trades: true });
  // break-even off but a partial on: still managed
  assert.deepEqual(applyMgmtPatch({ ...today, be_enabled: false }, { partials: 50 }), { partial_pct: 50, manage_trades: true });
  assert.deepEqual(applyMgmtPatch({ ...today, be_enabled: false, partial_pct: 50 }, { partials: 0 }), { partial_pct: 0, manage_trades: false });
  // an account the old switch turned off (never on these settings, a stale break-even underneath) does
  // not come back with it
  const offStale = { manage_trades: false, be_enabled: true, trail_mode: null, partial_pct: 50, gold_be_pips: 20 };
  assert.deepEqual(applyMgmtPatch(offStale, { partials: 25 }), { trail_mode: "off", be_enabled: false, partial_pct: 25, manage_trades: true });
  assert.equal(resolveMgmt({ ...offStale, ...applyMgmtPatch(offStale, { partials: 25 }) }).breakEven, false);
  assert.equal(resolveMgmt({ ...offStale, ...applyMgmtPatch(offStale, { partials: 25 }) }).partialPct, 25);
  assert.deepEqual(applyMgmtPatch(offStale, { follow: "loose" }), { trail_mode: "loose", be_enabled: false, partial_pct: 0, manage_trades: false });
  // the old number stays until a new one is picked
  assert.equal(resolveMgmt({ ...today, ...applyMgmtPatch(today, { follow: "tight" }) }).goldBePips, 10);
});

test("two quick changes saved from the same starting row both stand", () => {
  // The screen sends one change at a time, but a member with two devices can send two at once:
  // each request reads the row before the other has written. Writing only what changed keeps both.
  const start = backfilled({ manage_trades: true, gold_be_pips: null });
  const a = applyMgmtPatch(start, { breakEven: 20 });
  const b = applyMgmtPatch(start, { partials: 50 });
  for (const end of [{ ...start, ...a, ...b }, { ...start, ...b, ...a }]) {
    const m = resolveMgmt(end);
    assert.equal(m.goldBePips, 20);
    assert.equal(m.partialPct, 50);
    assert.equal(m.breakEven, true);
  }
});

test("what the screens are sent keeps the old field names honest", () => {
  const v = mgmtView(backfilled({ manage_trades: true, gold_be_pips: null }));
  assert.deepEqual(v, { manageTrades: true, beEnabled: true, partialsEnabled: false, profitGuard: true, goldBePips: null, breakEvenPips: 30, followPrice: "normal", followActive: true, partialPct: 0 });
  const w = mgmtView({ manage_trades: true, be_enabled: false, trail_mode: "tight", partial_pct: 50, gold_be_pips: 15 });
  assert.deepEqual(w, { manageTrades: true, beEnabled: false, partialsEnabled: true, profitGuard: false, goldBePips: 15, breakEvenPips: 15, followPrice: "tight", followActive: false, partialPct: 50 });
});

/* ── follow price ───────────────────────────────────────────────────────────────────────────────── */

test("Normal is the trail exactly as it ran: 0.6R behind the best price, 0.25R near the target", () => {
  assert.equal(followGivebackR("normal", false), 0.6);
  assert.equal(followGivebackR("normal", true), 0.25);
  assert.equal(followGivebackR("off", true), null);
  assert.equal(followGivebackR("off", false), null);
});

test("Tight is always at least as close as Normal, and Loose always at least as wide", () => {
  for (const near of [false, true]) {
    assert.ok(followGivebackR("tight", near)! <= followGivebackR("normal", near)!);
    assert.ok(followGivebackR("loose", near)! >= followGivebackR("normal", near)!);
  }
  // and strictly different, so the choice is felt
  assert.ok(FOLLOW_GIVEBACK_R.tight.far < FOLLOW_GIVEBACK_R.normal.far && FOLLOW_GIVEBACK_R.tight.near < FOLLOW_GIVEBACK_R.normal.near);
  assert.ok(FOLLOW_GIVEBACK_R.loose.far > FOLLOW_GIVEBACK_R.normal.far && FOLLOW_GIVEBACK_R.loose.near > FOLLOW_GIVEBACK_R.normal.near);
});

test("Tight is felt on gold: with the take-profit half a risk away, its stop rides above the break-even lock before the target", () => {
  // A typical gold trade: 90-pip stop, take-profit 45 pips (0.5R), lock 17 pips. Best price 42 pips up.
  const R = 90, best = 42, lock = 17;
  const stopAt = (gb: number) => Math.max(best - gb * R, lock);
  assert.equal(stopAt(followGivebackR("normal", false)!), lock, "Normal leaves the lock where it is (as today)");
  assert.ok(stopAt(followGivebackR("tight", false)!) > lock + 10, "Tight has moved it well into profit");
});

/* ── partials ───────────────────────────────────────────────────────────────────────────────────── */

test("halfway to the target the trade will actually close at", () => {
  // broker's own take-profit first, then the gold near target, then the plan's target
  assert.equal(targetInForce("buy", 4000, [4006, 4005, 4019]), 4006);
  assert.equal(targetInForce("buy", 4000, [null, 4005, 4019]), 4005);
  assert.equal(targetInForce("buy", 4000, [null, null, 4019]), 4019);
  // a candidate on the losing side is no target
  assert.equal(targetInForce("buy", 4000, [3990, null, 4019]), 4019);
  assert.equal(targetInForce("sell", 4000, [4010, 3994, 3980]), 3994);
  assert.equal(targetInForce("sell", 4000, [null, null, null]), null);
  assert.equal(partialTriggerPrice(4000, 4005), 4002.5);
  assert.equal(partialTriggerPrice(4000, null), null);
});
