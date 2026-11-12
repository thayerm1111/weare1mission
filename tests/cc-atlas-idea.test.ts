import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fixture from '../command-center/fixtures/replay-bars.json';
import { replay } from '../command-center/engines/replay';
import { replayIdea, replayFollow, replayEndOf } from '../command-center/engines/ideaReplay';
import {
  buildIdea, followIdea, forcedSide, ideaLevels, ideaOptionsOf, ideaRecord, ideaText, sayLevel, structureOf, IDEA_RULES, IDEA_VERSIONS, ATLAS_IDEA_VERSION,
  type AtlasIdea, type BuildIdeaInput,
} from '../command-center/engines/idea';
import { updateVerdict } from '../command-center/engines/ideaDesk';
import { noSetup, type BrainSetup } from '../command-center/engines/setup';
import { tradeable } from '../command-center/engines/snapshot';
import { STYLE } from '../command-center/core/style';
import { edgesOfRead } from '../command-center/core/read';
import { resample } from '../command-center/core/bars';
import type { AtlasRead } from '../command-center/core/atlasContract';
import type { Bar, MarketSnapshot } from '../command-center/core/types';

/*
 * GENERATE WITH ATLAS — the trade idea (owner 11-11), as ONE call in ATLAS's own voice with the stop behind
 * market structure (owner 11-12).
 *
 * Everything here runs the REAL engine over the recorded gold session in command-center/fixtures (a
 * labelled replay fixture, 18 September) or over small hand-built cases. Nothing reaches a network.
 */

const M5 = 5 * 60_000;
const m5: Bar[] = (fixture.m5 as number[][]).map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }));

const base = (r: ReturnType<typeof replay>, over: Partial<BuildIdeaInput> = {}): BuildIdeaInput => ({
  snapshot: r.snapshot, setup: r.state.setup, takeable: true, read: r.state.read, scenarios: r.state.scenarios, marketOpen: true, now: r.endedAt,
  bars5m: r.state.bars, ...over,
});

/** Every moment of the recording the idea engine is asked at, three candles apart. */
const MOMENTS = (() => {
  const out: { off: number; r: ReturnType<typeof replay>; idea: AtlasIdea }[] = [];
  for (let off = 0; off <= m5.length - 100; off += 3) {
    const r = replay(40, false, off);
    out.push({ off, r, idea: buildIdea(base(r)) });
  }
  return out;
})();
/** ATLAS's own calls: everything that is not a confirmed setup. */
const CALLS = MOMENTS.filter((m) => m.idea.source !== 'setup_engine');
const dirOf = (idea: AtlasIdea) => (idea.side === 'buy' ? 1 : -1);
/** What a stop gives the swing it hides behind (the engine's rule, restated). */
const bufferOf = (s: MarketSnapshot) => (s.spread != null && s.spread > 0 ? s.spread : 0) + Math.max(IDEA_RULES.STOP_BUFFER_MIN, IDEA_RULES.STOP_BUFFER_ATR * (s.timeframes['5m']?.features.atr ?? 0));
const floorOf = (s: MarketSnapshot) => Math.max(IDEA_RULES.MIN_STOP_PIPS * 0.1, IDEA_RULES.MIN_STOP_ATR * (s.timeframes['5m']?.features.atr ?? 0));
/** Everything a member reads on a call (the setup engine's own sentence rides along in `engine` and is not ATLAS's call). */
const wordsOf = (idea: AtlasIdea) => [idea.badge, idea.headline, idea.reasoning, idea.say, idea.entry?.text, idea.stop?.what, idea.execute.note, idea.confidence?.basis, idea.invalidation?.text, idea.poi, idea.targeting, idea.strategy, ...idea.warnings, ideaText(idea)].filter(Boolean).join('\n');

test('it always names a side and a trade: a confirmed setup, or ATLAS\'s own call — it never stands aside', () => {
  // Owner 11-11: "I don't want it ever to stand down. I want it forced to read the market and come up with
  // a direction and a trade."
  const kinds = new Set(MOMENTS.map((m) => `${m.idea.kind}/${m.idea.source ?? '-'}`));
  assert.ok(![...kinds].some((k) => k.startsWith('stand_aside')), 'it stood aside');
  assert.ok(kinds.has('enter_now/setup_engine'), 'never returned the setup engine\'s ready trade');
  assert.ok(kinds.has('enter_now/read_plan'), 'never made a call from a clear lean');
  assert.ok(kinds.has('enter_now/forced_read'), 'never made a call from a tilt of the evidence');
  for (const m of MOMENTS) {
    assert.equal(m.idea.version, ATLAS_IDEA_VERSION);
    assert.ok(m.idea.side && m.idea.entry && m.idea.stop && m.idea.targets.length >= 1, `no trade at ${m.off}: ${m.idea.headline}`);
  }
  assert.ok(CALLS.length >= 25, `only ${CALLS.length} calls on the recording`);
  assert.equal(ATLAS_IDEA_VERSION, 'idea-2');
  assert.deepEqual([...IDEA_VERSIONS], ['idea-1', 'idea-2'], 'ideas stored before the change are still a member\'s record');
  assert.match(readFileSync('command-center/engines/ideaDesk.ts', 'utf8'), /IDEA_VERSIONS\.includes\(i\.version\)/);
});

test('one ATLAS option: there is no style to choose, and a call is always the same shape — entered at the price', () => {
  // Owner 11-12: "not so many options just want an atlas option that goes off what atlas sees … I don't want
  // the quick, intraday, or swing versions."
  for (const raw of [{ style: 'quick' }, { style: 'hold' }, { style: 'swing' }, { style: 'everything' }, null, undefined, 'swing']) {
    assert.deepEqual(ideaOptionsOf(raw), { style: 'auto' });
  }
  for (const off of [0, 21, 33, 57]) {
    const auto = replayIdea({ style: 'auto' }, off);
    for (const style of ['quick', 'hold', 'swing']) assert.deepEqual(replayIdea({ style }, off), auto, `asking for ${style} changed the answer at ${off}`);
    assert.deepEqual(replayIdea({ style: 'auto' }, off), auto, 'the same market always produces the same idea');
    assert.equal(auto.id, `replay:${off}:auto`);
  }
  for (const { idea, r, off } of CALLS) {
    assert.equal(idea.kind, 'enter_now', `a call that is not an entry now at ${off}`);
    assert.equal(idea.entry!.type, 'market');
    assert.ok(Math.abs(idea.entry!.price - r.snapshot.price) < 0.011, 'entered at the price gold is at');
    assert.equal(idea.entry!.level, null); assert.equal(idea.entry!.trigger, null); assert.equal(idea.watch, null);
    assert.deepEqual(idea.waitingFor, []);
    assert.equal(idea.alternative, null, 'one answer, not two');
    assert.ok(!('enterNow' in idea), 'no second entry beside the call');
  }
  // The drawer: no style chips, no second entry, and it asks the server for nothing but "generate".
  const panel = readFileSync('src/components/command-center/hud/IdeaPanel.tsx', 'utf8');
  assert.doesNotMatch(panel, /ATLAS decides|"Quick"|"Intraday"|"Swing"|IdeaStyleChoice|setStyle|enterNow|Enter now instead|The other way in/);
  assert.match(panel, /post\(\{ action: "generate" \}\)/);
  assert.doesNotMatch(panel, /Setup engine ·|forced read/i);
  const desk = readFileSync('command-center/engines/ideaDesk.ts', 'utf8');
  assert.doesNotMatch(desk, /allowQuick|allowHold|allowSwing/, 'the style filter is gone from the live path');
  assert.doesNotMatch(readFileSync('command-center/engines/ideaReplay.ts', 'utf8'), /allowQuick|allowHold|allowSwing/);
});

test('every idea with a trade in it is geometrically sound', () => {
  for (const { idea } of MOMENTS) {
    assert.ok(idea.side && idea.entry && idea.stop && idea.style, `incomplete idea: ${idea.headline}`);
    const d = dirOf(idea);
    const E = idea.entry!.price, stop = idea.stop!.price, risk = Math.abs(E - stop);
    assert.ok(d * (E - stop) > 0, `stop on the wrong side: ${idea.headline}`);
    assert.ok(idea.entry!.low <= idea.entry!.high);
    assert.ok(E >= idea.entry!.low - 0.011 && E <= idea.entry!.high + 0.011, 'the reference entry is outside its own zone');
    // Pips are the distance in gold pips ($0.10), from the reference entry.
    assert.ok(Math.abs(idea.stop!.pips - risk / 0.1) <= 1, `stop pips ${idea.stop!.pips} vs ${risk / 0.1}`);
    assert.ok(idea.targets.length >= 1 && idea.targets.length <= 3);
    let prev = 0;
    idea.targets.forEach((t, k) => {
      const dist = d * (t.price - E);
      assert.equal(t.label, `TP${k + 1}`);
      assert.ok(dist > prev, `targets out of order on ${idea.headline}`);
      assert.ok(Math.abs(t.pips - dist / 0.1) <= 1);
      assert.ok(Math.abs(t.r - dist / risk) <= 0.06, `R for ${t.label}: ${t.r} vs ${dist / risk}`);
      prev = dist;
    });
    assert.equal(idea.rr!.first, idea.targets[0].r);
    assert.equal(idea.rr!.best, idea.targets[idea.targets.length - 1].r);
    assert.ok(idea.confidence && ['Low', 'Medium', 'High'].includes(idea.confidence.label));
    assert.match(idea.confidence!.basis, /not a win probability/);
    assert.ok(idea.invalidation && idea.invalidation.text.length > 10);
  }
});

/* ── market structure ───────────────────────────────────────────────────────────────────────────── */

