import test from "node:test";
import assert from "node:assert/strict";
import { liveNitrousPositions } from "../src/lib/nitrous/dashboard";
import type { NitrousAccount, NitrousPosition } from "../src/lib/nitrous/types";

const now = Date.parse("2026-11-27T04:00:00Z");
const position: NitrousPosition = {
  id: "position", side: "sell", entry: 3510, stop: 3515, target: 3495, quantity: 1,
  openedAt: new Date(now - 60000).toISOString(), liveObservedAt: new Date(now - 1000).toISOString(),
  status: "open", protectionState: "protected", managementEnabled: true,
  closeRequestedAt: null, closeRequestState: null, closeRequestError: null,
};
const account: Pick<NitrousAccount, "environment" | "state" | "positions"> =
  { environment: "live", state: "connected", positions: [position] };

test("boost engages only on a fresh observation for a live account", () => {
  assert.deepEqual(liveNitrousPositions(account, now), [position]);
  assert.deepEqual(liveNitrousPositions(null, now), []);
  assert.deepEqual(liveNitrousPositions({ ...account, positions: [] }, now), []);
  assert.deepEqual(liveNitrousPositions({ ...account, environment: "demo" }, now), []);
  assert.deepEqual(liveNitrousPositions({ ...account, state: "reconnect_required" }, now), []);
  assert.deepEqual(liveNitrousPositions(account, now + 30000), []);
  assert.deepEqual(liveNitrousPositions(account, 0), []);
});

test("boost drops on closure or unavailable broker evidence", () => {
  for (const patch of [
    { status: "closing" }, { status: "closed" }, { status: "orphan_review" },
    { closeRequestedAt: new Date(now).toISOString() }, { closeRequestState: "dispatching" },
    { liveObservedAt: null }, { quantity: 0 },
  ] satisfies Partial<NitrousPosition>[]) {
    assert.deepEqual(liveNitrousPositions({ ...account, positions: [{ ...position, ...patch }] }, now), []);
  }
});
