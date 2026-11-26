import assert from "node:assert/strict";
import test from "node:test";
import { createWaitingDiagnostics, noSetupReason, type WaitingDecision } from "../nitrous/waiting-diagnostics";

const decision = (patch: Partial<WaitingDecision> = {}): WaitingDecision => ({
  accountId: "account-one", userId: "member-one", setupId: "setup-one", snapshotId: "snapshot-one",
  stage: "entry", code: "outside_band", decision: "wait", reason: "Waiting for broker price to enter the setup's entry range.",
  ...patch,
});

test("the recorded wait names the observed trends and the entry rules this account can use", () => {
  assert.match(noSetupReason("sideways", "up", true), /ranging on the hourly chart/);
  assert.match(noSetupReason("unknown", "down", false), /Waiting for a confirmed hourly trend/);
  assert.match(noSetupReason("up", "up", true), /No buy setup qualified/);
  assert.match(noSetupReason("down", "sideways", true), /No sell setup qualified inside the 15-minute range/);
  assert.match(noSetupReason("up", "sideways", false), /needs the 15-minute chart to trend up\./);
  assert.match(noSetupReason("down", "up", true), /trend down or form a range/);
});

test("unchanged polls are deduplicated even when their snapshot and observed price change", async () => {
  const rows: WaitingDecision[] = [];
  const report = createWaitingDiagnostics(async row => { rows.push(row); });
  await report(decision({ evidence: { executablePrice: 2001 } }));
  await report(decision({ snapshotId: "next-snapshot", evidence: { executablePrice: 2002 } }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snapshotId, "snapshot-one");
  assert.equal(rows[0].evidence?.executablePrice, 2001);
});

test("a changed reason, code, setup, stage or account is a separate diagnostic", async () => {
  const rows: WaitingDecision[] = [];
  const report = createWaitingDiagnostics(async row => { rows.push(row); });
  const cases = [decision(), decision({ reason: "Waiting for a different confirmation." }),
    decision({ code: "trigger_pending" }), decision({ setupId: "setup-two" }),
    decision({ stage: "readiness" }), decision({ accountId: "account-two" })];
  for (const row of cases) await report(row);
  assert.equal(rows.length, cases.length);
  await report(decision({ accountId: "account-two" }));
  assert.equal(rows.length, cases.length);
});

test("concurrent repeated observations share one pending write without blocking the caller", async () => {
  let calls = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const report = createWaitingDiagnostics(async () => { calls++; await pending; });
  const first = report(decision());
  const second = report(decision());
  assert.equal(first, second);
  let settled = false;
  void first.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false, "control returns while the diagnostic writer is still pending");
  finish();
  assert.equal(await first, true);
});

test("logging failures are contained and retried without erasing a newer observation", async () => {
  let calls = 0;
  let rejectOld!: (error: Error) => void;
  const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  const report = createWaitingDiagnostics(async row => {
    calls++;
    if (row.reason === "old") await old;
    if (row.reason === "fails") throw new Error("logger unavailable");
  });
  assert.equal(await report(decision({ reason: "fails" })), false);
  assert.equal(await report(decision({ reason: "fails" })), false);
  assert.equal(calls, 2, "a failed log does not suppress a later retry");
  const older = report(decision({ reason: "old" }));
  assert.equal(await report(decision({ reason: "new" })), true);
  rejectOld(new Error("older write failed"));
  assert.equal(await older, false);
  await report(decision({ reason: "new" }));
  assert.equal(calls, 4, "failure of the older observation must not clear the newer successful dedupe state");
});
