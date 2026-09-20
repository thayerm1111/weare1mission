/**
 * WHAT THE BRAIN SAYS OUT LOUD.
 *
 * The owner asked to see the engine's health in the same channel as the GENX calls: that it is
 * watching, that it is about to act, and what it did. The hard part is not sending — it is sending
 * little enough to still be worth reading.
 *
 * THE WORKER TICKS EVERY TWENTY SECONDS. A message per tick is 180 an hour, which is not monitoring,
 * it is a denial of service on the owner's attention. So every stream here is throttled, and the
 * throttles are chosen by how often the underlying thing genuinely changes:
 *
 *   watching     — hourly. A heartbeat's job is to prove liveness, not to narrate.
 *   forming      — at most once every 20 minutes, and only when the shape changes.
 *   stood down   — at most once every 30 minutes PER REASON, because "why is it not trading" is the
 *                  question an owner actually has, and the answer repeats.
 *   taking       — never throttled. An order is an event.
 *   switch       — never throttled. A state change is an event.
 *
 * SILENCE IS ALSO A SIGNAL, so the heartbeat carries the things that would otherwise fail quietly: the
 * feed's age, whether the kill switch is on, how many accounts are armed, and what the engine thinks.
 * An hourly line that says "watching, feed 14s, 1 account armed" is worth more than a hundred that say
 * nothing.
 *
 * EVERY SEND IS BEST-EFFORT. Nothing in this file may throw into the trading loop or delay an order.
 */

import { sendTelegram, esc, fmt, telegramConfigured, type Audience } from "../adapters/telegram";
import type { MarketSnapshot } from "../core/types";

/* ── throttling ─────────────────────────────────────────────────────────── */

const lastSentAt = new Map<string, number>();

/** True when this key has not been sent inside its window. Records the send when it returns true. */
function due(key: string, windowMs: number): boolean {
  const now = Date.now();
  const prev = lastSentAt.get(key);
  if (prev != null && now - prev < windowMs) return false;
  lastSentAt.set(key, now);
  return true;
}

/** Fire and forget. The trading loop never waits on a chat message. */
function post(html: string, audience: Audience): void {
  if (!telegramConfigured()) return;
  void sendTelegram(html, audience).catch(() => { /* best-effort by design */ });
}

const HOUR = 3600_000;

/* ── the messages ───────────────────────────────────────────────────────── */

export type Health = {
  snapshot: MarketSnapshot | null;
  marketOpen: boolean;
  tradeable: boolean;
  switchOn: boolean;
  armedAccounts: number;
  thesis?: { label?: string | null; confidence?: number | null } | null;
};

/**
 * THE HOURLY HEARTBEAT.
 *
 * Sent only while the market is open — an hourly "watching" through a weekend is noise about nothing,
 * and the weekend silence is itself informative once the owner knows the rule.
 */
export function heartbeat(h: Health): void {
  if (!h.marketOpen) return;
  if (!due("watching", HOUR)) return;

  const s = h.snapshot;
  const feedAge = s?.feeds?.[0]?.ageMs;
  const ageLine = feedAge == null ? "feed —" : `feed ${Math.round(feedAge / 1000)}s`;

  // The blockers are the honest answer to "why is it quiet", so they lead rather than hide.
  const blocked = s?.blockers?.length ? s.blockers.map((b) => b.code).join(", ") : null;

  const lines = [
    `👁 <b>THE BRAIN — watching</b>`,
    s ? `Gold @ ${fmt(s.price)} · ${esc(s.regime)} · ${esc(s.session)}` : `No market read yet`,
    h.thesis?.label ? `Read: ${esc(h.thesis.label)}${h.thesis.confidence != null ? ` (${h.thesis.confidence})` : ""}` : null,
    blocked ? `Standing aside: ${esc(blocked)}` : (h.tradeable ? `Clear to trade` : `Not tradeable right now`),
    `${h.armedAccounts} account${h.armedAccounts === 1 ? "" : "s"} armed · ${ageLine} · autopilot ${h.switchOn ? "ON" : "OFF"}`,
  ].filter(Boolean);

  post(lines.join("\n"), "health");
}

