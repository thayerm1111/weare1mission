import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { atr, bollinger, rma, rsi, sma, stdevPop, stochastic, trueRange } from "../src/lib/cashtrap/indicators";
import { dmiCrosses, dmiStochastic } from "../src/lib/cashtrap/dmi";

/**
 * Cashtrap indicators against values worked out by hand from TradingView's documented formulas, and
 * the DMI-Stochastic against a literal bar-by-bar port of the owner's Pine v3 source.
 */
const near = (a: number | null, b: number, eps = 1e-9) => assert.ok(a != null && Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("SMA: na until the window is full, and na whenever the window holds an na", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(sma([1, null, 3, 4, 5], 2), [null, null, null, 3.5, 4.5]);
});

test("Bollinger Bands 20/2 use the population standard deviation (ta.stdev, biased)", () => {
  const closes = Array.from({ length: 20 }, (_, i) => i + 1);
  const bb = bollinger(closes, 20, 2);
  const sd = Math.sqrt((20 * 20 - 1) / 12);                // population sd of 1..20
  near(bb.basis[19], 10.5);
  near(bb.upper[19], 10.5 + 2 * sd);
  near(bb.lower[19], 10.5 - 2 * sd);
  assert.equal(bb.basis[18], null);
  near(stdevPop([5, 5, 5], 3)[2], 0);
});

test("RMA is Wilder's average seeded by the simple average of the first n values (ta.rma)", () => {
  const r = rma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  near(r[2], 2);
  near(r[3], (4 + 2 * 2) / 3);
  near(r[4], (5 + 2 * (8 / 3)) / 3);
});

test("RSI(4) matches the built-in RSI worked by hand", () => {
  // changes: +1 −1 +2 +1 −1 +2 → up/down seeded over bars 1–4, then Wilder-smoothed.
  const r = rsi([10, 11, 10, 12, 13, 12, 14], 4);
  assert.deepEqual(r.slice(0, 4), [null, null, null, null]);
  near(r[4], 80);                                         // up 1.0, down 0.25
  near(r[5], 100 - 100 / (1 + 0.75 / 0.4375));            // 63.157…
  near(r[6], 100 - 100 / (1 + 1.0625 / 0.328125));        // 76.404…
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 4)[5], 100, "no down moves: 100");
  assert.equal(rsi([6, 5, 4, 3, 2, 1], 4)[5], 0, "no up moves: 0");
});

test("the RSI-based moving average is a separate SMA(4) line of RSI — RSI itself is unchanged", () => {
  const c = [10, 11, 10, 12, 13, 12, 14, 13, 15];
  const r = rsi(c, 4);
  const ma = sma(r, 4);
  near(ma[7], ((r[4] as number) + (r[5] as number) + (r[6] as number) + (r[7] as number)) / 4);
  assert.notEqual(ma[7], r[7]);
});

test("Stochastic 5/1/1: %K is the raw stochastic and %D equals %K — no crossover is possible", () => {
  const high = [10, 11, 12, 11, 13, 12, 14];
  const low = [9, 10, 10, 9, 11, 11, 12];
  const close = [9.5, 10.5, 11, 10, 12.5, 11.5, 13];
  const { k, d } = stochastic(close, high, low, 5, 1, 1);
  near(k[4], (100 * (12.5 - 9)) / (13 - 9));              // 87.5
  near(k[6], (100 * (13 - 9)) / (14 - 9));                // 80
  assert.deepEqual(k, d);
  assert.equal(k[3], null, "needs five candles");
  const flat = stochastic([5, 5, 5, 5, 5], [5, 5, 5, 5, 5], [5, 5, 5, 5, 5], 5, 1, 1);
  assert.equal(flat.k[4], null, "a zero range has no value (Pine: division by zero is na)");
});

test("ATR(14) is RMA of true range with the first bar's high − low (ta.atr)", () => {
  const h = [10, 11, 12], l = [9, 10, 10], c = [9.5, 10.5, 11.5];
  assert.deepEqual(trueRange(h, l, c), [1, Math.max(1, 1.5, 0.5), Math.max(2, 1.5, 0.5)]);
  near(atr(h, l, c, 2)[1], (1 + 1.5) / 2);
  near(atr(h, l, c, 2)[2], (2 + 1.25) / 2);
});