test('the structure it reads is real and still standing: confirmed swings off closed candles that price has not traded through since', () => {
  let points = 0;
  for (const { r } of MOMENTS) {
    const bars = r.state.bars, P = r.snapshot.price;
    const struct = structureOf(r.snapshot, bars, r.endedAt);
    assert.ok(struct.length >= 2, 'no structure read from a full session of candles');
    const m15 = resample(bars, '5m', '15m');
    for (const p of struct) {
      points += 1;
      assert.ok(p.t != null && (p.tf === '5m' || p.tf === '15m'));
      const t = p.t as number;
      const made = bars.find((b) => b.t === t)!;
      assert.ok(made, `${p.label} has no candle behind it`);
      assert.ok(Math.abs((p.type === 'high' ? made.h : made.l) - p.price) < 0.006, `${p.label} at ${p.price} is not that candle's ${p.type}`);
      // Confirmed on its own chart: two lower highs (higher lows) on each side.
      const series = p.tf === '15m' ? m15 : bars;
      const k = p.tf === '15m' ? series.findIndex((b) => t >= b.t && t < b.t + 3 * M5) : bars.indexOf(made);
      const own = series[k];
      assert.ok(own && Math.abs((p.type === 'high' ? own.h : own.l) - p.price) < 0.006, `${p.label} is not its ${p.tf} candle's ${p.type}`);
      for (const j of [k - 2, k - 1, k + 1, k + 2]) {
        assert.ok(series[j], `${p.label} is too close to the edge of the candles to be confirmed`);
        assert.ok(p.type === 'high' ? series[j].h < own.h : series[j].l > own.l, `${p.label} is not a swing`);
      }
      // Still standing: nothing after it has traded through it, so it is on the right side of the price.
      assert.ok(!bars.some((b) => b.t > t && (p.type === 'high' ? b.h > p.price : b.l < p.price)), `${p.label} was traded through`);
      assert.ok(p.type === 'high' ? p.price >= P : p.price <= P);
    }
    // Under the price the lows are a staircase: the nearest is the most recent, each older one is lower.
    for (const type of ['low', 'high'] as const) {
      const side = struct.filter((p) => p.type === type);
      for (let k = 1; k < side.length; k++) {
        assert.ok(side[k].t! < side[k - 1].t!, 'not newest first');
        assert.ok(type === 'low' ? side[k].price < side[k - 1].price : side[k].price > side[k - 1].price, 'an older swing nearer the price than a newer one is one price has been through');
      }
      if (side[0]) assert.match(side[0].label, new RegExp(`^the last (5|15)-minute swing ${type}$`));
      for (const p of side.slice(1)) assert.match(p.label, new RegExp(`^the (5|15)-minute swing ${type} from \\d\\d:\\d\\d UTC$`));
    }
  }
  assert.ok(points > 200);
  // No candles on hand: each timeframe's last swing from the snapshot's own structure read stands in.
  const r = MOMENTS[0].r;
  const bare = structureOf(r.snapshot, null, r.endedAt);
  assert.ok(bare.length >= 1 && bare.every((p) => p.t == null && /^the last (5-minute|15-minute|1-hour) swing (high|low)$/.test(p.label)));
  // A candle still forming is never a swing, but it can take one out.
  const bars = r.state.bars;
  const lowNow = structureOf(r.snapshot, bars, r.endedAt).find((p) => p.type === 'low')!;
  const forming: Bar = { t: bars[bars.length - 1].t + M5, o: lowNow.price + 1, h: lowNow.price + 1.2, l: lowNow.price - 0.4, c: lowNow.price + 0.8 };
  assert.ok(!structureOf(r.snapshot, [...bars, forming], r.endedAt + 60_000).some((p) => p.type === 'low' && Math.abs(p.price - lowNow.price) < 0.006), 'a swing the forming candle swept is still called standing');
});