/**
 * A SETUP IS FORMING — the "about to call a trade" the owner asked for.
 *
 * Keyed on the shape of the setup, not just the clock, so a genuinely new setup is announced promptly
 * while the same one quietly ripening does not repeat every twenty minutes.
 */
export function formingSetup(input: {
  side: string; style: string; entry: number | null; stop: number | null; price: number | null;
  missing?: string | null;
}): void {
  const key = `forming:${input.side}:${input.style}:${fmt(input.stop)}`;
  if (!due(key, 20 * 60_000)) return;

  post([
    `⏳ <b>THE BRAIN — setup forming · ${esc(input.side.toUpperCase())} · ${esc(input.style)}</b>`,
    `Gold @ ${fmt(input.price)} · watching ${fmt(input.entry)} · stop would be ${fmt(input.stop)}`,
    input.missing ? `Waiting on: ${esc(input.missing)}` : `Waiting on the trigger.`,
    `<i>Not a call. THE BRAIN is watching this one.</i>`,
  ].join("\n"), "signals");
}

/**
 * AN ORDER WENT OUT. Never throttled — this is the event everything else exists to contextualise.
 */
export function tookTrade(input: {
  side: string; style: string; entry: number | null; stop: number | null;
  target: number | null; lots?: number | null; riskAmount?: number | null; accNum?: string | null;
}): void {
  const size = input.lots != null
    ? `${input.lots} lots${input.riskAmount != null ? ` · ${fmt(input.riskAmount)} at risk` : ""}`
    : null;

  post([
    `🤖 <b>THE BRAIN — TAKING · ${esc(input.side.toUpperCase())} · ${esc(input.style)}</b>`,
    `Entry ~${fmt(input.entry)} · Stop ${fmt(input.stop)}${input.target != null ? ` · Target ${fmt(input.target)}` : ""}`,
    size ? esc(size) : null,
    input.accNum ? `Account ${esc(input.accNum)}` : null,
    `<i>Automated. Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n"), "signals");
}

/**
 * IT WANTED TO TRADE AND SOMETHING SAID NO.
 *
 * The most useful health message in the file, and the easiest to get wrong. Throttled PER REASON, so a
 * cooldown that blocks fifty ticks produces one line, while a different refusal an hour later still
 * gets through. "Why is it not trading" is answered here or it is not answered at all.
 */
export function stoodDown(reason: string, ctx?: { side?: string; style?: string }): void {
  const key = `stood:${reason.slice(0, 60)}`;
  if (!due(key, 30 * 60_000)) return;

  post([
    `⛔ <b>THE BRAIN — stood down</b>${ctx?.side ? ` · ${esc(ctx.side.toUpperCase())}${ctx.style ? ` · ${esc(ctx.style)}` : ""}` : ""}`,
    esc(reason),
  ].join("\n"), "health");
}

/** The kill switch changed state. An event, never throttled, and worth seeing immediately. */
export function switchChanged(on: boolean): void {
  post(
    on
      ? `🟢 <b>THE BRAIN — autopilot ON</b>\nNew entries are enabled again.`
      : `🔴 <b>THE BRAIN — autopilot OFF</b>\nNo new entries. Open positions keep being managed.`,
    "health",
  );
}

/** One line at boot, carrying the pre-flight result so a broken deploy announces itself. */
export function booted(preflight: { ok: number; failing: number; detail?: string | null }): void {
  const bad = preflight.failing > 0;
  post([
    `${bad ? "⚠️" : "🟢"} <b>THE BRAIN — worker started</b>`,
    `Pre-flight: ${preflight.ok} ok, ${preflight.failing} failing`,
    bad && preflight.detail ? esc(preflight.detail.slice(0, 300)) : null,
  ].filter(Boolean).join("\n"), "health");
}

/** Test seam — clears the throttle memory between cases. */
export function __resetNotifyThrottles(): void {
  lastSentAt.clear();
}

/** Exposed so a test can assert the throttle windows rather than trust the comments. */
export const __due = due;
