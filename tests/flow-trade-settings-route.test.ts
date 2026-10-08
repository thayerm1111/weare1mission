/*
 * THE SETTINGS API FOR THE THREE TRADE SETTINGS (/api/flow/broker, owner 10-08). The real handler, against
 * the in-memory database: what a screen is sent, what a change saves, what is refused, and that the
 * older screens' switches (AI Pips, break-even, partials, gold pips) still leave an account consistent.
 */
import { member, idOf, call, T } from "./_routes";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveMgmt } from "../src/lib/flow/manageSettings";

const tok = member("trader");
const other = member("someone-else");
const me = idOf(tok);
T("flow_broker_connections").push(
  { id: "c1", user_id: me, broker: "tradelocker", environment: "demo", server: "GENFX", email: "trader@example.test", status: "connected", selected_account_id: "111", updated_at: "2026-10-06T10:00:00Z" },
  { id: "c9", user_id: idOf(other), broker: "tradelocker", environment: "demo", server: "GENFX", email: "else@example.test", status: "connected", selected_account_id: "999", updated_at: "2026-10-06T10:00:00Z" },
);
const row = (account_id: string, o: Record<string, unknown> = {}) => ({ id: `r-${account_id}`, user_id: me, connection_id: "c1", account_id, acc_num: account_id, name: `Acct ${account_id}`, created_at: "2026-10-01T00:00:00Z",
  autotrade_enabled: true, genx_follower: false, manage_trades: true, gold_be_pips: null, be_enabled: true, trail_mode: "normal", partial_pct: 0, ...o });
function fresh(): void {
  const t = T("flow_broker_accounts"); t.length = 0;
  t.push(row("111"), row("222", { gold_be_pips: 10 }), row("333", { manage_trades: false, be_enabled: false, trail_mode: "off" }),
    { ...row("999", { gold_be_pips: 40 }), user_id: idOf(other), connection_id: "c9" });
}
const acct = (id: string) => T("flow_broker_accounts").find((r) => r.account_id === id)!;

/*
 * The database's trigger flow_accounts_derive_manage (migration 20261008010000): on every write to an account
 * row that is on the new settings, manage_trades := break-even on, or a partial on. The in-memory database
 * has no triggers, so it is applied here after every write to the table — and the last test below checks the
 * migration's SQL says exactly this.
 */
const derive = (r: Record<string, any>) => { if (r.trail_mode != null) r.manage_trades = r.be_enabled !== false || Number(r.partial_pct ?? 0) > 0; };
{
  const real = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const res = await real(input, init);
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/rest/v1/flow_broker_accounts" && /PATCH|POST/.test(String(init.method ?? "").toUpperCase())) T("flow_broker_accounts").forEach(derive);
    return res;
  };
}
const post = (body: Record<string, unknown>, who = tok) => call("flow/broker", "POST", "/api/flow/broker", who, body);

test("a screen is sent each account's three settings — and the older names, still true", async () => {
  fresh();
  const r = await call("flow/broker", "GET", "/api/flow/broker", tok);
  assert.equal(r.status, 200);
  const by = Object.fromEntries((r.json.accounts as any[]).map((a) => [a.accountId, a]));
  assert.deepEqual(Object.keys(by).sort(), ["111", "222", "333"], "only this member's accounts");
  const pick = (a: any) => ({ beEnabled: a.beEnabled, breakEvenPips: a.breakEvenPips, goldBePips: a.goldBePips, followPrice: a.followPrice, followActive: a.followActive, partialPct: a.partialPct, manageTrades: a.manageTrades, partialsEnabled: a.partialsEnabled, profitGuard: a.profitGuard });
  assert.deepEqual(pick(by["111"]), { beEnabled: true, breakEvenPips: 30, goldBePips: null, followPrice: "normal", followActive: true, partialPct: 0, manageTrades: true, partialsEnabled: false, profitGuard: true });
  assert.deepEqual(pick(by["222"]), { beEnabled: true, breakEvenPips: 10, goldBePips: 10, followPrice: "normal", followActive: true, partialPct: 0, manageTrades: true, partialsEnabled: false, profitGuard: true });
  assert.deepEqual(pick(by["333"]), { beEnabled: false, breakEvenPips: 30, goldBePips: null, followPrice: "off", followActive: false, partialPct: 0, manageTrades: false, partialsEnabled: false, profitGuard: false });
});

