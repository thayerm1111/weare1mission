import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

/**
 * THE DESKTOP SHELL IS A WINDOW, NOT A TRADING SYSTEM.
 *
 * Every test here guards a boundary that is invisible at runtime and catastrophic to cross. A desktop
 * application that could place an order is a desktop application whose crash could strand one, and a
 * remote origin with filesystem access is a website with filesystem access. Neither failure announces
 * itself; both are one careless line away at any time.
 */

const conf = async () => JSON.parse(await fs.readFile("desktop/src-tauri/tauri.conf.json", "utf8"));
const cap = async (n: string) => JSON.parse(await fs.readFile(`desktop/src-tauri/capabilities/${n}.json`, "utf8"));

test("the shell loads the deployed application rather than bundling a second one", async () => {
  const c = await conf();
  const windows = c.app.windows as { label: string; url: string }[];
  const labels = windows.map((w) => w.label).sort();
  assert.deepEqual(labels, ["companion", "main"], "two windows, named");
  for (const w of windows) {
    assert.ok(w.url.startsWith("https://"), `${w.label} must load over https, not a bundled file`);
  }
  assert.ok(String(c.build.frontendDist).startsWith("https://"), "no local frontend is bundled");
  // The companion has no decorations, so the page must be free to drag its own window.
  const companion = windows.find((w) => w.label === "companion") as Record<string, unknown>;
  assert.equal(companion.decorations, false);
  assert.equal(companion.transparent, true);
  assert.equal(c.app.macOSPrivateApi, true, "transparency requires it on macOS, and it must be declared");
});

test("THE BRAIN appears first and the Command Center waits behind it", async () => {
  const c = await conf();
  const windows = c.app.windows as { label: string; visible?: boolean }[];
  assert.equal(windows[0].label, "companion", "the companion is created first");
  assert.equal(windows.find((w) => w.label === "main")?.visible, false, "the full application starts hidden");
  const rs = await fs.readFile("desktop/src-tauri/src/lib.rs", "utf8");
  assert.ok(/get_webview_window\("main"\)[\s\S]{0,80}hide\(\)/.test(rs), "and is hidden rather than never created, so raising it is instant");
});

test("the remote origin is granted windows and notifications, and nothing else", async () => {
  const c = await cap("remote-command-center");
  assert.equal(c.local, false, "this grant is for the deployed site only, never for local content");
  assert.ok(Array.isArray(c.remote?.urls) && c.remote.urls.length, "scoped to named origins");
  for (const u of c.remote.urls) assert.ok(String(u).startsWith("https://weare1mission.com") || String(u).startsWith("https://www.weare1mission.com"), `unexpected origin: ${u}`);

  const perms: string[] = c.permissions;
  assert.ok(!perms.includes("core:default"), "core:default is far wider than this needs");
  for (const p of perms) {
    assert.ok(
      /^core:(window|event):/.test(p) || /^notification:/.test(p),
      `a remote page must not be granted ${p}`,
    );
  }
  // The capabilities that would turn a web page into a local program.
  const forbidden = /(^|:)(fs|shell|process|http|os|dialog|updater|store|clipboard-manager|global-shortcut|autostart|deep-link)[:-]/;
  for (const p of perms) assert.ok(!forbidden.test(p), `${p} must never be reachable from remote content`);
});

test("the shell carries no credentials", async () => {
  const files = ["desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/src/lib.rs", "desktop/src-tauri/src/main.rs",
    "desktop/src-tauri/capabilities/default.json", "desktop/src-tauri/capabilities/remote-command-center.json",
    "desktop/package.json"];
  const secrets = /SERVICE_ROLE|SUPABASE_SERVICE|TL_[A-Z_]*KEY|ELEVENLABS_API_KEY|RAILWAY_TOKEN|STRIPE_[A-Z_]*KEY|FLOW_ENC_KEY|CC_ENC_KEY|sk_[a-z0-9]{16}|eyJ[A-Za-z0-9_-]{20}/;
  for (const f of files) {
    const body = await fs.readFile(f, "utf8");
    assert.ok(!secrets.test(body), `${f} must not contain a credential`);
  }
});

test("the global shortcut is registered by the shell, not by the page", async () => {
  const rs = await fs.readFile("desktop/src-tauri/src/lib.rs", "utf8");
  assert.ok(/global_shortcut/.test(rs), "the shell owns it");
  const c = await cap("remote-command-center");
  assert.ok(!c.permissions.some((p: string) => p.startsWith("global-shortcut:")),
    "granting a remote origin system-wide key bindings is worth more to an attacker than anything else here");
});

/*
 * THE ONE THAT MATTERS MOST.
 *
 * A "take trade" button on a floating window is the most dangerous control that could exist in this
 * product: it is small, it is always on screen, and it is one careless line away from bypassing risk
 * limits, permissions and the reconciliation that makes a position real. The companion opens the place
 * where that decision is made properly, and this test is what keeps it that way.
 */
test("the companion cannot place, modify or close a position", async () => {
  const src = await fs.readFile("src/components/command-center/BrainCompanion.tsx", "utf8");
  const calls = [...src.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["/api/command-center/live"], "it reads the same feed the screen reads, and calls nothing else");
  assert.ok(!/method:\s*"POST"/.test(src), "and never writes");
  assert.ok(/Review it in Command Center/.test(src), "a ready setup is handed to the full application");
});

test("the companion shows no live state while it is still connecting", async () => {
  const src = await fs.readFile("src/components/command-center/BrainCompanion.tsx", "utf8");
  assert.ok(/booting\)\s*return\s*\{\s*word:\s*"CONNECTING"/.test(src), "connecting is its own state");
  assert.ok(/setD\(null\)/.test(src), "and a failed poll clears the reading rather than leaving the last good one on screen");
});
