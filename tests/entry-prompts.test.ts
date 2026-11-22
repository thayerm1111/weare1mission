import test from "node:test";
import assert from "node:assert/strict";
import { createEntryPromptCoordinator } from "../src/lib/onboarding/entry";

test("disclosure takes priority, then welcome, then credits, regardless of mount order", () => {
  for (const disclosureFirst of [true, false]) {
    const queue = createEntryPromptCoordinator();
    const first = queue.reserve(disclosureFirst ? "disclosure" : "welcome");
    const second = queue.reserve(disclosureFirst ? "welcome" : "disclosure");
    assert.equal(queue.getSnapshot().canShowWelcome, false);
    assert.equal(queue.getSnapshot().canShowCredits, false);
    (disclosureFirst ? first : second)();
    assert.equal(queue.getSnapshot().consentReady, true, "presentation is resolved; this does not grant trading consent");
    assert.equal(queue.getSnapshot().canShowWelcome, true);
    assert.equal(queue.getSnapshot().canShowCredits, false);
    (disclosureFirst ? second : first)();
    assert.equal(queue.getSnapshot().canShowCredits, true);
  }
});

test("late cleanup of an old effect cannot release a newer disclosure or welcome", () => {
  for (const kind of ["disclosure", "welcome"] as const) {
    const queue = createEntryPromptCoordinator();
    const old = queue.reserve(kind), current = queue.reserve(kind);
    old(); old();
    assert.equal(queue.getSnapshot().canShowCredits, false);
    current();
    assert.equal(queue.getSnapshot().canShowCredits, true);
  }
});

test("screens without a mounted disclosure can replay welcome, and replay pauses a credit notice", () => {
  const queue = createEntryPromptCoordinator();
  assert.equal(queue.getSnapshot().canShowWelcome, true);
  assert.equal(queue.getSnapshot().canShowCredits, true);
  const replay = queue.reserve("welcome");
  assert.equal(queue.getSnapshot().canShowWelcome, true);
  assert.equal(queue.getSnapshot().canShowCredits, false);
  replay();
  assert.equal(queue.getSnapshot().canShowCredits, true);
});

test("stable snapshots notify only when presentation eligibility changes", () => {
  const queue = createEntryPromptCoordinator(); let changes = 0;
  const unsubscribe = queue.subscribe(() => { changes++; });
  const welcome = queue.reserve("welcome"), first = queue.getSnapshot(), another = queue.reserve("welcome");
  assert.equal(first, queue.getSnapshot());
  welcome();
  assert.equal(first, queue.getSnapshot());
  assert.equal(changes, 1);
  another();
  assert.equal(changes, 2);
  unsubscribe();
  queue.reserve("disclosure");
  assert.equal(changes, 2);
});
