import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatedTrade, statedTradeFrom, tradeGuidanceLines } from '../command-center/brain/statedTrade';

test("owner's question 09-21: in at 4369, price 4362, support 4359", () => {
  const t = parseStatedTrade('Should I pull out of the trade? I sold at 4369 and price is at 4362 and it is not breaking 4359', 4362);
  assert.ok(t);
  assert.equal(t!.side, 'sell');
  assert.equal(t!.entry, 4369);
});

test('spoken numbers arrive split — "43 69" is 4369', () => {
  const t = parseStatedTrade("I'm short from 43 69 with my stop at 43 74", 4362);
  assert.equal(t?.entry, 4369);
  assert.equal(t?.stop, 4374);
});

test('long with stop and target', () => {
  const t = parseStatedTrade('bought gold at 4355.5, stop 4349, target 4372', 4360);
  assert.deepEqual([t?.side, t?.entry, t?.stop, t?.target], ['buy', 4355.5, 4349, 4372]);
});

test('a question with no trade in it is not a trade', () => {
  assert.equal(parseStatedTrade('should I get out now?', 4362), null);
  assert.equal(parseStatedTrade('is 4359 holding?', 4362), null);
});

test('a number nowhere near gold is ignored', () => {
  assert.equal(parseStatedTrade('I sold at 1200', 4362), null);
});

test('the trade said earlier in the conversation is remembered; a later stop attaches to it', () => {
  const t = statedTradeFrom(['I took a short at 4369', 'what do you see?', 'my stop is 4375'], 4362);
  assert.equal(t?.entry, 4369);
  assert.equal(t?.stop, 4375);
});

test('guidance lines do the arithmetic from the trader side', () => {
  const L = tradeGuidanceLines('T', { side: 'sell', entry: 4369, stop: 4375, target: null }, 4362,
    [{ price: 4364.5, label: 'London high' }], [{ price: 4359, label: 'yesterday low' }]).join('\n');
  assert.match(L, /\+70 pips IN PROFIT/);
  assert.match(L, /4359\.00 \(yesterday low\)/);
  assert.match(L, /1\.17R/);
});
