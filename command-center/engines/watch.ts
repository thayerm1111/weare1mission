/**
 * PERSISTENT MONITORING INSTRUCTIONS — "watch the London high and tell me if the retest fails."
 *
 * THE RULE THIS FILE EXISTS FOR: never say "I'll watch it" unless the backend has registered the task.
 *
 * That sounds obvious and it is the single easiest thing in a voice product to get wrong, because the
 * language model will happily agree to watch something and then forget it existed the moment the socket
 * drops. So the order is always: parse, WRITE THE ROW, and only then confirm. A member who is told their
 * level is being watched has to be able to close the browser, come back tomorrow, and find it still
 * armed — or the assurance was a lie, and a lie about monitoring is worse than no monitoring.
 *
 * Evaluation runs in the worker, on the same snapshots everything else uses. It never runs in a browser.
 *
 * INFORMATIONAL vs ACTION is enforced at the type level and again at the database. A watch is a request
 * to be TOLD something. Turning one into a standing order is a separate, explicit authority, and it
 * still has to pass the mandate and the risk engine afterwards — so "watch this level" can never quietly
 * become "trade this level".
 */
import { db } from "../adapters/db";
import type { MarketSnapshot, Timeframe } from "../core/types";
import { PIP } from "../core/types";

export type WatchKind =
  | "level_break"      // price closes through it
  | "level_reject"     // price reaches it and is turned away
  | "retest_fail"      // it broke, came back, and failed to hold — the one people actually ask for
  | "pressure"         // one side's pressure crosses a threshold
  | "structure"        // structure breaks on a timeframe
  | "setup_ready"      // ATLAS's own setup reaches TRADE READY
  | "price";           // plain price touch

export type Watch = {
  id: string;
  userId: string;
  accountRowId: string | null;
  positionId: string | null;
  said: string;
  kind: WatchKind;
  timeframe: Timeframe | null;
  levelPrice: number | null;
  levelLabel: string | null;
  direction: "above" | "below" | "either" | null;
  params: Record<string, number | string | boolean>;
  authority: "informational" | "action";
  notify: "voice" | "stream" | "urgent";
  expiresAt: number | null;
  status: "armed" | "fired" | "expired" | "cancelled";
  progress: number | null;
  createdAt: number;
};

/** How long an unqualified watch stays armed before it stops being a live instruction. */
export const DEFAULT_TTL_MS = 12 * 3600_000;

/* ── understanding what was asked ───────────────────────────────────────── */

export type ParsedWatch = {
  kind: WatchKind;
  timeframe: Timeframe | null;
  levelPrice: number | null;
  levelLabel: string | null;
  direction: "above" | "below" | "either";
  params: Record<string, number | string | boolean>;
  ttlMs: number;
  /** What ATLAS will say back, so the member can hear whether it understood. */
  confirm: string;
};

const TF_WORDS: [RegExp, Timeframe][] = [
  [/\b(one|1)\s*min/, "1m"], [/\b(five|5)\s*min/, "5m"], [/\b(fifteen|15)\s*min/, "15m"],
  [/\bhour|\b1h|\b60\s*min/, "1h"], [/\bfour hour|\b4h/, "4h"], [/\bdaily|\bday\b|\b1d/, "1d"],
];

const LEVEL_WORDS: [RegExp, string][] = [
  [/london high/, "london_high"], [/london low/, "london_low"],
  [/new york high|ny high/, "ny_high"], [/new york low|ny low/, "ny_low"],
  [/asia high/, "asia_high"], [/asia low/, "asia_low"],
  [/previous day high|yesterday'?s high|pdh/, "pdh"], [/previous day low|yesterday'?s low|pdl/, "pdl"],
  [/today'?s high|session high|the high\b/, "dh"], [/today'?s low|session low|the low\b/, "dl"],
  [/daily open/, "daily_open"], [/weekly open/, "weekly_open"],
];

/**
 * Turn a spoken instruction into a watch, resolving "the London high" against levels that actually
 * exist in the current snapshot.
 *
 * Returns null when there is nothing concrete to watch. That is a real answer: saying "I couldn't tell
 * which level you meant" is enormously better than arming a watch on a price nobody asked for.
 */