/* ── DMI-Stochastic: the owner's Pine v3 source, ported line by line ──────────────────────────── */
type Bar = { h: number; l: number; c: number };
function pineDmiStoch(bars: Bar[], DMIlength = 10, Stolength = 3) {
  // Each wwma call keeps its own history, as a Pine function call site does.
  const mk = () => { let prev: number | null = null; return (l: number, p: number | null) => { const v = p == null ? null : ((prev ?? 0) * (l - 1) + p) / l; prev = v; return v; }; };
  const wAtr = mk(), wPlus = mk(), wMinus = mk();
  const osc: Array<number | null> = [], stoch: Array<number | null> = [], up: number[] = [], dn: number[] = [];
  const hiS: Array<number | null> = [], loS: Array<number | null> = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const hiDiff = p ? b.h - p.h : null;
    const loDiff = p ? p.l - b.l : null;
    const plusDM = hiDiff != null && loDiff != null && hiDiff > loDiff && hiDiff > 0 ? hiDiff : 0;
    const minusDM = hiDiff != null && loDiff != null && loDiff > hiDiff && loDiff > 0 ? loDiff : 0;
    const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : null;   // v3 `tr`: na on bar 0
    const ATR = wAtr(DMIlength, tr);
    const ps = wPlus(DMIlength, plusDM), ms = wMinus(DMIlength, minusDM);
    const PlusDI = ATR == null || ATR === 0 || ps == null ? null : (100 * ps) / ATR;
    const MinusDI = ATR == null || ATR === 0 || ms == null ? null : (100 * ms) / ATR;
    osc.push(PlusDI == null || MinusDI == null ? null : PlusDI - MinusDI);
    const win = (a: Array<number | null>) => (i + 1 >= Stolength ? a.slice(i + 1 - Stolength, i + 1) : null);
    const w = win(osc);
    hiS.push(w && w.every((x) => x != null) ? Math.max(...(w as number[])) : null);
    loS.push(w && w.every((x) => x != null) ? Math.min(...(w as number[])) : null);
    const nums = osc.map((o, j) => (o == null || loS[j] == null ? null : o - (loS[j] as number)));
    const dens = osc.map((_, j) => (hiS[j] == null || loS[j] == null ? null : (hiS[j] as number) - (loS[j] as number)));
    const sn = win(nums), sd = win(dens);
    const a = sn && sn.every((x) => x != null) ? (sn as number[]).reduce((x, y) => x + y, 0) : null;
    const d = sd && sd.every((x) => x != null) ? (sd as number[]).reduce((x, y) => x + y, 0) : null;
    stoch.push(a == null || d == null || d === 0 ? null : (a / d) * 100);
    const s0 = stoch[i], s1 = i > 0 ? stoch[i - 1] : null;
    up.push(s0 != null && s1 != null && s1 < 10 && s0 > 10 ? 1 : 0);
    dn.push(s0 != null && s1 != null && s1 > 90 && s0 < 90 ? 1 : 0);
  }
  return { osc, stoch, up, dn };
}

function randomBars(n: number, seed = 7): Bar[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: Bar[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + (rnd() - 0.5) * 0.4 + Math.sin(i / 25) * 0.05;
    const h = Math.max(o, c) + rnd() * 0.15;
    const l = Math.min(o, c) - rnd() * 0.15;
    out.push({ h, l, c });
    px = c;
  }
  return out;
}

test("DMI-Stochastic reproduces the Pine v3 source bar for bar: the line, and every B (crossUp) and S (crossDown)", () => {
  const bars = randomBars(1500);
  const ref = pineDmiStoch(bars);
  const got = dmiStochastic(bars.map((b) => b.h), bars.map((b) => b.l), bars.map((b) => b.c), 10, 3);
  for (let i = 0; i < bars.length; i++) {
    if (ref.stoch[i] == null) assert.equal(got.stoch[i], null, `bar ${i}`);
    else near(got.stoch[i], ref.stoch[i] as number, 1e-7);
  }
  const b = got.buy.map((x) => (x ? 1 : 0)), s = got.sell.map((x) => (x ? 1 : 0));
  assert.deepEqual(b, ref.up);
  assert.deepEqual(s, ref.dn);
  assert.ok(ref.up.reduce((a, x) => a + x, 0) > 10 && ref.dn.reduce((a, x) => a + x, 0) > 10, "the sample has plenty of events");
});

