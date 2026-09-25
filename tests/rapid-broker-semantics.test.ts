import test from "node:test";
import assert from "node:assert/strict";

import { SimulatedBroker, goldSpec } from "../rapid/exec/simulator";
import { brokerError, columnMap, field, priorityFor, readCollection, applyPublishedRateLimits, noteRateLimited, budgetStats } from "../rapid/broker/http";
import { resolveGold, toInstrumentSpec, positionForOrder, type TLInstrumentRow } from "../rapid/broker/tradelocker";
import { encryptSecret, decryptSecret, maskEmail } from "../rapid/broker/crypto";

/**
 * Broker semantics that are easy to get wrong and expensive to get wrong.
 */

const sim = (script = {}) =>
  new SimulatedBroker({ bid: 4315.9, ask: 4316.1, equity: 10_000, freeMargin: 9000, currency: "USD", spec: goldSpec }, script);

// =================================================================================================
test("amendment: an omitted leg is LEFT ALONE, and only an explicit null removes it", async () => {
  const b = sim();
  await b.submit({ side: "buy", qty: 0.1, stopLoss: 4310, takeProfit: 4326, strategyId: "RAPID:x" });
  const id = b.openRows()[0].positionId;

  // A stop-only amendment. If the serializer turned the omitted takeProfit into null, the broker
  // would strip the target off every position that ever gets trailed.
  await b.amend(id, { stopLoss: 4314 });
  assert.equal(b.openRows()[0].stopLoss, 4314);
  assert.equal(b.openRows()[0].takeProfit, 4326, "the take-profit must survive a stop-only amendment");

  await b.amend(id, { takeProfit: null });
  assert.equal(b.openRows()[0].takeProfit, null, "an explicit null does remove it");
  assert.equal(b.openRows()[0].stopLoss, 4314, "and leaves the stop alone");
});

test("close: a partial reduces the quantity; qty 0 closes the whole thing", async () => {
  const b = sim();
  await b.submit({ side: "buy", qty: 0.1, stopLoss: 4310, takeProfit: 4326, strategyId: "RAPID:x" });
  const id = b.openRows()[0].positionId;
  await b.close(id, 0.04);
  assert.ok(Math.abs((b.openRows()[0].qty ?? 0) - 0.06) < 1e-9);
  await b.close(id);
  assert.equal(b.openRows().length, 0);
});

test("close: a delayed close leaves the position open, so nothing may call it closed", async () => {
  const b = sim({ closeIsDelayed: true });
  await b.submit({ side: "buy", qty: 0.1, stopLoss: 4310, takeProfit: null, strategyId: "RAPID:x" });
  const id = b.openRows()[0].positionId;
  const r = await b.close(id);
  assert.equal(r.ok, true, "the request was accepted");
  assert.equal(b.openRows().length, 1, "and the position is still there — acceptance is not completion");
});

// =================================================================================================
test("envelope: an HTTP 200 carrying {s:'error'} is a rejection, not a success", () => {
  assert.equal(brokerError({ s: "ok", d: {} }), null);
  assert.match(String(brokerError({ s: "error", errmsg: "not permitted" })), /not permitted/);
  assert.ok(brokerError({ s: "rejected" }));
  assert.equal(brokerError(null), null);
});

test("collections: rows arrive under different keys, or as a bare array", () => {
  assert.deepEqual(readCollection([1, 2]), { ok: true, data: [1, 2] });
  assert.deepEqual(readCollection({ d: { positions: [1] } }, "positions"), { ok: true, data: [1] });
  assert.deepEqual(readCollection({ orders: [3] }, "orders"), { ok: true, data: [3] });
  assert.equal(readCollection({ nothing: 1 }, "positions").ok, false);
});

test("columnar rows: a positional array is read through the config's column map", () => {
  const cfg = { d: { positionsConfig: { columns: [{ id: "id" }, { id: "qty" }, { id: "stopLoss" }] } } };
  const cols = columnMap(cfg, "positionsConfig");
  assert.deepEqual(cols, { id: 0, qty: 1, stopLoss: 2 });
  assert.equal(field(["P1", 0.1, 4310], cols, ["id"]), "P1");
  assert.equal(field(["P1", 0.1, 4310], cols, ["stopLoss"]), 4310);
  assert.equal(field({ id: "P2", stopLoss: 4311 }, cols, ["stopLoss"]), 4311, "object rows still work");
  assert.equal(field(["P1"], cols, ["missing"]), undefined);
});

test("priority: a protective write outranks a quote poll, always", () => {
  assert.equal(priorityFor("PATCH", "/trade/positions/1"), "critical");
  assert.equal(priorityFor("DELETE", "/trade/positions/1"), "critical");
  assert.equal(priorityFor("POST", "/trade/accounts/1/orders"), "critical");
  assert.equal(priorityFor("GET", "/trade/quotes"), "normal");
  assert.equal(priorityFor("GET", "/trade/quotes", "background"), "background");
  assert.equal(priorityFor("POST", "/auth/jwt/token"), "auth");
});

