import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  orbVoiceOf, talkStateOf, automationOf, scenarioSlots, tfFromArg, rangeFromArg, balanceWords, ageShort,
} from '../src/components/command-center/hud/hudModel';
import type { LineActivity } from '../src/components/command-center/voiceLine';
import type { AtlasRead, Scenario } from '../command-center/core/atlasContract';

/*
 * THE HUD (ATLAS integration) — the screen's own small decisions, held to what is true: the orb says what the
 * voice line is doing, the talk header never claims a line that is not open, auto-entry is never called ARMED
 * on the profile toggle alone, a scenario card is a live scenario, and a lean is never shown as an entry.
 */

const ALL: LineActivity[] = ['off', 'connecting', 'awaiting_mic', 'listening', 'user_speaking', 'thinking', 'speaking', 'mic_muted', 'ptt_idle', 'disconnected', 'error', 'locked'];

test('the orb follows the line\'s precise activity — a closed microphone is MUTED, not listening', () => {
  const expect: Record<LineActivity, string | null> = {
    off: null, connecting: 'connecting', awaiting_mic: 'connecting', listening: 'listening', user_speaking: 'listening',
    thinking: 'thinking', speaking: 'speaking', mic_muted: 'muted', ptt_idle: 'muted', disconnected: null, error: null, locked: null,
  };
  for (const a of ALL) assert.equal(orbVoiceOf(a), expect[a], a);
});

test('the talk header says what is true — never "online" for a line that is not open', () => {
  for (const a of ALL) {
    const closed = talkStateOf({ activity: a, lineOpen: false, chatBusy: false, replay: false, accessEnded: false });
    assert.notEqual(closed.tone, 'live', `${a}: a closed line is never shown live`);
    assert.ok(!/online/i.test(closed.label), closed.label);
  }
  assert.equal(talkStateOf({ activity: 'off', lineOpen: false, chatBusy: false, replay: false, accessEnded: false }).label, 'Chat ready · voice off');
  assert.equal(talkStateOf({ activity: 'listening', lineOpen: true, chatBusy: false, replay: false, accessEnded: false }).label, 'Voice · listening');
  assert.equal(talkStateOf({ activity: 'mic_muted', lineOpen: true, chatBusy: false, replay: false, accessEnded: false }).tone, 'warn');
  assert.equal(talkStateOf({ activity: 'off', lineOpen: false, chatBusy: true, replay: false, accessEnded: false }).label, 'Chat · thinking');
  assert.equal(talkStateOf({ activity: 'listening', lineOpen: true, chatBusy: false, replay: false, accessEnded: true }).label, 'Window ended', 'an ended window outranks everything');
  assert.equal(talkStateOf({ activity: 'off', lineOpen: false, chatBusy: false, replay: true, accessEnded: false }).label, 'Replay · chat only');
});

test('auto-entry is ARMED only when the server says its autopilot is live — otherwise it is a request', () => {
  const base = { tradeActive: false, autoEntry: true, autoManagement: true };
  assert.equal(automationOf(base).word, 'AUTO-ENTRY REQUESTED', 'payload silent on CC_AUTOPILOT: a request, not ARMED');
  assert.equal(automationOf({ ...base, serverMode: null }).word, 'AUTO-ENTRY REQUESTED');
  assert.equal(automationOf({ ...base, serverMode: 'shadow' }).word, 'ARMED — SHADOW ON SERVER');
  assert.equal(automationOf({ ...base, serverMode: 'off' }).word, 'ARMED — OFF ON SERVER');
  assert.equal(automationOf({ ...base, serverMode: 'live' }).word, 'ARMED');
  assert.equal(automationOf({ ...base, tradeActive: true, tradeSide: 'sell' }).word, 'MANAGING');
  assert.equal(automationOf({ ...base, autoEntry: false }).word, 'MANAGE ONLY');
  assert.equal(automationOf({ ...base, autoEntry: false, autoManagement: false }).word, 'STANDBY');
});

const sc = (id: string, role: Scenario['role'], status: Scenario['status'], updatedAt: number): Scenario => ({
  id, role, status, updatedAt, title: id, tf: '15m', direction: 'range', evidence: [], since: 0, history: [],
  trigger: { text: 't', price: null }, invalidation: { text: 'i', price: null },
});