test("a change saves exactly that setting, and the answer is the settings as they now stand", async () => {
  fresh();
  let r = await post({ action: "management", accountId: "111", connectionId: "c1", breakEven: 20 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.breakEvenPips, 20);
  assert.equal(acct("111").gold_be_pips, 20);
  assert.equal(acct("111").trail_mode, "normal", "nothing else touched");
  r = await post({ action: "management", accountId: "111", connectionId: "c1", followPrice: "tight" });
  assert.equal(r.json.followPrice, "tight");
  r = await post({ action: "management", accountId: "111", connectionId: "c1", partials: 50 });
  assert.equal(r.json.partialPct, 50);
  assert.deepEqual(resolveMgmt(acct("111")), { manage: true, breakEven: true, goldBePips: 20, follow: "tight", followChoice: "tight", partialPct: 50 });
  // all three off: manage_trades goes off with them
  await post({ action: "management", accountId: "111", connectionId: "c1", breakEven: "off" });
  r = await post({ action: "management", accountId: "111", connectionId: "c1", partials: 0 });
  assert.equal(r.json.manageTrades, false);
  assert.equal(acct("111").manage_trades, false);
  assert.equal(r.json.followPrice, "tight", "the follow choice is kept for when break-even comes back");
  assert.equal(r.json.followActive, false);
  // and back on
  r = await post({ action: "management", accountId: "111", connectionId: "c1", breakEven: 30 });
  assert.equal(acct("111").manage_trades, true);
  assert.equal(r.json.followActive, true);
});

test("only the offered values are taken", async () => {
  fresh();
  for (const bad of [{ breakEven: 35 }, { breakEven: 10 }, { followPrice: "fast" }, { partials: 75 }, {}]) {
    const r = await post({ action: "management", accountId: "222", connectionId: "c1", ...bad });
    assert.equal(r.json.error, "bad_value", JSON.stringify(bad));
    assert.ok(typeof r.json.detail === "string" && r.json.detail.length > 10);
  }
  assert.equal(acct("222").gold_be_pips, 10, "nothing was written");
  assert.equal(acct("222").trail_mode, "normal");
});

test("a member can change only their own accounts", async () => {
  fresh();
  const r = await post({ action: "management", accountId: "999", breakEven: "off" });
  assert.equal(r.json.error, "not_found");
  assert.equal(acct("999").be_enabled, true);
  assert.equal((await post({ action: "management", accountId: "999", connectionId: "c9", breakEven: "off" })).json.error, "not_found");
  assert.equal(acct("999").be_enabled, true);
  assert.equal((await call("flow/broker", "POST", "/api/flow/broker", null, { action: "management", accountId: "111", breakEven: 20 })).status, 401);
  assert.equal((await post({ action: "management", breakEven: 20 })).json.error, "missing_account");
});

test("the older screens' AI Pips switch: off turns all three off; on brings break-even and follow price back", async () => {
  fresh();
  await post({ action: "management", accountId: "111", connectionId: "c1", partials: 25 });
  let r = await post({ action: "manage", accountId: "111", connectionId: "c1", enabled: false });
  assert.equal(r.json.manageTrades, false);
  assert.deepEqual(resolveMgmt(acct("111")), { manage: false, breakEven: false, goldBePips: 30, follow: "off", followChoice: "normal", partialPct: 0 });
  r = await post({ action: "manage", accountId: "111", connectionId: "c1", enabled: true });
  assert.deepEqual(resolveMgmt(acct("111")), { manage: true, breakEven: true, goldBePips: 30, follow: "normal", followChoice: "normal", partialPct: 0 });
  // AI Pips on for an account that had it off: follow price comes back as Normal
  r = await post({ action: "manage", accountId: "333", connectionId: "c1", enabled: true });
  assert.deepEqual(resolveMgmt(acct("333")), { manage: true, breakEven: true, goldBePips: 30, follow: "normal", followChoice: "normal", partialPct: 0 });
  // …and a member's own pick survives an older screen's switch
  await post({ action: "management", accountId: "222", connectionId: "c1", followPrice: "loose" });
  await post({ action: "manage", accountId: "222", connectionId: "c1", enabled: true });
  assert.equal(resolveMgmt(acct("222")).follow, "loose");
  assert.equal(resolveMgmt(acct("222")).goldBePips, 10);
});

test("the older break-even and partials switches keep manage_trades true to the settings", async () => {
  fresh();
  let r = await post({ action: "betoggle", accountId: "222", connectionId: "c1", enabled: false });
  assert.equal(r.json.beEnabled, false);
  assert.equal(acct("222").manage_trades, false);
  r = await post({ action: "partialtoggle", accountId: "222", connectionId: "c1", enabled: true });
  assert.equal(r.json.partialsEnabled, true);
  assert.equal(acct("222").partial_pct, 25);
  assert.equal(acct("222").manage_trades, true);
  r = await post({ action: "betoggle", accountId: "222", connectionId: "c1", enabled: true });
  assert.equal(acct("222").gold_be_pips, 10, "on again at the account's own pips");
  assert.equal(resolveMgmt(acct("222")).breakEven, true);
});

test("the gold pips on their own: only 20, 30, 40 or 50 — or nothing, for 30", async () => {
  fresh();
  assert.equal((await post({ action: "goldbe", accountId: "111", connectionId: "c1", goldBePips: 5 })).json.error, "bad_value");
  assert.equal((await post({ action: "goldbe", accountId: "111", connectionId: "c1", goldBePips: 100000 })).json.error, "bad_value");
  assert.equal(acct("111").gold_be_pips, null);
  assert.equal((await post({ action: "goldbe", accountId: "111", connectionId: "c1", goldBePips: 40 })).json.goldBePips, 40);
  assert.equal((await post({ action: "goldbe", accountId: "111", connectionId: "c1", goldBePips: null })).json.goldBePips, null);
  assert.equal(acct("111").gold_be_pips, null);
});

test("one broker account on two cards (the same login connected twice): both show what runs, and a change reaches both", async () => {
  fresh();
  T("flow_broker_connections").push({ id: "c2", user_id: me, broker: "tradelocker", environment: "demo", server: "GenFX", email: "trader@example.test", status: "connected", selected_account_id: "444", updated_at: "2026-10-05T10:00:00Z" });
  T("flow_broker_accounts").push(
    { ...row("444", { gold_be_pips: 40, partial_pct: 50 }), id: "r-444a", connection_id: "c1" },
    { ...row("444", { manage_trades: false, be_enabled: false, trail_mode: "off", partial_pct: 0 }), id: "r-444b", connection_id: "c2" },
  );
  let r = await call("flow/broker", "GET", "/api/flow/broker", tok);
  const cards = (r.json.accounts as any[]).filter((a) => a.accountId === "444");
  assert.equal(cards.length, 2);
  for (const c of cards) {
    // the manager combines the two rows: off on either wins
    assert.equal(c.beEnabled, false);
    assert.equal(c.partialPct, 0);
    assert.equal(c.manageTrades, false);
  }
  // a change on one card is written to both rows
  r = await post({ action: "management", accountId: "444", connectionId: "c1", breakEven: 30 });
  assert.equal(r.json.beEnabled, true);
  const both = T("flow_broker_accounts").filter((x) => x.account_id === "444");
  assert.deepEqual(both.map((x) => [x.be_enabled, x.gold_be_pips, x.manage_trades]), [[true, 30, true], [true, 30, true]]);
  r = await post({ action: "management", accountId: "444", connectionId: "c2", partials: 25 });
  assert.equal(r.json.partialPct, 25);
  assert.deepEqual(both.map((x) => x.partial_pct), [25, 25]);
  T("flow_broker_accounts").splice(0, T("flow_broker_accounts").length, ...T("flow_broker_accounts").filter((x) => x.account_id !== "444"));
  T("flow_broker_connections").splice(0, T("flow_broker_connections").length, ...T("flow_broker_connections").filter((x) => x.id !== "c2"));
});

test("two devices saving at once: manage_trades follows the row as it ends up, not either request's own read", async () => {
  fresh();
  // Device A turns break-even off. Between A reading the row and A writing it, device B's 50% partial lands.
  const real = (globalThis as any).fetch;
  let raced = false;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!raced && String(init.method).toUpperCase() === "PATCH" && url.pathname === "/rest/v1/flow_broker_accounts" && url.searchParams.get("id") === "eq.r-111") {
      raced = true;
      acct("111").partial_pct = 50;          // B's write, landing first
    }
    return real(input, init);
  };
  try {
    const r = await post({ action: "management", accountId: "111", connectionId: "c1", breakEven: "off" });
    assert.equal(raced, true);
    assert.equal(acct("111").be_enabled, false);
    assert.equal(acct("111").partial_pct, 50, "B's partial stands");
    assert.equal(acct("111").manage_trades, true, "and the account is still managed — A's read said otherwise");
    assert.equal(r.json.partialPct, 50, "the answer is the row as it ended up");
    assert.equal(r.json.manageTrades, true);
  } finally { (globalThis as any).fetch = real; }
});

