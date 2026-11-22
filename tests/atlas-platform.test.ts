import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { platformTopic, platformReply, asksMarket, marketIn, styleIn, type PlatformCosts } from "../command-center/brain/platform";
import { CREDIT_COST } from "../src/lib/creditConfig";
import { NAV } from "../src/lib/floor/nav";

/**
 * ATLAS KNOWS THE PLATFORM (owner 11-21 brief §8). Asked "what is OM AI Plays?", Atlas said it had no
 * documentation and wrapped the reply in a market-closed label. Product questions are now answered from the
 * product, with or without a market read; generating is the member's own tap with its price on it.
 */
const read = (p: string) => readFileSync(p, "utf8");
const C: PlatformCosts = { play: CREDIT_COST.signal, deepdive: CREDIT_COST.deepdive, scan: CREDIT_COST.scan, genx: CREDIT_COST.genx, cc: 5, ccMinutes: 30, setupMinutes: 30 };

test("the acceptance questions route to the product, not the market", () => {
  const cases: [string, string | null][] = [
    ["Explain the difference between OM AI Plays, GENX, Market Pulse, and FLOW.", "overview"],
    ["Walk me through generating my first AI Play.", "first_play"],
    ["Generate an intraday OM AI Play for EUR/USD.", "generate_play"],
    ["Generate an Atlas gold setup.", "generate_atlas"],
    ["What is GENX waiting for, and when was that read made?", "genx_now"],
    ["Show the latest Market Pulse candidates. How old is that scan?", "pulse_last"],
    ["What is the difference between my balance, equity, and FLOW results?", "results"],
    ["Why did this signal not execute on my selected account?", "not_executed"],
    ["Open this play in FLOW so I can review it.", "open_in_flow"],
    ["What is OM AI Plays?", "plays"],
    ["How do I connect FLOW?", "connect"],
    ["What is GENX?", "genx"],
    ["Explain this candle and show the relevant level.", null],
    ["Where is gold heading this session?", null],
  ];
  for (const [q, want] of cases) assert.equal(platformTopic(q), want, q);
});

