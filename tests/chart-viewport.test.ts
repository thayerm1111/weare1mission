import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTO_VIEW, MIN_BARS, timeWindow, zoomAt, spanAround, panTo, stretchPrice, toNewest, moved, anchorOf, atNewest, indexAtOrBefore,
  type ViewScale,
} from "../src/lib/chart/viewport";
import { timedBars, stampMs, candleTimeText, axisMarks } from "../src/lib/chart/candleTime";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const MIN = 60_000;
const barsOf = (n: number, t0 = Date.UTC(2026, 10, 20, 0, 0), step = 15 * MIN) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * step, o: 1, h: 2, l: 0.5, c: 1.5 }));
const scaleOf = (bars: { t: number }[], vp = AUTO_VIEW, autoSpan = 90, usable = 900): ViewScale => {
  const w = timeWindow(bars, vp, autoSpan);
  return { n: bars.length, ...w, bw: usable / w.span, usable, pricePerPx: 0.01 };
};

test("the view follows the newest candle until it is moved, and is anchored to a candle's time, not its place", () => {
  const bars = barsOf(200);
  const w = timeWindow(bars, AUTO_VIEW, 90);
  assert.equal(w.end, 199);
  assert.equal(w.span, 90);
  // Pan into the past: a new candle arriving does not move what is on screen.
  const s = scaleOf(bars);
  const past = panTo(AUTO_VIEW, s, bars, 120, 0);
  assert.equal(past.follow, false);
  const before = timeWindow(bars, past, 90);
  const more = [...bars, { t: bars[199].t + 15 * MIN, o: 1, h: 2, l: 0.5, c: 1.6 }];
  const after = timeWindow(more, past, 90);
  assert.equal(more[Math.floor(after.end)].t, bars[Math.floor(before.end)].t, "the same candle stays at the right edge");
  // An old candle dropping off the left does not move it either.
  const fewer = bars.slice(10);
  const shifted = timeWindow(fewer, past, 90);
  assert.equal(fewer[Math.floor(shifted.end)].t, bars[Math.floor(before.end)].t);
});

test("zoom keeps the candle under the pointer where it is; pinch is the same rule", () => {
  const bars = barsOf(300);
  const s = scaleOf(bars);
  const px = 300;
  const under = s.iL + px / s.bw - 0.5;
  const z = zoomAt(AUTO_VIEW, s, bars, px, -400);           // zoom in
  assert.ok(z.span < s.span);
  const s2 = scaleOf(bars, z, 90);
  assert.ok(Math.abs((s2.iL + px / s2.bw - 0.5) - under) < 1e-6, "the same bar under the pointer");
  // Never fewer than MIN_BARS, never more than there are.
  assert.equal(zoomAt(AUTO_VIEW, s, bars, px, -1e6).span, MIN_BARS);
  assert.equal(zoomAt(AUTO_VIEW, s, bars, px, 1e6).span, 300);
  const p = spanAround(AUTO_VIEW, s, bars, under, px, 40);
  assert.equal(p.span, 40);
});

test("Return to live keeps the zoom; Reset is the automatic view; price stretch has limits", () => {
  const bars = barsOf(120);
  const s = scaleOf(bars);
  const v = panTo({ ...AUTO_VIEW, span: 30 }, s, bars, 60, 4.2);
  assert.equal(moved(v), true);
  const live = toNewest(v);
  assert.deepEqual([live.follow, live.span, live.pOff], [true, 30, 0]);
  assert.equal(moved(AUTO_VIEW), false);
  assert.equal(stretchPrice(1, -1e9, 0.002), 30);
  assert.equal(stretchPrice(1, 1e9, 0.002), 0.2);
  // Within a quarter bar of the newest candle counts as live again.
  assert.equal(atNewest(118.8, 120), true);
  assert.equal(atNewest(118.7, 120), false);
  assert.deepEqual(anchorOf(bars, 50.5), { endT: bars[50].t, endOff: 0.5 });
  assert.equal(indexAtOrBefore(bars, bars[3].t + 1), 3);
});

test("the Command Center chart moves by the same rules (one implementation, not two)", () => {
  const gold = src("src/components/command-center/hud/GoldChart.tsx");
  assert.match(gold, /from "\.\.\/\.\.\/\.\.\/lib\/chart\/viewport"/);
  for (const f of ["timeWindow(", "zoomAt(", "spanAround(", "panTo(", "stretchPrice("]) assert.ok(gold.includes(f), f);
  assert.ok(!/const OVERSCROLL|function indexAtOrBefore/.test(gold), "no second copy of the maths");
  const om = src("src/components/om/chart/OmChart.tsx");
  for (const f of ["timeWindow(", "zoomAt(", "spanAround(", "panTo(", "stretchPrice("]) assert.ok(om.includes(f), f);
});

test("candle stamps: UTC only when the answer says so; duplicates and non-candles dropped; never re-timed", () => {
  const raw = [
    { t: "2026-11-21 06:30:00", o: 3532.8, h: 3533, l: 3532.7, c: 3532.9 },
    { t: "2026-11-21 06:15:00", o: 3532.7, h: 3532.9, l: 3532.6, c: 3532.8 },
    { t: "2026-11-21 06:30:00", o: 3532.8, h: 3533.1, l: 3532.7, c: 3533.0 },   // the same candle again: the later stands
    { t: "2026-11-21 06:45:00", o: 3533, h: 3532, l: 3534, c: 3533 },          // high under low: not a candle
  ];
  const a = timedBars(raw, "UTC");
  assert.equal(a.known, true);
  assert.deepEqual(a.bars.map((b) => b.t), [Date.UTC(2026, 10, 21, 6, 15), Date.UTC(2026, 10, 21, 6, 30)]);
  assert.equal(a.bars[1].c, 3533.0);
  assert.equal(a.dropped, 2);
  const b = timedBars(raw, undefined);
  assert.equal(b.known, false, "a stamp in the feed's own clock is never printed as a clock time");
  assert.equal(candleTimeText(b.bars[0].t, false, b.bars[1].t), "15 min before the newest candle");
  assert.equal(stampMs("1795243500000"), 1795243500000);
  assert.equal(stampMs("2026-11-21T06:45:00Z"), Date.UTC(2026, 10, 21, 6, 45));
  const marks = axisMarks(barsOf(40), 0, 39, 4, false);
  assert.ok(marks.every((m) => /ago$/.test(m.text)));
});

test("the chart is a view control: it fetches nothing, charges nothing, and writes no setting", () => {
  const om = src("src/components/om/chart/OmChart.tsx");
  assert.ok(!/fetch\(|\/api\/|localStorage|sessionStorage/.test(om));
  // Text inside the plot is not selectable; a sideways drag is the chart's and up-and-down the page's.
  const css = src("src/components/om/chart/om-chart.css");
  assert.match(css, /\.om-ch \{[^}]*touch-action: pan-y;[^}]*user-select: none;/s);
  // Old levels start at their own read; candles printed while gold was shut say so.
  assert.match(om, /data-analysis-mark/);
  assert.match(om, /Session break · feed quotes, not trading/);
  // The setup route asks the feed for UTC candles and says it did.
  const route = src("src/app/api/floor/setup/route.ts");
  assert.match(route, /series\("XAU\/USD", CHART_TF\[mode\], CHART_BARS, mdKey, false, "UTC"\)/);
  assert.match(route, /candlesTz: "UTC"/);
});
