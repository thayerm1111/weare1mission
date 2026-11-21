import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { APP_INSTALL_SCRIPT, APP_MANIFEST, APP_THEME, installGuide, landingPath } from '../src/lib/floor/app';

/*
 * THE ONE MISSION APP AND THE MOBILE PASS (owner 11-21: "Need to make mobile version and app also" — the One Mission
 * app on the new design, installed from the website; "Just me first").
 *
 * What is pinned here:
 *   • the new design is what installs — the manifest, its icons and the home-screen meta are on the new shell's pages
 *     only, and the new shell is still an admin's preview, so no member is offered anything yet;
 *   • the installed app opens in the new design even on an iPhone, whose home-screen apps keep their own cookies;
 *   • installing never happens on its own: the browser's offer is held for "Install the app", and where a browser has
 *     no dialog the steps are its own words;
 *   • a phone's controls are sized for a finger and its fields do not make an iPhone zoom; nothing is pushed past the
 *     screen's edge (Atlas's header was, in the preview).
 */
const read = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = () => read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const MAC_SAFARI = IPAD_AS_MAC;
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0';

/* ── how each browser installs it ── */
test('installing: the browser\'s own dialog where there is one, otherwise that browser\'s own steps', () => {
  assert.equal(installGuide(ANDROID, 5, true).kind, 'prompt', 'a browser that offers its dialog needs no steps');
  assert.deepEqual(installGuide(ANDROID, 5, true).steps, []);
  const ios = installGuide(IPHONE, 5, false);
  assert.equal(ios.kind, 'ios');
  assert.match(ios.steps.join(' '), /Share/);
  assert.match(ios.steps.join(' '), /Add to Home Screen/);
  assert.match(ios.note ?? '', /sign in once/, 'an iPhone keeps the app\'s sign-in apart from Safari\'s, so it is said');
  assert.equal(installGuide(IPAD_AS_MAC, 5, false).kind, 'ios', 'an iPad reports itself as a Mac; its touch points give it away');
  assert.equal(installGuide(MAC_SAFARI, 0, false).kind, 'mac-safari');
  assert.match(installGuide(MAC_SAFARI, 0, false).steps.join(' '), /Add to Dock/);
  assert.equal(installGuide(MAC_CHROME, 0, false).kind, 'desktop');
  assert.match(installGuide(MAC_CHROME, 0, false).steps.join(' '), /Install One Mission/);
  assert.equal(installGuide(ANDROID, 5, false).kind, 'android');
  assert.match(installGuide(ANDROID, 5, false).steps.join(' '), /Install app|Add to Home screen/);
  assert.equal(installGuide(FIREFOX, 0, false).kind, 'none', 'a browser that cannot install says so and names one that can');
  for (const ua of [IPHONE, ANDROID]) assert.match(installGuide(ua, 5, false).intro, /home screen/);
  for (const ua of [MAC_SAFARI, MAC_CHROME]) assert.match(installGuide(ua, 0, false).intro, /own window/);
});

test('the browser\'s offer is held for the menu, never shown on its own', () => {
  const heard: Record<string, (e: unknown) => void> = {};
  const fired: string[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (k: string, f: (e: unknown) => void) => { heard[k] = f; },
    dispatchEvent: (e: { type: string }) => { fired.push(e.type); return true; },
  };
  win.window = win;
  runInNewContext(APP_INSTALL_SCRIPT, { window: win, Event: class { type: string; constructor(t: string) { this.type = t; } } });
  let prevented = false;
  const offer = { preventDefault: () => { prevented = true; } };
  heard.beforeinstallprompt(offer);
  assert.ok(prevented, 'the mini-infobar does not pop up');
  assert.equal(win.__omInstall, offer, 'the offer is kept for "Install the app"');
  assert.deepEqual(fired, ['om-install-ready']);
  heard.appinstalled({});
  assert.equal(win.__omInstall, null, 'once installed, nothing is offered again');
});

/* ── the installed app opens in the new design ── */
test('the installed app opens in the new design for everyone: nothing has to switch it on any more', () => {
  const src = read('src/lib/floor/app.ts') + read('src/app/portal/layout.tsx');
  assert.ok(!/APP_RETURN_SCRIPT/.test(src), 'the admin-preview workaround is gone with the preview');
});

test('the preview switch lands back on the page it was asked from — a page on this site, never another', () => {
  assert.equal(landingPath('/portal/signals?td=EUR%2FUSD&style=intraday'), '/portal/signals?td=EUR%2FUSD&style=intraday');
  assert.equal(landingPath('/command-center'), '/command-center');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'portal', '', null, undefined, '/a\r\nSet-Cookie: x=1', '/' + 'a'.repeat(600)]) {
    assert.equal(landingPath(bad as string | null | undefined), null, `${String(bad).slice(0, 30)} is refused`);
  }
  const route = code('src/app/api/floor/preview/route.ts');
  assert.match(route, /if \(!profile \|\| profile\.role !== "admin"\) return new NextResponse\("Not found", \{ status: 404 \}\)/, 'still admin-only');
  assert.match(route, /new URL\(\(on && landingPath\(q\.get\("to"\)\)\) \|\| "\/portal\/trading", req\.url\)/);
});

