import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAIRS } from "../src/lib/genfx/pairs";
import { controlOf, configOf, inScope, minStopPips, readControl, DEFAULT_CONFIG, OWNER_USER_ID, GENFX_VERSION } from "../src/lib/genfx/control";
import { getInstrument } from "../src/lib/flow/instruments";
import { valuePerPricePerLot, contractKey } from "../src/lib/flow/sizing";

/*
 * The switches, and the wiring that makes GEN FX safe to ship switched on for nobody: everything is
 * off until someone turns it on, and an instruction that cannot be read is not permission to trade.
 */
const OWNER = OWNER_USER_ID, MEMBER = "11111111-2222-3333-4444-555555555555";

test("an unreadable control row means everything is off", async () => {
  const shut = controlOf(null);
  assert.deepEqual({ readable: shut.readable, scan: shut.scan, auto: shut.auto, scope: shut.scope, billing: shut.billing, telegram: shut.telegram }, { readable: false, scan: false, auto: false, scope: "owner", billing: false, telegram: false });
  assert.equal((await readControl(null)).readable, false);
  const failing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }) };
  assert.equal((await readControl(failing as never)).auto, false);
  const throwing = { from: () => { throw new Error("down"); } };
  assert.equal((await readControl(throwing as never)).readable, false);
});

test("a switch is on only when it is exactly true", () => {
  const c = controlOf({ scan_enabled: "true", auto_enabled: 1, billing_enabled: "yes", telegram_enabled: null, auto_scope: "everyone", config: null });
  assert.deepEqual({ scan: c.scan, auto: c.auto, billing: c.billing, telegram: c.telegram, scope: c.scope }, { scan: false, auto: false, billing: false, telegram: false, scope: "owner" });
  const on = controlOf({ scan_enabled: true, auto_enabled: true, billing_enabled: true, telegram_enabled: true, auto_scope: "all", config: {}, updated_at: "2026-10-02T00:00:00Z", replay_request: { weeks: 26 } });
  assert.deepEqual({ scan: on.scan, auto: on.auto, billing: on.billing, telegram: on.telegram, scope: on.scope, readable: on.readable }, { scan: true, auto: true, billing: true, telegram: true, scope: "all", readable: true });
  assert.deepEqual(on.replayRequest, { weeks: 26 });
  assert.equal(controlOf({ auto_scope: "demo" }).scope, "demo");
});

test("tunables: the defaults, the owner's values, and nothing out of range", () => {
  assert.deepEqual(configOf(null), DEFAULT_CONFIG);
  assert.deepEqual(DEFAULT_CONFIG.minStopPips, { EURUSD: 10, GBPJPY: 20 });
  assert.equal(DEFAULT_CONFIG.maxLeverage, 20);
  assert.equal(DEFAULT_CONFIG.maxLots, 50);
  assert.equal(DEFAULT_CONFIG.maxMinLotRiskPct, 5);
  assert.equal(DEFAULT_CONFIG.newsBlackout, false);
  const c = configOf({ minStopPips: { EURUSD: 8, GBPJPY: "25" }, maxLeverage: 10, maxLots: 5, maxMinLotRiskPct: 2, newsBlackout: true, freeStoriesPerDay: 0 });
  assert.deepEqual(c, { minStopPips: { EURUSD: 8, GBPJPY: 25 }, maxMinLotRiskPct: 2, maxLots: 5, maxLeverage: 10, newsBlackout: true, freeStoriesPerDay: 0 });
  // A typo cannot switch a safety off: out-of-range values fall back to the default.
  const bad = configOf({ minStopPips: { EURUSD: 0, GBPJPY: -4 }, maxLeverage: 500, maxLots: 0, maxMinLotRiskPct: 90, newsBlackout: "true", freeStoriesPerDay: -1 });
  assert.deepEqual(bad, DEFAULT_CONFIG);
  const ctl = controlOf({ config: { minStopPips: { EURUSD: 12 } } });
  assert.equal(minStopPips(ctl, PAIRS.EURUSD), 12);
  assert.equal(minStopPips(ctl, PAIRS.GBPJPY), 20);
});

