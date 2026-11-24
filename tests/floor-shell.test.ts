import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NAV, APP_TABS, TAB_ORDER, activeKey, activeTabKey, wantsNextShell, SHELL_COOKIE, SHELL_CSS } from '../src/lib/floor/nav';
import { FLOOR_ASK_KEY, FLOOR_ASK_MAX_AGE_MS, FLOOR_ASK_MAX_LEN, leaveFloorQuestion, takeFloorQuestion } from '../src/components/command-center/hud/floorAsk';

/*
 * THE REDESIGNED SHELL AND THE FLOOR (owner 11-20). What is pinned here is what must not drift:
 *   • the six destinations, in order, and nothing else beside them;
 *   • the redesign is a PREVIEW for an admin who switched it on — a member's cookie alone does nothing;
 *   • The Floor's own route reads and never charges or writes; one priced tap exists and it is the
 *     existing "See the play";
 *   • Atlas opens over The Floor, carrying only the visible read; the gold desk keeps its own entrance;
 *   • the sample route exists only on a developer's machine, and no member page uses its figures.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
});

/* ── destinations ── */
test('six destinations, in the order the owner gave, and no community among them', () => {
  assert.deepEqual(NAV.map((n) => n.label), ['The Floor', 'OM AI Plays', 'GENX', 'STRATA', 'Market Pulse', 'FLOW', 'Atlas Command Center']);
  assert.deepEqual(NAV.map((n) => n.href), ['/portal/trading', '/portal/signals', '/portal/genx', '/portal/strata', '/portal/trading?view=pulse', '/portal/trading?view=flow', '/command-center']);
  const all = JSON.stringify({ NAV }).toLowerCase();
  for (const gone of ['leaderboard', 'leadership', 'inner circle', 'community', 'training', 'academy', 'schedule', 'collection', 'experiences', 'updates', 'team', 'prospects', 'comp-plan', 'rapid', 'matty', 'genfx', 'cashtrap', 'xaughost', 'auric', '/portal/om-ai']) {
    assert.ok(!all.includes(gone), `"${gone}" is not a destination of the trading platform`);
  }
});

test('the phone has four clear destinations and groups every trading product under Tools', () => {
  assert.deepEqual(TAB_ORDER.map((k) => APP_TABS.find((n) => n.key === k)!.label), ['Floor', 'Gold Center', 'Tools', 'FLOW']);
  assert.equal(new Set(TAB_ORDER).size, 4, 'destinations are not duplicated');
  assert.equal(activeTabKey('/portal/tools', null), 'tools');
  for (const n of NAV) {
    const url = new URL(n.href, 'https://weare1mission.com');
    assert.equal(activeTabKey(url.pathname, url.searchParams.get('view')), ['plays', 'genx', 'pulse', 'strata'].includes(n.key) ? 'tools' : n.key, `${n.label} keeps the correct tab active`);
  }
  assert.equal(activeTabKey('/portal/account', null), null);
});

test('the gold desk keeps its destination while the Atlas app tab opens an in-place conversation', () => {
  assert.equal(NAV.find((n) => n.key === 'atlas')!.hard, true);
  assert.equal(NAV.filter((n) => n.hard).length, 1);
  const shell = read('src/components/om/AppShell.tsx');
  assert.match(shell, /n\.hard\s*\?\s*<a key=\{n\.key\} href=\{n\.href\}/);
  assert.equal(APP_TABS.find((n) => n.key === 'atlas')!.href, '/command-center');
  assert.equal(APP_TABS.find((n) => n.key === 'atlas')!.hard, true);
  assert.doesNotMatch(shell, /if \(n\.key === "atlas"\) return <button/);
});

test('the lit destination follows the page, including a tool opened inside The Floor', () => {
  assert.equal(activeKey('/portal/trading', null), 'floor');
  assert.equal(activeKey('/portal/trading/', 'home'), 'floor');
  assert.equal(activeKey('/portal/trading', 'flow'), 'flow');
  assert.equal(activeKey('/portal/trading', 'pulse'), 'pulse');
  assert.equal(activeKey('/portal/trading', 'genx'), 'genx');
  assert.equal(activeKey('/portal/trading', 'signals'), 'plays');
  assert.equal(activeKey('/portal/signals', null), 'plays');
  assert.equal(activeKey('/portal/genx', null), 'genx');
  assert.equal(activeKey('/command-center', null), 'atlas');
  assert.equal(activeKey('/portal', null), 'floor');
  assert.equal(activeKey('/portal/account', null), null, 'a utility page lights nothing');
  assert.equal(activeKey('/portal/credits', 'flow'), null);
});