test("manage_trades is worked out from the row as it stands after a change, not from the request's own read", async () => {
  fresh();
  // what two devices saving at once could leave behind: a partial on, the cached flag off
  Object.assign(acct("111"), { be_enabled: false, partial_pct: 50, manage_trades: false });
  await post({ action: "management", accountId: "111", connectionId: "c1", followPrice: "loose" });
  assert.equal(acct("111").manage_trades, true, "a partial is on, so the account is managed");
  Object.assign(acct("111"), { be_enabled: false, partial_pct: 0, manage_trades: true });
  await post({ action: "management", accountId: "111", connectionId: "c1", followPrice: "tight" });
  assert.equal(acct("111").manage_trades, false, "nothing is on, so it is not");
});

test("settings that cannot be read are marked as such — never shown as the defaults", async () => {
  fresh();
  const real = (globalThis as any).fetch;
  let refused = 0;
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/rest/v1/flow_broker_accounts" && /manage_trades/.test(url.searchParams.get("select") ?? "")) {
      refused++;
      return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return real(input, init);
  };
  try {
    const r = await call("flow/broker", "GET", "/api/flow/broker", tok);
    assert.equal(refused, 2, "tried twice");
    const a = (r.json.accounts as any[]).find((x) => x.accountId === "333");
    assert.equal(a.settingsUnread, true);
    assert.equal(a.beEnabled, undefined, "no made-up settings");
    assert.equal((r.json.accounts as any[]).length, 3, "the accounts are still listed");
    // and a save in that state is refused rather than guessed at
    const s = await post({ action: "management", accountId: "333", connectionId: "c1", partials: 25 });
    assert.equal(s.json.error, "save_failed");
  } finally { (globalThis as any).fetch = real; }
  assert.equal(acct("333").partial_pct, 0);
});

