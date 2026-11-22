import test from "node:test";
import assert from "node:assert/strict";
import {
  atlasPlayResult, atlasGenxResult, atlasExecution, atlasSignalContext,
  generateAtlasSignal, mergeSavedPlays, restoreAtlasSignalResult, saveAtlasPlay, SIGNALS_UPDATED_EVENT, GENX_UPDATED_EVENT,
  type AtlasSignalResult,
} from "../src/lib/atlas/signals";
import { normalizePlayDiagnostics } from "../src/lib/plays/diagnostics";
import { atlasContext } from "../src/lib/atlas/context";

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
  assert.deepEqual(result.signal, raw.signal, "Atlas does not regenerate or adjust the engine signal");
  assert.equal(result.signal.status, "no_trade");
  assert.deepEqual(result.candles, raw.candles);
  assert.equal(result.asOf, raw.asOf);
  assert.equal(result.as_of, raw.as_of);
  assert.equal(atlasPlayResult({ ...raw, td: "INVENTED" }), null);
  assert.equal(atlasPlayResult({ ...raw, signal: { direction: "MAYBE" } }), null);
});

const fiveFrames = () => ["4H", "1H", "30M", "15M", "5M"].map((tf, i) => ({
  tf, trend: i === 4 ? "ranging" : "bullish", aligned: i !== 4, confirmed: 1, total: 2,
  checklist: [{ label: "Closed-bar trend", ok: true }, { label: "Retest", ok: false }],
  asOf: `2026-11-21 ${String(8 + i).padStart(2, "0")}:00:00`, closed: true, unavailable: false,
}));

test("five-frame evidence survives a saved conversation without changing the play's identity or eligibility", () => {
  const diagnostics = fiveFrames();
  const raw = { ...playPayload({ timeframeConfirmations: diagnostics }), id: now, status: "win", hitTp: 2 };
  const saved = { kind: "plays", result: raw, saved: "synced" };
  const restored = restoreAtlasSignalResult(JSON.parse(JSON.stringify(saved)));
  assert.ok(restored?.kind === "plays");
  assert.equal(restored.result.id, now);
  assert.equal(restored.result.status, "win", "Price tracking is retained separately from the unconfirmed idea");
  assert.equal(restored.result.hitTp, 2);
  assert.deepEqual(normalizePlayDiagnostics(restored.result.signal).timeframeConfirmations, diagnostics);
  assert.equal(restored.result.asOf, raw.asOf);
  assert.equal(restored.result.as_of, raw.as_of);
  assert.equal(restored.result.price, raw.price);
  assert.equal(restored.result.signal.status, "no_trade");
  assert.equal(atlasExecution(restored)?.unconfirmed, true);
  assert.equal(atlasExecution(restored)?.entry, raw.signal.entry);
  assert.equal(atlasExecution(restored)?.stop, raw.signal.stopLoss);
  assert.deepEqual((raw.signal as Record<string, unknown>).timeframeConfirmations, diagnostics, "Normalization does not mutate the stored input");
});

test("damaged optional evidence is removed without losing a valid saved play or inventing confirmation", () => {
  const good = fiveFrames()[0];
  const missing = { ...fiveFrames()[1], unavailable: true, reason: "rate_limited", checklist: [null] };
  const raw = playPayload({
    timeframeConfirmations: [good, null, { ...fiveFrames()[2], checklist: [{ label: { unsafe: true }, ok: true }] }, missing],
    timeframes: [{ tf: "15m", trend: "bullish", confirmed: 1, total: 1, checklist: [{ label: "Structure", ok: true }] }, { tf: "5m", trend: "ranging", confirmed: 0, total: 1, checklist: null }],
    checklist: [{ label: "Trend", ok: "yes" }], flow: { h4: { unsafe: true }, h1: "bullish", dir: "LONG", aligned: true },
    setup: { unsafe: true }, verdict: ["object child"], confidence: { unsafe: true }, gate_score: Infinity,
  });
  const result = atlasPlayResult(raw, now);
  assert.ok(result, "Optional diagnostics cannot discard the paid read");
  const clean = normalizePlayDiagnostics(result.signal);
  assert.equal(clean.timeframes?.length, 1);
  assert.equal(clean.timeframeConfirmations?.length, 2);
  assert.deepEqual(clean.timeframeConfirmations?.[1], { tf: "1H", trend: null, aligned: null, confirmed: null, total: null, checklist: [], asOf: null, closed: true, unavailable: true, reason: "rate_limited" });
  for (const field of ["checklist", "flow", "setup", "verdict", "confidence", "gate_score"]) assert.equal((result.signal as Record<string, unknown>)[field], undefined, field);
  assert.equal(result.signal.rationale, raw.signal.rationale);
  assert.deepEqual(atlasExecution({ kind: "plays", result, saved: "device" }), { symbol: "BTC/USD", direction: "LONG", entry: 70_000, stop: 69_500, tp: 71_000, unconfirmed: true, orderType: "Limit" });
});

