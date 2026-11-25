import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as policy from "../src/lib/nitrous/policy";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
type Route = { GET: () => Promise<Response>; POST: (req: Request) => Promise<Response> };
function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as T };
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { Response, Request, URL })(
    (name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; }, module, module.exports);
  return module.exports;
}

function fixture(activeMember = true, automationEnabled = false, activation?: { verified: boolean; unresolved?: number; failed?: boolean }) {
  const reads: string[] = [], brokerCalls: string[] = [];
  const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
  let addonChecks = 0;
  const at = new Date().toISOString();
  const account = { id: ACCOUNT, user_id: USER, profile: "slow_drip", risk_pct: 0.5,
    automation_enabled: automationEnabled, automation_version: 17, management_enabled: true,
    ...(activation ? { connection_id: "conn-1", status: "linked", instrument_spec: { contractSize: 100 }, spec_missing: [],
      equity: 500, equity_at: at, ownership_check: { ok: true, checkedAt: at, workerVerified: activation.verified, workerConnectionId: "conn-1" } } : {}) };
  const admin = {
    from(name: string) {
      reads.push(name);
      if (name !== "profiles" && name !== "nitrous_accounts") throw new Error(`Unexpected protected read: ${name}`);
      const filters: Record<string, unknown> = {};
      return {
        select() { return this; }, eq(key: string, value: unknown) { filters[key] = value; return this; },
        async maybeSingle() {
          if (name === "profiles") return { data: { role: "member", status: activeMember ? "active" : "suspended", access_expires_at: null }, error: null };
          assert.equal(filters.id, ACCOUNT); assert.equal(filters.user_id, USER);
          return { data: account, error: null };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      writes.push({ name, args });
      assert.equal(name, "nitrous_apply_settings");
      assert.equal(args.p_user, USER); assert.equal(args.p_account, ACCOUNT);
      return { data: [{ applied: true, automation_enabled: (args.p_patch as Record<string, unknown>).automation_enabled === true, automation_version: 18 }], error: null };
    },
  };
  const shared = load<Record<string, unknown>>("src/app/api/nitrous/_shared.ts", {
    "next/server": { NextResponse: { json: (data: unknown, init: ResponseInit) => new Response(JSON.stringify(data), init) } },
    "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/nitrous/policy": policy,
    "@/lib/nitrous/addon": { getNitrousAddonAccess: async () => {
      addonChecks++;
      return { entitled: !!activation, source: activation ? "admin" : null, adminGranted: !!activation, priceUsd: 19.99, interval: "month", subscription: null };
    } },
  });
  const unexpectedBroker = (name: string) => () => { brokerCalls.push(name); throw new Error(`Unexpected broker use: ${name}`); };
  const dependencies: Record<string, unknown> = {
    "../_shared": shared,
    "@/lib/nitrous/policy": policy,
    "../../../../../rapid/db": { withNitrousDb: unexpectedBroker("withNitrousDb") },
    "../../../../../rapid/broker/crypto": { encryptionReady: unexpectedBroker("encryptionReady"), encryptSecret: unexpectedBroker("encryptSecret"), maskEmail: unexpectedBroker("maskEmail") },
    "../../../../../rapid/broker/tradelocker": { authenticate: unexpectedBroker("authenticate"), listAccounts: unexpectedBroker("listAccounts") },
    "../../../../../rapid/broker/session": { freshToken: unexpectedBroker("freshToken") },
    "@/lib/nitrous/prepare": { prepareNitrousAccount: activation ? async () => {
      brokerCalls.push("prepareNitrousAccount");
      if (activation.failed && account.ownership_check) account.ownership_check.ok = false;
    } : unexpectedBroker("prepareNitrousAccount") },
    "@/lib/nitrous/server": { readinessContext: activation ? async (_admin: unknown, _user: string, next: Record<string, unknown>) => ({
      account: next, connection: { status: "connected" }, workerAt: at, control: { mode: "live", entries_paused: false },
      unresolved: activation.unresolved ?? 0, now: Date.now(),
    }) : unexpectedBroker("readinessContext") },
  };
  const route = (name: string) => load<Route>(`src/app/api/nitrous/${name}/route.ts`, dependencies);
  const request = (name: string, body: unknown) => new Request(`https://weare1mission.com/api/nitrous/${name}`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://weare1mission.com" }, body: JSON.stringify(body),
  });
  return { route, request, reads, writes, brokerCalls, addonChecks: () => addonChecks };
}

test("the actual analyze route rejects missing add-on access before reading protected market snapshots", async () => {
  const f = fixture();
  const response = await f.route("analyze").GET();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "nitrous_addon_required");
  assert.equal(f.addonChecks(), 1);
  assert.deepEqual(f.reads, ["profiles"]);
  assert.deepEqual(f.writes, []);
});

test("the actual connect/select route checks the add-on before broker authentication or account discovery", async () => {
  for (const action of ["connect", "select"]) {
    const f = fixture();
    const response = await f.route("connect").POST(f.request("connect", { action, environment: "demo", server: "Demo" }));
    assert.equal(response.status, 403, action);
    assert.equal((await response.json()).error, "nitrous_addon_required");
    assert.equal(f.addonChecks(), 1);
    assert.deepEqual(f.brokerCalls, []);
    assert.deepEqual(f.reads, ["profiles"]);
    assert.deepEqual(f.writes, []);
  }
});

test("the actual settings route preserves pause and management controls when base membership and add-on access have lapsed", async () => {
  for (const change of [{ automationEnabled: false }, { managementEnabled: false }]) {
    const f = fixture(false, "automationEnabled" in change);
    const response = await f.route("settings").POST(f.request("settings", { accountId: ACCOUNT, ...change }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).automationEnabled, false);
    assert.equal(f.addonChecks(), 0);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].args.p_expected_version, 17);
    assert.deepEqual(f.brokerCalls, []);
  }
});

const confirmActivation = { accountId: ACCOUNT, mode: "nitrous", riskPct: 3, automationEnabled: true, acknowledgedRisk: true, consentVersion: policy.NITROUS_CONSENT_VERSION };
test("activation uses fresh verified worker evidence without another broker request", async () => {
  const f = fixture(true, false, { verified: true });
  const response = await f.route("settings").POST(f.request("settings", confirmActivation));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).automationEnabled, true);
  assert.deepEqual(f.brokerCalls, []);
  assert.equal(f.writes.length, 1);
});
test("activation falls back to broker preparation when worker proof is absent and refuses unknown exposure or unsettled orders", async () => {
  const fallback = fixture(true, false, { verified: false });
  assert.equal((await fallback.route("settings").POST(fallback.request("settings", confirmActivation))).status, 200);
  assert.deepEqual(fallback.brokerCalls, ["prepareNitrousAccount"]);
  const failed = fixture(true, false, { verified: false, failed: true });
  assert.equal((await failed.route("settings").POST(failed.request("settings", confirmActivation))).status, 409);
  assert.deepEqual(failed.writes, []);
  const unsettled = fixture(true, false, { verified: true, unresolved: 1 });
  assert.equal((await unsettled.route("settings").POST(unsettled.request("settings", confirmActivation))).status, 409);
  assert.deepEqual(unsettled.brokerCalls, []);
  assert.deepEqual(unsettled.writes, []);
});
