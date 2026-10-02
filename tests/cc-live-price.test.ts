import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSnapshot } from '../command-center/engines/snapshot';
import { emptyRolling, pushSnapshot } from '../command-center/brain/memory';
import { perceive } from '../command-center/brain';
import { contextPacket, agoWords, BRAIN_SYSTEM } from '../command-center/brain/context';
import { marketRead, briefing, scenarioOf } from '../command-center/brain/language';
import { diffSet } from '../command-center/brain/diff';
import { brainState } from '../command-center/brain/presence';
import { findSetup } from '../command-center/engines/setup';
import { asSetupProfile, DEFAULT_PROFILE } from '../command-center/engines/profile';
import { priceNow, priceReadAt, shownSnapshot } from '../command-center/core/priceNow';
import {
  withLivePrice, freshTick, liveGoldPrice,
  TICK_FRESH_MS, SPOKEN_TICK_MS, MAX_LIVE_DEVIATION, type LivePriceSources,
} from '../command-center/engines/livePrice';
import type { Bar, MarketSnapshot } from '../command-center/core/types';

/**
 * THE PRICE RIGHT NOW (owner 10-01: "when I talk to ATLAS it's behind on actual live price… it doesn't
 * say real price right then and there. It's always a little behind").
 *
 * ATLAS spoke the price out of the last PERSISTED snapshot, which is written about once a minute:
 * measured 67s between snapshots (88s at worst), gold moving $0.69 at the median and up to $5.40
 * between two of them. The newest streamed tick (or, in a conversation, a direct quote) is now attached
 * to the snapshot at the moment of the answer, and what is SAID and SHOWN as the price reads it.
 *
 * The other half of this file is the part that matters more: the attached quote must not move a single
 * decision. The setup, the position read and every button are computed from what the worker measured,
 * and the server recomputes from that same number.
 */
const M = 60_000;
const NOW = Date.UTC(2026, 9, 1, 14, 0, 0);   // Thursday, New York session — the market is open
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });
function series(n: number, start: number, drift: number, t0: number): Bar[] {
  const out: Bar[] = []; let p = start;
  for (let i = 0; i < n; i++) { const c = p + drift + Math.sin(i / 7) * 0.8; out.push(bar(t0 + i * 5 * M, p, Math.max(p, c) + 1.2, Math.min(p, c) - 1.2, c)); p = c; }
  return out;
}
const bars = series(160, 4150, 0.08, NOW - 160 * 5 * M);
const snapAt = (at: number, price: number): MarketSnapshot => buildSnapshot({
  now: at, bars: { '5m': bars, '15m': bars, '1h': bars, '4h': bars, '1d': bars }, price,
  feeds: [{ feed: 'twelvedata', state: 'live', lastTickMs: at, ageMs: 4_000 }],
});
function rollingBefore(at: number) {
  let r = emptyRolling();
  for (let i = 12; i >= 1; i--) r = pushSnapshot(r, snapAt(at - i * M, 4155 + i * 0.3));
  return r;
}
const MEASURED = 4161.64, LIVE = 4163.1;
const measuredAt = NOW - 63_000;

/* ── the quote itself ─────────────────────────────────────────────────────── */

test('a published tick is "now" for twenty seconds and not a moment longer', () => {
  assert.deepEqual(freshTick({ price: 4162.4, receivedAt: NOW - 1_500 }, NOW), { price: 4162.4, at: NOW - 1_500, source: 'stream' });
  assert.ok(freshTick({ price: 4162.4, receivedAt: NOW - TICK_FRESH_MS }, NOW), 'still fresh at the limit');
  assert.equal(freshTick({ price: 4162.4, receivedAt: NOW - TICK_FRESH_MS - 1 }, NOW), null, 'the stream has gone quiet — not a live price');
  assert.equal(freshTick(null, NOW), null, 'no row');
  assert.equal(freshTick({ price: 0, receivedAt: NOW }, NOW), null, 'not a price');
  assert.equal(freshTick({ price: 4162.4, receivedAt: NOW + 60_000 }, NOW), null, 'a tick from a minute in the future is a clock fault');
});

