import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAIRS, PAIR_KEYS } from "../src/lib/genfx/pairs";
import { FLOOR_INSTRUMENTS, GENFX_OPEN_PAIR, floorInstrument, floorFmt, fxPairKey, setupQuery, setupCacheKey, type FloorMode } from "../src/lib/floor/setupInstruments";
import { readFromSeries, genfxOf } from "../src/lib/genfx/compute";
import { MODES } from "../src/lib/genxCompute";

/*
 * The Floor's setup card, paged across gold and the two GEN FX pairs (owner 10-04: "make it so you can
 * page through here to GBPJPY, and EURUSD as well … just like the GENX").
 *
 * Two promises: a currency pair is shown from its own engine at its own precision, and gold is asked
 * for, cached, stored and printed exactly as it was before the card could show anything else.
 */
const route = readFileSync("src/app/api/floor/setup/route.ts", "utf8");
const card = readFileSync("src/components/portal/floor/FloorHome.tsx", "utf8");
const fxDesk = readFileSync("src/components/portal/floor/GenFxDesk.tsx", "utf8");
const count = (src: string, needle: string): number => src.split(needle).length - 1;

test("the card pages through gold, EUR/USD and GBP/JPY — gold first, and gold whenever nothing is asked for", () => {
  assert.deepEqual(FLOOR_INSTRUMENTS.map((i) => i.key), ["XAUUSD", "EURUSD", "GBPJPY"]);
  assert.deepEqual(FLOOR_INSTRUMENTS.map((i) => i.chip), ["Gold", "EUR/USD", "GBP/JPY"]);
  for (const v of [null, undefined, "", "XAUUSD", "xau/usd", "gold", "BTCUSD", "EURUSDX", "USDJPY", 7, {}]) assert.equal(floorInstrument(v).key, "XAUUSD", `"${String(v)}" is gold`);
  for (const v of ["EURUSD", "eurusd", "EUR/USD", "eur-usd", " EUR USD "]) assert.equal(floorInstrument(v).key, "EURUSD");
  for (const v of ["GBPJPY", "gbp/jpy", "Gbp-Jpy"]) assert.equal(floorInstrument(v).key, "GBPJPY");
  // The same object every time: the card memoises its formatter on it.
  assert.equal(floorInstrument("eur/usd"), floorInstrument("EURUSD"));
});

test("each market says whose read it is, and a pair is every GEN FX pair", () => {
  const gold = floorInstrument("XAUUSD");
  assert.deepEqual({ title: gold.title, engine: gold.engine, name: gold.name, view: gold.view, dec: gold.dec, money: gold.money },
    { title: "Gold Setup · XAUUSD", engine: "GENX", name: "gold", view: "plays", dec: 2, money: "$" });
  assert.equal(fxPairKey("XAUUSD"), null);
  for (const k of PAIR_KEYS) {
    const i = floorInstrument(k);
    assert.equal(i.key, k, `${k} is on the toggle`);
    assert.equal(i.engine, "GEN FX");
    assert.equal(i.dec, PAIRS[k].dec, "printed at the pair's own precision");
    assert.equal(i.money, "", "a rate, not an amount of dollars");
    assert.equal(i.view, "genfx", "expanding opens the GEN FX tool");
    assert.ok(i.title.includes(PAIRS[k].name) && i.title.includes("GEN FX"));
    assert.equal(fxPairKey(i.key), k);
  }
  assert.equal(FLOOR_INSTRUMENTS.length, 1 + PAIR_KEYS.length);
});

