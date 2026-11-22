const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const file = "src/app/api/portal/announcement/route.ts";
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }, fileName: file }).outputText;
const KEY = "one_mission_welcome_v1";

// The real route runs against a session-scoped fake. No external requests or service credentials exist here.
function harness(options = {}) {
  let member = options.member === undefined ? "member-a" : options.member;
  const rows = [...(options.rows ?? [])], writes = [], reads = [];
  const sb = {
    auth: { async getUser() { if (options.authThrows) throw Error("unavailable"); return { data: { user: member ? { id: member } : null }, error: null }; } },
    from(table) {
      assert.equal(table, "portal_announcements_seen");
      const filters = [];
      const q = {
        select() { return q; }, eq(key, value) { filters.push([key, value]); return q; },
        async maybeSingle() {
          reads.push(filters);
          return { error: options.readError ? { message: "unavailable" } : null, data: rows.find((row) => filters.every(([k, v]) => row[k] === v)) ?? null };
        },
        async upsert(row, settings) {
          writes.push({ row, settings });
          if (options.writeError) return { error: { message: "unavailable" } };
          const exists = rows.find((r) => r.user_id === row.user_id && r.key === row.key);
          if (!exists) rows.push({ ...row, seen_at: "fixture-first-write" });
          return { error: null };
        },
      }; return q;
    },
  };
  const mod = { exports: {} }, context = vm.createContext({ Response, Request, URL, JSON, Set });
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: file })((name) => {
    assert.equal(name, "@/lib/supabase/server"); return { createClient: () => options.configured === false ? null : sb };
  }, mod, mod.exports);
  return { rows, writes, reads, switchTo(value) { member = value; }, async run(method = "GET", body, headers = {}, key = KEY) {
    const req = new Request(`https://local.test/api/portal/announcement?key=${encodeURIComponent(key)}`, { method, headers, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body ?? { key }) } : {}) });
    const response = await mod.exports[method](req);
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  } };
}

test("the welcome key is persisted once for the authenticated member across subsequent reads", async () => {
  const h = harness();
  assert.deepEqual((await h.run()).body, { ok: true, seen: false, memberId: "member-a" });
  assert.equal((await h.run("POST", { key: KEY, expectedMemberId: "member-a", user_id: "someone-else" })).body.ok, true);
  assert.equal((await h.run()).body.seen, true);
  await h.run("POST", { key: KEY });
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].user_id, "member-a");
  assert.equal(h.writes[0].settings.ignoreDuplicates, true);
  h.switchTo("member-b");
  assert.equal((await h.run()).body.seen, false);
});

test("a stale member page cannot mark a different signed-in member's tutorial seen", async () => {
  const h = harness();
  assert.equal((await h.run("GET", null, { "x-portal-member": "member-b" })).status, 409);
  assert.equal((await h.run("POST", { key: KEY, expectedMemberId: "member-b" })).status, 409);
  assert.equal(h.reads.length, 0);
  assert.equal(h.writes.length, 0);
});

test("read failures stay unknown, and write failures never claim the tutorial was saved", async () => {
  const read = await harness({ readError: true }).run();
  assert.equal(read.status, 503); assert.equal(read.body.seen, null); assert.equal(read.body.ok, false);
  const write = harness({ writeError: true });
  const response = await write.run("POST", { key: KEY });
  assert.equal(response.status, 503); assert.equal(response.body.ok, false); assert.equal(write.rows.length, 0);
});

test("unconfigured, unauthenticated and unknown-key requests return honest private no-store errors", async () => {
  for (const method of ["GET", "POST"]) {
    for (const [options, status] of [[{ configured: false }, 503], [{ member: null }, 401], [{ authThrows: true }, 503]]) {
      const h = harness(options), result = await h.run(method, { key: KEY });
      assert.equal(result.status, status); assert.equal(result.body.ok, false); assert.match(result.cache, /private.*no-store/); assert.equal(h.writes.length, 0);
    }
    const h = harness(), invalid = await h.run(method, { key: "unrecognized" }, {}, "unrecognized");
    assert.equal(invalid.status, 400); assert.equal(h.writes.length, 0); assert.match(invalid.cache, /no-store/);
    const success = await harness().run(method, { key: KEY }); assert.match(success.cache, /no-store/);
  }
});

test("existing announcement keys remain valid and malformed bodies do not write", async () => {
  for (const key of ["atlas_command_center_2026_09", "flow_pass_2026_11"]) assert.equal((await harness().run("POST", { key })).status, 200);
  for (const body of ["{", "null", "[]", JSON.stringify({ key: [KEY] })]) {
    const h = harness(); assert.equal((await h.run("POST", body)).status, 400); assert.equal(h.writes.length, 0);
  }
});