test("a reconnect that cannot read the broker's account list keeps every account and its settings", async () => {
  const src = (await import("node:fs")).readFileSync("src/app/api/flow/broker/route.ts", "utf8");
  assert.match(src, /if \(accountsRes\.ok && staleIds\.length\) \{/);
});

test("the trigger the settings rely on is the one the migration creates", async () => {
  const sql = (await import("node:fs")).readFileSync("supabase/migrations/20261008010000_flow_trade_management.sql", "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");
  assert.match(sql, /if new\.trail_mode is not null then new\.manage_trades := \(new\.be_enabled is distinct from false\) or coalesce\(new\.partial_pct, 0\) > 0; end if;/);
  assert.match(sql, /create trigger flow_accounts_derive_manage before insert or update on public\.flow_broker_accounts for each row execute function public\.flow_accounts_derive_manage\(\);/);
  // and the rollback switches off the accounts the old code would otherwise read as full AI Pips
  const down = (await import("node:fs")).readFileSync("supabase/migrations/20261008010000_flow_trade_management_down.sql", "utf8");
  const first = down.indexOf("update public.flow_broker_accounts set manage_trades = false where be_enabled is false;");
  assert.ok(first >= 0 && first < down.indexOf("drop column"), "switched off before the columns go");
});

test("an older screen's AI Pips switch on a duplicated account keeps each row's own follow choice", async () => {
  fresh();
  T("flow_broker_accounts").push(
    { ...row("555", { trail_mode: "loose" }), id: "r-555a" },
    { ...row("555", { manage_trades: false, be_enabled: false, trail_mode: "off" }), id: "r-555b", connection_id: "c1" },
  );
  await post({ action: "manage", accountId: "555", connectionId: "c1", enabled: true });
  const rows = T("flow_broker_accounts").filter((x) => x.account_id === "555");
  assert.deepEqual(rows.map((x) => x.trail_mode), ["loose", "normal"]);
  assert.deepEqual(rows.map((x) => x.be_enabled), [true, true]);
  T("flow_broker_accounts").splice(0, T("flow_broker_accounts").length, ...T("flow_broker_accounts").filter((x) => x.account_id !== "555"));
});
