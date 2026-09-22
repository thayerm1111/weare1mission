import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneOf, zoneAction } from "../src/lib/genx/zoneSetups";

test("reads the page setup GENX is showing", () => {
  assert.deepEqual(zoneOf({ action: "WAIT_FOR_SELL_TRIGGER", entry: 4348.2, stop_loss: 4356.87, tp1: 4319.29, tp2: null, tp3: null }),
    { side: "sell", entry: 4348.2, stop: 4356.87, tp1: 4319.29, tp2: null, tp3: null });
  assert.equal(zoneOf({ action: "BUY_LIMIT", entry: 4338.13, stop_loss: 4332.54, tp1: 4356.77 })?.side, "buy");
  assert.equal(zoneOf({ action: "WAIT", entry: 4338, stop_loss: 4332, tp1: 4356 }), null);
  assert.equal(zoneOf({ action: "SELL_NOW", entry: 4338, stop_loss: 4345, tp1: 4320 }), null, "ENTER NOW calls stay on the scanner path");
  assert.equal(zoneOf({ action: "WAIT_FOR_SELL_TRIGGER", entry: 4348, stop_loss: 4340, tp1: 4320 }), null, "stop on the wrong side");
});

test("enters on touch, drops through the stop, otherwise waits", () => {
  assert.equal(zoneAction("sell", 4348.2, 4356.87, 4341), "wait");
  assert.equal(zoneAction("sell", 4348.2, 4356.87, 4347.95), "enter");
  assert.equal(zoneAction("sell", 4348.2, 4356.87, 4350), "enter");
  assert.equal(zoneAction("sell", 4348.2, 4356.87, 4357), "invalidate");
  assert.equal(zoneAction("buy", 4338.13, 4332.54, 4345), "wait");
  assert.equal(zoneAction("buy", 4338.13, 4332.54, 4338.4), "enter");
  assert.equal(zoneAction("buy", 4338.13, 4332.54, 4332), "invalidate");
});
