import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { H, H_CLASSIC, alpha } from '../src/components/command-center/hud/theme';
import { CC_NEXT_CSS } from '../src/components/command-center/hud/nextTheme';

/**
 * THE COMMAND CENTER IN THE PLATFORM'S MATERIALS (owner 11-20 brief §11).
 *
 * Every Command Center colour is a CSS variable that falls back to its classic value, so members — for whom no
 * variable is defined — see exactly the classic colours. Only the redesign preview defines them. The entrance
 * keeps Atlas's own colours, and nothing drawn on a canvas is given a variable it could not read.
 */
const ROOT = 'src/components/command-center';
const SKIP = new Set(['hud/EntryFx.tsx', 'hud/BrainOrb.tsx', 'VoicePresence.tsx', 'BrainCore.tsx', 'hud/EntrySequence.tsx', 'hud/LiquidityRadar.tsx', 'hud/theme.ts', 'hud/nextTheme.ts']);
const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []; });
const themed = files(ROOT).filter((p) => !SKIP.has(relative(ROOT, p).replace(/\\/g, '/')));
const mapped = [...CC_NEXT_CSS.matchAll(/--cc-([0-9a-f]{6}): #/g)].map((m) => m[1]);

test('each palette colour falls back to exactly its classic value', () => {
  for (const [k, v] of Object.entries(H_CLASSIC)) {
    const t = H[k as keyof typeof H];
    if (v.startsWith('#')) assert.equal(t, `var(--cc-${v.slice(1).toLowerCase()},${v})`, k);
    else assert.match(t, /^rgba\(var\(--cc-[0-9a-f]{6}-rgb,\d+,\d+,\d+\),[\d.]+\)$/, k);
  }
  assert.equal(alpha(H.green, '66'), 'rgba(var(--cc-29dfa6-rgb,41,223,166),0.4)', 'the same colour members saw as #29DFA666');
  assert.equal(alpha('#29DFA6', '66'), '#29DFA666', 'a plain colour is written as before');
});

test('no classic colour is left out of the theme, and none is written twice', () => {
  const left: string[] = [];
  for (const p of themed) {
    const s = readFileSync(p, 'utf8');
    for (const k of mapped) {
      const all = s.match(new RegExp(`#${k}(?![0-9a-f])`, 'gi'))?.length ?? 0;
      const wrapped = s.match(new RegExp(`var\\(--cc-${k},#${k}\\)`, 'gi'))?.length ?? 0;
      if (all !== wrapped) left.push(`${relative(ROOT, p)}: #${k} ${all - wrapped}×`);
    }
    assert.ok(!/var\(--cc-[0-9a-f]{6},var\(/.test(s), `${p}: a variable inside a variable`);
    assert.ok(!/\$\{[^{}]+\}[0-9a-fA-F]{2}(?=[\"'`; ,)])/.test(s), `${p}: a colour with an alpha suffix — use alpha()`);
  }
  assert.deepEqual(left, []);
});

test('the entrance keeps Atlas\'s own colours, and a canvas reads a real colour', () => {
  assert.match(readFileSync(join(ROOT, 'hud/EntrySequence.tsx'), 'utf8'), /import \{ H_CLASSIC as H \} from "\.\/theme";/);
  const radar = readFileSync(join(ROOT, 'hud/LiquidityRadar.tsx'), 'utf8');
  assert.match(radar, /const dot = cssColor\(c, H\.gold3\); g\.beginPath\(\); g\.fillStyle = dot;/);
  for (const f of ['hud/EntryFx.tsx', 'hud/BrainOrb.tsx', 'VoicePresence.tsx', 'BrainCore.tsx']) {
    assert.ok(!/var\(--cc-/.test(readFileSync(join(ROOT, f), 'utf8')), `${f} draws on a canvas: untouched`);
  }
});

test('only the redesign preview defines the variables; its back link returns to OM OS', () => {
  const layout = readFileSync('src/app/command-center/layout.tsx', 'utf8');
  assert.match(layout, /const next = wantsNextShell\(cookies\(\)\.get\(SHELL_COOKIE\)\?\.value, admin, headers\(\)\);/);
  assert.match(layout, /FULLSCREEN_CSS \+ \(next \? SHELL_CSS \+ CC_NEXT_CSS : ""\)/);
  assert.match(CC_NEXT_CSS, /^html\.om-cc-next \{/);
  for (const k of mapped) assert.match(CC_NEXT_CSS, new RegExp(`--cc-${k}-rgb: \\d+,\\d+,\\d+;`), `${k} has its rgb twin`);
  const hud = readFileSync(join(ROOT, 'hud/CommandCenterHud.tsx'), 'utf8');
  assert.match(hud, /aria-label=\{toFloor \? "Back to OM OS" : "Back to the portal"\}/);
});
