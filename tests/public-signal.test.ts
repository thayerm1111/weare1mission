import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formingPost, enterPost, cancelledPost, deskPost, publicHoldReason, givesPlayAway, GENX_TOOL, GENFX_TOOL, GOLD_MARKET, SITE_URL } from "../src/lib/publicSignal";
import { headsUpMsg, enterMsg, invalidMsg, genxTyped, calledSince } from "../src/lib/genx/watchTick";
import * as fx from "../src/lib/genfx/messages";
import { PAIRS } from "../src/lib/genfx/pairs";
import { type Mode } from "../src/lib/genxCompute";

/*
 * The Telegram channel has free subscribers (owner 10-05: "There's customers in there that are getting
 * free signals … make the customer have to go use credits in order to see"). These hold the channel to
 * that: a post may say that something is happening, on what and on which horizon, and where to read
 * it — never which way, never a level, never a price.
 */
const MODES: Mode[] = ["quick", "intraday", "swing"];
const src = (path: string): string => readFileSync(path, "utf8");

/** Every `fn(` call in a source text, as the text of its arguments (to the matching bracket). */
function calls(text: string, fn: string): string[] {
  const out: string[] = [];
  const needle = `${fn}(`;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text[at - 1] ?? " ";
    if (/[A-Za-z0-9_$.]/.test(before)) continue;                  // part of a longer name, or a method
    let depth = 0, i = at + fn.length;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push(text.slice(at + needle.length, i).trim());
  }
  return out;
}