test('the screen reads the stream only; a conversation spends one quote when the tick is more than a few seconds old', async () => {
  const sources = (tickAgeMs: number | null, quote: number | null) => {
    const calls = { quote: 0 };
    const s: LivePriceSources = {
      tick: async () => (tickAgeMs == null ? null : { price: 4162.4, receivedAt: NOW - tickAgeMs }),
      quote: async () => { calls.quote += 1; return quote; },
    };
    return { s, calls };
  };
  // the screen
  let x = sources(15_000, 4163.1);
  assert.deepEqual(await liveGoldPrice({ nowMs: NOW }, x.s), { price: 4162.4, at: NOW - 15_000, source: 'stream' });
  assert.equal(x.calls.quote, 0, 'a screen poll never spends an API credit');
  x = sources(TICK_FRESH_MS + 5_000, 4163.1);
  assert.equal(await liveGoldPrice({ nowMs: NOW }, x.s), null, 'no fresh tick: the screen keeps the snapshot price');
  assert.equal(x.calls.quote, 0);
  // a conversation
  x = sources(2_000, 4163.1);
  assert.deepEqual(await liveGoldPrice({ allowQuote: true, nowMs: NOW }, x.s), { price: 4162.4, at: NOW - 2_000, source: 'stream' });
  assert.equal(x.calls.quote, 0, 'a two-second-old tick is the price — no quote needed');
  x = sources(SPOKEN_TICK_MS + 4_000, 4163.1);
  assert.deepEqual(await liveGoldPrice({ allowQuote: true, nowMs: NOW }, x.s), { price: 4163.1, at: NOW, source: 'quote' });
  assert.equal(x.calls.quote, 1, 'the stream is quiet or behind: ask the provider once');
  x = sources(SPOKEN_TICK_MS + 4_000, null);
  assert.deepEqual(await liveGoldPrice({ allowQuote: true, nowMs: NOW }, x.s), { price: 4162.4, at: NOW - SPOKEN_TICK_MS - 4_000, source: 'stream' }, 'the quote failed — the ten-second-old tick still beats a minute-old snapshot');
  x = sources(null, null);
  assert.equal(await liveGoldPrice({ allowQuote: true, nowMs: NOW }, x.s), null, 'nothing fresher exists: the snapshot stands and says its age');
});

/* ── attached, never written over ─────────────────────────────────────────── */

test('the fresher quote is ATTACHED: the measured price and every measurement stay exactly as written', () => {
  const s = { ...snapAt(measuredAt, MEASURED), bid: 4161.5, ask: 4161.78, spread: 0.28 };
  const withQuote = withLivePrice(s, { price: LIVE, at: NOW - 1_000, source: 'stream' });
  assert.deepEqual(withQuote.live, { price: LIVE, at: NOW - 1_000, source: 'stream' });
  assert.equal(withQuote.price, MEASURED, 'snapshot.price is what the worker measured — decisions read this');
  const { live: _live, ...rest } = withQuote;
  assert.deepEqual(rest, s, 'nothing else changed: bid/ask, levels, pressure, timeframes, time');
  assert.equal(s.live, undefined, 'and the persisted snapshot itself is never mutated');

  assert.equal(priceNow(withQuote), LIVE, 'what is SAID and SHOWN is the fresher quote');
  assert.equal(priceReadAt(withQuote), NOW - 1_000);
  assert.equal(priceNow(s), MEASURED, 'with nothing attached, it is the same number');
  assert.equal(priceReadAt(s), s.at);
});

test('a quote that is not newer, or is implausibly far away, is refused', () => {
  const s = snapAt(NOW - 10_000, MEASURED);
  assert.equal(withLivePrice(s, null), s);
  assert.equal(withLivePrice(s, { price: 4163, at: s.at - 5_000, source: 'stream' }), s, 'older than the snapshot: the snapshot already has the newer price');
  const far = s.price * (1 + MAX_LIVE_DEVIATION) + 1;
  assert.equal(withLivePrice(s, { price: far, at: NOW, source: 'quote' }), s, 'a bad tick is not news');
  assert.equal(withLivePrice(s, { price: 0, at: NOW, source: 'quote' }), s);
});

