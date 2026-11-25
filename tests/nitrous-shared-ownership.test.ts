import { test } from "node:test";
import assert from "node:assert/strict";
import { accountOwnershipDecision, checkOwnership, isRapidTag, tagFor } from "../rapid/exec/ownership";
import { withNitrousDb, withRapidDb } from "../rapid/db";
import { verifiedOwnedPosition } from "../src/lib/nitrous/policy";

const checkedAt = new Date().toISOString();
const decision = (patch: Partial<Parameters<typeof accountOwnershipDecision>[0]> = {}) => accountOwnershipDecision({
  scope: "nitrous", sharedWith: [], positions: [], positionCols: {}, allowShared: true, checkedAt, ...patch,
});

test("Nitrous ignores other product registries and reports actual foreign exposure without claiming it", () => {
  const result = decision({ sharedWith: ["FLOW/GENX", "Command Center (ATLAS)", "AURIC", "Rapid"], positions: [
    { strategyId: "FLOW:123" }, { strategyId: "RAPID:456" }, { strategyId: null }, { strategyId: "NITROUS:own" },
  ] });
  assert.equal(result.ok, true); assert.equal(result.shared, true); assert.equal(result.foreignPositions, 3);
  assert.deepEqual(result.sharedWith, []);
  assert.equal(result.reason, "Shared-account access enabled. Nitrous manages only its own tagged positions.");
});

test("manual external positions are accurately reported as shared, even without another connected OM tool", () => {
  const result = decision({ positions: [{ strategyId: null }] });
  assert.equal(result.ok, true); assert.equal(result.shared, true); assert.equal(result.foreignPositions, 1);
});

test("unknown broker exposure remains blocked even on a shared account", () => {
  const result = decision({ sharedWith: ["FLOW/GENX"], positions: null });
  assert.equal(result.ok, false); assert.equal(result.foreignPositions, -1);
});

test("Rapid default isolation and its explicit shared-account behavior remain unchanged", () => {
  assert.equal(decision({ scope: "rapid", allowShared: false, sharedWith: ["FLOW/GENX"] }).ok, false);
  assert.equal(decision({ scope: "rapid", allowShared: false, positions: [{ strategyId: "NITROUS:123" }] }).ok, false);
  assert.equal(decision({ scope: "rapid", allowShared: false, positions: [{ strategyId: "RAPID:123" }] }).ok, true);
  const shared = decision({ scope: "rapid", allowShared: true, sharedWith: ["FLOW/GENX"], positions: [{ strategyId: "FLOW:123" }] });
  assert.equal(shared.ok, true); assert.equal(shared.foreignPositions, 1);
  assert.equal(shared.reason, "shared account explicitly allowed (FLOW/GENX); Rapid touches only its own tagged positions");
});

test("other-product registration never blocks Nitrous; unknown sharing permission still cannot claim foreign positions", () => {
  assert.equal(decision({ allowShared: false, sharedWith: ["FLOW/GENX", "AURIC", "Rapid"] }).ok, true);
  assert.equal(decision({ allowShared: false, positions: [{ strategyId: "FLOW:123" }] }).ok, false);
});

test("Nitrous readiness makes no database or retired-product requests and never claims the account is dedicated", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No registry lookup should be attempted"); });
  const clean = await withNitrousDb(() => checkOwnership("broker-account", [], {}, true));
  const shared = await withNitrousDb(() => checkOwnership("broker-account", [{ strategyId: "FLOW:123" }], {}, true));
  const unknown = await withNitrousDb(() => checkOwnership("broker-account", null, {}, true));
  assert.equal(calls, 0);
  assert.equal(clean.ok, true); assert.equal(clean.shared, false); assert.doesNotMatch(clean.reason, /dedicated/i);
  assert.equal(shared.ok, true); assert.equal(shared.shared, true); assert.equal(shared.foreignPositions, 1);
  assert.equal(unknown.ok, false); assert.equal(unknown.foreignPositions, -1);
});

test("scope-specific tags remain isolated across parallel preparations", async () => {
  await Promise.all([
    withNitrousDb(async () => { await Promise.resolve(); assert.equal(isRapidTag("RAPID:123"), false); assert.equal(isRapidTag("NITROUS:123"), true); assert.match(tagFor("entry-123"), /^NITROUS:/); }),
    withRapidDb(async () => { await Promise.resolve(); assert.equal(isRapidTag("NITROUS:123"), false); assert.equal(isRapidTag("RAPID:123"), true); assert.match(tagFor("entry-123"), /^RAPID:/); }),
  ]);
});

test("foreign-position reporting respects broker column maps", () => {
  const result = decision({ positionCols: { strategyId: 1 }, positions: [["position1", "FLOW:foreign"], ["position2", "NITROUS:owned"]] });
  assert.equal(result.ok, true); assert.equal(result.foreignPositions, 1);
});

test("permission to share never permits managing another tool's position or a tag-only match", () => {
  const ledger = { broker_position_id: "position_owned", broker_strategy_id: "NITROUS:owned-entry" };
  assert.equal(verifiedOwnedPosition(ledger, { positionId: "position_owned", strategyId: "NITROUS:owned-entry" }), true);
  assert.equal(verifiedOwnedPosition(ledger, { positionId: "position_foreign", strategyId: "NITROUS:owned-entry" }), false);
  assert.equal(verifiedOwnedPosition(ledger, { positionId: "position_owned", strategyId: "FLOW:foreign-entry" }), false);
  assert.equal(verifiedOwnedPosition({}, { positionId: "position_owned", strategyId: "NITROUS:owned-entry" }), false);
});
