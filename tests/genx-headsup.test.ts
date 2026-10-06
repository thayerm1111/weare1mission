import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calledSince } from "../src/lib/genx/watchTick";

/*
 * Two things kept from the 10-05 Telegram change when the channel's posts were switched back to the
 * full play (owner 10-06: "You can switch it back to how it was"):
 *   - a heads-up is not sent for a setup the channel has already been told to enter;
 *   - the live-alert feed behind the GENX Lab answers admins only.
 */
const src = (p: string): string => readFileSync(p, "utf8");

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
  // And the scan asks after the fees are charged, immediately before it would post — the full heads-up, as it was.
  const scan = src("src/app/api/cron/genx-scan/route.ts");
  const bill = scan.indexOf("await billSetupForming(admin, dedupeKey, mode)"), ask = scan.indexOf("const called = tgReady && await calledSince(admin, dedupeKey);");
  const post = scan.indexOf("if (tgReady && !called) await sendTelegram(headsUpMsg(side, mode, { entry_low: genx.entry_low, entry_high: genx.entry_high, stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, confidence: genx.confidence_score }));");
  assert.ok(bill > 0 && ask > bill && post > ask, "bill, then ask, then post");
  assert.equal((scan.match(/sendTelegram\(headsUpMsg\(/g) ?? []).length, 1, "the one place a gold heads-up is posted from");
});

test("the live-alert feed behind the GENX Lab is for admins", () => {
  const route = src("src/app/api/genx/alerts-status/route.ts");
  // The same test the page applies, before anything is read.
  const gate = route.indexOf('if (!profile || profile.role !== "admin") return json({ error: "forbidden" }, 403);');
  assert.ok(gate > 0);
  assert.ok(gate < route.indexOf("createAdminClient()"), "the admin test comes before the data is read");
  assert.match(src("src/app/portal/genx-lab/page.tsx"), /if \(!profile \|\| profile\.role !== "admin"\) redirect\("\/portal"\);/);
  // Nothing else on the site reads it.
  assert.match(src("src/components/portal/GenxLab.tsx"), /fetch\("\/api\/genx\/alerts-status"/);
});

test("the channel's posts carry the play again: side, zone, stop and targets, as before 10-05", async () => {
  const { headsUpMsg, enterMsg, invalidMsg } = await import("../src/lib/genx/watchTick");
  const z = { entry_low: 4129.98, entry_high: 4131.84, stop: 4170.6, tp1: 4048.74, tp2: 4021.5, tp3: 3990.25 };
  const heads = headsUpMsg("sell", "swing", { ...z, confidence: 66 });
  const enter = enterMsg("sell", "swing", z, 4130.2, true);
  const off = invalidMsg("sell", "swing", { entry_low: z.entry_low, entry_high: z.entry_high, invalidation: 4170.6 });
  for (const [name, msg] of [["heads-up", heads], ["enter", enter]] as const) {
    assert.ok(/SELL/.test(msg), `${name} names the side`);
    for (const level of ["4129.98", "4131.84", "4170.6", "4048.74"]) assert.ok(msg.replace(/,/g, "").includes(level), `${name} carries ${level}`);
  }
  assert.ok(/SELL/.test(off));
  // Nothing in the tree still words a post without the play.
  for (const f of ["src/lib/genx/watchTick.ts", "src/lib/genx/zoneSetups.ts", "src/lib/genfx/messages.ts", "src/app/api/cron/genx-scan/route.ts", "src/lib/flow/autoExec.ts"]) assert.ok(!/publicSignal|Run GENX to see the play/.test(src(f)), f);
});
