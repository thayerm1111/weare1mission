import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Rapid is a clean room.
 *
 * The point is not tidiness. FLOW's manager is the code that failed, and Rapid was built standalone
 * precisely so that nothing in FLOW's execution or management path can reach it. A test is the only
 * thing that keeps that true after the third or fourth "just import this one helper".
 */

const walk = (dir: string, exts = [".ts", ".tsx"]): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".next") return [];
    return statSync(p).isDirectory() ? walk(p, exts) : exts.some((e) => p.endsWith(e)) ? [p] : [];
  });
};

const RAPID_ROOTS = ["rapid", "src/app/api/rapid", "src/components/portal/rapid"];

const FORBIDDEN = [
  "@/lib/flow", "src/lib/flow",
  "@/lib/genx", "src/lib/genx", "@/lib/genxCompute", "@/lib/genxConfirm", "@/lib/genxResolve",
  "command-center/", "auric/",
  "@/lib/matty", "matty-pips",
  "@/lib/marketData", "@/lib/econCalendar", "@/lib/entryEngine", "@/lib/flowEngine",
  "@/lib/credits", "@/lib/ccPass",
  "worker/",
];

test("RAPID IS A CLEAN ROOM: nothing under rapid/ reaches FLOW, GENX, ATLAS, AURIC or Matty Pips", () => {
  const files = RAPID_ROOTS.flatMap((r) => walk(r));
  assert.ok(files.length >= 20, `expected the rapid package to exist (found ${files.length} files)`);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const bad of FORBIDDEN) {
      const patterns = [`from "${bad}`, `from '${bad}`, `import("${bad}`, `require("${bad}`];
      for (const p of patterns) {
        assert.ok(!src.includes(p), `${f} must not import ${bad}`);
      }
    }
  }
});

test("NOTHING ELSE DEPENDS ON RAPID except the three places that are allowed to render it", () => {
  const allowed = [
    "src/components/portal/floor/FloorWorkspace.tsx", // the Floor tab
  ];
  for (const root of ["src", "command-center", "worker", "relay", "auric"]) {
    for (const f of walk(root)) {
      if (RAPID_ROOTS.some((r) => f.startsWith(r))) continue;
      if (allowed.includes(f)) continue;
      const src = readFileSync(f, "utf8");
      assert.ok(
        !/from\s+["'][^"']*\/rapid\//.test(src) && !/from\s+["']rapid\//.test(src),
        `${f} must not import from rapid/ — add it to the allow-list only if it is a render site`,
      );
    }
  }
});

test("RAPID WRITES ONLY rapid_* TABLES", () => {
  const files = RAPID_ROOTS.flatMap((r) => walk(r));
  const writes: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.from\(["']([a-z0-9_]+)["']\)\s*\.(insert|update|upsert|delete)/g)) {
      writes.push(`${f}: ${m[1]}`);
    }
  }
  for (const w of writes) assert.match(w, /:\s*rapid_/, `a non-Rapid table is written: ${w}`);
  assert.ok(writes.length > 0, "expected the package to write something");
});

test("RAPID READS OTHER PRODUCTS' TABLES ONLY to check whether a broker account is shared", () => {
  const files = RAPID_ROOTS.flatMap((r) => walk(r));
  const foreignReads: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.from\(["']([a-z0-9_]+)["']\)/g)) {
      if (!m[1].startsWith("rapid_")) foreignReads.push(`${f}: ${m[1]}`);
    }
  }
  const allowedForeign = ["flow_broker_accounts", "cc_broker_accounts", "auric_accounts"];
  for (const r of foreignReads) {
    const table = r.split(": ")[1];
    assert.ok(allowedForeign.includes(table), `unexpected read of ${table} in ${r}`);
    assert.match(r, /ownership\.ts/, `${r}: the shared-account check is the only place that may read another product's table`);
  }
});

test("THE MIGRATION CREATES ONLY rapid_* OBJECTS and enables RLS on every one of them", () => {
  const sql = readFileSync("supabase/migrations/20260925120000_rapid.sql", "utf8");
  const created = [...sql.matchAll(/create table if not exists public\.([a-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(created.length >= 15, `expected the schema to create its tables (found ${created.length})`);
  for (const t of created) assert.match(t, /^rapid_/, `the migration creates a non-Rapid table: ${t}`);

  const rls = new Set([...sql.matchAll(/alter table public\.([a-z0-9_]+)\s+enable row level security/g)].map((m) => m[1]));
  for (const t of created) assert.ok(rls.has(t), `${t} does not have row level security enabled`);

  // Nothing in the migration may touch another product's data.
  assert.ok(!/\b(drop|alter)\s+table\s+(if exists\s+)?public\.(?!rapid_)/i.test(sql), "the migration alters or drops a non-Rapid table");
});

test("AUTOMATION DEFAULTS OFF IN THE SCHEMA — a deploy can never arm an existing member", () => {
  const sql = readFileSync("supabase/migrations/20260925120000_rapid.sql", "utf8");
  assert.match(sql, /automation_enabled boolean not null default false/, "automation_enabled must default to false");
  assert.match(sql, /entries_paused\s+boolean not null default true/, "the global control must start with entries paused");
});

test("THE LIVE FEATURE FLAG SHIPS OFF", async () => {
  const { DEFAULT_CONFIG } = await import("../rapid/config/defaults");
  assert.equal(DEFAULT_CONFIG.liveEnabled, false, "matty_rapid_v1 must ship with execution disabled");
  assert.equal(DEFAULT_CONFIG.entry.momentumEnabled, false, "the momentum research variant must ship off");
});

test("THE CONFIG IS FROZEN: nothing at runtime can quietly change a live parameter", async () => {
  const { DEFAULT_CONFIG } = await import("../rapid/config/defaults");
  assert.throws(() => {
    (DEFAULT_CONFIG as unknown as { protection: { stopCapUsd: number } }).protection.stopCapUsd = 999;
  }, /read only|Cannot assign/i);
});

test("NO LLM CALL EXISTS ANYWHERE IN THE QUOTE-TO-ORDER PATH", () => {
  const files = walk("rapid");
  const banned = /anthropic|openai|claude-|gpt-|\/v1\/messages|chat\.completions/i;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Comments may discuss it; code may not call it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    assert.ok(!banned.test(code), `${f} references a language-model API inside the decision path`);
  }
});
