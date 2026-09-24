import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acctArmed, masterShouldBe, accountsToArmOnMasterOn,
  setMaster, setAllAccounts, syncMasterFromAccounts, syncAccountsFromMaster, readMaster,
} from "../src/lib/flow/armState";

/**
 * The whole point of armState is that the two FLOW switches can never disagree, so these tests are
 * written against the disagreements that actually happened in production rather than against the
 * happy path: 25 members with an account armed and the master off, and 8 with the master on and
 * nothing to run it on.
 */

type Row = { account_id: string; autotrade_enabled?: boolean | null; genx_follower?: boolean | null; is_selected?: boolean | null };

/** A stand-in for the two tables, faithful enough to exercise the read/write round trip. */
function fakeAdmin(init: { accounts?: Row[]; master?: boolean | null; hasRow?: boolean; failAccounts?: boolean }) {
  const state = {
    accounts: (init.accounts ?? []).map((a) => ({ ...a })),
    master: init.master ?? null,
    hasRow: init.hasRow ?? init.master != null,
    writes: 0,
  };
  const admin = {
    from(table: string) {
      if (table === "flow_auto_settings") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => state.hasRow
                    ? { data: { user_id: "u", enabled: state.master }, error: null }
                    : { data: null, error: null },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            return { eq: async () => { state.master = patch.enabled as boolean; state.writes++; return { error: null }; } };
          },
          insert: async (row: Record<string, unknown>) => {
            state.master = row.enabled as boolean; state.hasRow = true; state.writes++; return { error: null };
          },
        };
      }
      // flow_broker_accounts
      return {
        select() {
          return { eq: async () => init.failAccounts ? { data: null, error: { message: "boom" } } : { data: state.accounts, error: null } };
        },
        update(patch: Record<string, unknown>) {
          const q = {
            _ids: null as string[] | null,
            eq() { return q; },
            in(_c: string, ids: string[]) { q._ids = ids; return q; },
            select: async () => {
              const hit = state.accounts.filter((a) => !q._ids || q._ids.includes(a.account_id));
              for (const a of hit) Object.assign(a, patch);
              return { data: hit.map((a) => ({ account_id: a.account_id })), error: null };
            },
          };
          return q;
        },
      };
    },
  };
  return { admin: admin as never, state };
}

test("an account counts as armed for auto-trading OR GENX following", () => {
  assert.equal(acctArmed({ account_id: "a", autotrade_enabled: true }), true);
  assert.equal(acctArmed({ account_id: "a", genx_follower: true }), true);
  assert.equal(acctArmed({ account_id: "a", autotrade_enabled: false, genx_follower: false }), false);
  assert.equal(acctArmed({ account_id: "a" }), false);
});

test("the master follows the accounts", () => {
  assert.equal(masterShouldBe([]), false);
  assert.equal(masterShouldBe([{ account_id: "a", autotrade_enabled: false }]), false);
  assert.equal(masterShouldBe([{ account_id: "a", autotrade_enabled: false }, { account_id: "b", genx_follower: true }]), true);
});

test("master ON arms the selected accounts, or the only one, and never guesses between several", () => {
  assert.deepEqual(accountsToArmOnMasterOn([{ account_id: "solo" }]), ["solo"]);
  assert.deepEqual(
    accountsToArmOnMasterOn([{ account_id: "a", is_selected: true }, { account_id: "b" }, { account_id: "c" }]),
    ["a"],
  );
  // several accounts, none selected → arm nothing rather than pick someone's live account for them
  assert.deepEqual(accountsToArmOnMasterOn([{ account_id: "a" }, { account_id: "b" }]), []);
  // already armed → leave their choice completely alone
  assert.deepEqual(accountsToArmOnMasterOn([{ account_id: "a", autotrade_enabled: true }, { account_id: "b" }]), []);
});

test("THE 25: arming an account with the master off arms the master", async () => {
  const { admin, state } = fakeAdmin({ master: false, accounts: [{ account_id: "a", autotrade_enabled: true }] });
  const r = await syncMasterFromAccounts(admin, "u");
  assert.equal(r.master, true);
  assert.equal(r.changed, true);
  assert.equal(state.master, true);
});

