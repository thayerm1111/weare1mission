const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function moduleWith(file, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file }).outputText;
  const mod = { exports: {} };
  const context = vm.createContext({ Response, Request, JSON, Date, setTimeout, clearTimeout, process: { env: {} } });
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: file })((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, mod, mod.exports);
  return mod.exports;
}

function route(options = {}) {
  const calls = [];
  const user = options.anonymous ? null : { id: "member-A" };
  const api = moduleWith("src/app/api/atlas/chat/route.ts", {
    "@/lib/supabase/bearer": { authedContext: async () => ({ configured: options.configured !== false, supabase: options.configured === false ? null : {}, user }) },
    "@/lib/creditConfig": { CREDIT_COST: { chat: 1 } },
    "@/lib/credits": {
      gateCredits: async () => { calls.push("gate"); return options.insufficient ? { ok: false, reason: "insufficient" } : { ok: true }; },
      chargeCredit: async () => { calls.push("charge"); },
    },
    "@/lib/atlas/actions": { atlasMessages: (raw) => Array.isArray(raw) ? raw : [] },
    "@/lib/atlas/brain": {
      atlasContext: () => ({}), atlasHelpReply: () => options.help ? { reply: "Choose a market", actions: [{ type: "plays" }] } : null,
      answerAtlasApp: async (input) => { calls.push(`model:${input.userId}`); return options.failed ? { ok: false, error: "model_unavailable", reason: "Try again" } : { ok: true, usedModel: true, reply: "A grounded answer", actions: [] }; },
    },
  });
  return { calls, run: () => api.POST(new Request("https://local.test/api/atlas/chat", { method: "POST", body: JSON.stringify({ message: "Question" }) })) };
}

test("app chat authenticates before product help or expensive work", async () => {
  for (const options of [{ anonymous: true, help: true }, { configured: false, help: true }]) {
    const h = route(options), res = await h.run();
    assert.equal(res.status, options.configured === false ? 503 : 401);
    assert.deepEqual(h.calls, []);
  }
});
test("product help is free, while a successful AI answer is gated then charged exactly once", async () => {
  const help = route({ help: true }); assert.equal((await help.run()).status, 200); assert.deepEqual(help.calls, []);
  const ai = route(); const res = await ai.run(); assert.equal(res.status, 200);
  assert.deepEqual(ai.calls, ["gate", "model:member-A", "charge"]);
  assert.deepEqual(await res.json(), { reply: "A grounded answer", actions: [] });
});
test("insufficient credits prevent the model, and a failed answer never charges", async () => {
  const no = route({ insufficient: true }); assert.equal((await no.run()).status, 402); assert.deepEqual(no.calls, ["gate"]);
  const fail = route({ failed: true }); assert.equal((await fail.run()).status, 503); assert.deepEqual(fail.calls, ["gate", "model:member-A"]);
});

test("a delayed End for one surface cannot close a newer call or another member's call", async () => {
  const rows = [
    { id: "old", user_id: "A", started_at: "2026-11-22T12:00:00Z", last_seen_at: null, ended_at: "2026-11-22T12:01:00Z" },
    { id: "new", user_id: "A", started_at: "2026-11-22T12:01:00Z", last_seen_at: null, ended_at: null },
    { id: "foreign", user_id: "B", started_at: "2026-11-22T12:01:00Z", last_seen_at: null, ended_at: null },
  ];
  const db = { from() {
    const filters = []; let update = null;
    const matches = (r) => filters.every(([key, value]) => r[key] === value);
    const q = {
      select() { return q; }, eq(key, value) { filters.push([key, value]); return q; }, is(key, value) { filters.push([key, value]); return q; },
      update(value) { update = value; return q; },
      maybeSingle: async () => ({ data: rows.find(matches) || null }),
      then(resolve) { if (update) rows.filter(matches).forEach((r) => Object.assign(r, update)); return Promise.resolve({}).then(resolve); },
    };
    return q;
  } };
  const engine = moduleWith("command-center/engines/voice.ts", { "node:crypto": require("node:crypto"), "../adapters/db": { db: () => db } });
  await engine.closeSession("A", "late old end", "old");
  assert.equal(rows[1].ended_at, null);
  await engine.closeSession("A", "wrong member", "foreign");
  assert.equal(rows[2].ended_at, null);
  await engine.closeSession("A", "current end", "new");
  assert.ok(rows[1].ended_at);
  assert.equal(rows[2].ended_at, null);
});