test("gold prints exactly as the card printed it before", () => {
  // The card's own formatter, as it was (FloorHome `gfmt`, with `gnum` in front of it).
  const gnum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const gfmt = (n: unknown) => { const v = gnum(n); return v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const f = floorFmt(floorInstrument("XAUUSD"));
  for (const v of [4154.03, 4129.87, 4130.37, 4126.38, 999.5, 0, 12345.678, 4143.666, "4156.97", "", null, undefined, NaN, Infinity, "abc"]) {
    assert.equal(f.px(v), gfmt(v), `px(${String(v)})`);
    if (gnum(v) != null) assert.equal(f.money(v), "$" + gfmt(v), `money(${String(v)})`);
  }
  // Two decimals whatever the reader's locale prints as the separator, and the dollar sign in front.
  assert.match(f.px(4154.03), /^4.?154.03$/);
  assert.equal(f.money(4154.03), "$" + f.px(4154.03));
  assert.equal(f.money(null), "—");
});

test("a currency pair prints at its own precision, with no dollar sign", () => {
  const eu = floorFmt(floorInstrument("EURUSD")), gj = floorFmt(floorInstrument("GBPJPY"));
  assert.equal(eu.px(1.12394), "1.12394");
  assert.equal(eu.px(1.1), "1.10000");
  assert.equal(eu.px(1.123456789), "1.12346");
  assert.equal(eu.money(1.12394), "1.12394");
  assert.equal(gj.px(208.739), "208.739");
  assert.equal(gj.px(209), "209.000");
  assert.equal(gj.money(208.7391), "208.739");
  for (const f of [eu, gj]) { assert.equal(f.px(null), "—"); assert.equal(f.money(undefined), "—"); assert.equal(f.px(NaN), "—"); }
  // Gold's two decimals would print EUR/USD's stop and target as the same number.
  const gold = floorFmt(floorInstrument("XAUUSD"));
  assert.equal(gold.px(1.12345), gold.px(1.12394), "which is why the card cannot print a pair with gold's formatter");
  assert.notEqual(eu.px(1.12345), eu.px(1.12394));
});

test("gold is asked for with exactly the request it always sent; a pair adds its symbol", () => {
  for (const m of ["quick", "intraday", "swing"] as FloorMode[]) {
    assert.equal(`/api/floor/setup?${setupQuery(m, "XAUUSD")}`, `/api/floor/setup?mode=${m}`);
    assert.equal(`/api/floor/setup?history=1&${setupQuery(m, "XAUUSD")}`, `/api/floor/setup?history=1&mode=${m}`);
    assert.equal(setupQuery(m, "EURUSD"), `mode=${m}&symbol=EURUSD`);
    assert.equal(setupQuery(m, "GBPJPY"), `mode=${m}&symbol=GBPJPY`);
  }
  // …and the server reads that symbol back to the same market.
  for (const i of FLOOR_INSTRUMENTS) assert.equal(floorInstrument(new URLSearchParams(setupQuery("intraday", i.key)).get("symbol")).key, i.key);
});

test("every market and horizon has its own cached payload", () => {
  const keys = FLOOR_INSTRUMENTS.flatMap((i) => (["quick", "intraday", "swing"] as FloorMode[]).map((m) => setupCacheKey(i.key, m)));
  assert.equal(new Set(keys).size, 9);
});

test("the route: gold is the GENX read as before; a pair is the GEN FX read; the route itself charges nothing", () => {
  // Gold, unchanged: the same engine call, the same builder inputs, the same chart and price reads.
  assert.ok(/computeGenxRead\(\{ mode, mdKey, fresh: false \}\)/.test(route));
  assert.ok(/buildGenx\(rr\.read, \{[\s\S]*?pip: GOLD\.pip, dec: GOLD\.dec, marketStory: \[\], volatility: rr\.volatility, atr: rr\.atr, m15: rr\.m15,\s*\}\)/.test(route));
  assert.ok(/series\("XAU\/USD", CHART_TF\[mode\], 60, mdKey, false\)/.test(route) && /livePrice\("XAU\/USD", mdKey, false\)/.test(route));
  // A pair: the GEN FX engine, the way the GEN FX page builds it, with no story.
  assert.ok(/computeGenfxRead\(\{ pair, mode, mdKey, fresh: false \}\)/.test(route));
  assert.ok(/genfxOf\(pair, rr\.read, \{[\s\S]*?marketStory: \[\], volatility: rr\.volatility, atr: rr\.atr,\s*\}\)/.test(route));
  assert.ok(/series\(pair\.td, CHART_TF\[mode\], 60, mdKey, false\)/.test(route));
  assert.ok(/const built = pair \? await fxSetup\(pair, mode, mdKey\) : await goldSetup\(mode, mdKey\)/.test(route));
  // The route cannot charge, for any market. (Since 10-05 the play takes credits to VIEW — who is sent
  // the map is decided by the member's window, and opening one is another route's work: setup-lock.test.ts.)
  assert.ok(!/credits|chargeCredit|gateCredits|billEvent|flow_bill/.test(route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "no credit call in the route's code");
  // One cache entry per market per horizon — written under that key and read back under it.
  assert.ok(/const ck = setupCacheKey\(inst\.key, mode\)/.test(route) && /CACHE\[ck\] = \{ at: Date\.now\(\), body \}/.test(route));
  assert.ok(/if \(CACHE\[ck\] && Date\.now\(\) - CACHE\[ck\]\.at < TTL_MS\) return json\(await shown\(\{ \.\.\.CACHE\[ck\]\.body, cached: true \}\)\)/.test(route));
  assert.ok(!/CACHE\[mode\]/.test(route), "the cache is no longer keyed by horizon alone");
  // The market is read from `symbol`, and every answer says which market it is of: the live map and
  // both "could not read" answers. (The card draws a map only under the market it names.)
  assert.ok(/const inst = floorInstrument\(url\.searchParams\.get\("symbol"\)\)/.test(route));
  assert.equal(count(route, "symbol: inst.key"), 3);
  assert.ok(/const body = \{ g, candles, price, session, mode, asOf, symbol: inst\.key \}/.test(route));
  // A pair's chart is drawn from the candles its read was made on; it is asked for again only if there are too few.
  assert.ok(/const candles = own\.length >= 44 \? own : toCandles\(await series\(pair\.td, CHART_TF\[mode\], 60, mdKey, false\)\)/.test(route));
  for (const m of ["quick", "intraday", "swing"] as const) assert.equal(MODES[m].tf.m15, ({ quick: "5min", intraday: "15min", swing: "1h" } as const)[m], "the engine's candles are the chart's timeframe");
});

test("the route: each market lists and stores only its own earlier maps", () => {
  // The list, and the "is it time for another snapshot?" look: a pair by its key, gold by having none.
  assert.equal((route.match(/\(pair \? \w+\.eq\("instrument", pair\.key\) : \w+\.is\("instrument", null\)\)/g) ?? []).length, 2);
  // A pair's snapshot carries its key; gold's insert names no instrument, as before.
  assert.ok(/\.\.\.\(pair \? \{ instrument: pair\.key \} : \{\}\)/.test(route));
  // A replayed map says which market it is of; one stored before the column existed is gold's.
  assert.ok(/symbol: row\.instrument \?\? "XAUUSD"/.test(route));
  // "When was the last snapshot?" failing to read is not "there has never been one".
  assert.ok(/if \(!lastErr && \(!lastAt \|\| Date\.now\(\) - lastAt > SNAPSHOT_MS\)\) \{/.test(route));
  const mig = readFileSync("supabase/migrations/20261005020000_floor_setup_history_instrument.sql", "utf8");
  assert.ok(/add column if not exists instrument text/.test(mig) && !/\bdrop\b/i.test(mig.replace(/^--.*$/gm, "")), "additive only");
});

test("the card: the toggle, one request per market, and no gold left in what it prints", () => {
  assert.ok(/FLOOR_INSTRUMENTS\.map\(\(i\) => \(\s*<button key=\{i\.key\} type="button" onClick=\{\(\) => onSymbol\(i\.key\)\} aria-pressed=\{i\.key === inst\.key\}/.test(card), "three buttons, the current one pressed");
  // (`fresh` is "&fresh=1" on the first look after arriving, switching or paying, and "" on every poll after.)
  assert.ok(/fetch\(`\/api\/floor\/setup\?\$\{setupQuery\(setupMode, setupSym, fresh\)\}`/.test(card));
  assert.ok(/fetch\(`\/api\/floor\/setup\?history=1&\$\{setupQuery\(setupMode, setupSym, fresh\)\}`/.test(card));
  assert.ok(/\}, \[setupMode, setupSym, setupTick\]\);/.test(card), "pressing the toggle reloads the card");
  // Opens on gold.
  assert.ok(/useState<FloorSymbol>\("XAUUSD"\)/.test(card));
  // A map is drawn only under the market it was read on — the live one and a replayed one alike —
  // and switching clears the one on screen.
  assert.ok(/const forMarket = \(d: SetupPayload \| null\) => \(d && floorInstrument\(d\.symbol\)\.key === setupSym \? d : null\);/.test(card));
  assert.ok(/const shownFrozen = forMarket\(frozen\);\s*const shownSetup = shownFrozen \?\? forMarket\(setup\);/.test(card));
  assert.ok(/data=\{shownSetup\} mode=\{setupMode\}\s*inst=\{floorInstrument\(setupSym\)\}/.test(card), "the guarded map is the one drawn");
  assert.ok(/past=\{past\} frozen=\{shownFrozen\}/.test(card), "and the 'frozen' banner is this market's or absent");
  assert.ok(/const fmt = useMemo\(\(\) => floorFmt\(inst\), \[inst\]\);/.test(card), "the card prints with the shown market's formatter");
  assert.ok(/onSymbol=\{\(s\) => \{ if \(s === setupSym\) return; setFrozen\(null\); setSetup\(null\); setPast\(\[\]\); setPastLocked\(false\); setSetupSym\(s\); \}\}/.test(card));
  // The setup card's own code: no dollar sign glued to a price, no two-decimal formatter, no engine or market named in a label.
  const from = card.indexOf("/* ── GOLD SETUP · Market Flow"), to = card.indexOf("function MarketIntel(");
  assert.ok(from > 0 && to > from);
  const setup = card.slice(from, to);
  assert.ok(!/"\$" \+/.test(setup) && !/\bgfmt\(/.test(setup));
  // Every price the card prints goes through the formatter, where gold had its dollar sign and where it had none.
  assert.equal(count(setup, "fmt.money("), 4, "NOW, the step prices, ENTER's zone edge, and the price tag on the chart");
  assert.equal(count(setup, "fmt.px("), 8, "the confirm level (x2), ENT, SL, TP and INVALIDATION on the chart, and the two tiles");
  assert.ok(!/>\s*Gold Setup · XAUUSD\s*</.test(setup) && /\{inst\.title\}/.test(setup));
  assert.ok(!/GENX projected path|"GENX wants"/.test(setup) && /\{inst\.engine\} projected path/.test(setup) && /`\$\{inst\.engine\} wants`/.test(setup));
  assert.ok(!/gold read/.test(setup) && /Loading the live \$\{inst\.name\} read…/.test(setup));
  // Expanding goes where that market's tool is — and a pair's card opens the GEN FX tool on that pair.
  assert.ok(/if \(i\.key !== "XAUUSD"\) \{ try \{ window\.sessionStorage\.setItem\(GENFX_OPEN_PAIR, i\.key\); \}/.test(card) && /onGo\(i\.view\);/.test(card));
  assert.ok(/const v = window\.sessionStorage\.getItem\(GENFX_OPEN_PAIR\);[\s\S]{0,160}window\.sessionStorage\.removeItem\(GENFX_OPEN_PAIR\);[\s\S]{0,80}if \(v === "EURUSD" \|\| v === "GBPJPY"\) setPair\(v\);/.test(fxDesk), "read once, removed, and only a real pair is taken");
  assert.equal(GENFX_OPEN_PAIR, "genfx:open-pair");
});

/* A steady climb with a pullback, at a pair's own scale — enough for the engine to read. */
function climb(base: number, step: number, n: number, ivMs: number, endMs: number) {
  const rows: { datetime: string; open: string; high: string; low: string; close: string }[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const drift = (i % 9 < 6 ? 1 : -0.8) * step;
    const o = p, c = p + drift, h = Math.max(o, c) + step * 0.4, l = Math.min(o, c) - step * 0.4;
    rows.push({ datetime: new Date(endMs - (n - i) * ivMs).toISOString().slice(0, 19).replace("T", " "), open: String(o), high: String(h), low: String(l), close: String(c) });
    p = c;
  }
  return rows;
}

test("what the GEN FX read hands the card is printed whole: every level at the pair's precision", () => {
  const now = Date.UTC(2026, 9, 6, 14, 0, 0);       // a Tuesday afternoon
  for (const k of PAIR_KEYS) {
    const pair = PAIRS[k], inst = floorInstrument(k), f = floorFmt(inst);
    const base = k === "EURUSD" ? 1.12 : 208.5, u = pair.unit;
    const s = {
      d1: climb(base - 300 * u, 6 * u, 90, 86_400_000, now), h1: climb(base - 120 * u, 2.2 * u, 120, 3_600_000, now),
      m30: climb(base - 60 * u, 1.4 * u, 120, 1_800_000, now), m15: climb(base - 40 * u, 0.9 * u, 150, 900_000, now), m5: climb(base - 20 * u, 0.5 * u, 150, 300_000, now),
    };
    const price = +s.m5[s.m5.length - 1].close;
    const r = readFromSeries(pair, "intraday", s, price, now);
    const m = MODES.intraday;
    const g = genfxOf(pair, r.read, { mode: "intraday", price, session: r.session, dataStatus: "live", hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, marketStory: [], volatility: r.volatility, atr: r.atr }) as unknown as Record<string, unknown>;
    // Everything the card draws is there to draw…
    for (const key of ["action", "directional_bias", "momentum", "buyer_control", "seller_control", "expected_hold_minutes", "projected_path", "trade_reasoning", "trigger_condition", "invalidation_reason"]) assert.ok(key in g, `${k}: the read carries ${key}`);
    assert.equal(g.symbol, k);
    // …and every price on it prints at the pair's precision, with no dollar sign and no thousands comma.
    const shape = new RegExp(`^\\d+\\.\\d{${pair.dec}}$`);
    const prices = [price, g.entry, g.entry_low, g.entry_high, g.stop_loss, g.tp1, g.tp2, g.tp3, g.closest_support, g.closest_resistance, g.invalidation_price,
      ...((g.projected_path as { price: number | null }[]) ?? []).map((p) => p.price)].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    assert.ok(prices.length >= 2, `${k}: there are prices to print`);
    for (const v of prices) {
      assert.match(f.px(v), shape);
      assert.equal(f.money(v), f.px(v));
      assert.equal(Number(f.px(v)), +v.toFixed(pair.dec), "the number printed is the number, to the pair's precision");
    }
    // Entry, stop and first target are different prices and print as different prices — which gold's
    // two decimals would not manage on EUR/USD.
    const lv = [g.entry, g.stop_loss, g.tp1].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    assert.equal(new Set(lv.map((v) => f.px(v))).size, new Set(lv).size, `${k}: distinct levels stay distinct`);
    // The rail beside the chart is 100 units wide; the longest label is "TP2 " and a price.
    assert.ok(("TP2 " + f.px(Math.max(...prices))).length <= 12, `${k}: the labels fit the rail gold's fit`);
  }
});
