import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountStrategyConsent, accountStrategyName, NitrousStrategyOptions, aggressiveAccountMessage, sweepAccountMessage } from "../src/components/om/nitrous/NitrousStrategyOptions";
import { NITROUS_AGGRESSIVE_CONSENT_VERSION, NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION, NITROUS_SWEEP_CONSENT_VERSION } from "../src/lib/nitrous/policy";

const original = { mode: "nitrous" as const, fastStrategyEnabled: false, sweepStrategyEnabled: false, automationEnabled: true };
const fast = { ...original, fastStrategyEnabled: true };
const sweep = { ...fast, sweepStrategyEnabled: true };
const renderOptions = (value: string, disabled = false) => renderToStaticMarkup(React.createElement(NitrousStrategyOptions, { value, disabled, onChange: () => {} }));
const selectedInputs = (html: string) => [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).filter(input => input.includes('checked=""'));

test("reopening authorization preserves existing original and v2 rules without adding sweep", () => {
  assert.equal(accountStrategyConsent(original, "nitrous"), NITROUS_CONSENT_VERSION);
  assert.equal(accountStrategyConsent(fast, "nitrous"), NITROUS_FAST_CONSENT_VERSION);
  assert.equal(accountStrategyConsent(sweep, "nitrous"), NITROUS_SWEEP_CONSENT_VERSION);
  assert.equal(accountStrategyConsent(sweep, "slow_drip"), NITROUS_CONSENT_VERSION);
  assert.equal(accountStrategyConsent({ ...sweep, mode: "slow_drip" }, "nitrous"), NITROUS_CONSENT_VERSION);
  assert.equal(accountStrategyName(fast), "Faster Nitrous");
  const selected = selectedInputs(renderOptions(accountStrategyConsent(fast, "nitrous")));
  assert.equal(selected.length, 1);
  assert.ok(selected[0].includes(`value="${NITROUS_FAST_CONSENT_VERSION}"`));
  assert.ok(!selected[0].includes(NITROUS_SWEEP_CONSENT_VERSION));
});

test("the explicit v3 choice discloses closed reclaim entry and unchanged risk", () => {
  const html = renderOptions(NITROUS_SWEEP_CONSENT_VERSION);
  assert.equal(selectedInputs(html).length, 1);
  assert.ok(selectedInputs(html)[0].includes(`value="${NITROUS_SWEEP_CONSENT_VERSION}"`));
  for (const text of ["already confirmed swing high or low", "completed 5- or 15-minute candle", "near the reclaim close without another retest", "unproven", "risk per trade and daily loss allowance stay the same"])
    assert.ok(html.includes(text), text);
  assert.match(renderOptions(NITROUS_SWEEP_CONSENT_VERSION, true), /<fieldset disabled=""/);
});

test("account strategy status distinguishes available, authorized, paused and stale", () => {
  assert.match(sweepAccountMessage(fast, true), /available, but this account has not authorized it/);
  assert.match(sweepAccountMessage(sweep, true), /authorized on this account/);
  assert.match(sweepAccountMessage({ ...sweep, automationEnabled: false }, true), /Auto trading is paused/);
  assert.match(sweepAccountMessage(sweep, false), /Refreshing this account/);
  assert.match(sweepAccountMessage(null, true), /Connect an account and review/);
  assert.match(sweepAccountMessage({ ...sweep, mode: "slow_drip" }, true), /has not authorized it/);
});

test("aggressive entries are a separate account choice and describe the additional gold strategies", () => {
  const account = { ...sweep, aggressiveStrategyEnabled: true };
  assert.equal(accountStrategyConsent(account, "nitrous"), NITROUS_AGGRESSIVE_CONSENT_VERSION);
  assert.equal(accountStrategyName(account), "Aggressive entries");
  assert.equal(accountStrategyConsent(account, "slow_drip"), NITROUS_CONSENT_VERSION);
  for (const prior of [original, fast, sweep]) {
    assert.doesNotMatch(selectedInputs(renderOptions(accountStrategyConsent(prior, "nitrous")))[0], /v4-aggressive/);
  }
  const html = renderOptions(NITROUS_AGGRESSIVE_CONSENT_VERSION);
  assert.equal(selectedInputs(html).length, 1);
  assert.match(selectedInputs(html)[0], /v4-aggressive/);
  for (const text of ["Range edge rejection", "Compression breakout", "5-minute candle", "sideways", "Includes all earlier strategies", "risk per trade and daily loss allowance stay the same"]) assert.ok(html.includes(text), text);
  assert.match(html, /tests it again/);
  assert.match(html, /together lost money after estimated trading costs/);
  assert.doesNotMatch(renderOptions(NITROUS_SWEEP_CONSENT_VERSION), /together lost money/);
  assert.match(aggressiveAccountMessage(sweep, true), /Watching only/);
  assert.match(aggressiveAccountMessage(account, true), /authorized on this account/);
  assert.match(aggressiveAccountMessage({ ...account, automationEnabled: false }, true), /paused/);
  assert.match(aggressiveAccountMessage(account, false), /Checking/);
  assert.match(aggressiveAccountMessage(null, true), /Connect/);
});
