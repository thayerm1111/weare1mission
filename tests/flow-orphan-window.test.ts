import test from "node:test";
import assert from "node:assert/strict";
import { managedRowCovers } from "../src/lib/flow/recover";

test("a row written after the placement covers it (adoption is late, up to 45 min)", () => {
  assert.equal(managedRowCovers("2026-09-21T00:58:30Z", "2026-09-21T00:57:05Z"), true);
  assert.equal(managedRowCovers("2026-09-21T01:30:00Z", "2026-09-21T00:57:05Z"), true);
});
test("the 09-21 bug: an EARLIER trade's row does not cover a new placement", () => {
  assert.equal(managedRowCovers("2026-09-21T00:36:48Z", "2026-09-21T00:57:05Z"), false);
});
test("clock skew of a few seconds is tolerated", () => {
  assert.equal(managedRowCovers("2026-09-21T00:57:00Z", "2026-09-21T00:57:05Z"), true);
});
test("rows long after do not match", () => {
  assert.equal(managedRowCovers("2026-09-21T01:50:00Z", "2026-09-21T00:57:05Z"), false);
});
