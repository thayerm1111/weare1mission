import test from "node:test";
import assert from "node:assert/strict";
import { scanWithAtlas, parseAtlasPulseResult, PULSE_UPDATED_EVENT } from "../src/lib/atlas/pulse";

const candidate = {
  symbol: "EUR/USD", name: "Euro", td: "EUR/USD", dir: "LONG", price: 1.0823,
  confirmed: 6, total: 8, checklist: [{ label: "Trend aligned", ok: true }], zone: "discount", rsi: 54,
  entry: 1.0823, stopLoss: 1.0801, takeProfits: [1.0856, 1.0878, 1.0911], riskReward: "1:2.5",
};
const read = { asOf: "2026-11-21 18:23 UTC", setups: [candidate] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function browserMock(run: (stored: Map<string, string>, events: { name: string; detail?: unknown }[]) => Promise<void>) {
  const names = ["window", "localStorage", "CustomEvent"] as const;
  const old = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const stored = new Map<string, string>([["om_pulse_v1", "previous saved scan"]]);
  const events: { name: string; detail?: unknown }[] = [];
  class DetailEvent extends Event { detail: unknown; constructor(name: string, init: { detail?: unknown } = {}) { super(name); this.detail = init.detail; } }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: (event: Event) => { events.push({ name: event.type, detail: (event as DetailEvent).detail }); return true; } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: DetailEvent });
  try { await run(stored, events); }
  finally { names.forEach((name, index) => { if (old[index]) Object.defineProperty(globalThis, name, old[index]!); else Reflect.deleteProperty(globalThis, name); }); }
}

test("Atlas scan preserves scanner levels, ranking and time, synchronizes Pulse, and makes one read request", async (t) => {
  const calls: { url: string; method?: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return json({ ...read, credits: { dailyLeft: 0, purchased: 20 }, cached: true });
  });
  await browserMock(async (stored, events) => {
    const result = await scanWithAtlas();
    assert.deepEqual(result, read);
    assert.deepEqual(JSON.parse(stored.get("om_pulse_v1")!), read);
    assert.deepEqual(calls, [{ url: "/api/om-scan", method: "POST" }]);
    assert.deepEqual(events, [{ name: PULSE_UPDATED_EVENT, detail: read }, { name: "credits-updated", detail: undefined }]);
    assert.equal(result.setups[0].entry, candidate.entry);
    assert.equal(result.setups[0].stopLoss, candidate.stopLoss);
    assert.deepEqual(result.setups[0].takeProfits, candidate.takeProfits);
  });
});

test("failed or unconfigured scans retain the prior result and publish no completed-read event", async (t) => {
  const responses = [
    json({ error: "unauthorized" }, 401),
    json({ error: "insufficient_credits" }, 402),
    json({ notConfigured: "marketdata" }),
    json({ error: "ratelimit", detail: "The feed needs a moment." }, 429),
    json({ error: "insufficient_data" }),
    json({ asOf: read.asOf, setups: "not a list" }),
    new Response("Service unavailable", { status: 503 }),
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => responses[calls++]);
  await browserMock(async (stored, events) => {
    for (let i = 0; i < responses.length; i++) {
      await assert.rejects(scanWithAtlas());
      assert.equal(stored.get("om_pulse_v1"), "previous saved scan");
      assert.deepEqual(events, []);
    }
    assert.equal(calls, responses.length, "a failure is not automatically retried");
  });
});

test("a valid empty scan replaces the older scan without inventing a candidate", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ asOf: read.asOf, setups: [], credits: null }));
  await browserMock(async (stored, events) => {
    const result = await scanWithAtlas();
    assert.deepEqual(result.setups, []);
    assert.deepEqual(JSON.parse(stored.get("om_pulse_v1")!), result);
    assert.equal(events[0].name, PULSE_UPDATED_EVENT);
  });
});

test("unsupported assets and malformed candidate directions never become trade suggestions", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ asOf: read.asOf, setups: [
    candidate, null, { ...candidate, td: "INVENTED" }, { ...candidate, dir: "BUY" }, { ...candidate, confirmed: "8" },
  ] }));
  await browserMock(async () => {
    const result = await scanWithAtlas();
    assert.deepEqual(result.setups, [candidate]);
  });
});

test("a completed scan remains usable and synchronized when device saving fails", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json(read); });
  await browserMock(async (stored, events) => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: () => { throw new Error("Storage unavailable"); } } });
    const result = await scanWithAtlas();
    assert.deepEqual(result, read);
    assert.equal(calls, 1);
    assert.equal(stored.get("om_pulse_v1"), "previous saved scan");
    assert.equal(events[0].name, PULSE_UPDATED_EVENT);
  });
});

test("an interrupted connection neither removes saved candidates nor retries the chargeable request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Disconnected"); });
  await browserMock(async (stored, events) => {
    await assert.rejects(scanWithAtlas(), /Disconnected/);
    assert.equal(calls, 1);
    assert.equal(stored.get("om_pulse_v1"), "previous saved scan");
    assert.deepEqual(events, []);
  });
});

test("restored scans reject corrupt rows, strip unrecognized fields, and preserve the source read", () => {
  assert.equal(parseAtlasPulseResult({ asOf: read.asOf, setups: [null] }), null);
  assert.equal(parseAtlasPulseResult({ asOf: "not a date", setups: [] }), null);
  assert.equal(parseAtlasPulseResult({ ...read, setups: [{ ...candidate, checklist: [null] }] }), null);
  assert.equal(parseAtlasPulseResult({ ...read, setups: [{ ...candidate, confirmed: 99 }] }), null);
  assert.equal(parseAtlasPulseResult({ ...read, setups: [{ ...candidate, takeProfits: ["1.09"] }] }), null);
  assert.deepEqual(parseAtlasPulseResult({ ...read, execute: true, setups: [{ ...candidate, accountId: "other", url: "/api/flow/execute" }] }), read);
  assert.deepEqual(parseAtlasPulseResult({ ...read, setups: [candidate, candidate] })?.setups, [candidate]);
});

test("a scan finishing after a member switch never writes into the new session", async (t) => {
  let current = true, calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; current = false; return json(read); });
  await browserMock(async (stored, events) => {
    await assert.rejects(scanWithAtlas(() => current), /previous signed-in session/);
    assert.equal(calls, 1);
    assert.equal(stored.get("om_pulse_v1"), "previous saved scan");
    assert.deepEqual(events, []);
    await assert.rejects(scanWithAtlas(() => current), /previous signed-in session/);
    assert.equal(calls, 1, "an already stale action makes no request");
  });
});