export function parseWatch(text: string, s: MarketSnapshot | null): ParsedWatch | null {
  const t = text.toLowerCase().trim();

  const timeframe = TF_WORDS.find(([re]) => re.test(t))?.[1] ?? null;

  // An explicit price always wins over a named level — if somebody says a number, they mean that number.
  const explicit = t.match(/\b(\d{3,5}(?:\.\d{1,2})?)\b/);
  let levelPrice: number | null = explicit ? Number(explicit[1]) : null;
  let levelLabel: string | null = explicit ? `${Number(explicit[1]).toFixed(2)}` : null;

  if (levelPrice == null && s) {
    const hit = LEVEL_WORDS.find(([re]) => re.test(t));
    if (hit) {
      const lvl = s.levels.find((l) => l.kind === hit[1]);
      if (lvl) { levelPrice = lvl.price; levelLabel = lvl.label; }
    }
  }

  const direction: ParsedWatch["direction"] =
    /\babove|over|through the top|breaks? up/.test(t) ? "above"
    : /\bbelow|under|loses|breaks? down/.test(t) ? "below"
    : "either";

  const kind: WatchKind =
    /retest fail|fails the retest|retest fails|fails to hold|loses it again/.test(t) ? "retest_fail"
    : /reject|turned away|holds|defend/.test(t) ? "level_reject"
    : /break|acceptance|closes? (above|below|through)/.test(t) ? "level_break"
    : /pressure/.test(t) ? "pressure"
    : /structure/.test(t) ? "structure"
    : /setup|qualifies|ready|tell me when you.*trade|when it.?s a trade/.test(t) ? "setup_ready"
    : levelPrice != null ? "price"
    : "setup_ready";

  if (kind !== "setup_ready" && kind !== "pressure" && levelPrice == null) return null;

  const ttlMs = /today|this session/.test(t) ? 8 * 3600_000
    : /overnight|tomorrow/.test(t) ? 24 * 3600_000
    : /this week/.test(t) ? 5 * 24 * 3600_000
    : DEFAULT_TTL_MS;

  const params: Record<string, number | string | boolean> = {};
  if (kind === "pressure") {
    const n = t.match(/\b(\d{2})\b/);
    params.threshold = n ? Number(n[1]) : 60;
    params.side = /bear|sell/.test(t) ? "bearish" : "bullish";
  }

  const where = levelLabel ? `${levelLabel}${levelPrice != null ? ` at ${levelPrice.toFixed(2)}` : ""}` : "that";
  const confirm =
    kind === "retest_fail" ? `Watching ${where} — I'll tell you if it breaks, comes back and fails to hold.`
    : kind === "level_break" ? `Watching ${where} for a ${direction === "below" ? "break below" : direction === "above" ? "break above" : "break"} with acceptance.`
    : kind === "level_reject" ? `Watching ${where} — I'll tell you if it gets defended.`
    : kind === "pressure" ? `Watching for ${params.side} pressure above ${params.threshold}.`
    : kind === "structure" ? `Watching ${timeframe ?? "5m"} structure.`
    : kind === "price" ? `Watching ${where}.`
    : "Watching for the setup to qualify — I'll tell you the moment it's a trade.";

  return { kind, timeframe, levelPrice, levelLabel, direction, params, ttlMs, confirm };
}

/* ── storage ────────────────────────────────────────────────────────────── */

const c = () => db();

const rowToWatch = (r: Record<string, unknown>): Watch => ({
  id: String(r.id),
  userId: String(r.user_id),
  accountRowId: (r.account_row_id as string) ?? null,
  positionId: (r.position_id as string) ?? null,
  said: String(r.said ?? ""),
  kind: String(r.kind) as WatchKind,
  timeframe: (r.timeframe as Timeframe) ?? null,
  levelPrice: r.level_price != null ? Number(r.level_price) : null,
  levelLabel: (r.level_label as string) ?? null,
  direction: (r.direction as Watch["direction"]) ?? null,
  params: (r.params as Watch["params"]) ?? {},
  authority: (r.authority as Watch["authority"]) ?? "informational",
  notify: (r.notify as Watch["notify"]) ?? "voice",
  expiresAt: r.expires_at ? Date.parse(String(r.expires_at)) : null,
  status: (r.status as Watch["status"]) ?? "armed",
  progress: r.progress != null ? Number(r.progress) : null,
  createdAt: r.created_at ? Date.parse(String(r.created_at)) : Date.now(),
});

/**
 * Register the instruction. Returns null when it could not be stored — and the caller MUST then say it
 * could not, rather than confirming. That is the whole contract of this module.
 */
