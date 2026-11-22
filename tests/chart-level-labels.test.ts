import test from "node:test";
import assert from "node:assert/strict";
import { orderedLevelLabels } from "../src/lib/chart/levelLabels";

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
