import test from "node:test";
import assert from "node:assert/strict";
import { raise, WebhookChannel, type NotificationChannel } from "../src/lib/cashtrap/alerts";
import { MemoryStore, type AlertInput, type AlertRow } from "../src/lib/cashtrap/store";

/** Alert delivery: in-app once per event, other channels at most once per alert — never twice, never late. */
class FakeChannel implements NotificationChannel {
  sent: AlertRow[] = [];
  constructor(readonly name: string, private ok = true, private on = true, private k = ["signal", "entry", "missed", "outcome"]) {}
  configured() { return this.on; }
  kinds() { return this.k; }
  async send(a: AlertRow) { this.sent.push(a); return this.ok ? { ok: true } : { ok: false, error: "HTTP 500" }; }
}
const alert = (key: string, kind: AlertInput["kind"] = "signal"): AlertInput => ({ dedupeKey: key, kind, symbol: "EURUSD", title: "EUR/USD: CALL", body: "Published 14:05:08 UTC." });

test("a new alert goes to each channel once; the same event raised again is not delivered again", async () => {
  const store = new MemoryStore();
  const ch = new FakeChannel("webhook");
  assert.equal(await raise(store, alert("signal:a"), 1_000, [ch]), true);
  assert.equal(await raise(store, alert("signal:a"), 2_000, [ch]), false);
  assert.equal(ch.sent.length, 1);
  assert.equal(store.alerts.length, 1);
  assert.deepEqual([...store.deliveries.values()].map((d) => d.status), ["sent"]);
});

test("a failed send is recorded and never retried; channels without credentials, or not taking the kind, are skipped", async () => {
  const store = new MemoryStore();
  const bad = new FakeChannel("bad", false);
  const off = new FakeChannel("off", true, false);
  const picky = new FakeChannel("picky", true, true, ["outcome"]);
  await raise(store, alert("signal:b"), 1_000, [bad, off, picky]);
  assert.deepEqual([bad.sent.length, off.sent.length, picky.sent.length], [1, 0, 0]);
  assert.deepEqual([...store.deliveries.entries()], [["1|bad|default", { status: "failed", error: "HTTP 500", at: 1_000 }]]);
  assert.equal(await store.reserveDelivery(1, "bad", "default", 5_000), false, "the reservation refuses a second send of the same alert");
});

test("a channel that throws does not stop the alert being raised in-app", async () => {
  const store = new MemoryStore();
  const boom: NotificationChannel = { name: "boom", configured: () => true, kinds: () => ["signal"], send: async () => { throw new Error("network down"); } };
  assert.equal(await raise(store, alert("signal:c"), 1_000, [boom]), true);
  assert.equal(store.alerts.length, 1);
});

test("the webhook is off unless both server variables are set; its kinds default to signal, entry, missed, outcome", () => {
  const keys = ["CASHTRAP_ALERT_WEBHOOK_URL", "CASHTRAP_ALERT_WEBHOOK_SECRET", "CASHTRAP_ALERT_WEBHOOK_KINDS"] as const;
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    const w = new WebhookChannel();
    assert.equal(w.configured(), false);
    process.env.CASHTRAP_ALERT_WEBHOOK_URL = "https://example.invalid/hook";
    assert.equal(w.configured(), false, "a URL without its secret is not enough");
    process.env.CASHTRAP_ALERT_WEBHOOK_SECRET = "s3cret";
    assert.equal(w.configured(), true);
    assert.deepEqual(w.kinds(), ["signal", "entry", "missed", "outcome"]);
    process.env.CASHTRAP_ALERT_WEBHOOK_KINDS = "armed, signal";
    assert.deepEqual(w.kinds(), ["armed", "signal"]);
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});
