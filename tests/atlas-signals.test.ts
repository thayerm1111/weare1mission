import test from "node:test";
import assert from "node:assert/strict";
import {
  atlasPlayResult, atlasGenxResult, atlasExecution, atlasSignalContext,
  generateAtlasSignal, mergeSavedPlays, saveAtlasPlay, SIGNALS_UPDATED_EVENT, GENX_UPDATED_EVENT,
  type AtlasSignalResult,
} from "../src/lib/atlas/signals";

const now = 1_800_000_000_000;
const playPayload = (signal: Record<string, unknown> = {}) => ({
  symbol: "BTC/USD", name: "Bitcoin", market: "Crypto", td: "BTC/USD", interval: "1h", orderType: "Limit",
  style: "Intraday (1H)", price: 70_000, asOf: "2026-11-21 12:00:00", as_of: "2026-11-21T12:14:00Z", marketClosed: false,
  candles: [{ t: "2026-11-21 12:00:00", o: 70_000, h: 70_020, l: 69_980, c: 70_000 }],
  signal: {
    direction: "LONG", status: "no_trade", entry: 70_000, stopLoss: 69_500, takeProfits: [71_000, 71_500],
    confidence: "Medium", riskReward: "1:2", timeframe: "Intraday", rationale: "The pullback is still developing.",
    invalidation: "A close below 69,500.", no_trade_reason: "Waiting for the closed-candle trigger.", ...signal,
  },
});
const genxPayload = (action = "WAIT_FOR_SELL_TRIGGER") => ({
  ok: true, signal_id: "saved-gold-read", symbol: "XAU/USD", mode: "quick", price: 3_500,
  asOf: "2026-11-21T12:14:00Z", data_status: "reference",
  genx: {
    action, mode: "quick", entry: 3_500, entry_low: 3_499, entry_high: 3_501, stop_loss: 3_505,
    tp1: 3_490, tp2: 3_485, tp3: null, confidence_score: 71,
    market_story: ["Gold is testing resistance."], trigger_condition: "Wait for a closed rejection candle.",
    invalidation_reason: "A close above resistance.", trade_reasoning: ["A lower high is forming."], risk_factors: [],
  },
});

test("OM adapter preserves no-trade, exact levels, and candle/analysis timestamps", () => {
  const raw = playPayload();
  const result = atlasPlayResult(raw, now)!;
  assert.equal(result.id, now);
  assert.equal(result.status, "open");
  assert.equal(result.signal, raw.signal, "Atlas does not regenerate or adjust the engine signal");
  assert.equal(result.signal.status, "no_trade");
  assert.deepEqual(result.candles, raw.candles);
  assert.equal(result.asOf, raw.asOf);
  assert.equal(result.as_of, raw.as_of);
  assert.equal(atlasPlayResult({ ...raw, td: "INVENTED" }), null);
  assert.equal(atlasPlayResult({ ...raw, signal: { direction: "MAYBE" } }), null);
});

test("ticket eligibility never promotes an unconfirmed OM idea or a waiting GENX plan", () => {
  const play: AtlasSignalResult = { kind: "plays", result: atlasPlayResult(playPayload(), now)!, saved: "synced" };
  assert.deepEqual(atlasExecution(play), { symbol: "BTC/USD", direction: "LONG", entry: 70_000, stop: 69_500, tp: 71_000, unconfirmed: true, orderType: "Limit" });
  assert.equal(atlasExecution({ ...play, result: atlasPlayResult(playPayload({ direction: "NEUTRAL" }), now)! }), null);
  assert.equal(atlasExecution({ ...play, result: atlasPlayResult(playPayload({ stopLoss: null }), now)! }), null);
  assert.equal(atlasPlayResult(playPayload({ entry: NaN }), now), null);
  const genx: AtlasSignalResult = { kind: "genx", result: atlasGenxResult(genxPayload())!, saved: "synced" };
  assert.equal(atlasExecution(genx)?.unconfirmed, true);
  assert.equal(atlasExecution(genx)?.direction, "SHORT");
  assert.equal(atlasExecution({ ...genx, result: atlasGenxResult(genxPayload("SELL_NOW"))! })?.unconfirmed, false);
  assert.equal(atlasExecution({ ...genx, result: atlasGenxResult(genxPayload("WAIT"))! }), null);
  assert.equal(atlasExecution({ ...genx, result: atlasGenxResult(genxPayload("BUY_LIMIT"))! })?.unconfirmed, true);
});

test("GENX adapter and assistant context preserve the actual gold read", () => {
  const raw = genxPayload();
  const result = atlasGenxResult(raw)!;
  assert.equal(result, raw);
  const context = atlasSignalContext({ kind: "genx", result, saved: "synced" });
  assert.equal(context.source, "GENX");
  assert.equal(context.data?.genx, raw.genx);
  assert.equal(context.data?.asOf, raw.asOf);
  assert.match(context.label, /Waiting for a sell trigger/);
  assert.equal(atlasGenxResult({ ...raw, symbol: "EUR/USD" }), null);
  assert.equal(atlasGenxResult({ error: "insufficient_data" }), null);
  assert.equal(atlasGenxResult({ ...raw, mode: { invalid: true } }), null);
  assert.equal(atlasGenxResult({ ...raw, genx: { ...raw.genx, trigger_condition: { invalid: true } } }), null);
  assert.equal(atlasGenxResult({ ...raw, genx: { ...raw.genx, market_story: [null] } }), null);
  assert.equal(atlasPlayResult(playPayload({ rationale: { invalid: true } })), null);
  assert.equal(atlasPlayResult(playPayload({ takeProfits: "71,000" })), null);
  assert.equal(atlasPlayResult(playPayload({ status: "WAIT" })), null, "an unknown state is never promoted to a setup");
});

