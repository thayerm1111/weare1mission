import type { ArmedSetup } from "./engine";
import type { SignalRecord } from "./signals";
import type { AlertInput, AlertRow, CashtrapStore } from "./store";
import { fmtPrice, SYMBOL_SPECS } from "./symbols";

/**
 * ALERTS — every alert has a dedupe key derived from what it is about (the setup or the signal and
 * the event), and the store keeps at most one alert per key, ever: a retried pass, a restarted runner
 * or a duplicate message cannot raise the same alert twice. In-app alerts are the alert rows
 * themselves. Other channels go through `NotificationChannel`s; a delivery row is reserved
 * (alert, channel, recipient — unique) BEFORE sending, so a channel is never sent the same alert twice.
 * Channel credentials live only in server environment variables.
 */
const hms = (t: number) => `${new Date(t).toISOString().slice(11, 19)} UTC`;

export function armedAlert(s: ArmedSetup): AlertInput {
  return {
    dedupeKey: `armed:${s.id}`, kind: "armed", symbol: s.symbol, setupId: s.id,
    title: `${SYMBOL_SPECS[s.symbol].label}: ${s.direction} setup armed`,
    body: `Exhaustion on the ${hms(s.exhaustionT).slice(0, 5)} candle. Not a signal — waiting for the DMI ${s.direction === "BUY" ? "B" : "S"}.`,
  };
}

export function signalAlert(s: SignalRecord): AlertInput {
  return {
    dedupeKey: `signal:${s.dedupeKey}`, kind: "signal", symbol: s.symbol, signalKey: s.dedupeKey, setupId: s.setupId,
    title: `${SYMBOL_SPECS[s.symbol].label}: ${s.direction}`,
    body: `Published ${hms(s.publishedAt)}. Entry window closes ${hms(s.entryDeadline)}. Expiry: ${s.expiryMode === "duration" ? `${s.expiryDurationSec} s from the reference entry (provisional)` : "the contract's fixed time"}.`,
  };
}

export function entryAlert(s: SignalRecord): AlertInput {
  if (s.status === "missed") {
    return { dedupeKey: `missed:${s.dedupeKey}`, kind: "missed", symbol: s.symbol, signalKey: s.dedupeKey, title: `${SYMBOL_SPECS[s.symbol].label}: ${s.direction} missed`, body: `No reference quote inside the entry window. Do not enter late.` };
  }
  return {
    dedupeKey: `entry:${s.dedupeKey}`, kind: "entry", symbol: s.symbol, signalKey: s.dedupeKey,
    title: `${SYMBOL_SPECS[s.symbol].label}: ${s.direction} active`,
    body: `Reference entry ${fmtPrice(s.symbol, s.referencePrice)} at ${hms(s.referenceAt as number)} (${s.referenceSource}); expires ${hms(s.expiryAt as number)}.`,
  };
}

export function outcomeAlert(s: SignalRecord): AlertInput {
  const res = s.result === "unresolved" ? "unresolved — no settlement quote" : `${s.result.toUpperCase()}: ${fmtPrice(s.symbol, s.settlementPrice)} vs entry ${fmtPrice(s.symbol, s.referencePrice)}`;
  return { dedupeKey: `outcome:${s.dedupeKey}`, kind: "outcome", symbol: s.symbol, signalKey: s.dedupeKey, title: `${SYMBOL_SPECS[s.symbol].label}: ${s.direction} ${s.result}`, body: `${res}. Reference-feed outcome (not a broker settlement).` };
}

/** A member's in-app alert choices when they have not set any: setups arming and data notices are off. */
export const DEFAULT_ALERT_PREFS = { kinds: { armed: false, signal: true, entry: true, missed: true, outcome: true, data: false } as Record<string, boolean>, sound: true };

/** Alert kinds a member has switched off (so they are neither listed nor counted as unread). */
export function mutedKinds(prefs: { kinds?: Record<string, boolean> } | null | undefined): string[] {
  const k = { ...DEFAULT_ALERT_PREFS.kinds, ...(prefs?.kinds ?? {}) };
  return Object.keys(k).filter((x) => k[x] === false);
}

/* ── other channels ───────────────────────────────────────────────────────────────────────────── */
export interface NotificationChannel {
  readonly name: string;
  /** Whether this deployment has the server-side credentials for the channel. */
  configured(): boolean;
  /** Which alert kinds this channel is sent. */
  kinds(): string[];
  send(a: AlertRow): Promise<{ ok: boolean; error?: string }>;
}

export const DEFAULT_WEBHOOK_KINDS = ["signal", "entry", "missed", "outcome"];

/**
 * A generic webhook: POSTs the alert as JSON to CASHTRAP_ALERT_WEBHOOK_URL with the header
 * x-cashtrap-secret: CASHTRAP_ALERT_WEBHOOK_SECRET. Off unless both are set. The kinds sent are
 * CASHTRAP_ALERT_WEBHOOK_KINDS (comma-separated; default signal,entry,missed,outcome). A send that
 * takes longer than 4 s is abandoned and recorded as failed — it is not retried, so it cannot arrive twice.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = "webhook";
  configured() { return !!process.env.CASHTRAP_ALERT_WEBHOOK_URL && !!process.env.CASHTRAP_ALERT_WEBHOOK_SECRET; }
  kinds() {
    const k = (process.env.CASHTRAP_ALERT_WEBHOOK_KINDS || "").split(",").map((x) => x.trim()).filter(Boolean);
    return k.length ? k : DEFAULT_WEBHOOK_KINDS;
  }
  async send(a: AlertRow) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    try {
      const r = await fetch(String(process.env.CASHTRAP_ALERT_WEBHOOK_URL), {
        method: "POST", headers: { "content-type": "application/json", "x-cashtrap-secret": String(process.env.CASHTRAP_ALERT_WEBHOOK_SECRET) },
        body: JSON.stringify({ kind: a.kind, symbol: a.symbol, title: a.title, body: a.body, at: new Date(a.createdAt).toISOString(), key: a.dedupeKey }),
        signal: ctrl.signal,
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    finally { clearTimeout(timer); }
  }
}

export const CHANNELS: NotificationChannel[] = [new WebhookChannel()];

/**
 * Deliver a NEW alert to each configured channel that takes its kind: reserve (alert, channel,
 * recipient — unique) first, then send, then record sent/failed. At most once per channel: a reserved
 * delivery is never sent again, and nothing re-sends old alerts later (a late trading alert is worse
 * than none). A channel problem never stops the runner.
 */
export async function deliver(store: CashtrapStore, a: AlertRow, nowMs: number, channels: NotificationChannel[] = CHANNELS): Promise<void> {
  for (const ch of channels) {
    try {
      if (!ch.configured() || !ch.kinds().includes(a.kind)) continue;
      if (!(await store.reserveDelivery(a.id, ch.name, "default", nowMs))) continue;
      const r = await ch.send(a);
      await store.finishDelivery(a.id, ch.name, "default", r.ok, r.ok ? null : r.error ?? "failed");
    } catch { /* recorded as reserved; never retried */ }
  }
}

/** Create the alert once (in-app); only a newly created alert goes to the other channels. */
export async function raise(store: CashtrapStore, a: AlertInput, nowMs: number, channels: NotificationChannel[] = CHANNELS): Promise<boolean> {
  const r = await store.createAlert(a, nowMs);
  if (r.created && r.id != null) await deliver(store, { ...a, id: r.id, createdAt: nowMs }, nowMs, channels);
  return r.created;
}