test("older saved diagnostics stay honest and bounded instead of gaining five invented reads", () => {
  const checklist = [{ label: "Trend", ok: true }, { label: "Retest", ok: false }];
  const legacy = {
    checklist, confirmed: 3, total: 6,
    timeframes: ["30m", "15m", "5m"].map((tf) => ({ tf, trend: "bullish", confirmed: 1, total: 2, checklist })),
    flow: { h4: "bullish", h1: "bullish", dir: "LONG", aligned: true },
  };
  const result = atlasPlayResult(playPayload(legacy), now)!;
  const clean = normalizePlayDiagnostics(result.signal);
  assert.deepEqual(clean.timeframes, legacy.timeframes);
  assert.deepEqual(clean.flow, legacy.flow);
  assert.equal(clean.confirmed, 3, "Legacy scalp aggregates are not recomputed from the primary-frame list");
  assert.equal(clean.timeframeConfirmations, undefined);
  assert.deepEqual(normalizePlayDiagnostics({ confirmed: 3 }), { confirmed: 3 }, "An older saved count remains usable without inventing its missing denominator");
  const oversized = normalizePlayDiagnostics({ checklist: Array.from({ length: 10_000 }, () => ({ label: "Large", ok: true })), timeframes: Array.from({ length: 1000 }, () => legacy.timeframes[0]), rationale: "x".repeat(20_001) });
  assert.equal(oversized.checklist, undefined);
  assert.ok(oversized.timeframes!.length <= 16);
  assert.equal(oversized.rationale, undefined);
});

test("Atlas can read every displayed check within the context budget even when legacy diagnostics are also saved", () => {
  const checklist = ["Trend", "Structure", "Fair value gap", "Liquidity", "Support / resistance", "Fibonacci", "Break and retest", "RSI"].map((label, i) => ({ label, ok: i % 2 === 0 }));
  const frames = fiveFrames().map((frame) => ({ ...frame, checklist, confirmed: 4, total: 8 }));
  const legacy = ["30m", "15m", "5m"].map((tf) => ({ tf, trend: "bullish", confirmed: 4, total: 8, checklist }));
  const result = atlasPlayResult(playPayload({
    setup: "Closed-bar retest", bias: "Bullish", poi: "Former resistance", liquidityTarget: "Previous high", verdict: "Wait for the retest.",
    flow: { h4: "bullish", h1: "bullish", dir: "LONG", aligned: true }, checklist, confirmed: 12, total: 24, timeframes: legacy,
    mtf: legacy.map(({ tf, trend }) => ({ tf, trend })), timeframeConfirmations: frames,
  }), now)!;
  const displayed = atlasSignalContext({ kind: "plays", result, saved: "synced" });
  const context = atlasContext({ result: { kind: "plays", data: displayed.data } });
  const facts = (context.result?.data as { signal: Record<string, unknown> }).signal;
  const kept = facts.timeframeConfirmations as typeof frames;
  assert.equal(kept.length, 5);
  assert.deepEqual(kept[4].checklist, checklist, "The final 5M row keeps all eight labels and explicit booleans");
  assert.deepEqual(kept.map((frame) => frame.asOf), frames.map((frame) => frame.asOf));
  assert.equal(facts.entry, result.signal.entry);
  assert.equal(facts.status, "no_trade");
  assert.equal(facts.timeframes, undefined, "Duplicated legacy checks are omitted only from the assistant's copy");
  assert.equal(facts.checklist, undefined);
  assert.deepEqual(result.signal.timeframes, legacy, "The saved/displayed history remains complete");
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
