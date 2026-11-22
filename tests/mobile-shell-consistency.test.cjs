const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const nav = require("../src/lib/floor/nav.ts");
const { landingPath } = require("../src/lib/floor/app.ts");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const request = (ua, more = {}) => new Headers({ "user-agent": ua, ...more });

test("a stale admin classic cookie cannot select the classic portal on a phone or embedded app", () => {
  for (const headers of [request(IPHONE), request(ANDROID), request("", { "sec-ch-ua-mobile": "?1" }), request(DESKTOP, { "sec-fetch-dest": "iframe" })]) {
    assert.equal(nav.prefersAppShell(headers), true);
    assert.equal(nav.wantsNextShell("classic", true, headers), true);
  }
  assert.equal(nav.wantsNextShell("classic", true, request(DESKTOP)), false, "An explicit desktop support choice remains available");
  assert.equal(nav.wantsNextShell("classic", false, request(DESKTOP)), true, "A member's cookie never enables the admin support view");
  assert.equal(nav.wantsNextShell(undefined, true, request(DESKTOP)), true);
});

function recover(options = {}) {
  const navigations = [];
  const window = { matchMedia: () => ({ matches: !!options.standalone }) };
  window.self = window; window.top = options.iframe ? {} : window;
  vm.runInNewContext(nav.APP_SHELL_RECOVERY_SCRIPT, {
    window,
    navigator: { userAgent: options.ua ?? DESKTOP, maxTouchPoints: options.touchPoints ?? 0, standalone: !!options.iosApp },
    location: { pathname: "/portal/trading", search: "?view=flow", hash: "#accounts", replace: (to) => navigations.push(to) },
  });
  return navigations;
}

test("installed and desktop-UA tablet recovery clears only the stale display choice and preserves the current page", () => {
  for (const options of [{ ua: IPHONE }, { iframe: true }, { standalone: true }, { iosApp: true }, { touchPoints: 5 }]) {
    const navigations = recover(options);
    assert.equal(navigations.length, 1);
    const url = new URL(navigations[0], "https://weare1mission.com");
    assert.equal(url.pathname, "/api/floor/preview");
    assert.equal(url.searchParams.get("on"), "1");
    assert.equal(url.searchParams.get("to"), "/portal/trading?view=flow#accounts");
  }
  assert.deepEqual(recover(), [], "A desktop browser deliberately in Classic is not redirected");
});

const filename = path.resolve(__dirname, "../src/app/api/floor/preview/route.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
}).outputText;

async function preview(profile, headers, query = "on=0") {
  class NextResponse {
    constructor(body, options = {}) { this.body = body; this.status = options.status ?? 200; this.writes = []; this.cookies = { set: (...args) => this.writes.push(args) }; }
    static redirect(to, status) { const response = new NextResponse(null, { status }); response.location = String(to); return response; }
  }
  const module = { exports: {} };
  const dependencies = { "next/server": { NextResponse }, "@/lib/auth": { getProfile: async () => profile }, "@/lib/floor/nav": nav, "@/lib/floor/app": { landingPath } };
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, { URL })((name) => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; }, module, module.exports);
  return module.exports.GET({ url: `https://weare1mission.com/api/floor/preview?${query}`, headers });
}

test("the existing admin switch cannot put a mobile app into Classic and still keeps its role guard", async () => {
  for (const headers of [request(IPHONE), request(DESKTOP, { "sec-fetch-dest": "iframe" })]) {
    const result = await preview({ role: "admin" }, headers);
    assert.equal(result.status, 303);
    assert.equal(result.writes.length, 1);
    assert.equal(result.writes[0][0], nav.SHELL_COOKIE);
    assert.equal(result.writes[0][1], "");
    assert.equal(result.writes[0][2].maxAge, 0, "The long-lived classic cookie is removed");
    assert.equal(result.writes[0][2].httpOnly, true);
  }
  const desktop = await preview({ role: "admin" }, request(DESKTOP));
  assert.equal(desktop.writes[0][1], nav.CLASSIC_SHELL);
  assert.ok(desktop.writes[0][2].maxAge > 0);
  const restored = await preview({ role: "admin" }, request(DESKTOP), "on=1&to=%2Fportal%2Fgenx%3Fread%3Dtest");
  assert.equal(restored.location, "https://weare1mission.com/portal/genx?read=test");
  assert.equal(restored.writes[0][2].maxAge, 0);
  for (const profile of [null, { role: "member" }]) {
    const denied = await preview(profile, request(IPHONE), "on=1");
    assert.equal(denied.status, 404);
    assert.equal(denied.writes.length, 0);
  }
});

test("the layout, metadata, landing page, Floor, GENX and gold desk use the same device-aware decision", () => {
  for (const file of ["src/app/portal/layout.tsx", "src/app/portal/page.tsx", "src/app/portal/trading/page.tsx", "src/app/portal/genx/page.tsx", "src/app/command-center/layout.tsx"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const calls = [...source.matchAll(/wantsNextShell\(([^\n]+)\)/g)].map((m) => m[1]);
    assert.ok(calls.length > 0, file);
    assert.ok(calls.every((call) => call.includes("headers()")), `${file} must not disagree with the shell about this phone`);
  }
  for (const file of ["src/app/portal/layout.tsx", "src/app/command-center/layout.tsx"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    assert.match(source, /const recoverApp = (isAdmin|admin) && cookies\(\)\.get\(SHELL_COOKIE\)\?\.value === CLASSIC_SHELL;/);
    assert.match(source, /recoverApp && <script dangerouslySetInnerHTML=\{\{ __html: APP_SHELL_RECOVERY_SCRIPT \}\}/);
  }
});