export async function arm(input: {
  userId: string;
  said: string;
  parsed: ParsedWatch;
  accountRowId?: string | null;
  positionId?: string | null;
  authority?: "informational" | "action";
  notify?: "voice" | "stream" | "urgent";
}): Promise<Watch | null> {
  const db0 = c();
  if (!db0) return null;
  const { parsed } = input;
  const { data, error } = await db0.from("cc_watches").insert({
    user_id: input.userId,
    account_row_id: input.accountRowId ?? null,
    position_id: input.positionId ?? null,
    said: input.said.slice(0, 500),
    kind: parsed.kind,
    timeframe: parsed.timeframe,
    level_price: parsed.levelPrice,
    level_label: parsed.levelLabel,
    direction: parsed.direction,
    params: parsed.params,
    // An action-authorised watch is never created by inference. It has to be asked for explicitly, and
    // even then it only proposes — the mandate and the risk engine still decide.
    authority: input.authority === "action" ? "action" : "informational",
    notify: input.notify ?? "voice",
    expires_at: new Date(Date.now() + parsed.ttlMs).toISOString(),
  }).select("*").single();
  if (error || !data) return null;
  return rowToWatch(data as Record<string, unknown>);
}

export async function armedFor(userId: string): Promise<Watch[]> {
  const db0 = c();
  if (!db0) return [];
  const { data } = await db0.from("cc_watches").select("*")
    .eq("user_id", userId).eq("status", "armed")
    .order("created_at", { ascending: false }).limit(25);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToWatch);
}

export async function cancel(userId: string, id: string): Promise<boolean> {
  const db0 = c();
  if (!db0) return false;
  const { error } = await db0.from("cc_watches")
    .update({ status: "cancelled" }).eq("id", id).eq("user_id", userId).eq("status", "armed");
  return !error;
}

/** Cancel everything armed for a member — "stop watching everything". */
export async function cancelAll(userId: string): Promise<number> {
  const db0 = c();
  if (!db0) return 0;
  const { data } = await db0.from("cc_watches")
    .update({ status: "cancelled" }).eq("user_id", userId).eq("status", "armed").select("id");
  return (data ?? []).length;
}

/* ── evaluation ─────────────────────────────────────────────────────────── */

export type WatchFire = { watch: Watch; detail: string };

/**
 * Has this instruction come true?
 *
 * Pure, so it can be tested against recorded bars rather than hoped about. `previous` is the snapshot
 * one step back, which is what makes a BREAK distinguishable from "it was already through".
 */
export function evaluate(w: Watch, s: MarketSnapshot, previous: MarketSnapshot | null): { fired: boolean; detail: string; progress: number } {
  const price = s.price;
  const lvl = w.levelPrice;
  const tf = (w.timeframe ?? "5m") as Timeframe;
  const view = s.timeframes[tf] ?? s.timeframes["5m"];
  const atr = view?.features.atr ?? 1;
  const near = (a: number, b: number) => Math.abs(a - b) / Math.max(atr, 1e-9);

  const noFire = (progress: number) => ({ fired: false, detail: "", progress: Math.max(0, Math.min(1, progress)) });

  switch (w.kind) {
    case "price": {
      if (lvl == null) return noFire(0);
      const hit = near(price, lvl) <= 0.08;
      return hit
        ? { fired: true, detail: `Gold has reached ${lvl.toFixed(2)}${w.levelLabel ? ` — ${w.levelLabel}` : ""}.`, progress: 1 }
        : noFire(1 - Math.min(1, near(price, lvl) / 3));
    }

    case "level_break": {
      if (lvl == null || !view) return noFire(0);
      // A BREAK is a close beyond, not a wick through it. A wick that comes straight back is the
      // opposite signal — it is the market refusing the level.
      const wasThrough = previous ? (w.direction === "below" ? previous.price < lvl : previous.price > lvl) : false;
      const isThrough = w.direction === "below" ? price < lvl : w.direction === "above" ? price > lvl : Math.abs(price - lvl) > atr * 0.2;
      const accepted = isThrough && (view.features.rangeExpansion >= 1.1 || Math.abs(price - lvl) > atr * 0.5);
      if (isThrough && accepted && !wasThrough) {
        return { fired: true, detail: `${w.levelLabel ?? lvl.toFixed(2)} has broken — price is ${price.toFixed(2)} and accepting ${price > lvl ? "above" : "below"} it.`, progress: 1 };
      }
      return noFire(1 - Math.min(1, near(price, lvl) / 2));
    }

    case "level_reject": {
      if (lvl == null || !view) return noFire(0);
      const touched = near(price, lvl) <= 0.35;
      const turned = w.direction === "below"
        ? price > lvl && (previous?.price ?? price) <= lvl
        : price < lvl && (previous?.price ?? price) >= lvl;
      if (touched || turned) {
        if (turned) return { fired: true, detail: `${w.levelLabel ?? lvl.toFixed(2)} was defended — price reached it and was turned away.`, progress: 1 };
      }
      return noFire(1 - Math.min(1, near(price, lvl) / 2));
    }

    case "retest_fail": {
      /*
       * The one people actually ask for, and the one that is meaningless without structure.
       *
       * A failed retest is three things in order: it broke, it came back to the level, and it did NOT
       * hold. The engine already computes `failedBreak` from closes rather than wicks, so this reads
       * that rather than inventing a second, weaker definition of the same idea.
       */
      if (!view || lvl == null) return noFire(0);
      const st = view.structure;
      const backThrough = w.direction === "above" ? price < lvl : w.direction === "below" ? price > lvl : false;
      const failed = st.failedBreak != null || backThrough;
      const cameBack = near(price, lvl) <= 0.6;
      if (failed && (cameBack || backThrough)) {
        return {
          fired: true,
          detail: `The retest of ${w.levelLabel ?? lvl.toFixed(2)} failed — price came back and did not hold it. Gold is ${price.toFixed(2)}.`,
          progress: 1,
        };
      }
      return noFire(cameBack ? 0.7 : 1 - Math.min(1, near(price, lvl) / 3));
    }

    case "pressure": {
      const threshold = Number(w.params.threshold ?? 60);
      const side = String(w.params.side ?? "bullish");
      const value = side === "bearish" ? s.pressure.bearish : s.pressure.bullish;
      return value >= threshold
        ? { fired: true, detail: `${side === "bearish" ? "Sellers" : "Buyers"} are at ${Math.round(value)}, through the ${threshold} you asked about.`, progress: 1 }
        : noFire(value / Math.max(threshold, 1));
    }

    case "structure": {
      if (!view) return noFire(0);
      const broke = view.structure.brokeStructure;
      return broke
        ? { fired: true, detail: `${tf} structure broke ${broke}. Gold is ${price.toFixed(2)}.`, progress: 1 }
        : noFire(0.3);
    }

    case "setup_ready":
      // Fired by the setup engine rather than measured here — see `fireSetupReady`.
      return noFire(0);
  }
}