test('attaching a live quote moves no decision: the setup, the state and the diffs are identical', () => {
  const r = rollingBefore(measuredAt);
  const s = snapAt(measuredAt, MEASURED);
  // A quote far enough away that a price-driven setup would visibly differ if anything read it.
  const withQuote = withLivePrice(s, { price: MEASURED + 6.5, at: NOW - 1_000, source: 'stream' });
  assert.ok(withQuote.live, 'the quote was accepted');

  const diffsA = diffSet(s, r.snapshots), diffsB = diffSet(withQuote, r.snapshots);
  assert.deepEqual(diffsB, diffsA);

  const profile = asSetupProfile(DEFAULT_PROFILE);
  const setup = (snapshot: MarketSnapshot) => findSetup({ snapshot, diffs: diffsA, profile, marketOpen: true, now: NOW });
  assert.deepEqual(setup(withQuote), setup(s), 'TAKE THIS TRADE recomputes from the measured snapshot — the card must be the same trade');
  // This is what writing the quote over `price` would have done: a ready trade on the server, and a
  // different card on the screen. It is why the quote is attached and the display copy stays out of here.
  assert.equal(setup(s).state, 'trade_ready');
  assert.notDeepEqual(setup(shownSnapshot(withQuote)), setup(s));

  const state = (snapshot: MarketSnapshot) => brainState({ snapshot, thesis: null, events: [] });
  assert.deepEqual(state(withQuote), state(s));
});

