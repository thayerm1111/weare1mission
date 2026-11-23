import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = (p: string) => readFileSync(p,"utf8");

test("standalone Floor sends authenticated members to the same current trading app", () => {
  const page = file("src/app/floor-app/page.tsx");
  assert.match(page,/supabase\.auth\.getUser\(\)/);
  assert.match(page,/if \(!user\) redirect\("\/login"\)/);
  assert.match(page,/redirect\("\/portal\/trading"\)/);
});

test("One Mission exposes new tools to ordinary active members, without an admin-only feature gate", () => {
  const portal = file("src/app/portal/layout.tsx");
  assert.match(portal,/profile\.status !== "active"/);
  assert.match(portal,/wantsNextShell/);
  const tools = file("src/components/om/ToolsHome.tsx");
  const dock = file("src/components/om/AppShell.tsx");
  assert.match(tools,/href="\/portal\/strata"/);
  assert.match(dock,/href: "\/portal\/strata"/);
  assert.match(file("src/lib/floor/nav.ts"),/return "strata"/);
  assert.doesNotMatch(file("src/app/portal/strata/page.tsx"),/role === "admin"/);
});

test("installed-app shortcut points to STRATA and the legacy app refreshes cached shell", () => {
  const newer = JSON.parse(file("public/om-app/manifest.webmanifest"));
  const old = JSON.parse(file("public/app/manifest.webmanifest"));
  assert.equal(newer.start_url,"/portal/trading");
  assert.ok(newer.shortcuts.some((s:{url:string})=>s.url==="/portal/strata"));
  assert.match(old.description,/STRATA/);
  const sw = file("public/app/sw.js");
  assert.match(sw,/const CACHE = "om-app-v\d+"/);
  assert.match(sw,/fetch\("\/app\/index\.html", \{ cache: "no-store" \}\)/);
  assert.match(sw,/\^om-app-v/);
});