test("who auto-trade may reach", () => {
  // "owner": the owner only.
  assert.equal(inScope("owner", { userId: OWNER, environment: "live" }, OWNER), true);
  assert.equal(inScope("owner", { userId: MEMBER, environment: "demo" }, OWNER), false);
  // "demo": the owner, and any member's DEMO account — never a member's live account.
  assert.equal(inScope("demo", { userId: MEMBER, environment: "demo" }, OWNER), true);
  assert.equal(inScope("demo", { userId: MEMBER, environment: "DEMO" }, OWNER), true);
  assert.equal(inScope("demo", { userId: MEMBER, environment: "live" }, OWNER), false);
  assert.equal(inScope("demo", { userId: MEMBER, environment: null }, OWNER), false);     // unknown is not demo
  assert.equal(inScope("demo", { userId: OWNER, environment: "live" }, OWNER), true);
  // "all": every account whose member opted in.
  assert.equal(inScope("all", { userId: MEMBER, environment: "live" }, OWNER), true);
});

test("the database starts everything that risks money or costs money OFF", () => {
  const sql = readFileSync("supabase/migrations/20261002200000_genfx.sql", "utf8");
  assert.match(sql, /auto_enabled boolean not null default false/);
  assert.match(sql, /auto_scope text not null default 'demo' check \(auto_scope in \('owner', 'demo', 'all'\)\)/);
  assert.match(sql, /billing_enabled boolean not null default false/);
  assert.match(sql, /telegram_enabled boolean not null default false/);
  assert.match(sql, /add column if not exists genfx_eurusd boolean not null default false/);
  assert.match(sql, /add column if not exists genfx_gbpjpy boolean not null default false/);
  assert.match(sql, /primary key \(signal_key, account_id\)/);                 // one fill per call per account
  assert.match(sql, /dedupe_key text not null unique/);                        // one row per call
  assert.match(sql, /insert into public\.flow_manage_lock \(id, holder, expires_at\) values \(6, null, now\(\)\)/);
  for (const t of ["genfx_control", "genfx_alerts", "genfx_signals", "genfx_tracked", "genfx_fills"]) assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
  // No GENX table is altered, and no gold row is rewritten.
  assert.ok(!/alter table public\.genx_|update public\.|delete from public\.(?!flow_manage_lock)/.test(sql));
  assert.ok(!/drop table/i.test(sql));
});