/* ── who sees it (owner 11-20: a preview, "just me first"; 11-21: "push live to everyone") ── */
test('the new design is for every member; only an admin can choose the classic portal, for support', () => {
  assert.equal(wantsNextShell(undefined, false), true, 'a member gets the new design with no cookie at all');
  assert.equal(wantsNextShell(undefined, true), true);
  assert.equal(wantsNextShell('classic', false), true, 'a member who sets the cookie by hand still gets the new design');
  assert.equal(wantsNextShell('classic', true), false, 'an admin who chose the classic portal gets it');
  assert.equal(wantsNextShell('next', true), true);
  assert.equal(wantsNextShell('', true), true);
  assert.equal(SHELL_COOKIE, 'om_shell');
});

test('the portal decides on the server, from the member\'s role — and the classic portal is still there underneath', () => {
  const layout = read('src/app/portal/layout.tsx');
  assert.match(layout, /wantsNextShell\(cookies\(\)\.get\(SHELL_COOKIE\)\?\.value, isAdmin, headers\(\)\)/);
  assert.match(layout, /const isAdmin = profile\?\.role === "admin";/);
  assert.match(layout, /<PortalNav isAdmin=\{isAdmin\} isOwner=\{isOwner\} \/>/, 'the classic navigation is untouched');
  assert.ok(layout.indexOf('wantsNextShell(') < layout.indexOf('<PortalNav'), 'the preview is a branch before the classic portal, not a change to it');
  // A member who is pending or suspended never reaches the new shell.
  assert.match(layout, /profile && !needsApproval && wantsNextShell/);
  // The risk disclosure still applies inside it.
  const branch = layout.slice(layout.indexOf('wantsNextShell('), layout.indexOf('return (\n    <div className="bg-cream">'));
  assert.match(branch, /<RiskConsentGate \/>/);
  const page = read('src/app/portal/trading/page.tsx');
  assert.match(page, /wantsNextShell\(cookies\(\)\.get\(SHELL_COOKIE\)\?\.value, profile\?\.role === "admin", headers\(\)\)/);
  assert.match(page, /<FloorWorkspace isCaller=\{isCaller\} followerCount=\{followerCount\} \/>/, 'everyone else gets the page as it was');
});