test('the display copy is the only place the fresher quote sits in `price`, and only the screen layer gets it', () => {
  const s = { ...snapAt(measuredAt, MEASURED), bid: 4161.5, ask: 4161.78, spread: 0.28 };
  assert.equal(shownSnapshot(s), s, 'nothing attached → the very same snapshot');
  const shown = shownSnapshot(withLivePrice(s, { price: LIVE, at: NOW - 1_000, source: 'stream' }));
  assert.equal(shown.price, LIVE);
  assert.equal(shown.bid, null); assert.equal(shown.ask, null); assert.equal(shown.spread, null);   // they described the measured quote
  assert.deepEqual(shown.levels, s.levels); assert.equal(shown.at, s.at);

  // Nothing that decides, sizes, places, manages or records a trade may ever be handed the display copy.
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
  walk('command-center'); walk('src/app/api/command-center');
  const users = files.filter((f) => /shownSnapshot\(/.test(readFileSync(f, 'utf8')) && !f.endsWith(join('core', 'priceNow.ts')));
  assert.deepEqual(users, [join('command-center', 'engines', 'live.ts')]);
  const live = readFileSync('command-center/engines/live.ts', 'utf8');
  assert.equal(live.match(/shownSnapshot\(/g)?.length, 1);
  assert.ok(/presentExtras\(\{\s*s: shownSnapshot\(s\)/.test(live), 'it goes to present/intel.ts — display only by construction');
});

/* ── what ATLAS is told, and what it says ─────────────────────────────────── */

test('the context tells ATLAS which number is the price this second, and measures the levels from it', () => {
  const r = rollingBefore(measuredAt);
  // One level sits between the measured price and the live one: above a minute ago, below now.
  const between = { price: 4162.5, kind: 'pdh' as const, label: "yesterday's high" };
  const snap = { ...snapAt(measuredAt, MEASURED), levels: [between, { price: 4170, kind: 'dh' as const, label: "today's high" }, { price: 4150, kind: 'dl' as const, label: "today's low" }], map: [] };
  const withQuote = withLivePrice(snap, { price: LIVE, at: NOW - 2_000, source: 'stream' });
  const packet = contextPacket(perceive({ rolling: r, snapshot: withQuote }).memory, { nowMs: NOW, tradeSummary: 'BUY XAUUSD, quick style, 0.5 lots from 4160.00' });
  assert.match(packet, /time now: 2026-10-01T14:00:00/);
  assert.match(packet, /price: 4163\.10 — LIVE quote, read 2 seconds ago\. This is the price right now/);
  assert.match(packet, /the rest of this read .* was measured 63 seconds ago, at 2026-10-01T13:58:57\.000Z, when price was 4161\.64/);
  const below = packet.slice(packet.indexOf('=== LEVELS BELOW PRICE'));
  assert.match(below, /yesterday's high: 4162\.50 \(0\.60 away\)/, 'price is through that level now — it is below, 0.60 away');
  assert.match(packet, /today's high: 4170\.00 \(6\.90 away\)/);
  assert.match(packet, /\(the pips, dollars and distances in this block were measured 63 seconds ago, with price at 4161\.64\)/, 'the position read is the measured one, and says so');

  // Without a fresher quote the same level is still above, measured from the snapshot's own price.
  const plain = contextPacket(perceive({ rolling: r, snapshot: snap }).memory, { nowMs: NOW, tradeSummary: 'BUY XAUUSD' });
  const above = plain.slice(plain.indexOf('=== LEVELS ABOVE PRICE'), plain.indexOf('=== LEVELS BELOW PRICE'));
  assert.match(above, /yesterday's high: 4162\.50 \(0\.86 away\)/);
  assert.ok(!/in this block were measured/.test(plain), 'no note when the position read and the price are the same age');
});

test('with no fresher quote the price is labelled with its age, not passed off as current', () => {
  const r = rollingBefore(measuredAt);
  const packet = contextPacket(perceive({ rolling: r, snapshot: snapAt(measuredAt, MEASURED) }).memory, { nowMs: NOW });
  assert.match(packet, /price: 4161\.64 — measured 63 seconds ago, at 2026-10-01T13:58:57\.000Z\. No fresher quote came through: if you say the price, say how old it is\./);
  assert.ok(!/LIVE quote/.test(packet));

  // A read written a few seconds ago IS the price now — no hedging about its age.
  const fresh = contextPacket(perceive({ rolling: rollingBefore(NOW - 4_000), snapshot: snapAt(NOW - 4_000, MEASURED) }).memory, { nowMs: NOW });
  assert.match(fresh, /price: 4161\.64 — measured 4 seconds ago\. This is the price right now\./);

  assert.match(BRAIN_SYSTEM, /The price line says whether its number is the price right now/);
  assert.match(BRAIN_SYSTEM, /say how old it is/);

  assert.equal(agoWords(1_000), '1 second'); assert.equal(agoWords(63_000), '63 seconds');
  assert.equal(agoWords(4 * M), '4 minutes'); assert.equal(agoWords(5 * 60 * M), '5 hours');
  assert.equal(agoWords(50 * 60 * M), '2 days', 'a weekend-old read is not "2880 minutes"');
});

test("ATLAS's own deterministic voice says the same live price the packet does", () => {
  const r = rollingBefore(measuredAt);
  const snap = { ...snapAt(measuredAt, MEASURED), levels: [{ price: 4162.5, kind: 'pdh' as const, label: "yesterday's high" }, { price: 4170, kind: 'dh' as const, label: "today's high" }, { price: 4150, kind: 'dl' as const, label: "today's low" }] };
  const m = perceive({ rolling: r, snapshot: withLivePrice(snap, { price: LIVE, at: NOW - 2_000, source: 'stream' }) }).memory;
  assert.match(marketRead(m), /XAUUSD is at 4163\.10/);
  assert.match(briefing(m), /XAUUSD is trading at 4163\.10\./);
  const sc = scenarioOf(m)!;
  assert.match(sc.bull, /above 4170\.00/, 'the level it has already traded through is no longer "above"');
  assert.match(sc.bear, /Losing 4162\.50/);
  const plain = perceive({ rolling: r, snapshot: snap }).memory;
  assert.match(marketRead(plain), /XAUUSD is at 4161\.64/);
  assert.match(scenarioOf(plain)!.bull, /above 4162\.50/);
});

/* ── the wiring ───────────────────────────────────────────────────────────── */

test('the stream publishes its newest tick without ever holding up the socket loop', () => {
  const stream = readFileSync('worker/priceStream.ts', 'utf8');
  assert.ok(/from\("market_live_ticks"\)\.upsert\(/.test(stream), 'the worker writes the newest tick');
  assert.ok(/published\.get\(sym\) === tk\.receivedAt\) continue/.test(stream), 'only when a new tick has arrived');
  assert.ok(/if \(!error\) published\.set\(sym, tk\.receivedAt\)/.test(stream), 'a failed write is tried again with the next pass');
  assert.ok(/PUBLISH_MS = 1_000/.test(stream), 'at most once a second');
  assert.ok(/\.abortSignal\(AbortSignal\.timeout\(PUBLISH_TIMEOUT_MS\)\)/.test(stream), 'a hung write is abandoned');
  const loop = stream.slice(stream.indexOf('while (!closed && !isShuttingDown())'));
  assert.ok(/if \(!publishing && now - lastPublish >= PUBLISH_MS\)/.test(loop), 'one write at a time');
  assert.ok(/void publishTicks\(\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ publishing = false; \}\)/.test(loop), 'fired, not awaited');
  assert.ok(!/await publishTicks\(/.test(stream) && !/await admin\.from\("market_live_ticks"\)/.test(loop), 'the keep-alive ping and the tick intake never wait on the database');
  const sql = readFileSync('supabase/migrations/20261002030000_market_live_ticks.sql', 'utf8');
  assert.ok(/enable row level security/.test(sql) && !/create policy/i.test(sql), 'server-side only');
});

test('the screen shows the live price while every decision on it is still computed from the measured snapshot', () => {
  const live = readFileSync('command-center/engines/live.ts', 'utf8');
  const state = live.slice(live.indexOf('export async function liveState'), live.indexOf('export async function liveMemory'));
  assert.ok(/wantLive \? liveGoldPrice\(\) : Promise\.resolve\(null\)/.test(state), 'the screen reads the stream only — no quote per poll');
  assert.ok(/const s: MarketSnapshot = withLivePrice\(latest\.snapshot, livePx\)/.test(state));
  assert.ok(/price: priceNow\(s\), bid: s\.live \? null : s\.bid/.test(state), 'the headline is the fresher quote');
  assert.ok(/priceReadAt: priceReadAt\(s\), priceSource: s\.live\?\.source \?\? "snapshot"/.test(state));
  // s.price is untouched by withLivePrice (tested above), so these read the measured market:
  assert.ok(/tradeState\(userId, s, diffs\)/.test(state), 'the position read');
  assert.ok(/findSetup\(\{\s*snapshot: s,/.test(state), 'the setup');
  assert.ok(/brainState\(\{\s*snapshot: s,/.test(state));
  // …and the server recomputes from the same thing when a button is pressed.
  const trade = readFileSync('src/app/api/command-center/trade/route.ts', 'utf8');
  assert.ok(/const snapshotNow = async \(\) => \(await latestWithBars\(\)\)\?\.snapshot \?\? null;/.test(trade));
  assert.ok(!/livePrice|priceNow|withLivePrice/.test(trade), 'no live quote reaches execution');
  for (const f of ['command-center/engines/tradeLive.ts', 'command-center/engines/setup.ts', 'command-center/engines/callTrade.ts', 'command-center/engines/autopilot.ts', 'command-center/engines/autoManage.ts', 'command-center/brain/trade.ts', 'command-center/worker/index.ts']) {
    assert.ok(!/priceNow|withLivePrice|shownSnapshot|\.live\?\.|liveGoldPrice/.test(readFileSync(f, 'utf8')), `${f} never reads the attached quote`);
  }
});

test('a conversation asks for the live price; anything that only records the market does not', () => {
  const live = readFileSync('command-center/engines/live.ts', 'utf8');
  const memory = live.slice(live.indexOf('export async function liveMemory'));
  assert.ok(/const wantLive = !!opts\.livePrice && marketOpen\(Date\.now\(\)\)/.test(memory), 'off unless asked for');
  assert.ok(/liveGoldPrice\(\{ allowQuote: true \}\)/.test(memory), 'a conversation may spend one direct quote');
  assert.ok(/withLivePrice\(latest\.snapshot, livePx\)/.test(memory));

  const voice = readFileSync('command-center/brain/voiceLlm.ts', 'utf8');
  const chat = readFileSync('src/app/api/command-center/brain/route.ts', 'utf8');
  for (const [name, src] of [['voice', voice], ['chat', chat]] as const) {
    assert.ok(/await liveMemory\(\{ livePrice: true \}\)/.test(src), `${name} reads the live price`);
    assert.ok(/const saidPrice = priceNow\(now\);/.test(src), `${name} works the member's own trade out at the price it says`);
    assert.ok(!/tradeGuidanceLines\([^)]*now\.price/.test(src), `${name} does not do that arithmetic at the minute-old price`);
    assert.ok(/findSetup\(\{\s*snapshot: memory\.now,/.test(src), `${name} reports the same setup the screen and the server compute`);
  }
  assert.ok(/tradeState\(session\.userId, memory\.now\)/.test(voice) && /tradeState\(user\.id, memory\.now\)/.test(chat));
  const teach = readFileSync('src/app/api/command-center/teach/route.ts', 'utf8');
  assert.ok(/const m = await liveMemory\(\);/.test(teach), 'a lesson is stored against the measured market, untouched');
});