test("saved-play merging preserves other records and replaces only matching ids", () => {
  const existing: { id: number | string; asOf?: string; createdAt?: string; label: string }[] = [{ id: now, asOf: "2026-11-21T00:00:00Z", label: "old copy" }, { id: "phone-play", createdAt: "2026-11-20T00:00:00Z", label: "phone" }];
  const merged = mergeSavedPlays(existing, [{ id: now, label: "new copy" }, { id: now + 1, label: "new read" }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].label, "new read");
  assert.equal(merged[1].label, "new copy");
  assert.ok(merged.some((item) => item.label === "phone"));
  assert.equal(mergeSavedPlays(existing, [], 1).length, 1);
});

async function browserMock(run: (data: Map<string, string>, events: string[]) => Promise<void>) {
  const names = ["window", "localStorage", "CustomEvent"] as const;
  const old = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const data = new Map<string, string>(), events: string[] = [];
  const target = new EventTarget();
  for (const name of [SIGNALS_UPDATED_EVENT, GENX_UPDATED_EVENT, "credits-updated", "open-credits-flyer"]) target.addEventListener(name, () => events.push(name));
  class DetailEvent extends Event { detail: unknown; constructor(name: string, init: { detail?: unknown } = {}) { super(name); this.detail = init.detail; } }
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: DetailEvent });
  try { await run(data, events); await new Promise((resolve) => setImmediate(resolve)); }
  finally { names.forEach((name, index) => { if (old[index]) Object.defineProperty(globalThis, name, old[index]!); else Reflect.deleteProperty(globalThis, name); }); }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a generated OM result is saved and synchronized without submitting any order", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === "/api/om-signal") {
      assert.deepEqual(JSON.parse(String(init?.body)).confirmations, ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"]);
      return json(playPayload());
    }
    if (url === "/api/signals") return json({ ok: true, saved: 1 });
    if (url === "/api/game") return json({ enabled: true });
    throw new Error("Unexpected request: " + url);
  });
  await browserMock(async (data, events) => {
    const result = await generateAtlasSignal({ tool: "plays", td: "BTC/USD" });
    assert.equal(result.saved, "synced");
    assert.equal(JSON.parse(data.get("om_signals")!)[0].signal.status, "no_trade");
    assert.ok(events.includes(SIGNALS_UPDATED_EVENT));
    assert.ok(events.includes("credits-updated"));
    assert.equal(calls.filter((url) => url === "/api/om-signal").length, 1);
    assert.ok(!calls.some((url) => url.includes("/flow/")));
  });
});

test("save failure returns the completed read without another paid generation", async (t) => {
  let generated = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/om-signal") { generated++; return json(playPayload()); }
    if (url === "/api/signals") throw new Error("offline");
    if (url === "/api/game") return json({ enabled: true });
    throw new Error("Unexpected request");
  });
  await browserMock(async () => {
    const result = await generateAtlasSignal({ tool: "plays", td: "BTC/USD" });
    assert.equal(result.saved, "device");
    assert.equal(result.kind, "plays");
    assert.equal(generated, 1);
  });
});

test("GENX uses its own persisted read and announces it without duplicate storage or orders", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return json(genxPayload()); });
  await browserMock(async (_, events) => {
    const result = await generateAtlasSignal({ tool: "genx", mode: "swing" });
    assert.equal(result.saved, "synced");
    assert.deepEqual(calls, ["/api/genx"]);
    assert.ok(events.includes(GENX_UPDATED_EVENT));
  });
});

test("unknown markets, cancelled starts and credit errors cannot become signals", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ error: "insufficient_credits" }, 402); });
  await browserMock(async (_, events) => {
    await assert.rejects(generateAtlasSignal({ tool: "plays", td: "INVENTED" }), { code: "unknown_asset" });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(generateAtlasSignal({ tool: "genx" }, abort.signal), { name: "AbortError" });
    assert.equal(calls, 0);
    await assert.rejects(generateAtlasSignal({ tool: "genx" }), { code: "insufficient_credits", status: 402 });
    assert.deepEqual(events, ["open-credits-flyer"]);
  });
});

test("saving reports unavailable when both device and server cannot retain a result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ error: "db_error" }, 500));
  await browserMock(async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { throw new Error("disabled"); } } });
    assert.equal(await saveAtlasPlay(atlasPlayResult(playPayload(), now)!), "unavailable");
  });
});

test("a generated read cannot be saved with a different member's later session", async (t) => {
  let current = true;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); current = false; return json(playPayload()); });
  await browserMock(async (data, events) => {
    await assert.rejects(generateAtlasSignal({ tool: "plays", td: "BTC/USD" }, undefined, () => current), { code: "session_changed" });
    assert.deepEqual(calls, ["/api/om-signal"], "no POST to /api/signals with the replacement session");
    assert.equal(data.has("om_signals"), false);
    assert.deepEqual(events, []);
    await assert.rejects(generateAtlasSignal({ tool: "genx" }, undefined, () => current), { code: "session_changed" });
    assert.equal(calls.length, 1, "an already stale action makes no request");
  });
});
