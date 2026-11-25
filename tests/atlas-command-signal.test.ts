import test from "node:test";
import assert from "node:assert/strict";
import {
  AtlasCommandSignalError, atlasCommandSignalContext, atlasCommandSignalSupported,
  loadAtlasCommandAccess, openAtlasCommandWindow, parseAtlasCommandSignal, requestAtlasCommandSignal,
} from "../src/lib/atlas/commandSignal";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const fixture = () => ({ ok: true, saved: true, copy: "Recorded engine call", analysis: { analysisAt: 1_700_000_000_000 }, idea: {
  version: "test", id: "stored-call", at: 1_700_000_005_000, snapshotAt: 1_700_000_000_000, snapshotId: 1,
  kind: "on_confirmation", source: "read_plan", side: "buy", style: "hold", options: { style: "auto" },
  strategy: "Test fixture", headline: "Wait for the recorded confirmation", badge: "Conditional gold call", price: 4000,
  entry: { type: "stop", price: 4005, low: 4004, high: 4005, text: "Wait for a close above 4005.", trigger: "A closed candle above 4005", confirm: "close_15m", distancePips: 50, level: null },
  stop: { price: 3990, pips: 150, what: "Below the recorded structure" },
  targets: [{ label: "TP1", price: 4035, pips: 300, r: 2, basis: "level", what: "Recorded target" }],
  rr: { first: 2, best: 2 }, confidence: { score: 60, label: "Medium", basis: "Test fixture" },
  reasoning: "The engine is waiting for a closed-candle confirmation.", bias: "buy", poi: null, targeting: null,
  invalidation: { text: "A break below the recorded stop.", price: 3990 },
  confirmations: [{ label: "Close above entry", ok: false, detail: "Still waiting" }], waitingFor: ["A close above 4005"],
  engine: { state: "forming", headline: "Waiting", say: "Waiting" }, alternative: null, paths: [], warnings: [], expiresAt: 1_700_010_000_000,
  execute: { via: "manual", now: false, note: "Review before execution.", approved: null, manual: { side: "buy", style: "hold", stop: 3990, takeProfit: 4035 } }, watch: null, say: "Wait for confirmation.",
} });

test("the adapter reaches the real Atlas idea endpoint exactly once without GENX, purchase, watch or execution", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await requestAtlasCommandSignal("XAUUSD", { fetcher: (async (input, init) => {
    calls.push({ url: String(input), init }); return response(fixture());
  }) as typeof fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/command-center/idea");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { action: "generate" });
  assert.equal(result?.idea.entry?.price, 4005);
  assert.equal(result?.idea.kind, "on_confirmation");
  assert.equal(result?.idea.execute.now, false, "The conditional call is not promoted to an executable signal");
});

test("non-gold markets are rejected before any request, with no silent gold fallback", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return response(fixture()); }) as typeof fetch;
  assert.equal(atlasCommandSignalSupported("XAU/USD"), true);
  for (const symbol of ["EURUSD", "GBPJPY", "USDJPY", "", "GOLD"]) {
    await assert.rejects(requestAtlasCommandSignal(symbol, { fetcher }), (error) => error instanceof AtlasCommandSignalError && error.code === "unsupported_market");
  }
  assert.equal(calls, 0);
});

test("a delayed response is discarded after the selected market changes", async () => {
  let complete!: (value: Response) => void;
  let current = "XAUUSD";
  const pending = requestAtlasCommandSignal("XAUUSD", {
    isCurrent: () => current === "XAUUSD",
    fetcher: (() => new Promise<Response>((resolve) => { complete = resolve; })) as typeof fetch,
  });
  current = "EURUSD";
  complete(response(fixture()));
  assert.equal(await pending, null, "Gold levels never appear beneath the newly selected FX market");
});

test("an already invalidated request performs no generation at all", async () => {
  let calls = 0;
  assert.equal(await requestAtlasCommandSignal("XAUUSD", { isCurrent: () => false, fetcher: (async () => { calls++; return response(fixture()); }) as typeof fetch }), null);
  assert.equal(calls, 0);
});

test("a closed entitlement window is reported without purchasing or retrying", async () => {
  const calls: string[] = [];
  await assert.rejects(requestAtlasCommandSignal("XAUUSD", { fetcher: (async (input) => {
    calls.push(String(input)); return response({ ok: false, error: "pass_required" }, 402);
  }) as typeof fetch }), (error) => error instanceof AtlasCommandSignalError && error.code === "pass_required");
  assert.deepEqual(calls, ["/api/command-center/idea"]);
});

test("window price lookup is read-only, and opening uses the existing pass endpoint without client-supplied pricing", async () => {
  const pass = { active: false, admin: false, expiresAt: null, cost: 5, minutes: 30, balance: 20 };
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = (async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
    return response({ ...pass, active: init?.method === "POST" });
  }) as typeof fetch;
  assert.deepEqual(await loadAtlasCommandAccess({ fetcher }), pass);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal((await openAtlasCommandWindow({ fetcher })).active, true);
  assert.deepEqual(calls.map((call) => [call.url, call.method]), [["/api/command-center/pass", "GET"], ["/api/command-center/pass", "POST"]]);
  assert.equal(calls[1].body, undefined);
});

test("invalid prices, a wrong-market response, and malformed confirmations cannot reach the display", () => {
  const badPrice = fixture(); badPrice.idea.targets[0].price = Number.NaN;
  assert.equal(parseAtlasCommandSignal(badPrice), null);
  assert.equal(parseAtlasCommandSignal({ ...fixture(), idea: { ...fixture().idea, symbol: "EURUSD" } }), null);
  assert.equal(parseAtlasCommandSignal({ ...fixture(), idea: { ...fixture().idea, confirmations: [{ label: "Bad", ok: true, detail: { execute: true } }] } }), null);
  assert.equal(parseAtlasCommandSignal({ ok: true }), null);
});

test("a stand-aside result is retained honestly and Explain receives facts without execution authority", () => {
  const raw = fixture();
  const waiting = parseAtlasCommandSignal({ ...raw, idea: { ...raw.idea, kind: "stand_aside", side: null, source: null, entry: null, stop: null, targets: [], headline: "Stand aside" } });
  assert.ok(waiting);
  assert.equal(waiting.idea.kind, "stand_aside");
  const context = atlasCommandSignalContext(waiting);
  assert.equal(context.data?.symbol, "XAUUSD");
  assert.equal(context.data?.source, "Atlas Command Center engine");
  assert.equal(context.data?.status, "No trade");
  assert.equal(context.data?.entry, null);
  assert.equal("execute" in (context.data ?? {}), false);
  assert.equal("account" in (context.data ?? {}), false);
});