test("disarming the LAST account disarms the master", async () => {
  const { admin, state } = fakeAdmin({ master: true, accounts: [{ account_id: "a", autotrade_enabled: false, genx_follower: false }] });
  const r = await syncMasterFromAccounts(admin, "u");
  assert.equal(r.master, false);
  assert.equal(state.master, false);
});

test("disarming one of two armed accounts leaves the master alone", async () => {
  const { admin, state } = fakeAdmin({
    master: true,
    accounts: [{ account_id: "a", autotrade_enabled: false }, { account_id: "b", autotrade_enabled: true }],
  });
  const r = await syncMasterFromAccounts(admin, "u");
  assert.equal(r.changed, false);
  assert.equal(state.master, true);
  assert.equal(r.armedAccounts, 1);
});

test("OFF MEANS OFF: master off disarms auto-trading and GENX following alike", async () => {
  const { admin, state } = fakeAdmin({
    master: true,
    accounts: [{ account_id: "a", autotrade_enabled: true }, { account_id: "b", genx_follower: true }],
  });
  const r = await syncAccountsFromMaster(admin, "u", false);
  assert.equal(r.accountsChanged, 2);
  assert.deepEqual(state.accounts.map((a) => [a.autotrade_enabled, a.genx_follower]), [[false, false], [false, false]]);
});

test("THE 8: master on with nothing armed arms the only account", async () => {
  const { admin, state } = fakeAdmin({ master: true, accounts: [{ account_id: "solo" }] });
  const r = await syncAccountsFromMaster(admin, "u", true);
  assert.equal(r.accountsChanged, 1);
  assert.equal(r.needsAccountPick, false);
  assert.equal(state.accounts[0].autotrade_enabled, true);
});

test("master on with several unselected accounts arms none and asks", async () => {
  const { admin, state } = fakeAdmin({ master: true, accounts: [{ account_id: "a" }, { account_id: "b" }] });
  const r = await syncAccountsFromMaster(admin, "u", true);
  assert.equal(r.accountsChanged, 0);
  assert.equal(r.needsAccountPick, true);
  assert.equal(state.accounts.every((a) => a.autotrade_enabled !== true), true);
});

test("master on NEVER switches GENX following on for someone", async () => {
  const { admin, state } = fakeAdmin({ master: true, accounts: [{ account_id: "solo" }] });
  await syncAccountsFromMaster(admin, "u", true);
  assert.notEqual(state.accounts[0].genx_follower, true);
});

test("a missing settings row reads as ON, so reconciling never silences a trading member", async () => {
  const { admin } = fakeAdmin({ hasRow: false, accounts: [{ account_id: "a", autotrade_enabled: true }] });
  assert.equal(await readMaster(admin, "u"), true);
});

test("an unreadable accounts table changes nothing", async () => {
  const { admin, state } = fakeAdmin({ master: false, failAccounts: true, accounts: [{ account_id: "a", autotrade_enabled: true }] });
  const before = state.writes;
  const r = await syncMasterFromAccounts(admin, "u");
  assert.equal(r.changed, false);
  assert.equal(state.writes, before);
  assert.equal(state.master, false);
});

test("setMaster creates a fully-formed row for a member who has never had one", async () => {
  const { admin, state } = fakeAdmin({ hasRow: false, accounts: [] });
  assert.equal(await setMaster(admin, "u", true), true);
  assert.equal(state.master, true);
  assert.equal(state.hasRow, true);
});

test("setAllAccounts can target a subset", async () => {
  const { admin, state } = fakeAdmin({
    master: true,
    accounts: [{ account_id: "a", autotrade_enabled: true }, { account_id: "b", autotrade_enabled: true }],
  });
  const n = await setAllAccounts(admin, "u", false, ["a"]);
  assert.equal(n, 1);
  assert.equal(state.accounts[0].autotrade_enabled, false);
  assert.equal(state.accounts[1].autotrade_enabled, true);
});
