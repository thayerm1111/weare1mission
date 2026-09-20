import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { RISK_DISCLOSURE, DISCLOSURE_VERSION, disclosureHash } from "../command-center/engines/consent";

/*
 * A CHECKBOX IN AN INTERFACE IS A DECORATION.
 *
 * It stops an honest member and nobody else, and it proves nothing in a dispute because there is no
 * record that anything was shown. These tests protect the version of this rule that is actually worth
 * something: the one in the routes.
 */

test("every door that reaches the broker is gated", async () => {
  const broker = await fs.readFile("src/app/api/command-center/broker/route.ts", "utf8");
  assert.ok(/requireConsent\(user\.id\)/.test(broker), "the broker route checks");
  for (const a of ["connect", "authorize_live", "permissions", "auto_trading"]) {
    assert.ok(new RegExp(`"${a}"`).test(broker.slice(broker.indexOf("const GATED"), broker.indexOf("switch (action)"))),
      `${a} must require a signature`);
  }

  const trade = await fs.readFile("src/app/api/command-center/trade/route.ts", "utf8");
  assert.ok(/requireConsent\(user\.id\)/.test(trade), "the trade route checks");
});

/*
 * AN ALLOW-LIST, NOT A BLOCK-LIST.
 *
 * A new action added later defaults to REQUIRING consent, which is the safe direction to be wrong in.
 * A block-list would let the next execution path ship ungated and nobody would notice.
 */
test("a new trading action defaults to gated", async () => {
  const trade = await fs.readFile("src/app/api/command-center/trade/route.ts", "utf8");
  const list = trade.slice(trade.indexOf("const UNGATED"), trade.indexOf("switch (action)"));
  assert.ok(/!UNGATED\.has\(action\)/.test(list), "it inverts an allow-list");
  for (const dangerous of ["execute", "close", "partial", "take_setup", "protect", "ai_management"]) {
    assert.ok(!new RegExp(`"${dangerous}"`).test(list), `${dangerous} must not be exempt`);
  }
  // Reading state and setting your own risk profile need no signature.
  for (const safe of ["prepare", "reconcile", "pass_setup", "profile"]) {
    assert.ok(new RegExp(`"${safe}"`).test(list), `${safe} should not require one`);
  }
});

test("the order-sending function checks again on its own", async () => {
  // The route already checks, so this never fires in normal operation. It exists so a future caller
  // cannot inherit market access without inheriting the rule.
  const src = await fs.readFile("command-center/engines/callTrade.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function takeSetup"), src.indexOf("const profile = await getProfile"));
  assert.ok(/requireConsent\(userId\)/.test(fn));
});

/*
 * BOTH THE BOX AND THE NAME, AND THE SERVER DECIDES.
 */
test("a signature needs an acknowledgement and a name", async () => {
  const src = await fs.readFile("command-center/engines/consent.ts", "utf8");
  assert.ok(/if \(!input\.acknowledged\) return \{ ok: false/.test(src), "the box is required");
  assert.ok(/name\.length < 3/.test(src), "and a real name");
  assert.ok(/if \(!r \|\| !r\.acknowledged\)/.test(src),
    "an unacknowledged row is not a consent, whatever the client sent");
});

/*
 * A CONSENT TO AN OLDER TEXT IS NOT CONSENT TO A NEWER ONE.
 */
test("consent is versioned and goes stale when the text changes", async () => {
  const src = await fs.readFile("command-center/engines/consent.ts", "utf8");
  assert.ok(/signed: r\.version === currentVersion/.test(src), "only the current version counts as signed");
  assert.ok(/stale: r\.version !== currentVersion/.test(src), "and an older one is reported as stale");
  assert.match(DISCLOSURE_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/, "the version is dated, so drift is visible");
});

test("what was shown is hashed into the record", () => {
  // A record that says only "accepted v1" is worth very little once v1 no longer exists anywhere.
  const h = disclosureHash();
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, disclosureHashOf("something else"));
});
function disclosureHashOf(s: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:crypto").createHash("sha256").update(s).digest("hex");
}

/*
 * THE DISCLOSURE HAS TO ACTUALLY DISCLOSE.
 *
 * Not legal review — that is a lawyer's job and is flagged as such in the source. This asserts the
 * risks specific to THIS product are present, because they are the ones a generic template omits.
 */
test("the risks particular to this system are named", () => {
  const t = RISK_DISCLOSURE.toLowerCase();
  for (const [what, re] of [
    ["total loss", /lose some, all/],
    ["leverage", /leverage magnifies/],
    ["no guarantee", /is a promise, a guarantee/],
    ["past performance", /past results do not predict/],
    ["not advice", /not financial, investment, legal or tax advice/],
    ["automation can fail", /automated and assisted trading can fail/],
    ["stops can gap", /stop losses are not a guarantee/],
    ["weekend gaps", /gold gaps at the weekly open/],
    ["costs", /spreads, commissions/],
    ["broker is theirs", /your broker relationship is yours/],
    ["permissions", /you control the permissions/],
    ["withdrawal", /you can withdraw at any time/],
  ] as const) {
    assert.ok(re.test(t), `the disclosure must cover: ${what}`);
  }
});

test("withdrawing does not pretend to close open positions", () => {
  assert.ok(/does not close positions that are\nalready open/.test(RISK_DISCLOSURE),
    "the one thing a member would most dangerously assume");
});

test("the source flags that the words need a lawyer", async () => {
  const src = await fs.readFile("command-center/engines/consent.ts", "utf8");
  assert.ok(/NOT LEGAL ADVICE AND HAVE NOT BEEN REVIEWED BY A LAWYER/.test(src),
    "nobody should mistake a draft for a reviewed document");
});

/*
 * ASKED ON THE WAY IN, NOT AT THE MOMENT IT BECOMES URGENT.
 *
 * Nobody should arrive at the second they want to trade and find a legal document in the way. The
 * sheet is mounted in the portal shell so it is read once, calmly, before any of it matters.
 */
test("every member is asked on the way into the portal", async () => {
  const layout = await fs.readFile("src/app/portal/layout.tsx", "utf8");
  assert.ok(/<RiskConsentGate \/>/.test(layout), "mounted in the shell every member passes through");
});

test("'later' defers for the visit, not for ever", async () => {
  const gate = await fs.readFile("src/components/command-center/RiskConsentGate.tsx", "utf8");
  assert.ok(/sessionStorage/.test(gate), "the deferral dies with the tab");
  // Comments are stripped: the code explains the sessionStorage choice by naming what it rejected.
  const code = gate.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/localStorage/.test(code), "a member who never signs is asked again, every visit");
  assert.ok(/if \(!consent \|\| consent\.signed\) return null;/.test(gate),
    "and it disappears entirely once signed");
});

/*
 * IT MUST NOT HOLD THE PORTAL HOSTAGE.
 *
 * Members pay for the community, the training and the tools. Locking those behind a TRADING
 * disclosure would punish people for something they may never do — and it would be security theatre
 * either way, because the gate that matters is the one on the server.
 */
test("declining leaves the rest of the product usable", async () => {
  const sheet = await fs.readFile("src/components/command-center/RiskConsent.tsx", "utf8");
  assert.ok(/Not now/.test(sheet), "there is a way past the sheet");
  assert.ok(/cannot connect a broker, place a trade or enable automation/.test(sheet),
    "and it says exactly what declining costs");
});
