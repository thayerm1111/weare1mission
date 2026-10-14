import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * MEMBERS READ THEIR OWN ACTIVITY ONLY THROUGH THE SITE (owner 10-14: "Fix whatever you gotta fix").
 * A member out of credits still gets a "skipped" line with the trade's side when a GENX setup triggers;
 * the site hides it behind the credit lock, and the database must not hand it over directly.
 * supabase/migrations/20261014180000_member_activity_reads_server_only.sql drops the own-row read
 * policies on flow_auto_events and genfx_fills. That is only safe while nothing reads those tables
 * from the browser, where row security now returns nothing at all.
 */
const TABLES = /["'`](flow_auto_events|genfx_fills)["'`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("the migration drops both own-row read policies, and its undo puts them back", () => {
  const up = readFileSync("supabase/migrations/20261014180000_member_activity_reads_server_only.sql", "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(up, /drop policy if exists flow_auto_events_own on public\.flow_auto_events;/);
  assert.match(up, /drop policy if exists genfx_fills_select_own on public\.genfx_fills;/);
  assert.doesNotMatch(up, /create policy|disable row level security|grant /i, "nothing is opened");
  const down = readFileSync("supabase/migrations/20261014180000_member_activity_reads_server_only_down.sql", "utf8");
  assert.match(down, /create policy flow_auto_events_own on public\.flow_auto_events for select using \(auth\.uid\(\) = user_id\);/);
  assert.match(down, /create policy genfx_fills_select_own on public\.genfx_fills for select using \(auth\.uid\(\) = user_id\);/);
});

test("no browser code reads either table", () => {
  const browser = [
    ...walk("src").filter((f) => /\.(tsx?|jsx?)$/.test(f) && /^\s*["']use client["']/.test(readFileSync(f, "utf8"))),
    ...walk("src/components").filter((f) => /\.(tsx?|jsx?)$/.test(f)),
    ...walk("public").filter((f) => /\.(html?|m?js)$/.test(f)),
  ];
  assert.ok(browser.length > 20, "the scan found the browser code");
  const readers = [...new Set(browser)].filter((f) => TABLES.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers, []);
});

test("every server read goes through the service-role client, which row security does not limit", () => {
  const server = walk("src").filter((f) => /\.tsx?$/.test(f) && TABLES.test(readFileSync(f, "utf8")));
  assert.ok(server.length >= 5);
  let calls = 0;
  for (const f of server) {
    // Every query on either table is made on `admin` — the service-role client these files are handed or
    // create. A user-scoped client (the member's own session) would now read nothing from them.
    for (const m of readFileSync(f, "utf8").matchAll(/(\w+)\s*\.\s*from\(\s*["'`](flow_auto_events|genfx_fills)["'`]/g)) {
      calls += 1;
      assert.equal(m[1], "admin", `${f}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.ok(calls >= 20, `found the queries (${calls})`);
});