test("gold: forming, enter and cancelled name the horizon and where to read the play — and give none of it away", () => {
  for (const mode of MODES) {
    const title = genxTyped(mode);
    const forming = headsUpMsg(mode), enter = enterMsg(mode), off = invalidMsg(mode);
    assert.equal(forming.split("\n")[0], `⏳ <b>${title} — setup forming</b>`);
    assert.equal(enter.split("\n")[0], `✅ <b>${title} — ENTER NOW</b>`);
    assert.equal(off.split("\n")[0], `❌ <b>${title} — setup cancelled</b>`);
    for (const post of [forming, enter, off]) {
      assert.equal(post.split("\n")[1], "Gold (XAU/USD)");
      assert.equal(givesPlayAway(post), false, post);
    }
    assert.match(forming, /Run GENX to see the play\./);
    assert.match(forming, /You'll get an <b>ENTER NOW<\/b> here the moment it triggers\./);
    assert.match(enter, /Run GENX now to get the play\./);
    assert.match(off, /This one is off\. Don't take it\./);
    // The two that send people to the site link the GENX page, where a run is paid for in credits.
    for (const post of [forming, enter]) assert.ok(post.includes(`<a href="${SITE_URL}/portal/genx">Open GENX →</a>`), post);
    assert.ok(!off.includes("<a "));
  }
  assert.match(headsUpMsg("swing"), /GENX \d+\.\d SWING — setup forming/);
  assert.deepEqual([GENX_TOOL.path, GENFX_TOOL.path], ["/portal/genx", "/portal/genfx"]);
});

test("GEN FX: the same three posts name the pair and the horizon, link the GEN FX page, and give nothing away", () => {
  for (const pair of [PAIRS.EURUSD, PAIRS.GBPJPY]) for (const mode of MODES) {
    const forming = fx.headsUpMsg(pair, mode), enter = fx.enterMsg(pair, mode), off = fx.invalidMsg(pair, mode);
    assert.equal(forming.split("\n")[0], `⏳ <b>${fx.genfxTyped(mode)} — setup forming</b>`);
    assert.equal(enter.split("\n")[0], `✅ <b>${fx.genfxTyped(mode)} — ENTER NOW</b>`);
    assert.equal(off.split("\n")[0], `❌ <b>${fx.genfxTyped(mode)} — setup cancelled</b>`);
    for (const post of [forming, enter, off]) {
      assert.equal(post.split("\n")[1], pair.name);
      assert.equal(givesPlayAway(post), false, post);
    }
    assert.match(forming, /Run GEN FX to see the play\./);
    assert.match(enter, /Run GEN FX now to get the play\./);
    for (const post of [forming, enter]) assert.ok(post.includes(`<a href="${SITE_URL}/portal/genfx">Open GEN FX →</a>`), post);
  }
  // A win is posted after the trade is over: it still says what was called.
  const win = fx.winMsg(PAIRS.EURUSD, "sell", "quick", { entry_low: 1.12271, entry_high: 1.12277, tp1: 1.12125 }, 17);
  assert.match(win, /GEN FX WIN · EUR\/USD SELL · Quick/);
  assert.match(win, /\+17 pips/);
  assert.match(win, /Called 1\.12271–1\.12277 → TP1 1\.12125\./);
});

test("the builders cannot be handed a side or a price: they take the horizon (and the pair), nothing else", () => {
  assert.deepEqual([headsUpMsg.length, enterMsg.length, invalidMsg.length], [1, 1, 1]);
  assert.deepEqual([fx.headsUpMsg.length, fx.enterMsg.length, fx.invalidMsg.length], [2, 2, 2]);
  assert.deepEqual([formingPost.length, enterPost.length, cancelledPost.length], [3, 3, 2]);
  const gold = src("src/lib/genx/watchTick.ts"), fxm = src("src/lib/genfx/messages.ts");
  assert.match(gold, /export const headsUpMsg = \(mode: Mode\): string => formingPost\(genxTyped\(mode\), GOLD_MARKET, GENX_TOOL\);/);
  assert.match(gold, /export const enterMsg = \(mode: Mode\): string => enterPost\(genxTyped\(mode\), GOLD_MARKET, GENX_TOOL\);/);
  assert.match(gold, /export const invalidMsg = \(mode: Mode\): string => cancelledPost\(genxTyped\(mode\), GOLD_MARKET\);/);
  assert.match(fxm, /export const headsUpMsg = \(p: FxPair, mode: Mode\): string => formingPost\(genfxTyped\(mode\), p\.name, GENFX_TOOL\);/);
  assert.match(fxm, /export const enterMsg = \(p: FxPair, mode: Mode\): string => enterPost\(genfxTyped\(mode\), p\.name, GENFX_TOOL\);/);
  assert.match(fxm, /export const invalidMsg = \(p: FxPair, mode: Mode\): string => cancelledPost\(genfxTyped\(mode\), p\.name\);/);
  // What the three shared posts are built from: the title, the market and the tool — as given.
  assert.equal(formingPost("T", "M", { name: "X", path: "/x" }), `⏳ <b>T — setup forming</b>\nM\nA setup is taking shape. Run X to see the play.\nYou'll get an <b>ENTER NOW</b> here the moment it triggers.\n<a href="${SITE_URL}/x">Open X →</a>\n<i>Educational, not financial advice.</i>`);
  assert.equal(enterPost("T", "M", { name: "X", path: "/x" }), `✅ <b>T — ENTER NOW</b>\nM\nThe setup just triggered. Run X now to get the play.\n<a href="${SITE_URL}/x">Open X →</a>\n<i>Educational, not financial advice.</i>`);
  assert.equal(cancelledPost("T", "M"), `❌ <b>T — setup cancelled</b>\nM\nThis one is off. Don't take it.`);
});

test("a call that is not a read on the GENX page says where it is being taken — and does not send anyone to run GENX for it", () => {
  // The previous-day scalp, a range fade, an owner level: running GENX would show something else.
  assert.equal(deskPost.length, 3);
  assert.equal(deskPost("✅", "T — ENTER NOW", "M"), `✅ <b>T — ENTER NOW</b>\nM\nFLOW is taking this one on connected accounts.\n<i>Educational, not financial advice.</i>`);
  for (const post of [deskPost("✅", "GENX 1.0 SCALP — ENTER NOW", GOLD_MARKET), deskPost("🎯", "GENX 1.0 — OWNER LEVEL triggered", GOLD_MARKET), deskPost("✅", "GENX 1.0 INTRADAY — ENTER NOW", GOLD_MARKET)]) {
    assert.equal(post.split("\n")[1], "Gold (XAU/USD)");
    assert.equal(givesPlayAway(post), false, post);
    assert.ok(!/Run GENX|<a /.test(post), post);
  }
});

test("what would give a play away: a direction, a level word, or anything shaped like a price", () => {
  for (const t of ["SELL setup forming", "Buyers confirmed on the close", "going long here", "structure flipped bearish", "Stop 4170.60", "Gold @ ~4122", "Entry 1.12271", "support held", "the top of the range", "watch 208.776"]) assert.equal(givesPlayAway(t), true, t);
  for (const t of ["GENX 1.0 SWING — ENTER NOW", "Gold (XAU/USD)", "EUR/USD", "GBP/JPY", "Run GENX to see the play.", `<a href="${SITE_URL}/portal/genfx">Open GEN FX →</a>`, "paused for another 45 min", "between 4:45pm and 7:00pm New York"]) assert.equal(givesPlayAway(t), false, t);
});

test("why the desk held an entry, as the channel reads it: the kind of safeguard, never which way or where", () => {
  // The desk's own reasons, exactly as autoExec.goldEntryHold and rangeGuard.blockedByRange write them.
  const choch = (flip: string, side: string) => `Change of character: gold structure just flipped ${flip} (a ${flip === "bullish" ? "higher high — price reclaimed the level it fell from" : "lower low — price broke the level it rose from"}). Not taking a ${side} against it — conservative and aggressive accounts wait for the structure to settle.`;
  for (const r of [choch("bullish", "SELL"), choch("bearish", "BUY")]) {
    assert.equal(givesPlayAway(r), true);
    assert.equal(publicHoldReason(r), "Change of character: the market's structure just flipped against this entry. Accounts wait for it to settle.");
  }
  const range = [
    "Range guard: price is only 12% up the 4120.00–4160.00 range — selling into the floor of a range is the trade that keeps stopping out. Waiting for a break of the low, or a rally back toward the top.",
    "Range guard: price is already 91% up the 4120.00–4160.00 range — buying into the ceiling of a range is the trade that keeps stopping out. Waiting for a break of the high, or a pullback toward the bottom.",
  ];
  for (const r of range) assert.equal(publicHoldReason(r), "Range guard: price is at the wrong edge of its range for this entry.");
  // The breaker says nothing about a side or a level: it is passed on as it is, timing and all.
  const breaker = "Desk breaker: 3 losing trades in the last six hours. New entries are paused for another 45 min so the desk stops paying to re-test a read the market keeps rejecting. Open trades are still managed; entries resume on their own.";
  const blind = "Desk breaker: the loss record could not be read, so the desk cannot tell whether it is on a losing streak. New entries wait until it can. Open trades are still managed.";
  assert.deepEqual([publicHoldReason(breaker), publicHoldReason(blind)], [breaker, blind]);
  // The blackouts name the side they were asked about; the channel's copy does not.
  assert.equal(publicHoldReason("Weekend-close blackout: no new SELL entries in the final 30 minutes before Friday's close. Open positions keep being managed; fresh setups resume at the Sunday reopen."),
    "Weekend-close blackout: no new entries in the final 30 minutes before Friday's close. Open positions keep being managed; fresh setups resume at the Sunday reopen.");
  assert.equal(publicHoldReason("Daily-reopen blackout: no new BUY entries between 4:45pm and 7:00pm New York (around the daily market close/reopen — spreads are widest and liquidity thinnest right there). Open positions keep being managed; fresh setups resume after 7pm NY."),
    "Daily-reopen blackout: no new entries between 4:45pm and 7:00pm New York (around the daily market close/reopen — spreads are widest and liquidity thinnest right there). Open positions keep being managed; fresh setups resume after 7pm NY.");
  // Anything it does not recognise — or that would still tell — is the plain line. It fails closed.
  const plain = "A desk safeguard is holding this entry back.";
  for (const r of ["Trend filter: not selling into a rising market", "", null, undefined, "Desk breaker: resting after the 4170.60 stop-out", "Weekend-close blackout: sellers only"]) assert.equal(publicHoldReason(r), plain, String(r));
  for (const r of [...range, choch("bullish", "SELL"), breaker, blind, "anything else"]) assert.equal(givesPlayAway(publicHoldReason(r)), false);
});

test("every post to the members' channel is one of the forms that carry no play", () => {
  const anyOf = (list: string[], allowed: RegExp[], where: string) => { for (const c of list) assert.ok(allowed.some((re) => re.test(c)), `${where}: sendTelegram(${c.slice(0, 120)}`); };

  // The gold scanner: the three live posts by horizon only; the two side strategies (not reads on the
  // GENX page) as desk calls; the win recap and the connection probe as they were.
  const scan = calls(src("src/app/api/cron/genx-scan/route.ts"), "sendTelegram");
  assert.equal(scan.length, 9);
  anyOf(scan, [/^enterMsg\(mode\)$/, /^headsUpMsg\(mode\)$/, /^invalidMsg\(mode\)$/, /^deskPost\("✅", `\$\{genxTyped\("(quick|intraday)"\)\} — ENTER NOW`, GOLD_MARKET\)$/, /^\[\s*`🏆 <b>GENX WIN/, /^\[\s*"✅ <b>GENX alerts connected<\/b>"/], "genx-scan");
  assert.deepEqual(scan.filter((c) => /^(enter|headsUp|invalid)Msg\(|^deskPost\(/.test(c)).sort(), ['deskPost("✅", `${genxTyped("intraday")} — ENTER NOW`, GOLD_MARKET)', 'deskPost("✅", `${genxTyped("quick")} — ENTER NOW`, GOLD_MARKET)', "enterMsg(mode)", "enterMsg(mode)", "enterMsg(mode)", "headsUpMsg(mode)", "invalidMsg(mode)"]);

  // The fast watch, the page setups and the previous-day scalp.
  assert.deepEqual(calls(src("src/lib/genx/watchTick.ts"), "sendTelegram"), ["enterMsg(row.mode)", "enterMsg(row.mode)", "invalidMsg(row.mode)"]);
  assert.deepEqual(calls(src("src/lib/genx/zoneSetups.ts"), "sendTelegram"), ["enterMsg(r.mode)"]);
  assert.deepEqual(calls(src("src/lib/genx/pdTick.ts"), "sendTelegram"), ['deskPost("✅", `${genxLabel()} SCALP — ENTER NOW`, GOLD_MARKET)']);
  assert.match(src("src/lib/genx/zoneSetups.ts"), /enterMsg: \(mode: Mode\) => string\)/);

  // GENX 3 (dormant): a desk call, plus its own shutdown notice.
  const g3 = calls(src("src/lib/genx3/runtime.ts"), "sendTelegram");
  assert.equal(g3.length, 2);
  anyOf(g3, [/^signalMessage\(\)$/, /^`🛑 <b>GENX 3\.0 disabled automatically<\/b>/], "genx3");
  assert.match(src("src/lib/genx3/runtime.ts"), /function signalMessage\(\): string \{\n  return deskPost\("✅", "GENX 3\.0 — ENTER NOW", GOLD_MARKET\);\n\}/);

  // GEN FX: the scanner speaks through say(); the watch posts the page-setup ENTER itself.
  const fxScan = calls(src("src/lib/genfx/scan.ts"), "say");
  assert.equal(fxScan.length, 6);
  anyOf(fxScan, [/^ctl, enterMsg\(pair, (row\.)?mode\)$/, /^ctl, invalidMsg\(pair, row\.mode\)$/, /^ctl, headsUpMsg\(pair, mode\)$/, /^ctl, winMsg\(pair, a\.side, a\.mode, \{ entry_low: a\.entry_low, entry_high: a\.entry_high, tp1: a\.tp1 \}, pips\)$/], "genfx scan");
  assert.deepEqual(calls(src("src/lib/genfx/watch.ts"), "sendTelegram"), ["enterMsg(pair, r.mode)"]);

  // FLOW's notes about an entry it held back. What a note may put into its text is listed here, and
  // it is short: the brand, the horizon, the swing floor's dollar figure — and the desk's reason only
  // through publicHoldReason. No side, no price, no reward figure, no raw reason.
  const filled = (c: string): string[] => [...c.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  const flow = calls(src("src/lib/flow/autoExec.ts"), "sendTelegram");
  assert.equal(flow.length, 5);
  const allowed = new Set(["genxLabel()", "genxTypeOf(sig.mode)", "publicHoldReason(gate.reason)", 'SWING_MIN_BALANCE.toLocaleString("en-US")']);
  for (const c of flow) for (const x of filled(c)) assert.ok(allowed.has(x), `autoExec note fills in \${${x}}`);
  assert.equal(flow.filter((c) => filled(c).includes("publicHoldReason(gate.reason)")).length, 2);
  for (const c of flow) assert.ok(!/\b(BUY|SELL)\b|toUpperCase|R:R/.test(c), c.slice(0, 160));

  // An owner level: that one fired and where it is being taken — not which way, which level or where.
  assert.deepEqual(calls(src("src/lib/flow/ownerLevels.ts"), "sendTelegram"), ['deskPost("🎯", `${genxLabel()} — OWNER LEVEL triggered`, GOLD_MARKET)']);

  // The trading monitor falls back to the members' channel when no private chat is set. Its one
  // warning that could name a trade's side names it for the private chat only.
  const monitor = src("src/app/api/cron/flow-monitor/route.ts");
  assert.equal((monitor.match(/p\.side\)/g) ?? []).length, 1);
  assert.ok(monitor.includes("BE stop parked at a LOSS: ${esc(p.symbol)}${adminChat ? ` ${esc(p.side)}` : \"\"} on "));
  const pushed = monitor.split("\n").filter((l) => l.includes("anomalies.push("));
  assert.equal(pushed.length, 3);
  assert.equal(pushed.filter((l) => /\.side/.test(l)).length, 1);
});

test("the live-alert feed behind the GENX Lab is for admins: it would hand over what the channel no longer does", () => {
  const route = src("src/app/api/genx/alerts-status/route.ts");
  // The same test the page applies, before anything is read.
  const gate = route.indexOf('if (!profile || profile.role !== "admin") return json({ error: "forbidden" }, 403);');
  assert.ok(gate > 0);
  assert.ok(gate < route.indexOf("createAdminClient()"), "the admin test comes before the data is read");
  assert.match(src("src/app/portal/genx-lab/page.tsx"), /if \(!profile \|\| profile\.role !== "admin"\) redirect\("\/portal"\);/);
  // Nothing else on the site reads it.
  assert.match(src("src/components/portal/GenxLab.tsx"), /fetch\("\/api\/genx\/alerts-status"/);
});

test("gold: a heads-up is not sent for a setup the channel has already been told to enter", async () => {
  // The alert row as the scan finds it when it comes back from charging the fees.
  const admin = (row: unknown, error: unknown = null, boom = false) => ({
    from: (t: string) => { assert.equal(t, "genx_alerts"); return { select: (c: string) => { assert.equal(c, "state, enter_sent_at"); return { eq: (col: string, v: string) => { assert.deepEqual([col, v], ["dedupe_key", "swing:sell:4130:4132"]); return { maybeSingle: async () => { if (boom) throw new Error("network"); return { data: row, error }; } }; } }; } }; },
  }) as never;
  const k = "swing:sell:4130:4132";
  assert.equal(await calledSince(admin({ state: "forming", enter_sent_at: null }), k), false);                       // still forming → say so
  assert.equal(await calledSince(admin({ state: "entered", enter_sent_at: "2026-10-06T02:45:06Z" }), k), true);      // the watch entered it
  assert.equal(await calledSince(admin({ state: "forming", enter_sent_at: "2026-10-06T02:45:06Z" }), k), true);      // armed: ENTER NOW sent, waiting for the pullback
  assert.equal(await calledSince(admin({ state: "invalidated", enter_sent_at: null }), k), true);                    // cancelled already
  // Nothing readable → the heads-up goes out, as it always did.
  assert.equal(await calledSince(admin(null), k), false);
  assert.equal(await calledSince(admin(null, { message: "timeout" }), k), false);
  assert.equal(await calledSince(admin(null, null, true), k), false);
  // And the scan asks after the fees are charged, immediately before it would post.
  const scan = src("src/app/api/cron/genx-scan/route.ts");
  const bill = scan.indexOf("await billSetupForming(admin, dedupeKey, mode)"), ask = scan.indexOf("const called = tgReady && await calledSince(admin, dedupeKey);"), post = scan.indexOf("if (tgReady && !called) await sendTelegram(headsUpMsg(mode));");
  assert.ok(bill > 0 && ask > bill && post > ask, "bill, then ask, then post");
});