test('scenario cards: the first LIVE scenario per role; finished ones fold away newest first and never fill a slot', () => {
  const { slots, finished } = scenarioSlots([
    sc('b1', 'base', 'watching', 5), sc('a1', 'alternative', 'developing', 4), sc('b0', 'base', 'confirmed', 9),
    sc('v0', 'view_change', 'invalidated', 3), sc('a0', 'alternative', 'expired', 7), sc('b2', 'base', 'developing', 6),
  ]);
  assert.equal(slots.base?.id, 'b1');
  assert.equal(slots.alternative?.id, 'a1');
  assert.equal(slots.view_change, null, 'an invalidated scenario is not promoted into the live card');
  assert.deepEqual(finished.map((s) => s.id), ['b0', 'a0', 'v0']);
  assert.deepEqual(scenarioSlots(undefined), { slots: { base: null, alternative: null, view_change: null }, finished: [] });
});

test('older [[UI: …]] markers: a timeframe the chart has, a range of two prices — nothing invented', () => {
  assert.equal(tfFromArg('1h'), '1h');
  assert.equal(tfFromArg('D'), '1d');
  assert.equal(tfFromArg('daily'), '1d');
  assert.equal(tfFromArg('15'), '15m');
  assert.equal(tfFromArg('1m'), null, 'the chart has no 1-minute candles');
  assert.equal(tfFromArg(null), null);
  assert.deepEqual(rangeFromArg('4,392.10-4,380'), [4380, 4392.1]);
  assert.equal(rangeFromArg('4380'), null);
  assert.equal(rangeFromArg(4380), null);
});

test('the evidence balance is a signed number, or a dash when there is not enough data', () => {
  assert.equal(balanceWords(17, 'balanced'), '+17');
  assert.equal(balanceWords(-42.4, 'bearish_lean'), '−42');
  assert.equal(balanceWords(55, 'insufficient_data'), '—');
  assert.equal(balanceWords(null, 'balanced'), '—');
  assert.equal(ageShort(41_000), '41 s');
  assert.equal(ageShort(180_000), '3 min');
  assert.equal(ageShort(null), '—');
});

const read: AtlasRead = {
  version: 'read-1', at: Date.UTC(2026, 10, 10, 14, 30), snapshotId: 7, horizon: 'intraday', horizonTf: '15m',
  lean: 'bullish_lean', strength: 'clear', score: 41,
  htfTrend: { tf: '1h', state: 'up', text: '1-hour: higher highs and higher lows.' },
  momentum: { tf: '5m', state: 'rising', text: 'Five-minute momentum is rising.' },
  setupStage: 'watching', entry: 'none',
  evidenceFor: [
    { text: 'Closed above the 15-minute swing high', weight: 12, ref: { kind: 'level', levelId: 'ny_high@4396.01', price: 4396.01 } },
    { text: 'Pressure proxy +30', weight: 4 }, { text: 'RSI 61', weight: 1 }, { text: 'tiny', weight: 0.2 },
  ],
  evidenceAgainst: [{ text: '5-minute lower high', weight: 3, ref: { kind: 'swing', tf: '5m', t: Date.UTC(2026, 10, 10, 14, 0), price: 4391.09, type: 'high' } }],
  nextWatch: { text: 'A 15-minute close above 4,401.20', ref: { kind: 'zone', from: 4398, to: 4401.2, label: 'next' } },
  invalidation: { text: 'A 15-minute close below 4,371.77', price: 4371.77 },
  since: Date.UTC(2026, 10, 10, 14, 0), previous: { lean: 'balanced', until: Date.UTC(2026, 10, 10, 14, 0), reason: 'Structure confirmed it.' },
  summary: 'The broader structure is bullish and the five-minute chart agrees.',
};

test('the read card: the lean, its evidence as chart buttons, the balance (not a probability), and an entry kept apart', async () => {
  const React = await import('react');
  (globalThis as unknown as { React: unknown }).React = React;   // the test runner compiles JSX the classic way
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ReadCard } = await import('../src/components/command-center/hud/ReadCard');
  const html = renderToStaticMarkup(React.createElement(ReadCard, {
    read, analysisAt: read.at, analysisAgeMs: 41_000, replay: false, onPoint: () => {}, onExplain: () => {},
  }));
  assert.ok(html.includes('Bullish lean') && html.includes('CLEAR'), 'lean label and strength chip');
  assert.ok(html.includes('Intraday · 15m/1h structure'), 'the horizon is stated');
  assert.ok(/a lean is not an entry/i.test(html), 'trade status is boxed apart from the lean');
  assert.ok(html.includes('No entry') && html.includes('Watching'), 'setup stage and entry come from the read as they are');
  assert.ok(html.includes('+41') && /Evidence balance/i.test(html), 'the score is an evidence balance');
  assert.ok(!/probability of/i.test(html.replace(/<[^>]+>/g, ' ').replace(/not a probability/gi, '')), 'never presented as a probability');
  assert.ok(html.includes('top 3 of 4'), 'top three on each side');
  assert.ok(!html.includes('tiny'), 'the fourth-weighted item is not shown');
  assert.equal((html.match(/title="Show this on the chart"/g) ?? []).length, 4, 'only what points at something real is a button: 2 referenced evidence lines, the next-watch zone, the invalidation price');
  assert.ok(html.includes('Was <b') && html.includes('Structure confirmed it.'), 'the previous lean and why it changed');

  const thin = renderToStaticMarkup(React.createElement(ReadCard, {
    read: { ...read, lean: 'insufficient_data', strength: null, score: 12 }, analysisAt: read.at, analysisAgeMs: null, replay: true, onPoint: () => {}, onExplain: () => {},
  }));
  assert.ok(thin.includes('Not enough current data'));
  assert.ok(/data-balance="">—</.test(thin), 'insufficient data: the balance is a dash, not a number');
  assert.ok(thin.includes('(recorded)'), 'a replayed read says it is recorded instead of claiming an age');
});

