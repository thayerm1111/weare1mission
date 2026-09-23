import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir: string, exts = [".ts", ".tsx"]): string[] =>
  readdirSync(dir).flatMap((f) => { const p = join(dir, f); if (f === "node_modules" || f === ".next") return []; return statSync(p).isDirectory() ? walk(p, exts) : exts.some((e) => p.endsWith(e)) ? [p] : []; });

const FORBIDDEN_IN_AURIC = ["@/lib/flow", "@/lib/genx", "src/lib/flow", "src/lib/genx", "@/lib/genxCompute", "command-center/", "@/lib/matty", "matty-pips", "om-ai", "omai", "@/lib/ccPass", "@/lib/credits", "@/lib/marketData", "@/lib/econCalendar", "worker/"];

test("AURIC IS CLEAN ROOM: nothing under auric/ imports GENX, FLOW, ATLAS, OM AI Plays or Matty Pips code", () => {
  const files = [...walk("auric"), ...walk("src/app/api/auric"), ...walk("src/app/auric"), ...walk("src/components/auric")];
  assert.ok(files.length >= 20, `expected the auric package to exist (${files.length} files)`);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const bad of FORBIDDEN_IN_AURIC) assert.ok(!src.includes(`from "${bad}`) && !src.includes(`from '${bad}`) && !src.includes(`from "../${bad}`) && !src.includes(`import("${bad}`), `${f} must not import ${bad}`);
  }
});

test("NOTHING ELSE IMPORTS AURIC: existing products are unchanged by the package's presence", () => {
  const roots = ["src", "command-center", "worker", "relay"];
  for (const root of roots) {
    for (const f of walk(root)) {
      if (f.startsWith("src/app/api/auric") || f.startsWith("src/app/auric") || f.startsWith("src/components/auric")) continue;
      const src = readFileSync(f, "utf8");
      assert.ok(!/from\s+["'][^"']*\/auric\//.test(src) && !/from\s+["']auric\//.test(src), `${f} must not import from auric/`);
    }
  }
});

test("AURIC writes only auric_* tables (plus the shared wallet RPC spend_credits_for inside its own RPC)", () => {
  const files = [...walk("auric"), ...walk("src/app/api/auric")];
  const writes: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.from\(["']([a-z0-9_]+)["']\)\s*\.(insert|update|upsert|delete)/g)) writes.push(`${f}:${m[1]}`);
  }
  for (const w of writes) assert.ok(/:auric_/.test(w), `non-auric table written: ${w}`);
});