test('the switch itself is admin-only, sets one cookie, and answers anyone else as if it were not there', () => {
  const src = read('src/app/api/floor/preview/route.ts');
  assert.match(src, /if \(!profile \|\| profile\.role !== "admin"\) return new NextResponse\("Not found", \{ status: 404 \}\)/);
  assert.match(src, /httpOnly: true/);
  assert.ok(!/createAdminClient|\.update\(|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(/.test(src), 'it changes nothing but the browser\'s own cookie');
});

test('while the shell is up the public header and footer step aside, and the language switch moves into the menu', () => {
  assert.match(SHELL_CSS, /html\.om-shell body>header,html\.om-shell body>footer\{display:none!important\}/);
  assert.match(SHELL_CSS, /body>div\[data-no-i18n\]\.fixed\{display:none!important\}/);
  const shell = read('src/components/om/AppShell.tsx');
  assert.match(shell, /new Event\("om-lang-toggle"\)/);
  assert.match(read('src/components/I18nProvider.tsx'), /addEventListener\("om-lang-toggle", h\)/);
  // The shell's own utilities: account, credits, support, language, sign out. Nothing from the community.
  for (const href of ['/portal/account', '/portal/credits', '/portal/support', '/auth/signout']) assert.ok(shell.includes(href), `${href} is in the account menu`);
  assert.ok(!/leaderboard|leadership|\/portal\/updates|\/portal\/team|\/portal\/training/.test(shell));
});

/* ── The Floor reads; it does not charge or write ── */
test('The Floor\'s route is read-only: it charges nothing, places nothing and changes no setting', () => {
  const src = read('src/app/api/floor/overview/route.ts');
  assert.deepEqual([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ['GET']);
  assert.ok(!/chargeCredit|gateCredits|spend_credits|openPass\(|add_purchased_credits/.test(src), 'no credit is touched');
  assert.ok(!/\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(src), 'no row is written');
  assert.ok(!/is_selected:\s|autotrade_enabled|genx_follower/.test(src.replace(/select\("[^"]*"\)/g, '')), 'no account setting is set');
  assert.ok(!/execute|placeOn|sizeFromRisk/.test(src));
  assert.match(src, /if \(!user\) return json\(\{ error: "unauthorized" \}, 401\)/);
  // Every member-specific read is by the signed-in member's id.
  assert.equal((src.match(/\.eq\("user_id", user\.id\)/g) ?? []).length, 3);
  // Which account to look at is validated against the member's own accounts, and arrives in a header.
  assert.match(src, /pickAccount\(accounts, req\.headers\.get\("x-floor-account"\), req\.headers\.get\("x-floor-env"\)\)/);
  assert.ok(!/searchParams\.get\("account"\)/.test(src), 'an account id is never part of an address');
});

test('the desk record is read whole, and a retired row is dropped before the fold', () => {
  const src = read('src/app/api/floor/overview/route.ts');
  assert.match(src, /allRows<RealRow>\(/);
  assert.match(src, /if \(!complete\) return null;/);
  assert.match(src, /buildRealResults\(rows\.filter\(\(r\) => r\.outcome !== "excluded"\)\)/);
  assert.ok(!/\.limit\(20000\)/.test(src), 'one request returns only the newest thousand rows');
  assert.match(src, /\.order\("created_at", \{ ascending: true \}\)\.order\("id", \{ ascending: true \}\)/, 'pages need one fixed order');
});

test('ATLAS\'s read reaches The Floor only while the member\'s Command Center window is open', () => {
  const src = read('src/app/api/floor/overview/route.ts');
  const atlas = src.slice(src.indexOf('const pass = await passState('), src.indexOf('const body: FloorOverview'));
  assert.match(atlas, /if \(pass\.active\) \{[\s\S]*cc_atlas_reads/);
  assert.match(atlas, /cost: pass\.cost, minutes: pass\.minutes/, 'the price shown is the Command Center\'s own, not a number typed here');
});

test('the screen has one priced tap — the existing "See the play" — and asks for nothing else with a POST', () => {
  const src = read('src/components/om/floor/Floor.tsx');
  assert.match(src, /useSeeThePlay\(onOpened\)/);
  assert.ok(!/method:\s*"POST"/.test(src), 'everything The Floor asks for itself is a read');
  const asked = [...src.matchAll(/fetch\(`?"?(\/api\/[a-z\-/]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(asked, ['/api/floor/overview', '/api/floor/setup', '/api/floor/ticker']);
  // The price on the button is the gate's own.
  assert.match(src, /`See the play · \$\{gate\.cost\} credits`/);
  assert.ok(!/See the play · \d/.test(src));
  // It never opens the microphone and never opens a connect-account prompt on its own.
  assert.ok(!/getUserMedia|SpeechRecognition|voiceBus/.test(src));
  assert.ok(!/FlowIntro|showModal|<dialog/.test(src));
});

test('changing account clears the old account\'s money first, and a late answer for the old account is dropped', () => {
  const src = read('src/components/om/floor/Floor.tsx');
  const choose = src.slice(src.indexOf('const choose = (a: FloorAccount) => {'), src.indexOf('// ── gold and GENX\'s state ──'));
  assert.ok(choose.indexOf('figures: null, flow: null') > 0 && choose.indexOf('figures: null, flow: null') < choose.indexOf('setPick('), 'cleared before the new account is asked for');
  assert.match(src, /if \(mine !== ovSeq\.current\) return;/);
  assert.match(src, /headers\["x-floor-account"\] = pick\.id/);
  // Choosing what to look at is not sent anywhere that could change a setting.
  assert.ok(!/\/api\/flow\/(broker|prefs|autorun|execute)/.test(src));
});

/* ── a question for Atlas ── */
const store = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
};
const T0 = Date.parse('2026-11-20T15:00:00Z');

test('a question left for Atlas is asked once', () => {
  const s = store();
  leaveFloorQuestion(s, '  Explain the current gold setup.  ', T0);
  assert.equal(takeFloorQuestion(s, T0 + 4000), 'Explain the current gold setup.');
  assert.equal(takeFloorQuestion(s, T0 + 5000), null, 'a reload or a renewed window cannot ask it again');
  assert.equal(s.m.has(FLOOR_ASK_KEY), false);
});

test('an old question, or something that is not a question, is dropped — and still removed', () => {
  const s = store();
  leaveFloorQuestion(s, 'Analyze gold right now.', T0);
  assert.equal(takeFloorQuestion(s, T0 + FLOOR_ASK_MAX_AGE_MS + 1), null, 'the market has moved on');
  assert.equal(s.m.size, 0);
  for (const junk of ['not json', '{"q":42,"at":1}', '{"q":"hi"}', '{"q":"   ","at":' + T0 + '}', '[]', 'null']) {
    s.setItem(FLOOR_ASK_KEY, junk);
    assert.equal(takeFloorQuestion(s, T0), null);
    assert.equal(s.m.size, 0);
  }
  leaveFloorQuestion(s, 'x'.repeat(5000), T0);
  assert.equal(takeFloorQuestion(s, T0)!.length, FLOOR_ASK_MAX_LEN);
});

test('opening the Command Center with no question clears one left earlier', () => {
  const s = store();
  leaveFloorQuestion(s, 'Analyze gold right now.', T0);
  leaveFloorQuestion(s, null, T0 + 1000);
  assert.equal(takeFloorQuestion(s, T0 + 2000), null);
  leaveFloorQuestion(s, '   ', T0);
  assert.equal(s.m.size, 0);
});

test('legacy desk handoffs still wait for its entrance; new Floor conversations open in the app', () => {
  const hud = read('src/components/command-center/hud/CommandCenterHud.tsx');
  assert.match(hud, /takeFloorQuestion\(window\.sessionStorage, Date\.now\(\)\)/);
  assert.match(hud, /window\.addEventListener\(ATLAS_ENTERED_EVENT, onEntered\)/);
  assert.match(hud, /if \(q\) ask\(q\);/, 'through the same ask the desk\'s own chips use');
  const gate = read('src/components/command-center/hud/PassGate.tsx');
  assert.match(gate, /if \(j\?\.eligible\) setIntro\(true\); else entered\(\);/);
  assert.match(gate, /onDone=\{\(\) => \{ setIntro\(false\); entered\(\); \}\}/, 'only once the entrance has finished');
  // The gate still charges only on its own button.
  assert.equal((gate.match(/method: "POST"/g) ?? []).length, 2);
  assert.match(gate, /<button onClick=\{buy\} disabled=\{busy\}/);
  const floor = read('src/components/om/floor/Floor.tsx');
  assert.match(floor, /openAtlas\(\{ question, voice, context \}\)/);
  assert.match(floor, /openAtlas\(\{ voice: true, context \}\)/);
  assert.ok(!/leaveFloorQuestion|window\.location\.assign/.test(floor), 'talking stays on The Floor');
  assert.match(floor, /href="\/command-center">Gold Command Center/, 'the gold desk remains an explicit destination');
});

/* ── the sample route ── */
test('the sample route exists only where a developer asked for it, and says what it is', () => {
  const page = read('src/app/floor-preview/page.tsx');
  assert.match(page, /if \(process\.env\.OM_FLOOR_SAMPLE !== "1"\) notFound\(\);/);
  assert.ok(page.indexOf('notFound()') < page.indexOf('floorSample('), 'nothing is built before the check');
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(read('src/components/om/floor/Floor.tsx'), /Sample data/);
  // What things cost is read from the real settings even there.
  assert.match(page, /play: CREDIT_COST\.genx, playMinutes: SETUP_MINUTES, atlas: CC_PASS_COST, atlasMinutes: CC_PASS_MS \/ 60_000/);
});

test('no member-facing page or route uses the sample figures', () => {
  const users = walk('src').filter((f) => /floor\/sample["']/.test(read(f)) || /from ["']\.\/sample["']/.test(read(f)));
  assert.deepEqual(users.map((f) => f.replace(/\\/g, '/')), ['src/app/floor-preview/page.tsx']);
  const floor = read('src/components/om/floor/Floor.tsx');
  assert.ok(!/3,?550|10,?000\.00|10,?125|\+120|\$240/.test(floor), 'none of the concept image\'s figures are written into the screen');
  const route = read('src/app/api/floor/overview/route.ts');
  assert.ok(!/3550|10000|10125/.test(route));
});

/* ── the bar with everything in it ── */
// A signed-in member's bar holds the brand, six destinations, credits, notifications and the profile.
// The first build of the shell was only ever looked at without the last three, and at a phone's width
// the profile slid off the edge. The widths themselves are checked in a browser; this keeps the tiers.
test('the bar steps down in tiers, so a signed-in bar always holds what is in it', () => {
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = (px: number) => { const i = css.indexOf(`@media (max-width: ${px}px)`); assert.ok(i >= 0, `there is a ${px}px tier`); return i; };
  const tiers = [1240, 980, 520, 380, 340].map(at);
  assert.deepEqual([...tiers].sort((a, b) => a - b), tiers, 'wider tiers come first, so the narrower one wins');
  const compact = css.slice(tiers[0], tiers[1]), thumb = css.slice(tiers[1], tiers[2]), mark = css.slice(tiers[2], tiers[3]), word = css.slice(tiers[4], tiers[4] + 400);
  assert.match(compact, /\.om-brand span \{ display: none; \}/, 'the wordmark steps aside before the destinations crowd');
  assert.match(thumb, /\.om-links \{ display: none; \}/);
  assert.match(thumb, /\.om-tabbar \{\s*position: fixed/, 'the destinations move to the tab bar at the same width they leave the bar');
  assert.match(thumb, /\.om-brand span \{ display: inline; \}/);
  assert.match(mark, /\.om-brand span \{ display: none; \}/, 'a phone shows the mark alone');
  assert.match(word, /\.om-credits-word \{[^}]*clip-path/, 'on the narrowest screens the credits pill keeps its number');
  assert.ok(!/\.om-credits-word \{[^}]*display: none/.test(css), 'the word is still read out, never removed');
  assert.match(read('src/components/om/AppShell.tsx'), /<span className="om-credits-word">credits<\/span>/);
  // Nothing in the bar is allowed to shrink under its neighbour.
  assert.match(css, /\.om-brand \{[^}]*flex: 0 0 auto/);
  assert.match(css, /\.om-nav-right \{[^}]*flex: 0 0 auto/);
});

// Seen on the live preview, 11-20: a strip of the notifications panel showed beside the bar, and the panel
// opened 64px tall inside it. A backdrop filter makes its element the frame for fixed-position children.
test('the notifications panel opens on the screen, not inside the bar', () => {
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => [...css.matchAll(new RegExp(`(?:^|[},])\\s*${sel.replace(/[.:]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(' ');
  const framing = /backdrop-filter:\s*(?!none)|(?:^|[\s;])(?:transform|filter|perspective|contain|will-change):\s*(?!none)/;
  // Nothing the bell sits inside may frame a fixed-position child: the app, the sticky wrap, the bar, its right side.
  for (const sel of ['.om-app', '.om-nav-wrap', '.om-nav', '.om-nav-right']) assert.ok(!framing.test(rule(sel)), `${sel} does not frame fixed-position children`);
  assert.match(rule('.om-nav::before'), /backdrop-filter: blur/, 'the frosted surface is its own layer behind the contents');
  assert.match(rule('.om-nav::before'), /z-index: -1/);
  assert.match(rule('.om-nav'), /isolation: isolate/, 'which keeps that layer behind the bar\'s contents and above the page');
  // The panel opens from inside the sticky wrap, so the wrap sits above the phone's tab bar and Tools sheet.
  const z = (sel: string) => Number(rule(sel).match(/z-index: (\d+)/)?.[1] ?? NaN);
  assert.ok(z('.om-nav-wrap') > z('.om-sheet') && z('.om-sheet') > z('.om-tabbar'), 'wrap above sheet above tab bar');
  // The real button and its panel are still the site's own, inside the bar.
  assert.match(read('src/components/om/AppShell.tsx'), /<span className="om-bell"><NotificationsBell trading \/><\/span>/);
  assert.match(read('src/components/portal/NotificationsBell.tsx'), /className=\{`fixed inset-0 /, 'the classic panel is fixed to the screen');
  assert.match(rule('.om-notes'), /position: fixed; inset: 0/, 'and so is the trading shell\'s');
});

test('the chart card says a closed market is closed, and shows the engine\'s words as it wrote them', () => {
  const floor = read('src/components/om/floor/Floor.tsx');
  assert.match(floor, /const shut = now > 0 && !isOpen\("metal", now\)/);
  assert.match(floor, /shut \? "Twelve Data · gold is closed · this is the last price before the close"/, 'a last price is not dated as if it had just been made');
  assert.match(floor, /<span className="om-faint">Trigger<\/span><span>\{own\(view\.waitingFor\)\}<\/span>/);
  assert.match(floor, /<span className="om-faint">Invalidation<\/span><span>\{own\(view\.changesIf\)\}<\/span>/);
  assert.match(floor, /shut && view\.stage === "live" \? " Gold is closed now, so it cannot be entered\." : ""/, 'a confirmed entry is not offered as enterable while the market is shut');
  assert.ok(!/>Waiting for <\/span>|>Changes if <\/span>/.test(floor), 'no sentence is started for the engine: its own words do not always follow on');
});

/* ── the trading platform's notifications (owner 11-20: a trading-only product) ── */
test('the trading shell lists and counts trading notifications only; the closed panel is out of reach', () => {
  const bell = read('src/components/portal/NotificationsBell.tsx');
  assert.match(bell, /const TRADING_FILTERS: [^=]*= \[\{ id: "all", label: "All" \}, \{ id: "trades", label: "Trades" \}\];/, 'no Inner Circle and no Calls among its categories');
  assert.match(bell, /const mine = useCallback\(\(n: Notif\) => !trading \|\| n\.type === "trade" \|\| n\.type === "system"/, 'likes, comments and calls are the community\'s');
  assert.match(bell, /const shown = items\.filter\(mine\)/);
  assert.match(bell, /setUnread\(list\.filter\(\(n\) => mine\(n\) && !n\.read\)\.length\)/, 'the number on the bell is the number of unread things in the panel');
  const trading = bell.slice(bell.indexOf('<div className="om-notes"'), bell.indexOf(') : ('));
  assert.ok(trading.length > 400 && !/Inner Circle|Calls you|Likes and comments/.test(trading), 'nothing of the community in the trading panel');
  assert.match(trading, /TRADING_FILTERS\.map/);
  // Keyboard: unreachable while closed, focus in on open, Escape closes, focus back to the bell — in both shells.
  assert.match(bell, /const hidden = \(open \? \{\} : \{ inert: "" \}\)/);
  assert.equal((bell.match(/\{\.\.\.hidden\}/g) ?? []).length, 2, 'both panels are inert while closed');
  assert.equal((bell.match(/aria-modal="true"/g) ?? []).length, 2);
  assert.match(bell, /if \(e\.key === "Escape"\) \{ setOpen\(false\); return; \}/);
  assert.match(bell, /shut\.current\?\.focus\(\);/);
  assert.match(bell, /from\?\.focus\(\);/);
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.om-notes-panel \{[^}]*transform: translateX\(100%\); visibility: hidden/, 'closed: off the edge and not rendered to anyone');
  assert.match(css, /\.om-notes-panel \{[^}]*max-width: 92vw/, 'open: it fits a phone');
  // The classic portal's panel keeps its own categories.
  assert.match(bell, /\{ id: "inner", label: "Inner Circle" \}/);
});

/* ── The Floor's composition (owner's brief, 11-20 evening) ── */
test('The Floor: active controls and winning runs on the first screen, one next step per context', () => {
  const floor = read('src/components/om/floor/Floor.tsx');
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // The chart row is held to about 400px on a desktop so the results bands are on screen at 1440 × 900 and 1728 × 881.
  assert.match(css, /\.om-stage \{[^}]*grid-template-columns: minmax\(0, 2\.3fr\) minmax\(330px, 1fr\); grid-auto-rows: clamp\(404px, 48vh, 480px\)/);
  // Atlas's mark on the Floor is small (36–48px); the full presence stays in the Command Center.
  const mark = css.match(/\.om-atlas-mark \{ width: (\d+)px; height: (\d+)px/);
  assert.ok(mark && Number(mark[1]) >= 36 && Number(mark[1]) <= 48 && mark[1] === mark[2]);
  // One next step in the chart card: the play when it is withheld, otherwise the way into GENX.
  const card = floor.slice(floor.indexOf('function ChartCard('), floor.indexOf('function AtlasPanel('));
  assert.equal((card.match(/className=\{?"?om-btn\b|className=\{view\.stage === "live" \? "om-btn" : "om-btn-quiet"\}/g) ?? []).length, 2, 'two renderings of the one action, never both at once');
  assert.match(card, /\{locked \? \(/);
  assert.ok(!/Generate a play/.test(card), 'generation is not repeated in the chart card');
  // Atlas offers three suggestions at a time, a visible input and one way into the Command Center.
  const atlas = floor.slice(floor.indexOf('function AtlasPanel('), floor.indexOf('function Spark('));
  assert.equal((atlas.match(/className="om-go"|<Go href/g) ?? []).length, 3);
  assert.equal((atlas.match(/href="\/command-center"/g) ?? []).length, 1);
  assert.match(atlas, /placeholder="Ask about gold or find a signal…"/);
  // The detailed GENX page still imports its existing record card and method.
  assert.equal((floor.match(/<Method id="om-method-(genx|flow)">/g) ?? []).length, 1);
  assert.match(floor, /Each GENX trade is counted once, at the average result of the accounts that took it\. These are the engine's results on gold, not a return for any one account\./);
  assert.ok(!/className="om-foot"/.test(floor), 'no paragraph of method under the figures');
  // The main screen uses the current winning run, not a feed of past positive/negative outcomes.
  assert.ok(!/om-tools|className="om-tool"/.test(floor) && !/\.om-tools?\b/.test(css));
  const main = floor.slice(floor.indexOf('export function Floor('));
  assert.equal((main.match(/<ActiveTrades\b/g) ?? []).length, 1, 'one set of controls across phone and desktop');
  assert.match(main, /!isSample && <ActiveTrades \/>/, 'sample pages never load a member\'s live controls');
  assert.equal((main.match(/<WinStreaks\b/g) ?? []).length, 1);
  assert.match(main, /<WinStreaks account=\{ov\?\.account \?\? null\} accountsKnown=\{!!ov\?\.accountsKnown\} switching=\{switching\}/);
  assert.match(main, /hideAccountPips=\{hide\} sample=\{isSample\}/);
  assert.ok(!/<Activity\b|<FlowCard\b|<GenxCard\b|om-mobile-results/.test(main));
  // Timeframes are text tabs, not a switch.
  assert.match(css, /\.om-tf button \{[^}]*border: 0;[^}]*background: none/);
});

test('Market Pulse never cuts a quote through the middle', () => {
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const list = css.match(/\.om-pulse-list \{([^}]*)\}/)?.[1] ?? '';
  assert.match(list, /flex-wrap: wrap/);
  assert.match(list, /height: 26px/);
  assert.match(list, /overflow: hidden/);
  assert.ok(!/mask-image/.test(list), 'the fade belongs to the phone row, which scrolls');
  assert.match(css, /\.om-pulse-item \{[^}]*line-height: 26px/);
});

/* ── design rules that are easy to break by accident ── */
test('the surface rules: scoped styles, opaque fallbacks, no decorative motion, no gold', () => {
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // Every rule is scoped to the app shell (or is an at-rule wrapping scoped rules).
  const heads = css.split('}').map((b) => b.split('{')[0].trim()).filter(Boolean);
  for (const h of heads) {
    if (h.startsWith('@')) continue;
    for (const sel of h.split(',').map((s) => s.trim()).filter(Boolean)) assert.ok(/^\.om-/.test(sel), `"${sel}" is scoped to the new shell`);
  }
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok(!/@keyframes|animation:(?!\s*none)/.test(css), 'nothing animates on its own');
  // "gold" may only appear where an earlier view's gold is being taken OUT (.om-legacy matches its class names).
  assert.ok(!/#ffc24b|#ffd47a|#d5a93d|gold/i.test(css.replace(/\.om-legacy \[class\*="[^"]*"\]/g, '')), 'no gold decoration');
  // The owner's tokens (11-21: "B · Stone", with Graphite a toggle away): One Mission's stone, white and ink, and the warm charcoal.
  for (const token of ['#f5f4f1', '#ffffff', '#111111', '#5f5c56', '#1a1a1d', '#232327', '#f6f5f2', '#bab6ae', '#6f6a5d', '#cfc7b3']) assert.ok(css.includes(token), `${token} is a token`);
  assert.match(css, /font-variant-numeric: tabular-nums/);
});