test("help is answered from the product — every tool, its inputs and its price from the settings", () => {
  const o = platformReply("overview", "", C);
  for (const w of ["OM AI Plays", "GENX", "Market Pulse", "FLOW", "Atlas"]) assert.ok(o.say.includes(w), w);
  assert.ok(o.say.includes(`${CREDIT_COST.signal} credits a play`) && o.say.includes(`Analyze gold is ${CREDIT_COST.genx} credits`) && o.say.includes(`A scan is ${CREDIT_COST.scan} credits`));
  assert.match(o.say, /GENX's results are the engine's own trades on gold\. My FLOW results are what actually happened on your account/);
  for (const t of ["overview", "plays", "first_play", "genx", "pulse", "flow", "connect", "atlas", "floor", "credits", "results", "not_executed", "open_in_flow", "generate_atlas"] as const) {
    const r = platformReply(t, "", C);
    assert.ok(!/market (is )?closed|can't see the market|not enough (current )?data/i.test(r.say), `${t} is not a market reply`);
    assert.ok(!/I have (generated|placed|changed|set)|I('ve| have) switched/i.test(r.say), `${t} claims nothing done`);
  }
  // What it cannot see, it says — no reason is guessed from a switch.
  assert.match(platformReply("not_executed", "", C).say, /can't see the delivery record for a signal on your account from here yet, so I won't guess/);
});

test("a request to generate asks only for what is missing, and its button says the price", () => {
  assert.equal(marketIn("a play on cable please"), "GBP/USD");
  assert.equal(marketIn("give me a nasdaq play"), "NAS100");
  assert.equal(styleIn("an intraday play"), "intraday");
  assert.equal(styleIn("a play on EUR/USD"), null, "a style is asked for, never assumed");
  const asks = platformReply("generate_play", "Generate an OM AI Play for EUR/USD", C);
  assert.match(asks.say, /Which style\?/);
  assert.deepEqual(asks.links.map((l) => [l.label, l.generate?.style]), [["Scalp · 3 credits", "scalp"], ["Intraday · 3 credits", "intraday"], ["Swing · 3 credits", "swing"]].map(([a, b]) => [a.replace("3", String(CREDIT_COST.signal)), b]));
  const ready = platformReply("generate_play", "Generate an intraday OM AI Play for EUR/USD", C);
  assert.match(ready.say, /^Ready: an intraday OM AI Play on EUR\/USD/);
  assert.equal(ready.links[0].label, `Generate · ${CREDIT_COST.signal} credits`);
  assert.deepEqual(ready.links[0].generate, { td: "EUR/USD", style: "intraday" });
  assert.equal(ready.links[1].generate, undefined, "opening without generating is free");
  assert.match(platformReply("generate_play", "generate a play", C).say, /Which market/);
});

test("a mixed question keeps its help answer when there is no market read", () => {
  assert.equal(asksMarket("What is OM AI Plays and what is gold doing right now?"), true);
  assert.equal(asksMarket("What is GENX?"), false);
  const route = read("src/app/api/command-center/brain/route.ts");
  const help = route.indexOf("const topic = platformTopic(message);");
  const noMarket = route.indexOf('"I can\'t see the market right now');
  assert.ok(help > 0 && noMarket > help, "the product is answered before the no-market refusal");
  assert.match(route, /answer: \{ say: r\.say, read: null, evidence: \[\], against: \[\], next: null, invalidation: null, freshness: "", actions: \[\], kind: "help", links: r\.links \}/);
  assert.match(route, /As for the market itself: I can't see a current gold read right now, so I won't describe it\./);
  assert.match(route, /topic \? `\\n\\n\$\{platformGuide\(COSTS\)\}` : ""/, "with a read, the model gets the product too");
  // GENX is read from GENX, with its own time, and its plan only through the member's window.
  const genx = route.slice(route.indexOf("async function genxNowText"), route.indexOf("function pulseText"));
  const closed = genx.slice(genx.indexOf("if (!gate.open) {"), genx.indexOf("const num ="));
  assert.ok(closed.length > 50 && !/trigger_condition|invalidation_reason|entry|stop_loss|tp1/.test(closed), "a closed window hears the stage only");
  assert.match(genx, /a newer quote does not make it newer/);
});

test("the console draws help as help, and generate buttons leave a one-time intent", () => {
  const ui = read("src/components/command-center/BrainConsole.tsx");
  const view = ui.slice(ui.indexOf("function AnswerView("), ui.indexOf("function EvidenceRow("));
  const helpBranch = view.slice(view.indexOf('if (answer.kind === "help") {'), view.indexOf("const r = answer.read;"));
  assert.ok(helpBranch.length > 100 && !/FEED_WORD|freshness/.test(helpBranch), "no feed label and no freshness line on help");
  assert.match(ui, /href = playsHref\(l\.generate\.td, l\.generate\.style, leaveGenerateIntent\(window\.sessionStorage, l\.generate\.td, l\.generate\.style\)\)/);
  assert.match(ui, /if \(!\/\\b\(pulse\|scan\|scanner\)\\b\/i\.test\(q\)\) return \{\};/, "only a Pulse question carries the last scan");
  const voice = read("command-center/brain/voiceLlm.ts");
  assert.ok(voice.indexOf("const ptopic = platformTopic(question);") > 0 && voice.indexOf("const ptopic") < voice.indexOf("if (!memory.now && !history && !needsBackground"), "voice answers the product before it says gold is closed");
});

test("the gold briefing (redesign preview): five parts in order, closed gold leads with its own time", async () => {
  const React = await import("react");
  (globalThis as unknown as { React: unknown }).React = React;     // the test runner compiles JSX the classic way
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ReadCard } = await import("../src/components/command-center/hud/ReadCard");
  const at = Date.UTC(2026, 10, 20, 21, 45);
  const read = {
    version: "t", at, snapshotId: 7, horizon: "intraday", horizonTf: "15m", lean: "bearish_lean", strength: "clear", score: -42,
    htfTrend: { tf: "1h", state: "down", text: "Lower highs on the hour." }, momentum: { tf: "5m", state: "falling", text: "Falling." },
    setupStage: "watching", entry: "none", evidenceFor: [{ text: "Lower high at 4,072", weight: 3 }], evidenceAgainst: [],
    nextWatch: { text: "A 15-minute close below 4,050" }, invalidation: { text: "A close back above 4,084", price: 4084 },
    since: at - 3_600_000, previous: { lean: "neutral", until: at - 3_600_000, reason: "the London low broke" }, summary: "Sellers have the hour.",
  } as never;
  const html = (b?: { closed: boolean }) => renderToStaticMarkup(React.createElement(ReadCard, { read, analysisAt: at, analysisAgeMs: 60_000, replay: false, onPoint: () => {}, onExplain: () => {}, briefing: b }));
  const brief = html({ closed: false });
  const order = ["Current read", "What changed", "Watching next", "What changes this view", "Setup"].map((k) => brief.indexOf(`data-brief="${k}"`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `in order: ${order}`);
  assert.match(brief, /GOLD BRIEFING/);
  assert.match(brief, /A lean is not an entry/);
  assert.ok(!/data-brief="closed"/.test(brief));
  assert.match(html({ closed: true }), /Gold is closed\. This is the last session&#x27;s briefing, from /);
  assert.match(html(), /ATLAS&#x27;S READ/, "the classic card is unchanged without the preview");
});

test("why a trade did not reach an account: that account's own records, and what is not recorded is said (11-21)", () => {
  const route = read("src/app/api/command-center/brain/route.ts");
  const ex = route.slice(route.indexOf("async function executionText"), route.indexOf("/** The member's last Market Pulse scan"));
  assert.match(ex, /from\("flow_broker_accounts"\)[\s\S]*?\.eq\("user_id", userId\)/, "only the member's own accounts are read");
  assert.match(ex, /from\("flow_trade_log"\)[\s\S]*?\.eq\("user_id", userId\)\.eq\("account_id", a\.account_id\)/);
  assert.match(ex, /FLOW does not keep a per-signal record of which check it was where I can read it, so I won't guess\./);
  assert.match(ex, /With Trading and Follow both off, this account takes no GENX trade\./);
  assert.match(ex, /Auto-run FLOW is switched off, and with it off no automated trade reaches any of your accounts\./);
  assert.ok(!/\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(ex), "reading only");
  const ui = read("src/components/command-center/BrainConsole.tsx");
  assert.match(ui, /window\.localStorage\.getItem\("om:floor:account"\)/);
});

test("the Command Center says what each section is for; the replay is named as one; closed-market lines say so", () => {
  const hud = read("src/components/command-center/hud/CommandCenterHud.tsx");
  assert.match(hud, /BACKTEST: "A recorded replay of past sessions — not the live market, and not a performance backtest"/);
  assert.match(hud, /next && n === "BACKTEST" \? "REPLAY" : n/);
  assert.match(hud, /<Timeline rows=\{timelineRows\} className="hud-timeline" closedAt=\{\(t\) => !goldOpenAt\(t\)\} live=\{alive\} \/>/);
  const tl = read("src/components/command-center/hud/Timeline.tsx");
  assert.match(tl, /\{live && <LiveDot size=\{5\} \/>\}/, "no live dot just because the panel runs");
  assert.match(tl, /\{shut \? "MKT CLOSED" : r\.tag \?\? KIND_WORD\[r\.kind\]\}/);
  assert.ok(!/filter\(\(r\) => !closedAt|rows\.filter\([^)]*closedAt/.test(tl), "closed-market lines are labelled, never deleted");
  // The microphone is never started by a tab choice or a page load.
  const pick = hud.slice(hud.indexOf('const saved = window.localStorage.getItem("cc:talk-tab");'), hud.indexOf('} catch { /* the portal, as before */ }'));
  assert.ok(pick.length > 20 && !/voiceBus\.start|getUserMedia/.test(pick));
});

test("the OS dock exposes five real apps, marks the active destination, and respects reduced motion", () => {
  const shell = read("src/components/om/AppShell.tsx");
  const apps = shell.slice(shell.indexOf("const APPS = ["), shell.indexOf("function AppDock()"));
  const destinations = [...apps.matchAll(/\{ key: "([^"]+)" as const,[^}]*?href: "([^"]+)", hard: (true|false) \}/g)];
  assert.deepEqual(destinations.map((item) => item[1]), ["atlas", "genx", "plays", "pulse", "flow"]);
  for (const [, key, href, hard] of destinations) {
    const target = NAV.find((item) => item.key === key)!;
    assert.ok(target, `${key} is a real platform destination`);
    assert.equal(href, target.href, `${key} shares the mobile navigation's destination`);
    assert.equal(hard === "true", target.hard === true, `${key} retains its established navigation behavior`);
  }
  const dock = shell.slice(shell.indexOf("function AppDock()"), shell.indexOf("export function AppShell("));
  assert.match(dock, /<nav className="om-os-dock" aria-label="One Mission apps">/);
  assert.match(dock, /activeKey\(path, useSearchParams\(\)\.get\("view"\)\)/);
  assert.equal((dock.match(/aria-current=\{here === app\.key \? "page" : undefined\}/g) ?? []).length, 2, "both full-page and client links identify the current app");
  assert.match(dock, /<span className="om-os-app-title">\{app\.label\}/, "the icons keep visible text labels");
  const frame = shell.slice(shell.indexOf("export function AppShell("));
  const provider = frame.indexOf("<FlowAccountProvider configured={configured}>"), account = frame.indexOf("<FlowAccountBar />"), tools = frame.indexOf("<AppDock />"), children = frame.indexOf("{children}"), end = frame.indexOf("</FlowAccountProvider>");
  assert.ok(provider > 0 && account > provider && tools > account && children > tools && end > children, "the account bar and all tools share one persistent account view");
  const css = read("src/components/om/om.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.om-app \*, \.om-app \*::before, \.om-app \*::after \{ transition: none !important; animation: none !important; \}/);
  const os = read("src/components/om/os.css");
  assert.match(os, /\.om-os-dock \{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(os, /\.om-os :is\(a,button,input,select,textarea\):focus-visible \{[^}]*outline: 2px solid/);
  const calm = os.slice(os.indexOf("@media (prefers-reduced-motion:reduce)"), os.indexOf("@media (prefers-reduced-transparency:reduce)"));
  assert.match(calm, /transition:none!important; animation:none!important/);
  assert.match(calm, /\.om-os-app:hover \{ transform:none; \}/, "hover lifts also stop when reduced motion is requested");
});

test("an Atlas link opens OM AI Plays without generating in either view; only its Generate button can make a play", () => {
  const ready = platformReply("generate_play", "Generate an intraday OM AI Play for EUR/USD", C);
  for (const l of ready.links) assert.match(l.href, /&open=1$/, `${l.label}: the plain address only fills in`);
  assert.ok(ready.links[0].generate, "the Generate button adds the one-time intent when tapped");
});