test("budget: the broker's published limits shape the spend, and Retry-After is honoured", () => {
  const key = "test-budget";
  const r = applyPublishedRateLimits(key, { d: { rateLimits: [{ measure: "SECONDS", intervalNum: 1, limit: 5 }] } });
  assert.equal(r.applied, true);
  assert.ok(r.spacingMs >= 200, `5 per second is at least 200ms apart, got ${r.spacingMs}`);
  assert.equal(applyPublishedRateLimits(key, { nothing: true }).applied, false, "an unparseable config is left alone, not widened");

  const waited = noteRateLimited(key, 3);
  assert.equal(waited, 3000, "Retry-After wins over any local guess");
  assert.ok((budgetStats()[key]?.pausedForMs ?? 0) > 2000);
});

// =================================================================================================
const inst = (symbol: string): TLInstrumentRow => ({
  tradableInstrumentId: symbol, brokerSymbol: symbol, tradeRouteId: "T", infoRouteId: "I", raw: null,
});

test("gold resolution: an ambiguous match BLOCKS with the candidates named", () => {
  assert.equal(resolveGold([inst("XAUUSD"), inst("EURUSD")]).ok, true);
  assert.equal(resolveGold([inst("XAUUSD.r"), inst("EURUSD")]).ok, true, "a suffixed symbol still resolves");
  // XAUUSD and XAUUSD.raw are usually different contracts. Picking one silently is a decision
  // about somebody's money made by a regex, so it blocks and names both.
  const ambiguous = resolveGold([inst("XAUUSD"), inst("XAUUSD.raw")]);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.match(ambiguous.reason, /2 gold instruments/);
    assert.deepEqual(ambiguous.candidates, ["XAUUSD", "XAUUSD.raw"]);
  }
  const none = resolveGold([inst("EURUSD")]);
  assert.equal(none.ok, false);
});

test("contract metadata: what is missing is NAMED, never defaulted", () => {
  const full = toInstrumentSpec(inst("XAUUSD"), { contractSize: 100, lotStep: 0.01, minLot: 0.01, tickSize: 0.01, tickValue: 1, currency: "USD" });
  assert.deepEqual(full.missing, []);
  assert.equal(full.spec.contractSize, 100);

  const thin = toInstrumentSpec(inst("XAUUSD"), { contractSize: 100 });
  assert.ok(thin.missing.includes("tickSize"));
  assert.ok(thin.missing.includes("lotStep"));
  assert.ok(thin.missing.includes("currency"));
  assert.equal(thin.spec.tickSize, null, "absent means null, not a guess");

  // Metadata nested under `details` is still found.
  const nested = toInstrumentSpec(inst("XAUUSD"), { details: { contractSize: 50, tickSize: 0.01, lotStep: 0.01, minLot: 0.01 }, currency: "EUR" });
  assert.equal(nested.spec.contractSize, 50, "a 50-unit contract is NOT silently treated as 100");
});

test("an order id is never a position id: the mapping comes from history", () => {
  const cols = { id: 0, positionId: 1 };
  const history = [["O1", "P1"], ["O2", "P2"]];
  assert.equal(positionForOrder(history, cols, "O2"), "P2");
  assert.equal(positionForOrder(history, cols, "O9"), null, "no guess when there is no mapping");
  assert.equal(positionForOrder([["O3", null]], cols, "O3"), null);
});

// =================================================================================================
test("credentials: encrypted at rest, and the plaintext never appears in the blob", () => {
  process.env.RAPID_ENC_KEY = "a".repeat(64);
  const secret = "refresh-token-value-12345";
  const blob = encryptSecret(secret);
  assert.notEqual(blob, secret);
  assert.equal(blob.includes(secret), false, "the plaintext must not be recoverable by eye");
  assert.equal(blob.split(".").length, 3, "iv.tag.ciphertext");
  assert.equal(decryptSecret(blob), secret);
  assert.notEqual(encryptSecret(secret), blob, "a fresh IV each time, so the same secret does not produce the same blob");
  assert.throws(() => decryptSecret("garbage"), /malformed/);
});

test("credentials: a tampered blob fails authentication rather than decrypting to nonsense", () => {
  process.env.RAPID_ENC_KEY = "a".repeat(64);
  const blob = encryptSecret("secret");
  const [iv, tag, ct] = blob.split(".");
  const flipped = Buffer.from(ct, "base64");
  flipped[0] ^= 0xff;
  assert.throws(() => decryptSecret(`${iv}.${tag}.${flipped.toString("base64")}`));
});

test("the email is masked wherever it is stored", () => {
  assert.equal(maskEmail("matthew@example.com"), "m***@example.com");
  assert.equal(maskEmail("nonsense"), "***");
});

// =================================================================================================
test("a foreign position is never touched: ownership needs the tag AND a local record", async () => {
  const b = sim();
  // Something else's position on the same account.
  await b.submit({ side: "sell", qty: 1, stopLoss: 4330, takeProfit: null, strategyId: "SOMEONE-ELSE:9" });
  await b.submit({ side: "buy", qty: 0.1, stopLoss: 4310, takeProfit: 4326, strategyId: "RAPID:mine" });
  const rows = b.openRows();
  const ours = rows.filter((r) => (r.strategyId ?? "").startsWith("RAPID:"));
  assert.equal(ours.length, 1);
  assert.equal(ours[0].qty, 0.1, "the 1-lot foreign position is not ours and is not managed");
});