test('the scenario cards: one per role with its status, triggers that point at the chart, and "Show on chart"', async () => {
  const React = await import('react');
  (globalThis as unknown as { React: unknown }).React = React;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ScenarioCards } = await import('../src/components/command-center/hud/ScenarioCards');
  const live: Scenario = {
    ...sc('up-1', 'alternative', 'developing', Date.UTC(2026, 10, 10, 14, 25)), title: 'Breakout above 4,396.01', direction: 'up',
    trigger: { text: 'A 15-minute close above 4,396.01 (new york high)', price: 4396.01, ref: { kind: 'level', levelId: 'ny_high@4396.01', price: 4396.01 } },
    invalidation: { text: 'A 15-minute close below 4,371.77', price: 4371.77 },
  };
  const html = renderToStaticMarkup(React.createElement(ScenarioCards, {
    scenarios: [sc('base-1', 'base', 'watching', 1), live, sc('done', 'view_change', 'invalidated', 2)],
    selectedId: null, onShow: () => {}, onPoint: () => {}, now: Date.UTC(2026, 10, 10, 14, 30), replay: false,
  }));
  assert.ok(html.includes('data-scenario="base"') && html.includes('data-scenario="alternative"'));
  assert.ok(html.includes('data-status="developing"') && html.includes('data-status="watching"'));
  assert.ok(!html.includes('data-scenario="view_change"'), 'a finished scenario is not shown as the live card');
  assert.ok(html.includes('None live right now'), 'the empty role says so');
  assert.equal((html.match(/Show on chart/g) ?? []).length, 2);
  assert.ok(html.includes('Finished · 1'), 'the finished one is folded away, not deleted');
  assert.ok(/Conditional — not forecasts/.test(html));
  assert.ok(html.includes('4,396.01</b>'), 'the trigger price is highlighted where the sentence states it');
});

test('the screen\'s honesty, in its source: no hard-coded "Online", LIVE only from the feed, broker panel portalled, renewal heard', () => {
  const hud = readFileSync('src/components/command-center/hud/CommandCenterHud.tsx', 'utf8');
  assert.ok(!/>\s*Online\s*</.test(hud) && !/"Online"/.test(hud), 'the talk header is never hard-coded "Online"');
  assert.ok(!/d\?\.live \? "LIVE"/.test(hud), 'LIVE never comes from the /live payload flag');
  assert.ok(/FEED_STATUS_WORD\[feed\.status\]/.test(hud), 'the status pill is the feed state\'s own word');
  assert.ok(/useLiveFeed\(\{ enabled: !isReplay, demo: isReplay, serverFeed: d\?\.feed \?\? null \}\)/.test(hud));
  assert.ok(!/"ARMED"/.test(hud), 'ARMED is decided by hudModel.automationOf, not written into the screen');
  assert.ok(!/hidden min-\[1800px\]:block"><BrokerBar/.test(hud), 'the broker chip is not hidden below 1800 px any more');
  const broker = readFileSync('src/components/command-center/BrokerBar.tsx', 'utf8');
  assert.ok(/createPortal\(panel, document\.body\)/.test(broker), 'the broker panel renders into <body>, outside any hidden header');
  const gate = readFileSync('src/components/command-center/hud/PassGate.tsx', 'utf8');
  assert.ok(/addEventListener\(PASS_RENEW_EVENT/.test(gate), 'Renew in the console brings the renewal gate');
  const entry = readFileSync('src/components/command-center/hud/EntrySequence.tsx', 'utf8');
  assert.ok(/e\.key === "Escape"/.test(entry) && (entry.match(/SKIP ›/g) ?? []).length >= 2, 'the entrance can be skipped from either screen, and with Esc');
});
