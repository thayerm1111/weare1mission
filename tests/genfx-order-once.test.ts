import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * ONE SEND, ONE ORDER. The desk routes broker calls through relays (other servers, other outbound
 * addresses). When a relay fails, the client sends the request again directly "rather than dropping a
 * member's order" — which is right when the relay never forwarded it, and a second order when it had.
 * A GEN FX order is labelled and is found again by its label, so it is sent at most once: where the
 * relay's failure leaves it unknown whether the broker got the order, the send throws and the books
 * pass asks the broker. Everybody else's requests behave exactly as they did.
 *
 * The broker client reads its relay settings when it is loaded, so they are set first.
 */
process.env.BROKER_RELAYS = "https://relay.test";
process.env.BROKER_RELAY_SECRET = "s3cret";

type Call = { url: string; body: Record<string, unknown> | null };
const realFetch = globalThis.fetch;
function stubFetch(relay: (call: Call) => Response | Promise<Response>, direct: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    const call = { url, body };
    calls.push(call);
    return url.startsWith("https://relay.test") ? relay(call) : direct(call);
  }) as typeof fetch;
  return calls;
}
const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const accepted = () => json(200, { s: "ok", d: { orderId: "777" } });
const viaRelayOk = () => json(200, { status: 200, text: JSON.stringify({ s: "ok", d: { orderId: "777" } }) });

async function client() {
  const tl = await import("../src/lib/flow/tradelocker");
  // An account number whose route is the relay (route 0 is this server itself).
  let accNum = "1";
  for (let i = 1; i < 500; i++) if (tl.pickRoute(`demo:${i}`, 2) === 1) { accNum = String(i); break; }
  const base = { accountId: "A1", accNum, tradableInstrumentId: "278", routeId: "1", side: "buy" as const, type: "limit" as const, qty: 0.5, price: 1.0845, stopLoss: 1.0825, takeProfit: 1.087 };
  return { tl, base };
}
const directCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("https://demo.tradelocker.com"));

test("the label goes out with a labelled order, and with no other", async () => {
  const { tl, base } = await client();
  try {
    const calls = stubFetch(viaRelayOk, accepted);
    await tl.createOrder("demo", "tok", { ...base, strategyId: "gfx-" + "a".repeat(40), exactlyOnce: true });
    await tl.createOrder("demo", "tok", base);
    const sent = calls.map((c) => JSON.parse(String((c.body as { body?: string }).body ?? "{}")) as Record<string, unknown>);
    assert.equal(String(sent[0].strategyId).length, 31);              // clipped to the broker's limit
    assert.equal("strategyId" in sent[1], false);
    assert.deepEqual(Object.keys(sent[1]).sort(), ["price", "qty", "routeId", "side", "stopLoss", "stopLossType", "takeProfit", "takeProfitType", "tradableInstrumentId", "type", "validity"]);
  } finally { globalThis.fetch = realFetch; }
});

test("a relay that may already have delivered the order: a labelled order is NOT sent again — it throws", async () => {
  const { tl, base } = await client();
  try {
    // The relay's own call to the broker failed part-way: it answers 502 without the broker's status.
    for (const relay of [() => json(502, { error: "upstream_failed" }), () => json(500, { error: "boom" }), () => { throw new Error("socket hang up"); }]) {
      const calls = stubFetch(relay, accepted);
      await assert.rejects(() => tl.createOrder("demo", "tok", { ...base, strategyId: "gfx-1", exactlyOnce: true }), /relay_outcome_unknown/);
      assert.equal(directCalls(calls).length, 0);
    }
  } finally { globalThis.fetch = realFetch; }
});

test("a relay that never forwarded it: the labelled order goes direct, once", async () => {
  const { tl, base } = await client();
  try {
    const refused = [() => json(401, { error: "unauthorized" }), () => json(503, { error: "relay_not_configured" }), () => json(404, { error: "not_found" }), () => json(400, { error: "bad_json" }),
      () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }];
    for (const relay of refused) {
      const calls = stubFetch(relay, accepted);
      const r = await tl.createOrder("demo", "tok", { ...base, strategyId: "gfx-1", exactlyOnce: true });
      assert.equal(r.ok, true);
      assert.equal(directCalls(calls).length, 1);
    }
  } finally { globalThis.fetch = realFetch; }
});

test("everybody else's order behaves exactly as before: any relay failure falls back to a direct send", async () => {
  const { tl, base } = await client();
  try {
    for (const relay of [() => json(502, { error: "upstream_failed" }), () => { throw new Error("socket hang up"); }, () => json(503, { error: "relay_not_configured" })]) {
      const calls = stubFetch(relay, accepted);
      const r = await tl.createOrder("demo", "tok", base);
      assert.equal(r.ok, true);
      assert.equal(directCalls(calls).length, 1);
    }
    // And a read is never held back by the at-most-once rule.
    const calls = stubFetch(() => json(502, { error: "upstream_failed" }), () => json(200, { s: "ok", d: { orders: [] } }));
    const r = await tl.listOrders("demo", "tok", base.accNum, "A1");
    assert.equal(r.ok, true);
    assert.equal(directCalls(calls).length, 1);
  } finally { globalThis.fetch = realFetch; }
});
