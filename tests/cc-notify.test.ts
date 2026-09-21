/**
 * WHAT ATLAS SAYS OUT LOUD, AND HOW OFTEN.
 *
 * The worker ticks every 20 seconds. Untuned, that is 180 messages an hour in a channel the owner
 * shares with GENX signals — not monitoring, a denial of service on his attention. These tests pin the
 * throttles, because the difference between "useful health feed" and "channel nobody reads" is
 * entirely in these numbers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { __due, __resetNotifyThrottles } from "../command-center/engines/notify";
import { esc, fmt } from "../command-center/adapters/telegram";

test("a throttled key fires once and then holds", () => {
  __resetNotifyThrottles();
  assert.equal(__due("watching", 3600_000), true, "first call goes out");
  assert.equal(__due("watching", 3600_000), false, "the second is held");
  assert.equal(__due("watching", 3600_000), false);
});

test("different keys throttle independently", () => {
  /*
   * This is why "stood down" is keyed on the REASON. A cooldown blocking fifty ticks must produce one
   * line, while a genuinely different refusal an hour later must still get through — otherwise the one
   * question an owner actually has, "why is it not trading", goes unanswered.
   */
  __resetNotifyThrottles();
  assert.equal(__due("stood:cooldown", 30 * 60_000), true);
  assert.equal(__due("stood:cooldown", 30 * 60_000), false, "same reason is held");
  assert.equal(__due("stood:daily loss limit", 30 * 60_000), true, "a different reason still speaks");
});

test("a zero window never holds anything — trades and switch changes are events", () => {
  __resetNotifyThrottles();
  assert.equal(__due("took", 0), true);
  assert.equal(__due("took", 0), true, "an order is never suppressed");
});

test("the forming key changes with the setup, not just the clock", () => {
  // Keyed on side, style and stop, so a new setup announces promptly while the same one ripening quietly
  // does not repeat every twenty minutes.
  __resetNotifyThrottles();
  assert.equal(__due("forming:buy:quick:4380.00", 20 * 60_000), true);
  assert.equal(__due("forming:buy:quick:4380.00", 20 * 60_000), false, "same setup stays quiet");
  assert.equal(__due("forming:sell:quick:4395.00", 20 * 60_000), true, "a different setup is new news");
});

test("HTML from the market can never break the message", () => {
  // Telegram's HTML parse mode rejects a malformed message outright, which would silently drop a trade
  // announcement. Everything interpolated is escaped.
  assert.equal(esc("<b>not bold</b>"), "&lt;b&gt;not bold&lt;/b&gt;");
  assert.equal(esc("gold & silver"), "gold &amp; silver");
});

test("prices are two decimals, and a missing one is a dash rather than null", () => {
  assert.equal(fmt(4380.004), "4380.00");
  assert.equal(fmt(null), "—");
  assert.equal(fmt(undefined), "—");
  assert.equal(fmt(Number.NaN), "—", "a NaN price in a channel looks like a broken bot");
});