/** Mark a watch as fired, and return what to say. Idempotent: a fired watch cannot fire twice. */
export async function fire(w: Watch, detail: string): Promise<boolean> {
  const db0 = c();
  if (!db0) return false;
  const { data } = await db0.from("cc_watches")
    .update({ status: "fired", fired_at: new Date().toISOString(), fired_detail: detail.slice(0, 500), progress: 1 })
    .eq("id", w.id).eq("status", "armed").select("id");
  return (data ?? []).length > 0;
}

/**
 * Walk every armed watch against the current market. Returns the ones that came true.
 *
 * Runs in the worker. Expiry is handled here too, because a watch that quietly stays armed forever is a
 * promise the member no longer knows they are relying on.
 */
export async function sweep(s: MarketSnapshot, previous: MarketSnapshot | null, limit = 200): Promise<WatchFire[]> {
  const db0 = c();
  if (!db0) return [];
  const nowIso = new Date().toISOString();

  await db0.from("cc_watches").update({ status: "expired" })
    .eq("status", "armed").lt("expires_at", nowIso);

  const { data } = await db0.from("cc_watches").select("*").eq("status", "armed").limit(limit);
  const watches = ((data ?? []) as Record<string, unknown>[]).map(rowToWatch);

  const fired: WatchFire[] = [];
  for (const w of watches) {
    if (w.kind === "setup_ready") continue;          // fired by the setup engine, not by price
    const r = evaluate(w, s, previous);
    await db0.from("cc_watches").update({
      progress: r.progress, last_checked_at: nowIso, checks: (w as Watch & { checks?: number }).checks ?? 0,
    }).eq("id", w.id);
    if (r.fired && await fire(w, r.detail)) fired.push({ watch: w, detail: r.detail });
  }
  return fired;
}

/** A setup reaching TRADE READY is what a "tell me when it qualifies" watch is waiting for. */
export async function fireSetupReady(userId: string, say: string): Promise<WatchFire[]> {
  const db0 = c();
  if (!db0) return [];
  const { data } = await db0.from("cc_watches").select("*")
    .eq("user_id", userId).eq("status", "armed").eq("kind", "setup_ready");
  const out: WatchFire[] = [];
  for (const w of ((data ?? []) as Record<string, unknown>[]).map(rowToWatch)) {
    const detail = `You asked me to tell you when this qualified. ${say}`;
    if (await fire(w, detail)) out.push({ watch: w, detail });
  }
  return out;
}
