import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("manual position sends do not resend an ambiguous relay result and cannot dispatch after their deadline; old defaults stay unchanged", () => {
  // Isolated module initialization selects a synthetic relay. Every fetch is replaced before import.
  const script = `
    import assert from 'node:assert/strict';
    let direct = 0, relay = 0;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://fixture-relay.invalid/')) { relay++; return new Response(JSON.stringify({error:'unknown_upstream_outcome'}), {status:200}); }
      direct++; return new Response(null, {status:204});
    };
    const module = await import('./src/lib/flow/tradelocker.ts');
    const tl = module.default ?? module;
    let acc = 1; while(tl.pickRoute('demo:'+acc, 2) !== 1) acc++;
    const args = ['demo', 'fixture-token', String(acc), 'fixture-position'];
    await assert.rejects(() => tl.closePosition(...args, .25, {noResend:true, notAfterMs:Date.now()+10000}), /relay_outcome_unknown/);
    await assert.rejects(() => tl.modifyPosition(...args, {stopLoss:2400.5}, {noResend:true, notAfterMs:Date.now()+10000}), /relay_outcome_unknown/);
    assert.equal(direct, 0); assert.equal(relay, 2);
    await assert.rejects(() => tl.closePosition(...args, .25, {noResend:true, notAfterMs:Date.now()-1}), /send_deadline_passed/);
    await assert.rejects(() => tl.modifyPosition(...args, {stopLoss:2400.5}, {noResend:true, notAfterMs:Date.now()-1}), /send_deadline_passed/);
    assert.equal(direct, 0); assert.equal(relay, 2);
    assert.equal((await tl.closePosition(...args, .25)).ok, true);
    assert.equal((await tl.modifyPosition(...args, {stopLoss:2400.5})).ok, true);
    assert.equal(direct, 2); assert.equal(relay, 4);
    process.stdout.write('fixture transport passed');
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, BROKER_RELAYS: "https://fixture-relay.invalid", BROKER_RELAY_SECRET: "fixture-only" },
  });
  assert.match(output, /fixture transport passed/);
});
