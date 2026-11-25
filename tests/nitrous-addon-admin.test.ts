import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { allowedWriteOrigin } from "../src/lib/nitrous/policy";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
function endpoint(options: { signedIn?: boolean; role?: string; actorReadError?: boolean; memberExists?: boolean; grantError?: boolean } = {}) {
  const writes: unknown[][] = [];
  const admin = { from(name: string) {
    assert.equal(name, "profiles");
    let id = "";
    return { select() { return this; }, eq(_key: string, value: string) { id = value; return this; },
      async maybeSingle() { return id === ACTOR ? { data: { role: options.role ?? "admin", status: "active" }, error: options.actorReadError ? { message: "offline" } : null }
        : { data: options.memberExists === false ? null : { id }, error: null }; } };
  } };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const dependencies: Record<string, unknown> = {
    stripe: class Stripe {},
    "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user: options.signedIn === false ? null : { id: ACTOR, user_metadata: { role: "admin" } } }, error: null }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/nitrous/policy": { allowedWriteOrigin },
    "../../nitrous/_shared": { json, bodyOf: async (req: Request) => req.json().catch(() => null) },
    "@/lib/nitrous/addon": { NitrousBillingError: class NitrousBillingError extends Error {}, setAdminNitrousGrant: async (...args: unknown[]) => {
      writes.push(args);
      if (options.grantError) throw new Error("private provider detail");
      return { entitled: args[3] === true, source: args[3] ? "admin" : null, adminGranted: args[3], priceUsd: 19.99, interval: "month", subscription: null };
    } },
  };
  const source = ts.transpileModule(readFileSync("src/app/api/admin/nitrous-access/route.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as { POST: (req: Request) => Promise<Response> } };
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { process: { env: {} }, Response, Request })(
    (name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; }, module, module.exports);
  const request = (body: unknown = { userId: MEMBER, enabled: true }, origin = "https://weare1mission.com") => new Request("https://weare1mission.com/api/admin/nitrous-access", {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  return { post: module.exports.POST, request, writes, admin };
}

test("Nitrous admin grants require a fresh admin profile rather than self-asserted metadata", async () => {
  for (const options of [{ signedIn: false }, { role: "member" }, { actorReadError: true }]) {
    const h = endpoint(options); const response = await h.post(h.request());
    assert.ok([401, 403, 503].includes(response.status));
    assert.equal(h.writes.length, 0);
  }
});
test("cross-origin writes, malformed grants and unknown members make no entitlement change", async () => {
  const h = endpoint();
  assert.equal((await h.post(h.request(undefined, "https://example.org"))).status, 403);
  assert.equal((await h.post(h.request({ userId: MEMBER, enabled: "true" }))).status, 400);
  assert.equal((await h.post(h.request({ userId: "not-a-member", enabled: true }))).status, 400);
  assert.equal(h.writes.length, 0);
  const absent = endpoint({ memberExists: false });
  assert.equal((await absent.post(absent.request())).status, 404);
  assert.equal(absent.writes.length, 0);
});
test("a verified admin can grant and remove only the requested member's Nitrous entitlement", async () => {
  const h = endpoint();
  for (const enabled of [true, false]) {
    const response = await h.post(h.request({ userId: MEMBER, enabled }));
    assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.addon.adminGranted, enabled);
    const args = h.writes.at(-1)!;
    assert.equal(args[0], h.admin); assert.equal(args[1], null);
    assert.equal(args[2], MEMBER); assert.equal(args[3], enabled); assert.equal(args[4], ACTOR);
  }
});
test("grant failures return an error without leaking provider details or reporting success", async () => {
  const h = endpoint({ grantError: true }); const response = await h.post(h.request());
  assert.equal(response.status, 503);
  const result = await response.json(); assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /private provider detail/);
});
