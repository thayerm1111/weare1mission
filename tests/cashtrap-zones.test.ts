import test from "node:test";
import assert from "node:assert/strict";
import { M5, closeOf, type Candle } from "../src/lib/cashtrap/candles";
import { atr } from "../src/lib/cashtrap/indicators";
import { autoZonesAt, contributingZone, manualZonesAt, type ZoneConfig } from "../src/lib/cashtrap/zones";
import { calm, then, T_START } from "./_cashtrap";

const Z: ZoneConfig = { pivotLeft: 2, pivotRight: 2, lookbackCandles: 200, halfWidthAtrMult: 0.15, manualInvalidateOnClose: true };
const atrOf = (s: Candle[]) => atr(s.map((x) => x.h), s.map((x) => x.l), s.map((x) => x.c), 14);

/** 300 calm candles, then a clean swing low at index p = 302 (low 99.5). */
function withSwingLow(): { s: Candle[]; p: number } {
  let s = calm(300);
  s = then(s, [[100, 100.02, 99.8, 99.82], [99.82, 99.84, 99.7, 99.72], [99.72, 99.74, 99.5, 99.6], [99.6, 99.75, 99.58, 99.7], [99.7, 99.85, 99.68, 99.8], [99.8, 99.9, 99.78, 99.88]]);
  return { s, p: 302 };
}

test("a swing becomes a zone only after its two right-hand candles close — never earlier (no future-pivot leakage)", () => {
  const { s, p } = withSwingLow();
  const a = atrOf(s);
  const at = (e: number) => autoZonesAt("EURUSD", s, a, e, Z).filter((z) => z.kind === "support" && z.pivotT === s[p].t);
  assert.equal(at(p + 1).length, 0, "while the right side is forming");
  assert.equal(at(p + 2).length, 0, "at the open of the second right-hand candle");
  const z = at(p + 3);
  assert.equal(z.length, 1, "from the open of the candle after the confirming candle");
  assert.equal(z[0].createdAt, closeOf(s[p + 2].t), "created when the confirming candle closed");
  assert.equal(z[0].center, 99.5);
});

test("half-width is 0.15 × ATR(14) at the confirming candle, and stays frozen", () => {
  const { s, p } = withSwingLow();
  const a = atrOf(s);
  let longer = then(s, Array.from({ length: 30 }, () => [99.9, 100.6, 99.85, 100.4] as [number, number, number, number]));
  const a2 = atrOf(longer);
  const z1 = autoZonesAt("EURUSD", s, a, p + 3, Z).find((z) => z.pivotT === s[p].t && z.kind === "support")!;
  const z2 = autoZonesAt("EURUSD", longer, a2, longer.length - 1, Z).find((z) => z.pivotT === s[p].t && z.kind === "support")!;
  assert.ok(Math.abs((z1.halfWidth as number) - 0.15 * (a[p + 2] as number)) < 1e-12);
  assert.equal(z2.halfWidth, z1.halfWidth, "volatility afterwards does not change it");
  assert.ok((a2[longer.length - 2] as number) > (a[p + 2] as number) * 2, "ATR did move a lot meanwhile");
  longer = [];
});

test("support is invalidated by a completed CLOSE below its lower edge — a wick below is not enough; it never flips", () => {
  const { s, p } = withSwingLow();
  const wick = then(s, [[99.8, 99.82, 99.3, 99.6]]);                          // wick through, close back above
  const a1 = atrOf(wick);
  const z1 = autoZonesAt("EURUSD", wick, a1, wick.length - 1 + 1 - 1, Z);   // at the wick candle's own open
  const zAfterWick = autoZonesAt("EURUSD", [...wick, { ...wick[wick.length - 1], t: wick[wick.length - 1].t + M5 }], [...a1, null], wick.length, Z).find((z) => z.pivotT === s[p].t)!;
  assert.equal(zAfterWick.invalidatedAt, null, "a wick below does not break support");
  assert.ok(zAfterWick.touches >= 1, "it is a touch");
  void z1;
  const broken = then(s, [[99.8, 99.82, 99.3, 99.4]]);                         // closes below 99.5 − hw
  const a2 = atrOf(broken);
  const zb = autoZonesAt("EURUSD", [...broken, { ...broken[broken.length - 1], t: broken[broken.length - 1].t + M5 }], [...a2, null], broken.length, Z).find((z) => z.pivotT === s[p].t)!;
  assert.equal(zb.invalidatedByClose, 99.4);
  assert.equal(zb.invalidatedAt, closeOf(broken[broken.length - 1].t));
  assert.equal(zb.kind, "support", "a broken support does not become resistance");
});

test("only swings inside the most recent 200 completed candles are used", () => {
  const { s, p } = withSwingLow();
  const long = then(s, Array.from({ length: 220 }, (_, i) => [99.9, 99.92 + (i % 2) * 0.001, 99.88, 99.9] as [number, number, number, number]));
  const a = atrOf(long);
  const zs = autoZonesAt("EURUSD", long, a, long.length - 1, Z);
  assert.equal(zs.filter((z) => z.pivotT === s[p].t).length, 0);
});

test("a manual zone is never applied to candles before it was marked, and then tracks touches", () => {
  const s = calm(320);
  const markedAt = s[310].t + 60_000;                 // marked one minute into candle 310
  const mz = [{ id: "m1", symbol: "EURUSD" as const, kind: "support" as const, lower: 99.9, upper: 99.97, activeFrom: markedAt, activeUntil: null }];
  assert.equal(manualZonesAt(mz, s, 310, Z).length, 0, "not at candle 310, which opened before it was marked");
  const z = manualZonesAt(mz, s, 312, Z);
  assert.equal(z.length, 1);
  assert.equal(z[0].origin, "manual");
  const removed = [{ ...mz[0], activeUntil: s[315].t }];
  assert.equal(manualZonesAt(removed, s, 316, Z).length, 0, "not after it was removed");
});

test("the contributing zone: range overlaps, close on the right side, nearest centre wins", () => {
  const near = { id: "a", symbol: "EURUSD" as const, kind: "support" as const, origin: "auto" as const, lower: 99.49, upper: 99.51, center: 99.5, pivotT: 1, createdAt: 1, confirmedAt: 1, atrAtCreation: 0.1, halfWidth: 0.01, touches: 0, firstTouchT: null, lastTouchT: null, invalidatedAt: null, invalidatedByClose: null, activeUntil: null };
  const far = { ...near, id: "b", lower: 99.53, upper: 99.57, center: 99.55, confirmedAt: 2 };
  const broken = { ...near, id: "c", invalidatedAt: 5 };
  const k = { t: T_START, o: 99.7, h: 99.72, l: 99.5, c: 99.6 };
  assert.equal(contributingZone([far, near, broken], k, "BUY")?.id, "a");
  assert.equal(contributingZone([near], { ...k, c: 99.48 }, "BUY"), null, "closing below the zone's lower edge disqualifies it");
  assert.equal(contributingZone([near], { ...k, l: 99.52 }, "BUY"), null, "a range that does not reach the zone");
  assert.equal(contributingZone([near], k, "SELL"), null, "support never confirms a SELL");
});
