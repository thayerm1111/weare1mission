import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../rapid/engine/snapshot";
import { makeZone, mergeZones } from "../rapid/engine/zones";
import { NITROUS_CONFIG } from "../nitrous/config";

const start = Date.UTC(2026, 10, 24, 12);
const five = 300_000;
const bars = Array.from({ length: 180 }, (_, i) => {
  const p = 3500 + i * 0.09 + Math.sin(i * 0.53) * 8 + Math.sin(i * 0.117) * 5;
  return { t: start + i * five, o: p - 0.4, c: p + 0.4, h: p + 1, l: p - 1, v: null };
});
const input = { asOf: start + bars.length * five + 1000, cfg: NITROUS_CONFIG, tick: 0.01,
  m1: [], higher: { M5: bars }, quote: null, contractSize: null, minStopDistance: null, preserveZoneHistory: true };

test("repeated Nitrous polls keep the same active, retired and merged levels on unchanged candles", () => {
  const first = buildSnapshot(input);
  assert.ok(first.zones.some(z => z.invalidatedAt != null));
  assert.ok(first.zones.some(z => z.invalidatedAt == null));
  assert.ok(first.zones.some(z => z.mergedFrom.length > 0));
  let previous = first.zones;
  for (let poll = 1; poll <= 4; poll++) {
    const next = buildSnapshot({ ...input, asOf: input.asOf + poll * 15_000, priorZones: previous });
    assert.deepEqual(next.zones, first.zones);
    previous = next.zones;
  }
  const retired = first.zones.filter(z => z.invalidatedAt != null).map(z => z.id);
  const rolled = buildSnapshot({ ...input, higher: { M5: [] }, priorZones: previous });
  assert.ok(rolled.zones.every(z => !retired.includes(z.id)));
  const extra = Array.from({ length: 7 }, (_, i) => ({ ...bars.at(-1)!, t: start + (bars.length + i) * five, h: i === 3 ? 3600 : 3530 }));
  const updated = buildSnapshot({ ...input, asOf: input.asOf + extra.length * five, higher: { M5: [...bars, ...extra] }, priorZones: previous });
  const newPivot = `sw:M5:high:${extra[3].t}`;
  assert.ok(updated.zones.some(z => z.id === newPivot || z.mergedFrom.includes(newPivot)));
});

test("a newly discovered older parent retains all identities absorbed by an existing level", () => {
  const seed = { role: "support" as const, low: 3500, high: 3502, origin: "M5" as const, tier: "execution" as const,
    knownAt: start, provenance: { kind: "swing" as const, timeframe: "M5" as const, pivotT: start } };
  const older = makeZone(seed, "older", "older", start);
  const existing = makeZone({ ...seed, knownAt: start + five }, "existing", "existing", start + five);
  existing.mergedFrom = ["constituent"];
  const [combined] = mergeZones([existing, older], { M5: 1 }, .15, new Set([existing.id]));
  assert.equal(combined.id, older.id);
  assert.deepEqual(combined.mergedFrom, ["existing", "constituent"]);
});
