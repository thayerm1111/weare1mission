import test from "node:test";
import assert from "node:assert/strict";
import { levelTag, orderedLevelLabels } from "../src/lib/chart/levelLabels";

// A 454×312 chart has a 24px time axis. Text must stay below its readout and above the time axis.
const TOP = 46, BOTTOM = 282;
const gold = [
  { label: "Reference stop", price: 3534.2, ly: 234.3 },
  { label: "Reference limit entry", price: 3533.5, ly: 239.8 },
  { label: "Reference target 1", price: 3532.5, ly: 251.1 },
  { label: "Reference target 2", price: 3531.5, ly: 267 },
  { label: "Reference target 3", price: 3530, ly: 280.1 },
];
function readable(labels: { labelY: number }[], top = TOP, bottom = BOTTOM, gap = 16) {
  assert.ok(labels.every((level) => level.labelY >= top && level.labelY <= bottom), "every text baseline stays in the plot");
  for (let i = 1; i < labels.length; i++) assert.ok(labels[i].labelY - labels[i - 1].labelY >= gap - 1e-9, "adjacent labels retain their order and spacing");
}

test("clustered gold targets never jump above entry or stop when the last label reaches the bottom", () => {
  const original = JSON.stringify(gold);
  const labels = orderedLevelLabels([...gold].reverse(), TOP, BOTTOM);
  readable(labels);
  assert.deepEqual(labels.map(({ label, price, ly }) => ({ label, price, ly })), gold, "actual line coordinates and signal values remain exact");
  assert.ok(labels[4].labelY > labels[1].labelY, "target 3 stays below entry on this sell chart");
  assert.equal(JSON.stringify(gold), original, "layout never mutates saved levels");
});

test("a tight group at either plot boundary stays ordered and separated", () => {
  for (const coordinates of [[30, 31, 33, 35, 36], [274, 276, 279, 281, 282], [100, 100, 100, 100, 100]]) {
    const levels = coordinates.map((ly, index) => ({ ly, index }));
    const labels = orderedLevelLabels(levels, TOP, BOTTOM);
    readable(labels);
    assert.deepEqual(labels.map((level) => level.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(labels.map((level) => level.ly), coordinates);
  }
});

test("well-spaced annotations keep their natural baselines and empty or short charts stay bounded", () => {
  const levels = [70, 120, 180, 240].map((ly) => ({ ly }));
  assert.deepEqual(orderedLevelLabels(levels, TOP, BOTTOM).map((level) => level.labelY), [64, 114, 174, 234]);
  assert.deepEqual(orderedLevelLabels([], TOP, BOTTOM), []);
  assert.equal(orderedLevelLabels([{ ly: 35 }], TOP, BOTTOM)[0].labelY, TOP);
  const short = orderedLevelLabels(gold, TOP, TOP + 40);
  readable(short, TOP, TOP + 40, 10);
  assert.deepEqual(short.map((level) => level.ly), gold.map((level) => level.ly));
});

test("backed support/resistance tags cannot overlap at either plot edge or alter the true price lines", () => {
  const top = 49, bottom = 279;
  for (const coordinates of [[29, 30, 31, 32, 34], [268, 269, 274, 278, 288], [150, 150, 150, 150, 150]]) {
    const levels = coordinates.map((ly, i) => ({ ly, price: 3560 - i }));
    const labels = orderedLevelLabels(levels, top, bottom, 25);
    readable(labels, top, bottom, 25);
    assert.ok(labels.every((label) => label.labelY - 14 >= 34 && label.labelY + 8 < 288));
    for (let i = 1; i < labels.length; i++) {
      assert.ok(labels[i].labelY - 14 > labels[i - 1].labelY + 8, "22px backings have a visible gap");
    }
    assert.deepEqual(labels.map(({ ly, price }) => ({ ly, price })), levels);
  }
});

test("narrow level tags shorten only the name, preserving exact market precision", () => {
  const full = levelTag("Support", "3,555.36", 240);
  assert.equal(full.text, "Support 3,555.36");
  assert.ok(full.width < 240);
  const fx = levelTag("Former resistance · 4h confirmed swing", "1.08457", 170);
  assert.ok(fx.text.endsWith(" 1.08457"));
  assert.match(fx.text, /…/);
  assert.ok(fx.width <= 170);
  assert.equal(levelTag("Former support", "153.742", 70).text, "153.742");
});