test("DMI's Wilder average starts from zero (nz of the previous value) — it is not ta.rma", () => {
  const bars = [{ h: 10, l: 9, c: 9.5 }, { h: 11, l: 10, c: 10.5 }, { h: 12, l: 10.5, c: 11.5 }];
  const got = dmiStochastic(bars.map((b) => b.h), bars.map((b) => b.l), bars.map((b) => b.c), 10, 3);
  // Bar 1: ATR = tr/10 = 1.5/10; +DM = 1 → wwma 0.1; −DM 0 → osc = 100 · 0.1 / 0.15 = 66.67.
  near(got.osc[1], 100 * 0.1 / 0.15);
  assert.equal(got.osc[0], null, "tr is na on the first bar, so ATR and the oscillator are na");
});

test("B and S are strict crossings of 10 and 90, exactly as written", () => {
  const { buy, sell } = dmiCrosses([5, 10, 12, 9, 11, 95, 90, 89, 92, 85]);
  assert.deepEqual(buy.map((x, i) => (x ? i : -1)).filter((i) => i >= 0), [4], "5→10 is not a cross; 10→12 is not (10 is not < 10); 9→11 is");
  assert.deepEqual(sell.map((x, i) => (x ? i : -1)).filter((i) => i >= 0), [9], "95→90 is not (not < 90); 92→85 is");
});

test("a window that starts later converges to the full-history DMI value (500-candle window ≈ full chart)", () => {
  const bars = randomBars(1200, 3);
  const full = dmiStochastic(bars.map((b) => b.h), bars.map((b) => b.l), bars.map((b) => b.c));
  const tail = bars.slice(700);
  const part = dmiStochastic(tail.map((b) => b.h), tail.map((b) => b.l), tail.map((b) => b.c));
  near(part.stoch[tail.length - 1], full.stoch[bars.length - 1] as number, 1e-6);
  const r1 = rsi(bars.map((b) => b.c), 4), r2 = rsi(tail.map((b) => b.c), 4);
  near(r2[tail.length - 1], r1[bars.length - 1] as number, 1e-9);
});

/* ── TradingView parity, from an exported chart ───────────────────────────────────────────────── */
const FIX = "tests/fixtures/cashtrap/tradingview";
test("TradingView parity: indicator values match an exported 5-minute chart", { skip: !existsSync(FIX) || !readdirSync(FIX).some((f) => f.endsWith(".csv")) ? "no TradingView export in tests/fixtures/cashtrap/tradingview (see docs/cashtrap.md, 'Verify against TradingView')" : false }, () => {
  for (const f of readdirSync(FIX).filter((x) => x.endsWith(".csv"))) {
    const [head, ...rows] = readFileSync(`${FIX}/${f}`, "utf8").trim().split(/\r?\n/);
    const cols = head.split(",").map((x) => x.trim().toLowerCase());
    const idx = (name: string) => cols.findIndex((c) => c === name);
    const data = rows.map((r) => r.split(",").map(Number));
    const close = data.map((r) => r[idx("close")]), high = data.map((r) => r[idx("high")]), low = data.map((r) => r[idx("low")]);
    const checks: Array<[string, Array<number | null>]> = [
      ["basis", bollinger(close, 20, 2).basis], ["upper", bollinger(close, 20, 2).upper], ["lower", bollinger(close, 20, 2).lower],
      ["rsi", rsi(close, 4)], ["%k", stochastic(close, high, low, 5, 1, 1).k], ["stochastic", dmiStochastic(high, low, close, 10, 3).stoch],
    ];
    for (const [name, mine] of checks) {
      const c = idx(name);
      if (c < 0) continue;
      for (let i = 300; i < data.length; i++) {
        const tv = data[i][c];
        if (!Number.isFinite(tv)) continue;
        near(mine[i], tv, Math.max(1e-6, Math.abs(tv) * 1e-6));
      }
    }
  }
});