test("placement checks its switches before anything else, and only reaches accounts that asked", () => {
  const src = readFileSync("src/lib/genfx/place.ts", "utf8");
  const body = src.slice(src.indexOf("export async function placeGenfx"));
  const iCtl = body.indexOf("if (!ctl.readable || !ctl.auto) return report(");
  assert.ok(iCtl > 0, "the master switch is checked");
  for (const later of ["marketFor(", "judgeSignal(", "armedAccounts(", "io.send(", "io.login(", "io.quiet()"]) {
    const i = body.indexOf(later);
    assert.ok(i > iCtl, `${later} comes after the switch check`);
  }
  // Accounts come only from the pair's own opt-in column, filtered by the owner's scope.
  assert.match(src, /\.eq\(pair\.column, true\)/);
  assert.match(src, /\.filter\(\(r\) => inScope\(ctl\.scope, \{ userId: String\(r\.user_id\), environment: r\.env \}, OWNER_USER_ID\)\)/);
  assert.ok(!/genx_follower|autotrade_enabled\s*:\s*a\./.test(src), "nobody's gold or FLOW switch arms GEN FX");
  // GEN FX's lock and its "is it the same side?" rule are its own: nothing gold can switch off reaches them.
  assert.ok(!/genx2\/reservation|genx\/hedge|reserveGold|goldResvKey|blocksEntry/.test(src), "placement does not go through gold's fail-open lock or its hedge switch");
  assert.match(src, /import \{ reserveFx, markFx, releaseFxIfHeldBy, fxResvKey \} from "@\/lib\/genfx\/reserve";/);
  const reserve = readFileSync("src/lib/genfx/reserve.ts", "utf8");
  assert.ok(!/genx2ReservationEnabled|hedgeEnabled|reserved: true/.test(reserve), "the lock has no switch and no fail-open answer");
  assert.match(reserve, /if \(error\) return \{ ok: false, reason: "reservation_unavailable" \};/);
  assert.match(reserve, /catch \{ return \{ ok: false, reason: "reservation_unavailable" \}; \}/);
  // The yen rate is settled before the fan-out; the lock, then the claim, then the written size, then the order.
  assert.ok(body.indexOf("no_usdjpy_rate") < body.indexOf("armedAccounts(admin, pair, ctl)"));
  const order = ["reserveFx(admin, aid, pair.key, sig.side, signalKey, 60)", "claimAt = Date.now();", 'status: "reserved",', 'await remember(qty, "reserved")', "r = await send(qty);", 'const took = await record({ status: "placed", order_id: orderId'];
  for (let i = 1; i < order.length; i++) assert.ok(body.indexOf(order[i - 1]) > 0 && body.indexOf(order[i - 1]) < body.indexOf(order[i]), `${order[i - 1]} comes before ${order[i]}`);
  // A thrown order is held as unknown and said to be uncertain; the order is capped a quarter of the stop past the quote.
  assert.match(body, /await markFx\(admin, aid, resvKey, "unknown"\);\s+const doubt = await record\(\{ status: "uncertain", clean: 0, next_check_at: new Date\(\)\.toISOString\(\), updated_at: new Date\(\)\.toISOString\(\) \}\);/);
  // …unless the order function says nothing was attempted: then the claim is simply handed back.
  assert.match(body, /if \(\(e as \{ noOrderSent\?: boolean \} \| null\)\?\.noOrderSent === true\) \{\s+await undo\(\);/);
  // Placement never writes "managed", and never writes the ledger: the books pass does both, from the broker's own record.
  assert.ok(!/status: "managed"/.test(body), "placement does not call a call finished");
  assert.ok(!/ensureLedgerRow|from\("flow_managed_positions"\)\.insert/.test(src), "placement writes no ledger row");
  // The final write only lands on a row still as this pass left it; a row written off in the meantime is an alarm.
  assert.match(body, /let wrote = await write\(\["sending", "uncertain"\]\);/);
  assert.match(body, /WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED/);
  // …and so does the write after a send that threw: neither way out of a send writes over a row it has not looked at.
  assert.match(body, /WAS SENT AFTER ITS RECORD HAD BEEN CLOSED/);
  assert.ok(!/setFill\(/.test(body), "no unconditional write to the call's row");
  // The switches are read again a moment before each order, and the order carries its label and a deadline.
  assert.ok(body.indexOf("const still = await stillOn(a);") > 0 && body.indexOf("const still = await stillOn(a);") < body.indexOf('await remember(qty, "reserved")'));
  // ONE deadline for the call, counted from its claim — the retry at the smallest size does not get a fresh one.
  assert.match(body, /const notAfterMs = claimAt \+ SEND_DEADLINE_MS;\s+const send = \(qty: number\) => io\.send\(\{ userId: uid, ref, pair: pair\.key, side: sig\.side, qty, stop, tp, maxEntry, tag, notAfterMs \}\);/);
  assert.match(body, /created_at: new Date\(claimAt\)\.toISOString\(\), next_check_at: new Date\(claimAt \+ CLAIM_DEAD_MS\)\.toISOString\(\)/);
  assert.match(body, /const maxEntry = maxEntryFor\(pair, sig\.side, fillRef, stop\);/);
  assert.match(src, /symbol: o\.pair, side: o\.side, qty: o\.qty, stop: o\.stop, tp: o\.tp, source: "genfx", maxEntry: o\.maxEntry,/);
  // The size is cut from this account's own broker price, read before the order, and that price is
  // re-checked against the stop, the minimum stop and the 0.8-to-1 floor.
  const iQuote = body.indexOf("io.quote(ref, pair.key, sig.side)"), iSize = body.indexOf("sizeFx(pair, { entry: fillRef, stop, equity, riskPct, usdJpy, limits: ctl.config })"), iSend = body.indexOf("r = await send(qty);");
  assert.ok(iQuote > 0 && iQuote < iSize && iSize < iSend);
  const between = body.slice(iQuote, iSize);
  assert.match(between, /if \(sig\.side === "buy" \? fillRef <= stop : fillRef >= stop\) \{ await undo\(\); return skip\("through_stop"/);
  assert.match(between, /stopWideEnough\(pair, fillRef, stop, mkt\.minStopPips\)/);
  assert.match(between, /if \(chasedAt\(sig\.side, stop, tp, fillRef\)\) \{ await undo\(\); return skip\("chased"/);
  // No broker price → the feed's, moved AWAY from the stop by the pair's cost, so the size can only come out smaller.
  assert.match(between, /sig\.side === "buy" \? sizeEntry \+ pair\.costPips \* pair\.pip : sizeEntry - pair\.costPips \* pair\.pip/);
  // An account whose currency cannot be read is not assumed to be in dollars.
  assert.match(body, /if \(ccy !== "USD"\) \{ await undo\(\);/);
  // Every ledger row GEN FX opens carries its stamp, whoever writes it.
  assert.match(readFileSync("src/lib/genfx/ledger.ts", "utf8"), /\(\{ strategy_version: GENFX_VERSION, mode: x\.mode, signal_id: x\.signalKey, setup_family: x\.setup \}\)/);
  assert.equal(GENFX_VERSION, "genfx-1.0");
});

test("a member cannot arm an account the owner's scope does not reach, and only the owner moves the switches", () => {
  const src = readFileSync("src/app/api/genfx/desk/route.ts", "utf8");
  assert.match(src, /const enabled = body\.enabled === true;/);
  assert.match(src, /if \(!inScope\(ctl\.scope, \{ userId: user\.id, environment: acct\.conn\.environment \}, OWNER_USER_ID\)\) \{\s+return json\(\{ ok: false, error: "not_open"/);
  assert.match(src, /\.eq\("user_id", user\.id\)\.eq\("account_id", accountId\)/);     // their own account only
  const post = src.slice(src.indexOf("export async function POST"));
  assert.ok(post.indexOf('if (!owner) return json({ error: "forbidden" }, 403);') < post.indexOf('if (action === "control")'));
  assert.ok(post.indexOf('if (!owner) return json({ error: "forbidden" }, 403);') < post.indexOf('if (action === "replay")'));
});

test("the scanner and the watch do nothing when scanning is off or the row is unreadable", () => {
  const scan = readFileSync("src/lib/genfx/scan.ts", "utf8");
  assert.match(scan, /if \(!ctl\.readable \|\| !ctl\.scan\) \{/);
  const watch = readFileSync("src/lib/genfx/watch.ts", "utf8");
  assert.match(watch, /if \(!ctl\.readable \|\| !ctl\.scan\) return \{ zones: 0, forming: 0, sent \};/);
  assert.match(watch, /const LOCK_ID = 6;/);
  // A call is written and won before it is announced or placed, in both.
  assert.ok(scan.indexOf('state: "entered", enter_price: price') > 0 && scan.indexOf('state: "entered", enter_price: price') < scan.indexOf("out.placed = await place({"));
  const zone = watch.slice(watch.indexOf("// Move the row forward FIRST"));
  assert.ok(zone.indexOf('.eq("id", r.id).eq("state", "zone").select("id")') > 0 && zone.indexOf('.eq("id", r.id).eq("state", "zone").select("id")') < zone.indexOf("await place({"));
  assert.match(zone, /if \(!won\?\.length\) continue;/);
  // Nothing is posted unless the owner switched GEN FX's Telegram on.
  assert.match(scan, /const say = async \(ctl: GenfxControl, html: string\) => \{ if \(ctl\.telegram && tgEnv\(\)\)/);
  assert.match(watch, /const tg = ctl\.telegram && /);
});

test("credits are untouched unless billing is switched on", () => {
  const place = readFileSync("src/lib/genfx/place.ts", "utf8");
  assert.match(place, /const gate: FxFireGate = ctl\.billing \? await fxFireGate\(/);
  assert.match(place, /if \(ctl\.billing\) \{ try \{ await chargeFxFire\(/);
  const scan = readFileSync("src/lib/genfx/scan.ts", "utf8");
  assert.match(scan, /if \(ctl\.billing\) \{\n\s+\/\/ Only a setup auto-trade would actually place is billed/);
  // …under the setup's fee key: its own, or — for a setup that was let go and came straight back — the first one's.
  assert.match(scan, /const feeKey = recall \? \(recall\.fee_key \?\? recall\.dedupe_key\) : dedupeKey;/);
  assert.match(scan, /try \{ out\.billed = await billFxSetup\(admin, feeKey, tradeable\.ok \? await armedUserIds\(admin, pair, ctl\) : \[\], tradeable\); \}/);
  const route = readFileSync("src/app/api/genfx/route.ts", "utf8");
  assert.match(route, /if \(ctl\.billing\) \{\s+const gate = await gateCredits\("genx"\);/);
  assert.match(route, /if \(ctl\.billing && chargeable\) await chargeCredit\("genx"\);/);
  // The fee for a trade is taken after the order is on the account, never before.
  const body = place.slice(place.indexOf("export async function placeGenfx"));
  assert.ok(body.indexOf("r = await send(qty);") > 0 && body.indexOf("r = await send(qty);") < body.indexOf("chargeFxFire(admin, uid, signalKey, gate)"));
});

test("GEN FX cannot change who pays for gold: its rows are invisible to the gold setup-fee rule", () => {
  const billing = readFileSync("src/lib/flow/flowBilling.ts", "utf8");
  const fn = billing.slice(billing.indexOf("export async function unreachableUserIds"), billing.indexOf("/** Pure: which billable members should pay for this setup."));
  assert.match(fn, /\.eq\("status", "skipped"\)[\s\S]*?\.not\("reason", "like", "genfx%"\)\.limit\(20000\)/);
  assert.match(fn, /\.in\("status", \["placed", "uncertain"\]\)[\s\S]*?\.or\("reason\.is\.null,reason\.not\.like\.genfx\*"\)\.limit\(20000\)/);
  // …which only works because every row GEN FX writes to that table says so at the start of its reason.
  const place = readFileSync("src/lib/genfx/place.ts", "utf8");
  // Two writers in place.ts: the desk-wide breadcrumb, and the per-account one every skip, uncertain and placed row goes through.
  assert.match(place, /from\("flow_auto_events"\)\.insert\(\{ user_id: OWNER_USER_ID, symbol: pair\.key, side: sig\.side, status, reason: `genfx: \$\{reason\}`/);
  assert.equal((place.match(/from\("flow_auto_events"\)\.insert\(/g) ?? []).length, 2);
  const rows = place.match(/await event\(\{[^\n]*/g) ?? [];
  assert.ok(rows.length >= 3);
  for (const line of rows) assert.match(line, /reason: (`genfx: |[a-zA-Z ?:]*"genfx: )/, line.slice(0, 200));
  assert.match(place, /source: "genfx", maxEntry: o\.maxEntry,/);
  // The books pass writes two kinds of row there — a note on one order, and "GEN FX switched itself off on
  // this account" — and both say GEN FX at the start too.
  const settle = readFileSync("src/lib/genfx/settle.ts", "utf8");
  assert.equal((settle.match(/from\("flow_auto_events"\)\.insert\(/g) ?? []).length, 2);
  assert.match(settle, /from\("flow_auto_events"\)\.insert\(\{[^\n]*reason: `genfx: \$\{reason\}`/);
  assert.match(settle, /const reason = `genfx: SWITCHED OFF on this account — \$\{why\}`/);
  // Nothing else in GEN FX inserts into that table.
  for (const f of ["src/lib/genfx/scan.ts", "src/lib/genfx/watch.ts", "worker/genfx.ts"]) assert.ok(!/from\("flow_auto_events"\)\.insert/.test(readFileSync(f, "utf8")), f);
  // And the gold orphan recovery, which recognises a fill by its size, leaves every GEN FX row alone.
  const recover = readFileSync("src/lib/flow/recover.ts", "utf8");
  assert.match(recover, /return !r\.startsWith\("play"\) && !r\.startsWith\("genfx"\);/);
  // …and leaves them out of its read as well, so a GEN FX fan-out cannot crowd gold's own events out of the
  // hundred rows it looks at. If that filter is ever refused, it reads exactly what it read before.
  assert.match(recover, /await recent\(\)\.or\("reason\.is\.null,reason\.not\.like\.genfx\*"\)\.order\("created_at", \{ ascending: false \}\)\.limit\(100\);\s+if \(evErr\) \(\{ data: ev, error: evErr \} = await recent\(\)\.order\("created_at", \{ ascending: false \}\)\.limit\(100\)\);/);
  // GEN FX's own setup-fee rule reads only the rows GEN FX wrote — the mirror image.
  const fxBilling = readFileSync("src/lib/genfx/billing.ts", "utf8");
  assert.equal((fxBilling.match(/\.like\("reason", "genfx%"\)/g) ?? []).length, 2);
});

test("the shared desk knows GBP/JPY (it used to fall back to gold's numbers)", () => {
  const g = getInstrument("GBPJPY");
  assert.equal(g.canonical, "GBPJPY");
  assert.equal(g.twelveDataSymbol, "GBP/JPY");
  assert.equal(g.pipSize, 0.01);
  assert.equal(g.pricePrecision, 3);
  assert.equal(g.minQuantity, 0.01);
  const e = getInstrument("EURUSD");
  assert.equal(e.canonical, "EURUSD");
  assert.equal(e.pipSize, 0.0001);
  assert.equal(e.pricePrecision, 5);
  assert.equal(contractKey("GBPJPY"), "GBPJPY");
  // The desk's own sizing for a GBP/JPY play, handed the USD/JPY rate: ¥100,000 ÷ 150 a lot — exact.
  assert.ok(Math.abs(valuePerPricePerLot("GBPJPY", 150) - 100_000 / 150) < 1e-9);
  // Before the row existed an unknown symbol was worth $1 a lot per 1.0 of price, which sized a play at the lot clamp.
  assert.equal(valuePerPricePerLot("NZDJPY", 90), 1);
  // Gold and the dollar pairs are exactly as they were.
  assert.equal(getInstrument("XAUUSD").pipSize, 0.1);
  assert.equal(valuePerPricePerLot("XAUUSD", 4300), 100);
  assert.equal(valuePerPricePerLot("EURUSD", 1.08), 100_000);
  assert.ok(Math.abs(valuePerPricePerLot("USDJPY", 150) - 100_000 / 150) < 1e-9);
});

test("GEN FX is wired in beside GENX, not into it", () => {
  const worker = readFileSync("worker/index.ts", "utf8");
  assert.match(worker, /import \{ genfxLoop \} from "\.\/genfx";/);
  assert.match(worker, /void genfxLoop\(\(\) => shuttingDown, HOLDER\)\.catch\(/);      // outside the fatal Promise.all
  const stream = readFileSync("worker/priceStream.ts", "utf8");
  assert.match(stream, /const GENFX_SYMBOLS = process\.env\.WORKER_GENFX === "0" \? \[\] : \["EUR\/USD", "GBP\/JPY", "USD\/JPY"\];/);
  const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
  assert.ok(crons.some((c) => c.path === "/api/cron/genfx-scan" && c.schedule === "*/5 * * * *"));
  assert.ok(crons.some((c) => c.path === "/api/cron/genfx-scan?watch=1" && c.schedule === "* * * * *"));
  assert.ok(crons.some((c) => c.path.startsWith("/api/cron/genx-scan")), "gold's scanner is still scheduled");
  const cron = readFileSync("src/app/api/cron/genfx-scan/route.ts", "utf8");
  assert.match(cron, /let got = await acquireFxLock\(admin, holder, LOCK_TTL_MS\);/);
  assert.match(cron, /if \(!got\) return json\(\{ ok: true, skipped: "locked \(worker active\)" \}\);/);
  // The minute run waits only for the scan-only run, never for the worker, and scans when the candle has not been scanned.
  assert.match(cron, /for \(let i = 0; !got && watch && i < 6 && \(await holderKind\(admin\)\) === "cron"; i\+\+\)/);
  assert.match(cron, /if \(await scanDue\(admin, Date\.now\(\)\)\) \{\n\s+scanned = true;\n\s+await untilFeedHasIt\(\);\n\s+const scan = await runGenfxScan\(admin, mdKey\);/);
  // The books need no market data: the minute run does them before it asks for the key, and again after anything that placed.
  assert.ok(cron.indexOf("let books = (await genfxSweep(admin)).settle;") > 0 && cron.indexOf("let books = (await genfxSweep(admin)).settle;") < cron.indexOf('skipped: "no_market_data_key (books only)"'));
  assert.match(cron, /if \(pass\.sent\.some\(\(x\) => \/ENTER\/\.test\(x\)\) \|\| \(booksDueAt && Date\.now\(\) >= booksDueAt\)\) \{\s+books = \(await genfxSweep\(admin\)\)\.settle;/);
  // …and the run's FIRST books pass counts: if it left something waiting on the broker, the books are looked at again ten seconds on.
  assert.match(cron, /let booksDueAt = books\.waiting \|\| books\.cancelled \? Date\.now\(\) \+ 10_000 : 0;/);
  // A history replay never runs on the trade manager's thread.
  const loop = readFileSync("worker/genfx.ts", "utf8");
  // Switched on: the scan runs before the watch looks at anything left on record from before.
  // "Switched on" is judged between two reads that both succeeded: a failed read answers "everything off", and is not the switch being turned.
  assert.match(loop, /let scanWas: boolean \| null = ctl\.readable \? ctl\.scan : null;/);
  const flip = "if (ctl.readable) { if (ctl.scan && scanWas === false) lastScanSlot = 0; scanWas = ctl.scan; }";
  assert.ok(loop.includes(flip));
  assert.ok(loop.indexOf(flip) < loop.indexOf("const r = await runGenfxScan(admin, mdKey, { worker: true });") && loop.indexOf("const r = await runGenfxScan(admin, mdKey, { worker: true });") < loop.indexOf("const w = await genfxWatchPass(admin, mdKey, ctl);"));
  assert.match(loop, /fork\(path\.join\(process\.cwd\(\), "worker", "genfxReplay\.ts"\), \[\], \{ stdio: "inherit" \}\)/);
  assert.ok(!/runRequestedReplay/.test(loop));
  assert.match(readFileSync("worker/genfxReplay.ts", "utf8"), /await runRequestedReplay\(admin, log, /);
  const nav = readFileSync("src/components/portal/PortalNav.tsx", "utf8");
  assert.match(nav, /genfx: \{ href: "\/portal\/genfx", label: "GEN FX"/);
  assert.match(nav, /\{ kind: "page", key: "genx" \},\n  \{ kind: "page", key: "genfx" \},/);
  const floor = readFileSync("src/components/portal/floor/FloorWorkspace.tsx", "utf8");
  assert.match(floor, /\{tab === "genfx" && <GenFxDesk \/>\}/);
  assert.match(floor, /\{ key: "genfx", label: "GEN FX", icon: ArrowLeftRight, view: "genfx" \}/);
  // The GENX results card reads gold only, so a GEN FX trade can never appear in it.
  assert.match(readFileSync("src/app/api/flow/stats/route.ts", "utf8"), /\.eq\("symbol", "XAUUSD"\)/);
});
