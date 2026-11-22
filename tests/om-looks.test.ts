import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DEFAULT_LOOK, LOOKS, LOOK_CLASS, LOOK_KEY, applyLook, lookOf, themeOf } from '../src/lib/floor/look';
import { SHELL_CSS, SHELL_SCRIPT } from '../src/lib/floor/nav';

/*
 * THE TWO LOOKS (owner 11-21: "a little brighter… clean Apple, Restoration Hardware, ultra luxury" — chose "B · Stone",
 * then "have a toggle that can go from graphite and stone").
 *
 * What is pinned here:
 *   • Stone is the default; Graphite is one tap away in the account menu, kept in this browser, and on the page before
 *     its first paint, so a page never shows the other look first;
 *   • every colour in the shell is a token, and both looks define every token — so nothing is left in the other look's
 *     colour when the member switches;
 *   • the charts draw with the same tokens (an SVG attribute cannot read a CSS variable, so they set them as style);
 *   • the classic portal's own dark mode follows Graphite, for anything of it drawn inside the shell; Atlas keeps its
 *     own dark frame in either look.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const css = () => read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (c: string, head: string) => { const i = c.indexOf(head); assert.ok(i >= 0, `${head} exists`); return c.slice(i, c.indexOf('\n}', i)); };
const tokens = (b: string) => new Set([...b.matchAll(/(--om-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

test('Graphite is the OS default; both existing stored preferences are honoured', () => {
  assert.equal(DEFAULT_LOOK, 'graphite');
  assert.equal(lookOf(null), 'graphite');
  assert.equal(lookOf('stone'), 'stone');
  assert.equal(lookOf('graphite'), 'graphite');
  assert.equal(lookOf('dark'), 'graphite');
  assert.deepEqual(LOOKS.map((l) => l.label), ['Stone', 'Graphite']);
  assert.equal(themeOf('stone'), '#f5f4f1');
  assert.equal(themeOf('graphite'), '#08090b');
  assert.equal(LOOK_KEY, 'om-look');
  const on = new Set<string>();
  const root = { classList: { toggle: (t: string, f?: boolean) => { if (f) on.add(t); else on.delete(t); return !!f; } } };
  applyLook(root, 'graphite');
  assert.deepEqual([...on].sort(), [LOOK_CLASS, 'om-dark'].sort(), 'Graphite brings the classic dark mode for anything classic inside the shell');
  applyLook(root, 'stone');
  assert.deepEqual([...on], [], 'Stone takes both away');
});

test('the look is on the page before its first paint, with the browser\'s bar colour to match', () => {
  const run = (saved: string | null) => {
    const cls = new Set<string>(); let bar: string | null = null;
    const document = {
      documentElement: { classList: { add: (c: string) => cls.add(c), toggle: (c: string, f: boolean) => { if (f) cls.add(c); else cls.delete(c); } } },
      querySelector: (q: string) => (q === 'meta[name="theme-color"]' ? { setAttribute: (_k: string, v: string) => { bar = v; } } : null),
    };
    const window: Record<string, unknown> = { navigator: {}, matchMedia: () => ({ matches: false }) };
    window.self = window; window.top = window;   // a browser tab, not the installed app
    runInNewContext(SHELL_SCRIPT, { document, window, localStorage: { getItem: (k: string) => (k === 'om-look' ? saved : null) } });
    return { cls: [...cls].sort().join(' '), bar };
  };
  assert.deepEqual(run(null), { cls: 'om-dark om-look-graphite om-shell', bar: '#08090b' });
  assert.deepEqual(run('stone'), { cls: 'om-shell', bar: '#f5f4f1' });
  assert.deepEqual(run('graphite'), { cls: 'om-dark om-look-graphite om-shell', bar: '#08090b' });
  // The page behind the shell is the look's own canvas.
  assert.match(SHELL_CSS, /html\.om-shell,html\.om-shell body\{background:#f5f4f1!important\}/);
  assert.match(SHELL_CSS, /html\.om-shell\.om-look-graphite,html\.om-shell\.om-look-graphite body\{background:#08090b!important\}/);
  assert.match(SHELL_CSS, /html\.om-shell\{color-scheme:light\}html\.om-shell\.om-look-graphite\{color-scheme:dark\}/);
});

test('both looks define every token, so nothing keeps the other look\'s colour after a switch', () => {
  const c = css();
  const stone = tokens(block(c, '.om-app {')), graphite = tokens(block(c, '.om-look-graphite .om-app {'));
  const layout = new Set(['--om-r-panel', '--om-r-input', '--om-gap', '--om-pad', '--om-font', '--om-display']);
  const colours = [...stone].filter((t) => !layout.has(t));
  assert.ok(colours.length >= 50, 'the look is a full set of tokens');
  for (const t of colours) assert.ok(graphite.has(t), `Graphite defines ${t}`);
  for (const t of graphite) assert.ok(stone.has(t), `Stone defines ${t}`);
  // Stone: One Mission's stone, white and ink; Graphite: the warm charcoal.
  const s = block(c, '.om-app {'), g = block(c, '.om-look-graphite .om-app {');
  assert.match(s, /--om-page: #f5f4f1;/); assert.match(s, /--om-surface: #ffffff;/); assert.match(s, /--om-text: #111111;/); assert.match(s, /--om-ink: #ffffff;/);
  assert.match(g, /--om-page: #1a1a1d;/); assert.match(g, /--om-surface: #232327;/); assert.match(g, /--om-text: #f6f5f2;/); assert.match(g, /--om-ink: #1a1a1d;/);
  assert.match(s, /color-scheme: light;/); assert.match(g, /color-scheme: dark;/);
});

test('no colour is written into the shell outside the two looks — only highlights, sheens and the app icon\'s own tile', () => {
  const c = css();
  const s0 = c.indexOf('.om-app {'), s1 = c.indexOf('\n}', s0), g0 = c.indexOf('.om-look-graphite .om-app {'), g1 = c.indexOf('\n}', g0);
  const rest = c.slice(0, s0) + c.slice(s1, g0) + c.slice(g1);
  const allowed = [
    /box-shadow:[^;]*inset 0 1px 0 rgba\(255, 255, 255, 0\.\d+\)/g,                        // a highlight on a surface's top edge
    /linear-gradient\(180deg, rgba\(255, 255, 255, 0\.\d+\), rgba\(255, 255, 255, 0\) \d+px\)/g, // a sheen fading down a surface
    /radial-gradient\(closest-side, rgba\(150, 132, 246, 0\.2\), rgba\(150, 132, 246, 0\)\)/g, // Atlas's mark
    /linear-gradient\(90deg, #000 calc\(100% - 44px\), transparent\)/g,                     // a fade mask (alpha only)
    /color: #f4f5f7;\s*background: radial-gradient\(60px 52px at 92% -12%, rgba\(128, 104, 232, 0\.55\), transparent 72%\), #08090e;/g, // the app icon tile
    /\.om-swatch\[data-look="(stone|graphite)"\] \{ background: #(f5f4f1|1a1a1d); \}/g,     // the look switch's own swatches
  ];
  let left = rest;
  for (const a of allowed) left = left.replace(a, '');
  const stray = [...left.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\((?!var\()[^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(stray, [], 'every other colour comes from a token');
});

test('the charts and the sparkline draw with the look\'s tokens', () => {
  const chart = read('src/components/om/chart/OmChart.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(fill|stroke|stopColor)=["'{][^"'}]*(#[0-9a-fA-F]{3,6}|rgba?\()/.test(chart), 'no fixed colour in an SVG attribute');
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(chart), 'no fixed colour at all');
  assert.match(chart, /const UP = "var\(--om-pos\)", DOWN = "var\(--om-neg\)";/);
  assert.match(chart, /style=\{\{ stroke: col \}\}/);
  assert.match(chart, /style=\{\{ fill: p\.priceLive \? UP : "var\(--om-ch-tag\)" \}\}/);
  const floor = read('src/components/om/floor/Floor.tsx');
  assert.match(floor, /const col = up \? "var\(--om-pos\)" : "var\(--om-neg\)";/);
});

test('the account menu switches the look in place, and remembers it in this browser', () => {
  const shell = read('src/components/om/AppShell.tsx');
  assert.match(shell, /<div className="om-menu-look" role="group" aria-label="Look">/);
  assert.match(shell, /role="menuitemradio" aria-checked=\{look === l\.key\} onClick=\{\(\) => onLook\(l\.key\)\}/);
  assert.match(shell, /try \{ localStorage\.setItem\(LOOK_KEY, l\); \} catch/);
  assert.match(shell, /document\.querySelector\('meta\[name="theme-color"\]'\)\?\.setAttribute\("content", themeOf\(l\)\);/);
  // Leaving the shell gives the classic portal back its own theme choice.
  assert.match(shell, /d\.classList\.remove\("om-shell", "om-standalone", LOOK_CLASS\);/);
  assert.match(shell, /dark = localStorage\.getItem\("om-theme"\) === "dark";/);
  assert.ok(!/classList\.add\("om-shell", "om-dark"\)/.test(shell), 'the shell no longer forces the dark mode');
});

test('One Mission\'s lettering: the wordmark and page titles in Archivo, the name over every title', () => {
  const c = css();
  assert.match(c, /--om-display: "Archivo", var\(--om-font\);/);
  assert.match(c, /\.om-brand span \{ font-family: var\(--om-display\);[^}]*letter-spacing: 0\.26em; text-transform: uppercase;/);
  assert.match(c, /\.om-title \{[^}]*font-family: var\(--om-display\);/);
  assert.match(c, /\.om-title::before \{[^}]*content: "One Mission"; content: "One Mission" \/ "";[^}]*color: var\(--om-bone\);/, 'shown, not read out a second time');
  // The site loads Archivo for every page; the shell does not load a second copy.
  assert.match(read('src/app/layout.tsx'), /family=Archivo/);
});

test('Atlas keeps its own dark frame in either look', () => {
  const cc = read('src/app/command-center/layout.tsx');
  assert.match(cc, /themeColor: ATLAS_THEME/);
  assert.ok(!/LOOK_CLASS|om-look-graphite/.test(cc));
});