test('the stop follows market structure: behind the last swing still standing — tight when the swing is close, with no style floor', () => {
  // Owner 11-12: "needs to go with market structure for the stop loss. It can be less then 30 pips stop."
  let swing = 0, level = 0, passedOver = 0;
  for (const { idea, r, off } of CALLS) {
    const d = dirOf(idea), E = idea.entry!.price, stop = idea.stop!.price, s = r.snapshot;
    const struct = structureOf(s, r.state.bars, r.endedAt).filter((p) => p.type === (idea.side === 'buy' ? 'low' : 'high') && d * (E - p.price) > 0);
    const buffer = bufferOf(s), floor = floorOf(s);
    assert.ok(idea.stop!.pips >= Math.floor(floor / 0.1) && idea.stop!.pips <= IDEA_RULES.MAX_STOP_PIPS, `stop ${idea.stop!.pips} pips at ${off}`);
    const fits = (price: number) => { const risk = d * (E - price) + buffer; return risk >= floor && risk <= IDEA_RULES.MAX_STOP_PIPS * 0.1; };
    const first = struct.find((p) => fits(p.price));          // nearest first: the last swing a stop can hide behind
    if (/market structure, not a fixed distance/.test(idea.stop!.what)) {
      swing += 1;
      assert.ok(first, `a swing stop with no swing behind it at ${off}`);
      // The stop is beyond that swing by the spread and the buffer — or beyond the ones packed right behind it.
      const beyond = d * (first!.price - stop);
      assert.ok(beyond >= buffer - 0.011, `the stop at ${stop} is not beyond ${first!.label} (${first!.price}) at ${off}`);
      const cluster = Math.max(IDEA_RULES.STOP_BUFFER_MIN, IDEA_RULES.STOP_CLUSTER_ATR * (s.timeframes['5m']?.features.atr ?? 0));
      if (beyond > buffer + 0.011) assert.match(idea.reasoning, /which also clears/, `the stop is ${beyond.toFixed(2)} beyond ${first!.label} without saying what else it clears`);
      else assert.ok(Math.abs(beyond - buffer) < 0.011);
      assert.ok(cluster > 0);
      assert.match(idea.reasoning, new RegExp(`My stop is [\\d,.]+, ${idea.stop!.pips} pips away — just (below|above) |so I'm using the one before it: my stop is [\\d,.]+, ${idea.stop!.pips} pips away, just (below|above) `));
      assert.match(idea.reasoning, new RegExp(`If that ${idea.side === 'buy' ? 'low' : 'high'} breaks, the structure I'm leaning on is gone and I'm wrong\\.`));
      // Any swing nearer than the one used was passed over only because a stop there would be inside the noise.
      for (const p of struct) {
        if (p === first) break;
        passedOver += 1;
        assert.ok(d * (E - p.price) + buffer < floor, `${p.label} was skipped though a stop fits behind it`);
        assert.match(idea.reasoning, /inside the noise — so I'm using the one before it/);
      }
    } else {
      // No swing at a usable distance: said, and a real level takes its place (or the range, called measured).
      level += 1;
      assert.equal(first, undefined, `a swing stood behind the entry at ${off} and the stop ignored it`);
      assert.match(idea.reasoning, /(there's no swing (low|high) (under|over) the price to lean on|the last swing (low|high) is (only )?\d+ pips)/i);
      assert.match(idea.stop!.what, /no swing (low|high|or level) stands at a usable distance behind the entry/);
      if (!/^Measured/.test(idea.stop!.what)) {
        const lv = ideaLevels(s).map((l) => l.price).concat([edgesOfRead(r.state.read).support?.price ?? NaN, edgesOfRead(r.state.read).resistance?.price ?? NaN]);
        assert.ok(lv.some((x) => d * (x - stop) > 0 && d * (x - stop) <= buffer + 0.011), `the stop at ${stop} is not just beyond a real level at ${off}`);
      }
    }
    // What it says matches what it did, and what makes it wrong is that structure.
    assert.match(idea.invalidation!.text, /the stop is [\d,.]+\.$|^The stop at /);
    assert.equal(idea.invalidation!.price, stop);
  }
  assert.ok(swing >= 20, `only ${swing} swing stops on the recording`);
  assert.ok(level >= 1 && passedOver >= 1, 'the recording should exercise the level fallback and a passed-over swing');
});

/** Closed 5-minute candles ending just before `now`, from [high, low] pairs (oldest first). */
const handBars = (now: number, hl: [number, number][]): Bar[] => hl.map(([h, l], k) => ({ t: now - (hl.length - k) * M5, o: (h + l) / 2, h, l, c: (h + l) / 2 }));
/** A quiet market at `price` with nothing ATLAS knows about nearby: no levels, a small range, no blockers. */
const quiet = (r: ReturnType<typeof replay>, price: number, atr5 = 1.2): MarketSnapshot => ({
  ...r.snapshot, price, live: undefined, spread: 0.2, levels: [], map: [], blockers: [], warnings: [],
  timeframes: Object.fromEntries(Object.entries(r.snapshot.timeframes).map(([k, v]) => [k, {
    ...v!, features: { ...v!.features, atr: k === '5m' ? atr5 : k === '15m' ? atr5 * 1.8 : v!.features.atr }, structure: { ...v!.structure, swingHigh: null, swingLow: null },
  }])),
});

test('hand-built structure: a tight stop under a close swing, a swept swing ignored, noise passed over, and no swing said plainly', () => {
  const r = MOMENTS[0].r, now = r.endedAt, P = 4000;
  const read = { ...(r.state.read as AtlasRead), lean: 'bullish_lean' as const, strength: 'clear' as const, score: 44 };
  const ask = (bars: Bar[], over: Partial<MarketSnapshot> = {}) => buildIdea(base(r, { snapshot: { ...quiet(r, P), ...over }, read, bars5m: bars, setup: noSetup('Nothing has set up.') }));

  // A staircase up: … low 3,990 (broken later? no) … the last higher low at 3,998.2, price 4,000.
  const stair: [number, number][] = [
    [3993, 3991], [3992.5, 3990.6], [3992, 3990], [3993, 3991], [3995, 3992.5],      // swing low 3,990.0
    [3997, 3994.5], [3998, 3996], [3998.5, 3996.2], [3999, 3995.6], [4000, 3997],     // swing low 3,995.6
    [4001, 3998.6], [4001.5, 3998.9], [4001.2, 3998.2], [4001.6, 3998.8], [4001.4, 3999.3], // swing low 3,998.2 (the last higher low)
  ];
  const a = ask(handBars(now, stair));
  assert.equal(a.side, 'buy'); assert.equal(a.kind, 'enter_now');
  // Buffer: the 0.20 spread plus three pips. The stop is under 30 pips and nothing pads it out to a style floor.
  assert.equal(a.stop!.price, 3997.7);
  assert.equal(a.stop!.pips, 23);
  assert.ok(a.stop!.pips < 30, 'owner: "It can be less then 30 pips stop"');
  assert.match(a.stop!.what, /^Below the last 5-minute swing low \(3,998\.20\), plus the spread — market structure, not a fixed distance\.$/);
  assert.match(a.reasoning, /My stop is 3,997\.70, 23 pips away — just below the last 5-minute swing low at 3,998\.20\. If that low breaks, the structure I'm leaning on is gone and I'm wrong\./);
  assert.match(a.say, /^I'd buy gold here, around 4,000\.00\. Stop 3,997\.70, 23 pips, below the last 5-minute swing low\. /);
  assert.ok(a.warnings.some((w) => /^That's a tight stop — 23 pips\./.test(w)), 'a tight stop is called tight');
  assert.equal(a.style, 'quick', 'the order ticket gets the style whose checks a stop that size belongs to');
  assert.ok(a.stop!.pips >= STYLE[a.style!].noiseFloorPips * 0.5 && a.stop!.pips <= STYLE[a.style!].maxStopPips, 'and those checks would take it');
  assert.equal(a.invalidation!.price, 3997.7);
  assert.match(a.poi!, /^3,998\.20 — the last 5-minute swing low, the structure the stop is behind\.$/);

  // The last swing low only 4 pips under the price: a stop there would be inside the noise, so the one before it — and it says so.
  const nearBars = stair.map(([h, l], k) => [h, k === 10 ? 3999.75 : k === 11 ? 3999.8 : k === 12 ? 3999.6 : k === 13 ? 3999.75 : k === 14 ? 3999.7 : l] as [number, number]);
  const near = ask(handBars(now, nearBars));
  assert.match(near.reasoning, /The last 5-minute swing low is only 4 pips under the price — inside the noise — so I'm using the one before it: my stop is 3,995\.10, 49 pips away, just below the 5-minute swing low from \d\d:\d\d UTC at 3,995\.60\. If that low breaks/);
  assert.equal(near.stop!.price, 3995.1);

  // The last higher low gets swept by a later candle: it is a confirmed swing, but not structure any more.
  const sweptBars = handBars(now, [...stair, [4001, 3997.9], [4001.4, 3999.3], [4001.8, 3999.5], [4001.9, 3999.4]]);
  assert.ok(!structureOf(quiet(r, P), sweptBars, now).some((p) => Math.abs(p.price - 3998.2) < 0.006), 'a swing that was traded through is still called standing');
  const swept = ask(sweptBars);
  assert.ok(!/3,998\.20/.test(swept.reasoning), 'a swing that was traded through is still being leaned on');
  // …the sweep itself made a new, lower swing low at 3,997.90, and that is the last one standing.
  assert.match(swept.reasoning, /just below the last 5-minute swing low at 3,997\.90/);
  assert.equal(swept.stop!.price, 3997.4);

  // Selling into the same staircase (the read turned down): the last lower high is what the stop hides behind — the mirror.
  const down = buildIdea(base(r, { snapshot: quiet(r, P), read: { ...read, lean: 'bearish_lean', score: -44 }, setup: noSetup('Nothing has set up.'),
    bars5m: handBars(now, stair.map(([h, l]) => [8000 - l, 8000 - h] as [number, number])) }));
  assert.equal(down.side, 'sell'); assert.equal(down.stop!.price, 4002.3); assert.equal(down.stop!.pips, 23);
  assert.match(down.reasoning, /just above the last 5-minute swing high at 4,001\.80\. If that high breaks/);

  // Gold at the low of its move: no swing low stands under the price. A real level takes its place and it says why.
  const falling: [number, number][] = Array.from({ length: 14 }, (_, k) => [4016 - k, 4014 - k] as [number, number]);
  const lv = ask(handBars(now, falling), { levels: [{ kind: 'pdl', price: 3996.5, label: "yesterday's low" } as MarketSnapshot['levels'][number]] });
  assert.match(lv.reasoning, /There's no swing low under the price to lean on, because gold is at the low of this move, so I'm using the nearest real level instead: my stop is 3,996\.00, 40 pips away, just below yesterday's low at 3,996\.50\./);
  assert.match(lv.stop!.what, /^Below yesterday's low \(3,996\.50\), plus the spread — no swing low stands at a usable distance behind the entry\.$/);
  // …and with nothing real anywhere near, the stop is a stated multiple of the range and the targets are measured — every one of them said.
  const open = ask(handBars(now, falling));
  assert.match(open.stop!.what, /^Measured: 1\.2 × the 15-minute range — no swing or level stands at a usable distance behind the entry\.$/);
  assert.match(open.reasoning, /and there's no real level at a usable distance either, so my stop is measured from the range: [\d,.]+, \d+ pips away\./);
  const atr15 = quiet(r, P).timeframes['15m']!.features.atr;
  assert.ok(Math.abs(open.stop!.pips - (IDEA_RULES.MEASURED_STOP_ATR * atr15 + bufferOf(quiet(r, P))) / 0.1) <= 1);
  assert.ok(open.targets.every((t) => t.basis === 'measured'));
  assert.deepEqual(open.targets.map((t) => t.r), [...IDEA_RULES.FALLBACK_R]);
  assert.ok(open.warnings.some((w) => /no real level to aim at/.test(w)));
  assert.match(open.reasoning, /There's no real level to aim at on this side, so my targets are multiples of the risk/);
  assert.equal(open.execute.via, 'manual'); assert.equal(open.execute.now, true);

  // Swings packed right behind the chosen one are cleared with it, and it says which.
  const lows = [3999, 3998.6, 3997.95, 3998.5, 3999, 3999.4, 3999.2, 3998.9, 3998.2, 3998.7, 3999.1, 3999.3, 3999.5];
  const packed = ask(handBars(now, lows.map((l) => [l + 2.5, l] as [number, number])));
  assert.match(packed.reasoning, /just below the 5-minute swing low from \d\d:\d\d UTC at 3,997\.95, which also clears the last 5-minute swing low at 3,998\.20\./);
  assert.equal(packed.stop!.price, 3997.45);
  assert.match(packed.stop!.what, /^Below the 5-minute swing low from \d\d:\d\d UTC \(3,997\.95\), clearing the last 5-minute swing low \(3,998\.20\), plus the spread — market structure, not a fixed distance\.$/);
});

test('every target is a real level or a swing still standing — or says plainly that it is measured, never a mix', () => {
  for (const { idea, r } of MOMENTS) {
    const e = edgesOfRead(r.state.read);
    const standing = structureOf(r.snapshot, r.state.bars, r.endedAt).map((p) => p.price);
    const real = [...ideaLevels(r.snapshot).map((l) => l.price), e.support?.price, e.resistance?.price, ...(idea.source === 'setup_engine' ? [] : standing)].filter((x): x is number => x != null);
    const isReal = (p: number) => real.some((x) => Math.abs(x - p) < 0.06);
    if (idea.source !== 'setup_engine') {
      const bases = new Set(idea.targets.map((t) => t.basis));
      assert.equal(bases.size, 1, `real and measured targets mixed on ${idea.headline}`);
      // An objective closer than one R is not an objective; each further one is at least 0.6 R beyond.
      assert.ok(idea.targets[0].r >= IDEA_RULES.MIN_R - 0.06);
      for (let k = 1; k < idea.targets.length; k++) assert.ok(idea.targets[k].r - idea.targets[k - 1].r >= IDEA_RULES.NEXT_R - 0.11);
    }
    for (const t of idea.targets) {
      if (t.basis === 'level') assert.ok(isReal(t.price), `${t.label} ${t.price} on "${idea.headline}" is not a level ATLAS has`);
      else assert.match(t.what, /risk|multiple/);
    }
  }
});

/* ── the voice ──────────────────────────────────────────────────────────────────────────────────── */

test('it reads as ATLAS speaking: what it sees, the trade, how sure — and it never claims more than it has', () => {
  // Owner 11-12: "Needs to feel like it's come right from the AI."
  for (const { idea, r, off } of CALLS) {
    const verb = idea.side === 'buy' ? 'buy' : 'sell';
    assert.match(idea.badge, /^ATLAS'S CALL · (LOW|MEDIUM|HIGH) CONVICTION$/, `badge at ${off}: ${idea.badge}`);
    assert.equal(idea.headline, `${verb.toUpperCase()} XAUUSD — enter now`);
    // Three paragraphs: what I see and my side · the trade · how sure and whose call.
    const paras = idea.reasoning.split('\n\n');
    assert.equal(paras.length, 3, `the call at ${off} is not three paragraphs`);
    assert.match(paras[0], new RegExp(`I'm a ${verb}er\\.$`), `the first paragraph does not end on the side at ${off}: ${paras[0]}`);
    assert.match(paras[1], new RegExp(`^I'd ${verb} here, around [\\d,.]+\\. `));
    assert.match(paras[1], /(First target is .+ at [\d,.]+, (\d+(\.\d)? times the risk|the same distance as the risk)|my targets are multiples of the risk)/);
    const conv = idea.confidence!.label.toLowerCase();
    assert.match(paras[2], new RegExp(`^Conviction is ${conv} — that's how one-sided my evidence is, not a win rate\\. `));
    assert.match(idea.say, new RegExp(`^I'd ${verb} gold here, around [\\d,.]+\\. Stop [\\d,.]+, \\d+ pips.*\\. First target [\\d,.]+, [\\d.]+ to one\\. (Low|Medium|High) conviction — my read, your call\\.$`));
    // First person throughout, and none of the old labels: one ATLAS, not an engine report.
    const words = wordsOf(idea);
    assert.doesNotMatch(words, /forced read|setup engine|ATLAS decides|NOT AN ENGINE-CONFIRMED|the member/i, `old wording on the call at ${off}`);
    assert.doesNotMatch(words, /\b(Quick|Intraday|QUICK|HOLD|SWING|INTRADAY)\b/, `a style name on the call at ${off}`);
    assert.doesNotMatch(idea.reasoning, /ATLAS('s)? (thinks|sees|would|is|has)/, 'it talks about itself in the third person');
    // It says, in the same breath, that this is its read and not a confirmed setup — or exactly why nothing can be opened.
    assert.match(paras[2], /It isn't one of my confirmed setups( yet)?, so I'm not taking it myself — taking it is your call\.|my order checks won't open a trade — mine or yours\. So this is my read for you to weigh, not something I can put on\.|so I'm not taking this one myself — it's my read, and taking it is your call\./);
    // Conviction is the evidence, not a promotion.
    const sc = idea.confidence!.score;
    assert.equal(idea.confidence!.label, sc >= 55 ? 'High' : sc >= 30 ? 'Medium' : 'Low');
    // Never taken as ATLAS's own trade: executing is the member's decision through the order ticket.
    assert.notEqual(idea.execute.via, 'take_setup'); assert.equal(idea.execute.approved, null);
    assert.equal(idea.execute.manual!.stop, idea.stop!.price); assert.equal(idea.execute.manual!.takeProfit, idea.targets[0].price);
    assert.equal(idea.execute.manual!.style, idea.style);
    assert.equal(idea.engine.state, r.state.setup.state, 'the setup engine\'s own verdict rides along unchanged');
    assert.equal(idea.expiresAt, r.endedAt + (idea.source === 'read_plan' ? IDEA_RULES.PLAN_TTL_MS : IDEA_RULES.FORCED_TTL_MS));
    // The copy says what it is wherever it is pasted.
    assert.match(ideaText(idea), new RegExp(`^ATLAS · XAUUSD ${verb.toUpperCase()} · ATLAS's call, ${conv} conviction — a read, not a confirmed setup\\nEntry: [\\d,.]+ \\(market\\)\\nStop: `));
    // What it lists as "for" is for ITS side.
    const read = r.state.read!;
    const forDir = read.lean === 'bullish_lean' ? 1 : read.lean === 'bearish_lean' ? -1 : read.score >= 0 ? 1 : -1;
    const mine = dirOf(idea) === forDir ? read.evidenceFor : read.evidenceAgainst;
    assert.deepEqual(idea.confirmations.filter((c) => c.ok).map((c) => c.label), mine.slice(0, 5).map((x) => x.text));
    // The read's own two levels still say where the picture would be decided.
    const e = edgesOfRead(read);
    if (e.support && e.resistance && e.support.price < e.resistance.price) {
      assert.equal(idea.paths.length, 2);
      assert.equal(idea.paths.find((p) => p.side === 'buy')!.price, +e.resistance.price.toFixed(2));
      assert.equal(idea.paths.find((p) => p.side === 'sell')!.price, +e.support.price.toFixed(2));
    }
  }
  // A clear or strong lean is what makes it a "read_plan"; anything fainter is a "forced_read". One badge for both.
  for (const { idea, r } of CALLS) {
    const read = r.state.read!;
    const clear = (read.lean === 'bullish_lean' || read.lean === 'bearish_lean') && (read.strength === 'clear' || read.strength === 'strong');
    if (idea.source === 'read_plan') { assert.ok(clear && !r.snapshot.blockers.length); assert.equal(idea.side, read.lean === 'bullish_lean' ? 'buy' : 'sell'); }
    if (r.snapshot.blockers.length) assert.equal(idea.source, 'forced_read');
  }
  // Mid-sentence, an acronym keeps its capitals and "I" stays "I".
  const rr = CALLS[0].r, rd = rr.state.read as AtlasRead;
  const rsi = buildIdea(base(rr, { read: { ...rd, lean: 'transitioning', strength: null, score: 9, evidenceFor: rd.evidenceFor, evidenceAgainst: [{ ...(rd.evidenceAgainst[0] ?? rd.evidenceFor[0]), text: 'RSI 15m 75, 5m 29' }] }, setup: { ...noSetup('Building a long.', [], 'setup_developing', rr.endedAt), side: 'buy' } }));
  assert.match(rsi.reasoning, /What argues against it: RSI 15m 75, 5m 29\./);
  assert.match(rsi.reasoning, /Until that happens: I don't hold a lean right now, but I'm already building a long here/);
  assert.equal(sayLevel('new york high'), 'the New York high');
  assert.equal(sayLevel('london low'), 'the London low');
  assert.equal(sayLevel("yesterday's low"), "yesterday's low");
  assert.equal(sayLevel('daily open'), 'the daily open');
  assert.equal(sayLevel('4h swing high (Thu, 09/17) · 1h swing high (Thu, 09/17)'), 'the 4-hour swing high from Thu 09/17');
  assert.equal(sayLevel('the last 5-minute swing low'), 'the last 5-minute swing low');
  assert.equal(sayLevel('resistance'), "the resistance I'm watching");
});

test('a call\'s stop and target would pass ATLAS\'s own order checks — nothing about those checks changed', () => {
  for (const { idea, off } of CALLS) {
    const st = STYLE[idea.execute.manual!.style];
    // engines/validator.ts: a stop under half the style's noise floor is refused; over its ceiling is refused.
    assert.ok(idea.stop!.pips >= st.noiseFloorPips * 0.5, `the ${idea.stop!.pips}-pip stop at ${off} is inside the noise of a ${st.label} trade`);
    assert.ok(idea.stop!.pips <= st.maxStopPips, `the ${idea.stop!.pips}-pip stop at ${off} is wider than ${st.label} allows`);
  }
  const validator = readFileSync('command-center/engines/validator.ts', 'utf8');
  assert.match(validator, /const gate = tradeable\(i\.snapshot\);\s*\n\s*if \(!gate\.ok\) return no\(gate\.reason\);/, 'the market gate is still the first thing the order checks ask');
  assert.match(validator, /if \(stopPips < floor \* 0\.5\)/);
});

test('which side: its lean, then the trade it is already building, then the tilt of the evidence, then structure — deterministically', () => {
  const r = MOMENTS[0].r;
  const read = (over: Partial<AtlasRead>): AtlasRead => ({ ...(r.state.read as AtlasRead), ...over });
  // 1 — a lean, however faint.
  assert.equal(forcedSide(read({ lean: 'bearish_lean', strength: 'slight', score: -17 }), r.snapshot).side, 'sell');
  const lean = forcedSide(read({ lean: 'bullish_lean', strength: 'slight', score: 19 }), r.snapshot);
  assert.deepEqual([lean.side, lean.from, lean.score], ['buy', 'lean', 19]);
  assert.equal(lean.basis, "It's only a slight lean — +19 of 100 on my evidence balance — but it's up, so I'm a buyer");
  assert.equal(forcedSide(read({ lean: 'bearish_lean', strength: 'clear', score: -41 }), r.snapshot).basis, "That's a clear lean — -41 of 100 on my evidence balance — so I'm a seller");
  // …and a lean outranks the setup engine's side: the read is what ATLAS sees.
  assert.equal(forcedSide(read({ lean: 'bearish_lean', strength: 'clear', score: -41 }), r.snapshot, { side: 'buy', state: 'watching' }).side, 'sell');
  // 2 — no lean, and the setup engine is already building or watching a trade: one ATLAS, one side.
  const building = forcedSide(read({ lean: 'balanced', strength: null, score: -15 }), r.snapshot, { side: 'buy', state: 'setup_developing' });
  assert.deepEqual([building.side, building.from, building.score], ['buy', 'setup', 0], 'evidence on the other side is not counted as conviction');
  assert.equal(building.basis, "I don't hold a lean right now, but I'm already building a long here — it isn't confirmed yet — so that's my side: I'm a buyer");
  const watching = forcedSide(read({ lean: 'balanced', strength: null, score: -22 }), r.snapshot, { side: 'sell', state: 'watching' });
  assert.deepEqual([watching.side, watching.from, watching.score], ['sell', 'setup', 22]);
  assert.match(watching.basis, /I'm already watching a short here/);
  // A blocked or empty setup engine has no side to follow.
  assert.equal(forcedSide(read({ lean: 'balanced', strength: null, score: -12 }), r.snapshot, { side: 'buy', state: 'blocked' }).from, 'evidence');
  assert.equal(forcedSide(read({ lean: 'balanced', strength: null, score: -12 }), r.snapshot, { side: null, state: 'watching' }).from, 'evidence');
  // 3 — neither: the sign of the evidence balance.
  const tilt = forcedSide(read({ lean: 'balanced', strength: null, score: -12 }), r.snapshot);
  assert.deepEqual([tilt.side, tilt.from, tilt.score], ['sell', 'evidence', 12]);
  assert.equal(tilt.basis, "The balance of what I see tilts down — -12 of 100, short of what I'd call a lean — so right now I'm a seller");
  assert.equal(forcedSide(read({ lean: 'transitioning', strength: null, score: 8 }), r.snapshot).side, 'buy');
  // Big enough to be a lean but not yet held over a second candle: it does not call that "short of a lean".
  const justTilted = forcedSide(read({ lean: 'balanced', strength: null, score: -37 }), r.snapshot);
  assert.deepEqual([justTilted.side, justTilted.from, justTilted.score], ['sell', 'evidence', 37]);
  assert.equal(justTilted.basis, "The balance of what I see has just tilted down — -37 of 100 — and I'd normally want one more closed candle before I call that a lean, but right now I'm a seller");
  // 4 — no usable read, or a dead-even one: the structure the snapshot measured.
  const tf = (sequence: 'HH_HL' | 'LH_LL' | 'mixed', slope = 0) => ({ ...r.snapshot.timeframes['15m']!, features: { ...r.snapshot.timeframes['15m']!.features, slope, rsi: 50 }, structure: { ...r.snapshot.timeframes['15m']!.structure, sequence } });
  const snap = (over: Partial<MarketSnapshot>): MarketSnapshot => ({ ...r.snapshot, live: undefined, pressure: { ...r.snapshot.pressure, net: 0 }, timeframes: { '15m': tf('mixed'), '1h': tf('mixed') }, levels: [], map: [], ...over });
  const down = forcedSide(null, snap({ timeframes: { '15m': tf('mixed'), '1h': tf('LH_LL') } }));
  assert.deepEqual([down.side, down.from], ['sell', 'structure']); assert.match(down.basis, /the 1-hour is making lower highs and lower lows/);
  assert.ok(down.score < 30);
  assert.equal(forcedSide(null, snap({ timeframes: { '15m': tf('HH_HL'), '1h': tf('mixed') } })).side, 'buy');
  assert.equal(forcedSide(null, snap({ timeframes: { '15m': tf('mixed', -0.4), '1h': tf('mixed') } })).side, 'sell', 'a slope when there is no swing sequence');
  assert.equal(forcedSide(null, snap({ pressure: { ...r.snapshot.pressure, net: 22 } })).side, 'buy', 'then the pressure proxy');
  // A dead heat: the daily open, then the 15-minute RSI, then a stated default — never a coin.
  const P = r.snapshot.price;
  const openBelow = forcedSide(null, snap({ levels: [{ kind: 'daily_open', price: P - 5, label: 'daily open' } as MarketSnapshot['levels'][number]] }));
  assert.equal(openBelow.side, 'buy'); assert.match(openBelow.basis, /price is above the daily open/);
  assert.equal(forcedSide(null, snap({ levels: [{ kind: 'daily_open', price: P + 5, label: 'daily open' } as MarketSnapshot['levels'][number]] })).side, 'sell');
  const rsi = (v: number) => ({ ...tf('mixed'), features: { ...tf('mixed').features, rsi: v } });
  assert.equal(forcedSide(null, snap({ timeframes: { '15m': rsi(41), '1h': tf('mixed') } })).side, 'sell');
  const dead = forcedSide(null, snap({}));
  assert.equal(dead.side, 'buy'); assert.match(dead.basis, /nothing I can measure separates the two sides, and I default to the long side/);
  assert.match(forcedSide(read({ lean: 'balanced', strength: null, score: 0.2 }), snap({})).basis, /^My read is dead even/);
  // The same inputs, the same side — and on the recording every call trades the side this names.
  for (const m of MOMENTS) assert.deepEqual(forcedSide(m.r.state.read, m.r.snapshot, m.r.state.setup), forcedSide(m.r.state.read, m.r.snapshot, m.r.state.setup));
  let fromSetup = 0;
  for (const { idea, r: rr } of CALLS) {
    const f = forcedSide(rr.state.read, rr.snapshot, rr.state.setup);
    assert.equal(idea.side, f.side);
    if (f.from === 'setup') { fromSetup += 1; assert.equal(idea.side, rr.state.setup.side, 'the call and the trade card disagree'); assert.match(idea.reasoning, /I'm already (watching|building) a (long|short) here/); }
    // Where the read holds no lean, the call never sells while the trade card is building a long (or the reverse).
    const su = rr.state.setup, read = rr.state.read!;
    if (su.side && ['setup_developing', 'watching'].includes(su.state) && read.lean !== 'bullish_lean' && read.lean !== 'bearish_lean') assert.equal(idea.side, su.side);
  }
  assert.ok(fromSetup >= 1, 'the recording should exercise a call that follows the setup engine\'s side');
  // A lean against the setup it is watching is said, not hidden.
  const m = MOMENTS.find((x) => x.r.state.setup.side && x.r.state.read && (x.r.state.read.lean === 'bullish_lean' || x.r.state.read.lean === 'bearish_lean'))?.r ?? r;
  const leanDown = { ...(m.state.read as AtlasRead), lean: 'bearish_lean' as const, strength: 'clear' as const, score: -40 };
  const against = buildIdea(base(m, { read: leanDown, setup: { ...noSetup('Watching a long.', [], 'watching', m.endedAt), side: 'buy' } }));
  assert.equal(against.side, 'sell');
  assert.match(against.reasoning, /And on the five-minute chart I'm watching a long at the same time, so the short-term picture disagrees with this lean\.$/);
});

test('when the setup engine has a trade ready, the idea is that trade number for number — its own stop, unchanged', () => {
  const ready = MOMENTS.filter((m) => m.r.state.setup.state === 'trade_ready');
  assert.ok(ready.length >= 1, 'the recording has no ready setup to test against');
  for (const { idea, r } of ready) {
    const su = r.state.setup;
    assert.equal(idea.kind, 'enter_now'); assert.equal(idea.source, 'setup_engine');
    assert.equal(idea.side, su.side); assert.equal(idea.style, su.style);
    assert.equal(idea.stop!.price, su.stop);
    assert.equal(idea.targets[0].price, su.initialObjective);
    if (idea.targets[1]) assert.equal(idea.targets[1].price, su.extendedObjective);
    assert.equal(idea.entry!.type, 'market');
    assert.equal(idea.entry!.low, su.entryLow); assert.equal(idea.entry!.high, su.entryHigh);
    assert.equal(idea.confidence!.score, su.confidence);
    assert.equal(idea.expiresAt, su.expiresAt);
    // It is taken as ATLAS's own trade: the approval is exactly what take-setup compares against.
    assert.equal(idea.execute.via, 'take_setup'); assert.equal(idea.execute.now, true);
    assert.deepEqual(idea.execute.approved, { side: su.side, style: su.style, stop: su.stop, invalidationPrice: su.invalidationPrice });
    assert.deepEqual(idea.confirmations.map((c) => [c.label, c.ok]), su.conditions.map((c) => [c.text, c.met]));
    // The same voice: it says this one is confirmed, and that it would take it itself.
    assert.equal(idea.badge, "ATLAS'S CALL · CONFIRMED SETUP");
    const paras = idea.reasoning.split('\n\n');
    assert.equal(paras[0], su.thesis);
    assert.match(paras[1], new RegExp(`^This is one of my confirmed setups — every condition I need is met — so it's a trade I'd take myself\\. I'd ${su.side} here, around `));
    assert.match(idea.say, /It's one of my confirmed setups — I'd take this one myself\.$/);
    assert.match(ideaText(idea), /^ATLAS · XAUUSD (BUY|SELL) · confirmed setup\n/);
    assert.doesNotMatch(wordsOf(idea), /setup engine|SETUP ENGINE|intraday trade|\bQUICK\b|\bHOLD\b/);
    // When the server could not recompute it as ATLAS's own, it is the member's call instead.
    const mine = buildIdea(base(r, { takeable: false }));
    assert.equal(mine.execute.via, 'manual'); assert.equal(mine.execute.approved, null);
    assert.deepEqual(mine.execute.manual, { side: su.side, style: su.style, stop: su.stop, takeProfit: su.initialObjective });
  }
  // The setup engine itself is untouched by any of this.
  const setupSrc = readFileSync('command-center/engines/setup.ts', 'utf8');
  assert.doesNotMatch(setupSrc, /from\s+["']\.\/idea/);
});

test('the only answer with no trade is NO MARKET DATA; closed, stale, doubtful and flagged markets still get a call that says where it stands', () => {
  const r = MOMENTS.find((m) => m.idea.source === 'read_plan')!.r;
  const trade = (x: AtlasIdea) => { assert.ok(x.side && x.entry && x.stop && x.targets.length >= 1, x.headline); assert.equal(x.source, 'forced_read'); assert.equal(x.execute.approved, null); };

  // Nothing to read at all: no number is invented.
  const none = buildIdea(base(r, { snapshot: null }));
  assert.equal(none.kind, 'stand_aside'); assert.equal(none.badge, 'NO MARKET DATA'); assert.equal(none.price, null);
  assert.equal(none.entry, null); assert.equal(none.execute.via, null); assert.match(none.reasoning, /won't invent a price/);
  const noRange = buildIdea(base(r, { snapshot: { ...r.snapshot, timeframes: {} } }));
  assert.equal(noRange.kind, 'stand_aside'); assert.match(noRange.reasoning, /nothing to size an entry or a stop from — and I won't invent one/);

  // Gold closed: the side and the levels from the last session, as a plan for the reopen. Nothing can be sent.
  const closed = buildIdea(base(r, { marketOpen: false }));
  trade(closed);
  assert.equal(closed.badge, "ATLAS'S CALL · GOLD IS CLOSED · FOR THE REOPEN");
  assert.match(closed.reasoning, /Gold is closed, so this is my plan for the reopen, built on the last session's prices — there's nothing to enter yet\./);
  assert.match(closed.reasoning, /From the last price, [\d,.]+, I'd (buy|sell) inside [\d,.]+–[\d,.]+\. /);
  assert.equal(closed.execute.via, null); assert.equal(closed.execute.now, false); assert.equal(closed.watch, null);
  assert.notEqual(closed.kind, 'enter_now', 'a closed market is never an entry now');
  assert.equal(closed.expiresAt, r.endedAt + IDEA_RULES.FORCED_CLOSED_TTL_MS, 'it waits for the reopen');
  // Every figure is measured from the worst price in the zone.
  assert.equal(closed.entry!.price, closed.side === 'buy' ? closed.entry!.high : closed.entry!.low);
  const closedBlocker = buildIdea(base(r, { snapshot: { ...r.snapshot, blockers: [{ code: 'market_closed', detail: 'Gold is closed' }] } }));
  trade(closedBlocker); assert.equal(closedBlocker.execute.via, null);

  // A market read too old to enter from.
  const stale = buildIdea(base(r, { stale: true, now: r.endedAt + 9 * 60_000 }));
  trade(stale);
  assert.match(stale.reasoning, /My last look at the market was 9 minutes ago, so check the price before you act on any of this\./);
  assert.equal(stale.badge, "ATLAS'S CALL · FROM MY LAST CLEAN READ");
  assert.equal(stale.execute.via, null); assert.notEqual(stale.kind, 'enter_now');

  // The data itself in doubt.
  const doubt = buildIdea(base(r, { snapshot: { ...r.snapshot, blockers: [{ code: 'feed_stale', detail: 'The price feed is stale' }] } }));
  trade(doubt);
  assert.match(doubt.reasoning, /My price data has a problem right now \(the price feed is stale\), so treat these levels as approximate\./);
  assert.equal(doubt.execute.via, null);
  assert.match(doubt.execute.note, /My market data is in doubt, so nothing is sent from it/);

  // The market flagged chaotic (the owner's screenshot: "Market is chaotic — no strategy is eligible"): it
  // still names a side and a trade — and says plainly that the order checks will not open one while the flag is up.
  const chaoticSnap: MarketSnapshot = { ...r.snapshot, blockers: [{ code: 'chaotic', detail: 'Market is chaotic — no strategy is eligible' }], warnings: ['Market is chaotic — no strategy is eligible'] };
  const chaotic = buildIdea(base(r, { snapshot: chaoticSnap, setup: noSetup("I'm standing down: Market is chaotic — no strategy is eligible.", [], 'blocked', r.endedAt) }));
  trade(chaotic);
  assert.equal(chaotic.kind, 'enter_now');
  assert.match(chaotic.badge, /^ATLAS'S CALL · (LOW|MEDIUM|HIGH) CONVICTION$/);
  assert.match(chaotic.reasoning, /I have the market flagged as chaotic right now, and while that flag is up my order checks won't open a trade — mine or yours\. So this is my read for you to weigh, not something I can put on\./);
  assert.equal(tradeable(chaoticSnap).ok, false, 'the order checks really do refuse on this snapshot — the call must not offer a ticket they would turn down');
  assert.equal(chaotic.execute.via, null); assert.equal(chaotic.execute.now, false);
  assert.match(chaotic.execute.note, /^No ticket for this one: while I have the market flagged as chaotic, my order checks don't open trades\. Generate again when it clears\.$/);
  assert.ok(!chaotic.warnings.includes('Market is chaotic — no strategy is eligible'), 'the flag is said once, in the call, not repeated as a warning');
  assert.equal(chaotic.engine.state, 'blocked', 'the setup engine\'s own verdict rides along, unchanged');
  assert.ok(!/that to clear|standing aside|STANDING ASIDE/i.test(JSON.stringify({ ...chaotic, engine: null })), 'the old stand-aside wording is gone');
  // …and on the recording, every flagged moment behaves the same way.
  const flagged = MOMENTS.filter((m) => m.r.snapshot.blockers.some((b) => b.code === 'chaotic'));
  assert.ok(flagged.length >= 3);
  for (const m of flagged) { assert.ok(m.idea.side && m.idea.stop); assert.equal(m.idea.execute.via, null); assert.equal(tradeable(m.r.snapshot).ok, false); }
  for (const m of CALLS.filter((x) => !x.r.snapshot.blockers.length)) { assert.equal(m.idea.execute.via, 'manual'); assert.equal(m.idea.execute.now, true); assert.equal(tradeable(m.r.snapshot).ok, true); }

  // The setup engine blocked for its own reason (no market blocker): the ticket is still the member's to open.
  const blocked = buildIdea(base(r, { setup: noSetup('The daily loss limit has been reached.', [], 'blocked', r.endedAt) }));
  trade(blocked);
  assert.match(blocked.reasoning, /My own trading is standing down right now \(the daily loss limit has been reached\), so I'm not taking this one myself — it's my read, and taking it is your call\./);
  assert.equal(blocked.execute.via, 'manual');

  // No read at all: the side comes from the structure the snapshot measured, and says so.
  const noRead = buildIdea(base(r, { read: null, setup: noSetup('Nothing has set up.', ['a level to break']) }));
  trade(noRead);
  assert.match(noRead.reasoning, /^I don't have a clean directional read right now, so I'm going off the structure I can measure: /);
  assert.match(noRead.confidence!.basis, /^No directional read behind this one/);
  assert.ok(noRead.confidence!.score < 30, 'a count of structure is never called a lean');
});

test('a call is graded as a trade from where it was priced, on its own clock', () => {
  const m = CALLS.find((x) => x.idea.targets.length >= 1 && x.idea.source === 'forced_read')!;
  const idea = m.idea, up = idea.side === 'buy', E = idea.entry!.price, tp = idea.targets[0].price, stop = idea.stop!.price, t0 = Math.ceil(idea.at / M5) * M5;
  const bar = (k: number, a: number, b: number): Bar => ({ t: t0 + k * M5, o: a, h: Math.max(a, b) + 0.02, l: Math.min(a, b) - 0.02, c: b });
  const mid = (E + tp) / 2;
  // The lean flips against it straight away: a call from a tilt is still graded as a trade, not cancelled.
  const leans = [{ at: idea.at - M5, lean: 'balanced' }, { at: t0 + M5, lean: up ? 'bearish_lean' : 'bullish_lean' }];
  const won = followIdea(idea, { price: tp, bars: [bar(0, E, mid), bar(1, mid, tp + (up ? 0.3 : -0.3))], tf: '5m', now: t0 + 2 * M5, leans });
  assert.equal(won.state, 'tp1', won.text); assert.deepEqual(won.entered, { at: idea.at, price: E });
  const lost = followIdea(idea, { price: stop, bars: [bar(0, E, (E + stop) / 2), bar(1, (E + stop) / 2, stop + (up ? -0.3 : 0.3))], tf: '5m', now: t0 + 2 * M5, leans });
  assert.equal(lost.state, 'stopped'); assert.equal(lost.pips, -idea.stop!.pips);
  // Untouched and unmoved: still there to take. Sitting past its life: expired.
  assert.equal(followIdea(idea, { price: E, bars: [], tf: '5m', now: idea.at + 60_000 }).state, 'ready');
  assert.equal(followIdea(idea, { price: E, bars: [], tf: '5m', now: idea.expiresAt! + 1 }).state, 'expired');
});

/* ── the setup engine's waiting states (hand-built: the recording has none) ─────────────────────── */

const waiting = (r: ReturnType<typeof replay>, over: Partial<BrainSetup>): BrainSetup => {
  const p = r.snapshot.price;
  return {
    state: 'waiting_for_trigger', side: 'buy', style: 'hold', strategy: 'trend_pullback', styleWhy: 'The 15m and 1h structure is carrying this.',
    entryLow: +(p - 0.6).toFixed(2), entryHigh: +p.toFixed(2), stop: +(p - 9).toFixed(2), initialObjective: +(p + 14).toFixed(2), extendedObjective: +(p + 26).toFixed(2),
    stopPips: 90, expectedMovePips: [140, 260], conditions: [], metCount: 0, totalCount: 0, confidence: 62,
    thesis: 'Pullback into trend. 15m is still making higher lows.', invalidation: `A close back below ${(p - 6).toFixed(2)} with bearish pressure expanding.`,
    invalidationPrice: +(p - 6).toFixed(2), waitingFor: [], say: 'Everything is in place except the trigger.', headline: 'WAITING FOR TRIGGER',
    blockedBy: null, expiresAt: r.endedAt + 90 * 60_000, at: r.endedAt, ...over,
  };
};

test('waiting on a break trigger: the entry is the trigger, re-priced from it, and nothing is executable yet', () => {
  const r = MOMENTS[0].r, p = r.snapshot.price;
  const trig = +(p + 4).toFixed(2);
  const su = waiting(r, { conditions: [
    { id: 'pivot', text: `Hold above ${(p - 6).toFixed(2)}`, met: true, detail: '', trigger: false },
    { id: 'trigger', text: `Break ${trig.toFixed(2)}`, met: false, detail: '40 pips away.', trigger: true },
  ] });
  const idea = buildIdea(base(r, { setup: su }));
  assert.equal(idea.kind, 'on_break'); assert.equal(idea.source, 'setup_engine');
  assert.equal(idea.entry!.price, trig); assert.equal(idea.entry!.confirm, 'touch'); assert.equal(idea.entry!.type, 'stop');
  assert.equal(idea.stop!.price, su.stop);
  assert.equal(idea.stop!.pips, Math.round((trig - su.stop!) / 0.1));
  assert.equal(idea.execute.via, null); assert.equal(idea.execute.now, false);
  assert.deepEqual(idea.watch, { price: trig, direction: 'above', say: `Watch ${trig.toFixed(2)} and tell me if it breaks above.` });
  assert.ok(idea.targets[0].r >= 1 - 0.06);
  assert.equal(idea.badge, "ATLAS'S CALL · WAITING ON THE BREAK");
  assert.match(idea.say, /Everything else I need is in place — I'm only waiting on that break\.$/);
  assert.doesNotMatch(idea.reasoning + idea.say + idea.execute.note, /setup engine|ATLAS re-prices/);
});

test('ready on the conditions but short on confidence: said plainly, and only ever the member\'s own call', () => {
  const r = MOMENTS[0].r;
  const su = waiting(r, { confidence: 48, conditions: [{ id: 'pivot', text: 'Hold above the level', met: true, detail: '', trigger: false }, { id: 'trigger', text: 'Entry is still close to the level', met: true, detail: '', trigger: true }] });
  const idea = buildIdea(base(r, { setup: su, minConfidence: 55 }));
  assert.equal(idea.kind, 'on_confirmation');
  assert.match(idea.entry!.text, /confidence is 48/);
  assert.equal(idea.execute.via, 'manual'); assert.equal(idea.execute.approved, null);
  assert.match(idea.execute.note, /^I haven't confirmed this one, so taking it is your call\./);
  assert.equal(idea.badge, "ATLAS'S CALL · NOT CONFIRMED YET");
});

/* ── following an idea on real candles ──────────────────────────────────────────────────────────── */

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
const plan = (over: Partial<AtlasIdea> = {}): AtlasIdea => ({
  version: ATLAS_IDEA_VERSION, id: 'x', at: T0, snapshotAt: T0, snapshotId: 1, options: { style: 'auto' },
  kind: 'at_level', source: 'read_plan', side: 'buy', style: 'hold', strategy: 'Pullback into the lean',
  headline: 'BUY the pullback to 4,000.00', badge: 'PLAN', price: 4012,
  entry: { type: 'limit', price: 4002, low: 4000, high: 4002, level: { price: 4000, label: 'london low' }, trigger: null, confirm: 'none', text: '', distancePips: 100 },
  stop: { price: 3994, pips: 80, what: '' },
  targets: [
    { label: 'TP1', price: 4012, pips: 100, r: 1.3, basis: 'level', what: 'a' },
    { label: 'TP2', price: 4020, pips: 180, r: 2.3, basis: 'level', what: 'b' },
  ],
  rr: { first: 1.3, best: 2.3 }, confidence: { score: 40, label: 'Medium', basis: 'not a win probability' },
  reasoning: '', bias: null, poi: null, targeting: null, invalidation: { text: 'A 15-minute close below 4,000.00', price: 4000 },
  confirmations: [], waitingFor: [], engine: { state: 'no_setup', headline: 'NO TRADE', say: '' }, alternative: null, paths: [], warnings: [],
  expiresAt: T0 + 4 * 3600_000,
  execute: { via: 'manual', now: false, note: '', approved: null, manual: { side: 'buy', style: 'hold', stop: 3994, takeProfit: 4012 } },
  watch: { price: 4002, direction: 'below', say: 'Watch 4002.00 and tell me when price reaches it.' }, say: '', ...over,
});
/** Five-minute candles from T0, each [open, high, low, close]. */
const candles = (rows: number[][], from = T0): Bar[] => rows.map(([o, h, l, c], k) => ({ t: from + k * M5, o, h, l, c }));
const at = (n: number) => T0 + n * M5;

test('a level entry: not entered until price reaches the zone, then the first target before the stop is the result', () => {
  const idea = plan();
  const waitingBars = candles([[4012, 4014, 4008, 4010], [4010, 4011, 4004, 4005]]);
  const w = followIdea(idea, { price: 4005, bars: waitingBars, tf: '5m', now: at(2) });
  assert.equal(w.state, 'waiting'); assert.equal(w.entered, null); assert.equal(w.canExecute, false);
  assert.match(w.text, /30 pips away/);

  const inZone = followIdea(idea, { price: 4001.2, bars: waitingBars, tf: '5m', now: at(2) });
  assert.equal(inZone.state, 'in_zone'); assert.equal(inZone.canExecute, true);

  const win = followIdea(idea, { price: 4013, tf: '5m', now: at(5), bars: candles([
    [4012, 4014, 4008, 4010], [4010, 4011, 4001, 4003], [4003, 4008, 4002.5, 4007], [4007, 4012.5, 4006, 4012], [4012, 4014, 4011, 4013],
  ]) });
  assert.equal(win.state, 'tp1'); assert.equal(win.reached, 1); assert.equal(win.pips, 100);
  assert.deepEqual(win.entered, { at: at(1), price: 4002 });
  assert.match(win.basis, /5 closed 5-minute candles/);

  const loss = followIdea(idea, { price: 3990, tf: '5m', now: at(4), bars: candles([
    [4012, 4014, 4008, 4010], [4010, 4011, 4001, 4003], [4003, 4004, 3993, 3995], [3995, 3996, 3989, 3990],
  ]) });
  assert.equal(loss.state, 'stopped'); assert.equal(loss.pips, -80); assert.equal(loss.stopped, true);
});

test('grading is conservative: the forming candle is not read, the entry candle only checks the stop, and the stop wins a tie', () => {
  const idea = plan();
  // A candle that opened BEFORE the idea reached the zone and the target: it is not read at all.
  const before = followIdea(idea, { price: 4010, tf: '5m', now: at(1), bars: [{ t: T0 - M5, o: 4010, h: 4013, l: 4001, c: 4010 }, { t: T0, o: 4010, h: 4011, l: 4008, c: 4010 }] });
  assert.equal(before.state, 'waiting');
  // The entry candle spans the target as well: its high may have come first, so it does not count.
  const sameBar = followIdea(idea, { price: 4006, tf: '5m', now: at(1), bars: candles([[4010, 4013, 4001, 4006]]) });
  assert.equal(sameBar.state, 'open'); assert.equal(sameBar.reached, 0);
  // The entry candle spans the stop: counted, because it cannot be ruled out.
  const entryStop = followIdea(idea, { price: 3996, tf: '5m', now: at(1), bars: candles([[4010, 4011, 3993, 3996]]) });
  assert.equal(entryStop.state, 'stopped');
  // A later candle spans both the stop and the target: the stop counts.
  const tie = followIdea(idea, { price: 4010, tf: '5m', now: at(2), bars: candles([[4010, 4011, 4001, 4003], [4003, 4013, 3993, 4010]]) });
  assert.equal(tie.state, 'stopped'); assert.equal(tie.pips, -80);
  // A candle still forming at `now` is not read either.
  const forming = followIdea(idea, { price: 4005, tf: '5m', now: at(1) + 60_000, bars: candles([[4010, 4011, 4004, 4005], [4005, 4005, 3990, 3991]]) });
  assert.equal(forming.state, 'waiting');
});

test('a break needs a 15-minute candle to CLOSE through the level — a five-minute poke is not an entry', () => {
  const brk = plan({
    kind: 'on_break', headline: 'BUY a 15-minute close above 4,020.00',
    entry: { type: 'stop', price: 4022, low: 4020, high: 4022, level: { price: 4020, label: 'new york high' }, trigger: 'A 15-minute close above 4,020.00', confirm: 'close_15m', text: '', distancePips: 80 },
    stop: { price: 4014, pips: 80, what: '' }, invalidation: { text: 'A 15-minute close below 4,000.00', price: 4000 },
    targets: [{ label: 'TP1', price: 4032, pips: 100, r: 1.3, basis: 'level', what: 'a' }],
  });
  // 12:00, 12:05, 12:10 → the 15-minute candle closes at 12:15 with the 12:10 close.
  const poke = followIdea(brk, { price: 4018, tf: '5m', now: at(3), bars: candles([[4012, 4016, 4011, 4015], [4015, 4023, 4014, 4021], [4021, 4022, 4017, 4018]]) });
  assert.equal(poke.state, 'waiting'); assert.equal(poke.entered, null);
  const closed = followIdea(brk, { price: 4021.5, tf: '5m', now: at(3), bars: candles([[4012, 4016, 4011, 4015], [4015, 4019, 4014, 4018], [4018, 4022, 4017, 4021.5]]) });
  assert.equal(closed.state, 'open'); assert.deepEqual(closed.entered, { at: at(3), price: 4021.5 });
  // A close far beyond the zone is not chased: the entry is the retest.
  const far = followIdea(brk, { price: 4029, tf: '5m', now: at(3), bars: candles([[4012, 4016, 4011, 4015], [4015, 4024, 4014, 4023], [4023, 4030, 4022.5, 4029]]) });
  assert.equal(far.state, 'waiting'); assert.match(far.text, /retest/);
  const retest = followIdea(brk, { price: 4026, tf: '5m', now: at(5), bars: candles([[4012, 4016, 4011, 4015], [4015, 4024, 4014, 4023], [4023, 4030, 4022.5, 4029], [4029, 4030, 4021.5, 4024], [4024, 4027, 4023, 4026]]) });
  assert.equal(retest.state, 'open'); assert.deepEqual(retest.entered, { at: at(3), price: 4022 });
  // A 15-minute close through the invalidation first: the idea is off.
  const dead = followIdea(brk, { price: 3997, tf: '5m', now: at(3), bars: candles([[4012, 4013, 4004, 4005], [4005, 4006, 3999, 4000], [4000, 4001, 3996, 3997]]) });
  assert.equal(dead.state, 'invalidated');
  // The setup engine's own trigger is price trading through it.
  const touch = followIdea({ ...brk, source: 'setup_engine', entry: { ...brk.entry!, price: 4020, low: 4020, high: 4020, confirm: 'touch' } },
    { price: 4021, tf: '5m', now: at(2), bars: candles([[4012, 4016, 4011, 4015], [4015, 4021, 4014, 4020.5]]) });
  assert.deepEqual(touch.entered, { at: at(1), price: 4020 });
});

test('a plan is off the moment the read is no longer its read, and it expires', () => {
  const idea = plan();
  const bars = candles([[4012, 4014, 4008, 4010], [4010, 4011, 4001, 4003], [4003, 4004, 3993, 3995]]);
  const leans = [{ at: T0 - 3600_000, lean: 'bullish_lean' }, { at: at(1) - 60_000, lean: 'balanced' }];
  const off = followIdea(idea, { price: 3995, bars, tf: '5m', now: at(3), leans });
  assert.equal(off.state, 'invalidated'); assert.equal(off.pips, null); assert.match(off.text, /not counted as a trade/);
  // The same candles while the lean held: a real stop.
  assert.equal(followIdea(idea, { price: 3995, bars, tf: '5m', now: at(3), leans: [leans[0]] }).state, 'stopped');
  // The setup engine's own trades are not judged by the read.
  assert.equal(followIdea({ ...idea, source: 'setup_engine' }, { price: 3995, bars, tf: '5m', now: at(3), leans }).state, 'stopped');
  const late = followIdea(idea, { price: 4010, bars: candles([[4012, 4014, 4008, 4010]]), tf: '5m', now: T0 + 5 * 3600_000 });
  assert.equal(late.state, 'expired');
  // Through the stop without ever entering on a closed candle: off.
  assert.equal(followIdea(idea, { price: 3990, bars: [], tf: '5m', now: at(1) }).state, 'invalidated');
});

test('a market idea: still there, gone, and graded from where it was priced', () => {
  const mkt = plan({ kind: 'enter_now', source: 'setup_engine', entry: { type: 'market', price: 4002, low: 4001.5, high: 4002, level: null, trigger: null, confirm: 'none', text: '', distancePips: 0 }, watch: null });
  assert.equal(followIdea(mkt, { price: 4003, bars: [], tf: '5m', now: T0 + 60_000 }).state, 'ready');
  assert.equal(followIdea(mkt, { price: 4003, bars: [], tf: '5m', now: T0 + 60_000 }).canExecute, true);
  // Moved more than 0.6 R from where it was priced (the engine's own drift rule): it is a different trade.
  const gone = followIdea(mkt, { price: 4008, bars: [], tf: '5m', now: T0 + 60_000 });
  assert.equal(gone.state, 'missed'); assert.equal(gone.canExecute, false);
  const won = followIdea(mkt, { price: 4021, tf: '5m', now: at(2), bars: candles([[4002, 4013, 4001, 4012], [4012, 4021, 4011, 4020.5]]) });
  assert.equal(won.state, 'tp2'); assert.equal(won.pips, 180);
  assert.deepEqual(won.entered, { at: T0, price: 4002 });
  assert.equal(followIdea(plan({ kind: 'stand_aside', side: null, entry: null, stop: null, targets: [] }), { price: 4000, bars: [], tf: '5m', now: at(1) }).state, 'none');
});

test('the record counts a target before the stop as a win and never counts a cancelled plan', () => {
  const rec = ideaRecord([
    { state: 'tp1', pips: 88 }, { state: 'tp3', pips: 240 }, { state: 'stopped', pips: -95 },
    { state: 'invalidated', pips: null }, { state: 'expired', pips: null }, { state: 'waiting', pips: null }, { state: 'open', pips: null }, { state: 'none', pips: null },
  ]);
  assert.deepEqual(rec, { graded: 3, wins: 2, losses: 1, pips: 233, open: 2, untriggered: 2 });
});

test('the update says whether ATLAS still agrees with its own plan', () => {
  const idea = plan();
  const f = followIdea(idea, { price: 4008, bars: [], tf: '5m', now: at(1) });
  const read = (lean: AtlasRead['lean'], score: number, strength: AtlasRead['strength']) => ({ lean, score, strength } as AtlasRead);
  assert.match(updateVerdict(idea, f, read('bullish_lean', 44, 'clear'), null), /still agrees: bullish lean, clear \(evidence \+44\)/);
  assert.match(updateVerdict(idea, f, read('balanced', 6, null), null), /My read is now balanced[^—]*— that is no longer the read this call was made on\. Generate a fresh one\./);
  const ready = { state: 'trade_ready', side: 'sell', style: 'quick', headline: 'TRADE READY', say: 'I want to SELL gold.' } as BrainSetup;
  assert.match(updateVerdict(idea, f, read('bullish_lean', 44, 'clear'), ready), /I now have a confirmed setup ready \(sell\)\. Generate again to see it\./);
  // A call from a tilt of the evidence, not a clear lean: the update says where the tilt is now.
  const forcedIdea = { ...idea, source: 'forced_read' as const };
  assert.match(updateVerdict(forcedIdea, f, read('balanced', 9, null), null), /What I see still tilts up: balanced[^,]*, \+9 of 100\./);
  assert.match(updateVerdict(forcedIdea, f, read('balanced', -14, null), null), /My evidence now tilts the other way: .* -14 of 100\. This call no longer has that behind it — generate a fresh one\./);
  assert.doesNotMatch(updateVerdict(forcedIdea, f, read('balanced', -14, null), ready), /forced read|setup engine|ATLAS's read/i);
  assert.match(updateVerdict(forcedIdea, f, read('bearish_lean', -40, 'clear'), null), /now tilts the other way/);
  assert.match(updateVerdict(forcedIdea, f, read('balanced', 0, null), null), /dead even/);
  const done = followIdea(idea, { price: 3990, bars: [], tf: '5m', now: at(1) });
  assert.equal(updateVerdict(idea, done, read('bullish_lean', 44, 'clear'), null), done.text);
});

test('the replay generates and follows an idea on the recording, and is addressed without storing anything', () => {
  assert.equal(replayEndOf('33'), 33); assert.equal(replayEndOf('9999'), 100); assert.equal(replayEndOf('nope'), 0);
  const idea = replayIdea({ style: 'auto' }, 33);
  assert.equal(idea.id, 'replay:33:auto');
  assert.equal(idea.kind, 'enter_now'); assert.equal(idea.side, 'buy'); assert.equal(idea.source, 'read_plan');
  const f = replayFollow(idea.id!)!;
  assert.deepEqual(f.idea, idea);
  assert.match(f.follow.state, /^tp[123]$/);
  assert.ok((f.follow.pips ?? 0) > 0);
  assert.equal(replayFollow('replay:x:auto'), null);
  // An id from a page that has not refreshed still resolves — to the one answer there is.
  assert.deepEqual(replayFollow('replay:33:quick')!.idea, idea);
  assert.match(ideaText(idea), /^ATLAS · XAUUSD BUY · ATLAS's call, (low|medium|high) conviction — a read, not a confirmed setup\nEntry: /);
  // The end of the recording used to be "no trade right now": it is a call with a side and levels.
  const end = replayIdea({ style: 'auto' }, 0);
  assert.equal(end.source, 'forced_read'); assert.equal(end.kind, 'enter_now');
  assert.match(ideaText(end), /^ATLAS · XAUUSD (BUY|SELL) · ATLAS's call, low conviction — a read, not a confirmed setup\nEntry: /, 'pasted anywhere, it still says it is a read');
  const confirmed = replayIdea({ style: 'auto' }, 57);
  assert.equal(confirmed.source, 'setup_engine');
  assert.match(ideaText(confirmed), /^ATLAS · XAUUSD SELL · confirmed setup\nEntry: /);
  assert.match(ideaText(buildIdea(base(MOMENTS[0].r, { snapshot: null }))), /^ATLAS · XAUUSD — I can't read gold right now\. /);
});

test('the idea engine cannot trade: it never touches the executor, a broker or FLOW/GENX', () => {
  for (const f of ['command-center/engines/idea.ts', 'command-center/engines/ideaDesk.ts', 'command-center/engines/ideaReplay.ts', 'src/app/api/command-center/idea/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from\s+["'][^"']*(executor|callTrade|tradelocker|autopilot|autoManage)["']/, `${f} imports an execution module`);
    assert.doesNotMatch(src, /from\s+["'][^"']*\/(genx|flow)[^"']*["']/, `${f} imports FLOW/GENX`);
    assert.doesNotMatch(src, /\b(prepare|execute|takeSetup|manage)\s*\(/, `${f} calls an execution function`);
  }
  // And nothing that decides, sizes, sends or manages an order reads an idea.
  for (const f of ['executor', 'autopilot', 'autoManage', 'setup', 'broker', 'callTrade', 'validator', 'tradeLive', 'watch', 'profile']) {
    const src = readFileSync(`command-center/engines/${f}.ts`, 'utf8');
    assert.doesNotMatch(src, /from\s+["']\.\/idea(Desk|Replay)?["']/, `${f} imports the idea engine`);
  }
  assert.doesNotMatch(readFileSync('command-center/worker/index.ts', 'utf8'), /engines\/idea/, 'the worker imports the idea engine');
  assert.doesNotMatch(readFileSync('src/app/api/command-center/trade/route.ts', 'utf8'), /engines\/idea/, 'the trade route imports the idea engine');
  // The pure engine has no I/O at all.
  const pure = readFileSync('command-center/engines/idea.ts', 'utf8');
  assert.doesNotMatch(pure, /adapters\/|Date\.now\(\)|fetch\(/);
  // And the watch an idea arms is informational, with its price taken from the stored idea.
  const desk = readFileSync('command-center/engines/ideaDesk.ts', 'utf8');
  assert.match(desk, /authority: "informational"/);
  assert.doesNotMatch(desk, /authority: "action"/);
});
