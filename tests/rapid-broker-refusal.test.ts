import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brokerReadProblem, isBrokerRefusal, BROKER_API_ACCESS_OFF } from '../rapid/broker/refusal';

/**
 * SAY WHAT THE BROKER SAID (owner 09-29: "Rapid is also not working"). GenesisFX answered 403 on the
 * owner's login from Monday 09-28 15:32 CDT; Rapid's panel kept a stale "positions could not be read"
 * because the refusal was thrown past the row write, and the account loop died on it every pass.
 */
test('a 403 / "not allowed to use this API endpoint" reads as the broker switch, with the fix', () => {
  assert.equal(brokerReadProblem('rapid_broker_config_unavailable: config unavailable (403)'), BROKER_API_ACCESS_OFF);
  assert.equal(brokerReadProblem('instruments unavailable (403)'), BROKER_API_ACCESS_OFF);
  assert.equal(brokerReadProblem('You are not allowed to use this API endpoint. Please check with your broker whether they allow API access'), BROKER_API_ACCESS_OFF);
  assert.match(BROKER_API_ACCESS_OFF, /^broker_api_access_off \(403\)/);
  assert.match(BROKER_API_ACCESS_OFF, /Ask the broker to enable API access/);
});

test('every other broker error passes through unchanged', () => {
  for (const e of ['quote unavailable (429)', 'positions unavailable (503)', 'timeout', 'reconnect required']) {
    assert.equal(brokerReadProblem(e), e);
    assert.equal(isBrokerRefusal(e), false);
  }
});

test('a refusal is recorded on the account and the pass moves on', () => {
  const port = readFileSync('rapid/exec/tradelockerPort.ts', 'utf8');
  assert.ok(/async positions\(\)[\s\S]*?try \{ await this\.ensureConfig\(\); \} catch/.test(port), 'positions() answers instead of throwing on a config refusal');
  const prep = readFileSync('rapid/exec/prepare.ts', 'utf8');
  assert.ok(/patch\.block_reason = brokerReadProblem\(s\.error\)/.test(prep), 'instrument refusal is written honestly');
  assert.ok(/if \(!positions\.ok\) ownership\.reason = /.test(prep), 'positions refusal is written honestly');
  assert.ok(/update\(\{ block_reason: reason, updated_at/.test(prep), 'a thrown failure still reaches the row');
  const worker = readFileSync('rapid/worker/index.ts', 'utf8');
  const loop = worker.slice(worker.indexOf('async function accountLoop'), worker.indexOf('await beat("rapid-accounts"'));
  assert.ok(/try \{\s*await withLease\(/.test(loop) && /catch \(e\) \{\s*await health\("rapid-account", "degraded"/.test(loop), 'one account cannot end the pass for the rest');
  const status = readFileSync('src/app/api/rapid/status/route.ts', 'utf8');
  assert.ok(/\/\^broker_api_access_off\/\.test\(a\.block_reason\)/.test(status), 'the panel shows the refusal as itself');
});