/* ── what installs, and who is offered it ── */
test('the manifest names the One Mission app on the new design, and its icons are real files of the sizes it says', () => {
  assert.equal(APP_MANIFEST, '/om-app/manifest.webmanifest');
  const m = JSON.parse(read('public' + APP_MANIFEST));
  assert.equal(m.name, 'One Mission');
  assert.equal(m.display, 'standalone');
  assert.equal(m.scope, '/');
  assert.equal(m.start_url, '/portal/trading', 'it opens on The Floor');
  assert.equal(m.theme_color, APP_THEME);
  assert.equal(m.background_color, APP_THEME);
  assert.equal(APP_THEME, '#f5f4f1', 'the canvas of the default look, Stone');
  assert.ok(m.id && m.id !== '/app/index.html', 'its own identity: the members\' app at /app/ stays a separate app');
  const png = (p: string) => { const b = readFileSync('public' + p); assert.equal(b.toString('ascii', 1, 4), 'PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  const icons = m.icons as { src: string; sizes: string; purpose?: string }[];
  for (const i of [...icons, ...m.shortcuts.flatMap((s: { icons: { src: string; sizes: string }[] }) => s.icons)]) {
    assert.ok(existsSync('public' + i.src), `${i.src} exists`);
    assert.equal(png(i.src).join('x'), i.sizes, `${i.src} is ${i.sizes}`);
  }
  assert.ok(icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512'), 'the two sizes every install needs');
  assert.ok(icons.some((i) => i.purpose === 'maskable'), 'Android can shape it to its own icon mask');
  assert.equal(png('/om-app/apple-touch-icon.png').join('x'), '180x180', 'the iPhone home-screen icon');
  for (const s of m.shortcuts) assert.ok(String(s.url).startsWith('/') && !String(s.url).startsWith('//'));
  // The members' app is untouched.
  assert.match(read('public/app/manifest.webmanifest'), /"scope": "\/app\/"/);
});

test('the new shell\'s pages say they can be installed — every active member\'s — with one profile lookup per request', () => {
  for (const f of ['src/app/portal/layout.tsx', 'src/app/command-center/layout.tsx']) {
    const src = code(f);
    const gate = src.slice(src.indexOf('const inNewShell = cache('), src.indexOf('export async function generateMetadata'));
    assert.match(gate, /const profile = await getProfile\(\);\s*if \(!profile\) return false;/, `${f}: a signed-out page says nothing`);
    assert.match(gate, /wantsNextShell\(cookies\(\)\.get\(SHELL_COOKIE\)\?\.value, (isAdmin|profile\.role === "admin")\)/, `${f}: the same answer as the layout's own, decided on the server`);
    assert.match(src, /const getProfile = cache\(readProfile\);/, `${f}: the profile is read once per request`);
    const meta = src.slice(src.indexOf('export async function generateMetadata'));
    assert.match(meta, /if \(!\(await inNewShell\(\)\)\) return (PORTAL|CC)_METADATA;/, `${f}: everyone else's page is as it was`);
    assert.match(meta, /manifest: APP_MANIFEST/);
    assert.match(meta, /appleWebApp: \{ capable: true, title: APP_NAME, statusBarStyle: "default" \}/, `${f}: a light bar with dark text, for the Stone look`);
    assert.match(meta, /apple: \[\{ url: "\/om-app\/apple-touch-icon\.png"/);
  }
  const portal = code('src/app/portal/layout.tsx');
  assert.match(portal, /if \(!isAdmin && profile\.status !== "active"\) return false;/, 'a pending or suspended member\'s page is the classic notice, and says nothing about an app');
  assert.match(portal, /return \(await inNewShell\(\)\) \? \{ themeColor: APP_THEME, viewportFit: "cover" \} : \{\};/, 'the shell reaches the screen\'s edges and pads itself');
  assert.match(portal, /<script dangerouslySetInnerHTML=\{\{ __html: APP_INSTALL_SCRIPT \}\} \/>\s*<AppShell/, 'the offer is caught before the shell mounts');
  assert.match(code('src/app/command-center/layout.tsx'), /return \(await inNewShell\(\)\) \? \{ themeColor: ATLAS_THEME \} : \{\};/, 'Atlas keeps its own dark frame, inside the safe area');
  // No site-wide manifest: Next's app/manifest convention would put it on every page, for everyone.
  assert.ok(!existsSync('src/app/manifest.ts') && !existsSync('src/app/manifest.json') && !existsSync('src/app/manifest.webmanifest'));
});

test('the account menu offers "Install the app" in a browser tab; an admin\'s "Classic portal" is not offered inside the installed app', () => {
  const shell = code('src/components/om/AppShell.tsx');
  assert.match(shell, /\{onInstall && <button type="button" role="menuitem" onClick=\{\(\) => \{ setOpen\(false\); onInstall\(\); \}\}><Smartphone aria-hidden="true" \/>Install the app<\/button>\}/);
  assert.match(shell, /onInstall=\{configured && offer \? install : undefined\}/);
  assert.match(shell, /\{preview && asApp !== true && <a role="menuitem" href="\/api\/floor\/preview\?on=0"><Undo2 aria-hidden="true" \/>Classic portal<\/a>\}/);
  assert.match(code('src/app/portal/layout.tsx'), /preview=\{isAdmin\}/, 'only an admin is offered the classic portal');
  assert.match(shell, /<OfflineNotice \/>/);
  const ia = code('src/components/om/InstallApp.tsx');
  assert.match(ia, /return \{ asApp, offer: asApp === false && !installed, canPrompt, install \};/, 'nothing is offered on a guess, or once installed');
  assert.match(ia, /\(window\.navigator as Navigator & \{ standalone\?: boolean \}\)\.standalone === true \|\| window\.matchMedia\("\(display-mode: standalone\)"\)\.matches/);
  assert.match(ia, /role="dialog" aria-modal="true" aria-labelledby="om-install-title"/);
  assert.match(ia, /if \(e\.key === "Escape"\) onClose\(\);/);
  assert.match(ia, /from\?\.focus\?\.\(\);/, 'focus goes back where it came from');
  // Nothing installed by this work caches the site on the device: every screen is the live site.
  assert.ok(!/serviceWorker\.register/.test(ia + shell));
});

/* ── a phone, a finger ── */
test('the shell keeps clear of notches and the home indicator, and sizes controls for a finger', () => {
  const c = css();
  assert.match(c, /\.om-frame \{[^}]*padding: 0 max\(var\(--om-pad\), env\(safe-area-inset-right, 0px\)\) 0 max\(var\(--om-pad\), env\(safe-area-inset-left, 0px\)\)/);
  assert.match(c, /\.om-nav-wrap \{[^}]*padding-top: calc\(18px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(c, /\.om-tabbar \{\s*position: fixed;[^}]*padding: 6px max\(8px, env\(safe-area-inset-right, 0px\)\) calc\(6px \+ env\(safe-area-inset-bottom, 0px\)\) max\(8px, env\(safe-area-inset-left, 0px\)\)/);
  const touch = c.slice(c.indexOf('@media (pointer: coarse)'));
  assert.ok(c.includes('@media (pointer: coarse)'));
  assert.match(touch, /\.om-input, \.om-combo input, \.om-ask input, \.om-select select, \.om-flow-find \.om-select select \{ font-size: 16px; \}/, 'an iPhone zooms in on a field under 16px');
  assert.match(touch, /\.om-icon-btn \{ width: 40px; height: 40px; \}/);
  assert.match(touch, /\.om-go \{ padding-top: 9px; padding-bottom: 9px; margin-top: -9px; margin-bottom: -9px; \}/, 'a text link\'s reach grows, not the layout');
  assert.match(c, /\.om-icon-btn \{ flex: 0 0 auto; \}/, 'an icon button is never squeezed to a sliver beside a long line (FLOW\'s desk record)');
  assert.match(c, /\.om-app \{ -webkit-tap-highlight-color: transparent; \}/);
  assert.match(c, /\.om-install \{[^}]*position: fixed; inset: 0; z-index: 60/);
  assert.match(c, /\.om-offline \{[^}]*position: fixed/);
});

test('Atlas\'s header fits a phone in the preview, and the members\' Command Center is unchanged', () => {
  const hud = read('src/components/command-center/hud/CommandCenterHud.tsx');
  assert.match(hud, /min-\[1440px\]:hidden \$\{toFloor \? "max-sm:hidden" : ""\}/, 'the two-line name gives way to the mark on a phone');
  assert.match(hud, /\$\{toFloor \? "xl:inline-flex" : "sm:inline-flex"\}/, 'the dock under the thumb carries GENERATE below 1280px');
  assert.match(hud, /\{toFloor\s*\? <><span className="max-sm:hidden">\{FEED_STATUS_WORD\[feed\.status\]\}<\/span><span className="sm:hidden">\{FEED_STATUS_WORD\[feed\.status\]\.replace\(\/\^MARKET \/, ""\)\}<\/span><\/>\s*: FEED_STATUS_WORD\[feed\.status\]\}/, 'the same state, said shorter on a phone; the classic words as they were');
  assert.match(hud, /className=\{`grid place-items-center rounded-\[7px\] lg:hidden \$\{toFloor \? "h-10 w-10" : "h-8 w-8"\}`\}/);
});

test('the chart\'s closed caption never sits under a phone\'s chart buttons, and shortens where the whole line does not fit', () => {
  const chart = code('src/components/om/chart/OmChart.tsx');
  assert.match(chart, /const capR = Math\.min\(x1, plotW\) - 8;/);
  assert.match(chart, /const cap = compact \? null : room\(236\) \? "Market closed · feed quotes, not trading" : room\(84\) \? "Market closed" : null;/);
  assert.match(chart, /\{shut\(hb\.t\) && <span className="om-ch-tag">Market closed<\/span>\}/, 'on a phone the readout says it, for the candle being read');
});
