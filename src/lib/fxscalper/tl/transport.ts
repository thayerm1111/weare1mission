/**
 * THE FX SCALPER'S ONE REQUEST SCHEDULER for TradeLocker.
 *
 * Every broker call the bot makes goes through one instance of this, so its whole spend is visible in
 * one place and ordered by what matters:
 *
 *   PROTECT (0)    closing a position, setting or checking its stop/target, cancelling
 *   ENTRY (1)      the quote an entry is priced from, the order itself, finding its fill
 *   SIGNAL (2)     the candle a signal is decided on
 *   SYNC (3)       positions/orders/history reconciliation, account state
 *   BACKGROUND (4) dashboard quotes, contract details, config
 *
 * LIMITS ARE THE BROKER'S OWN. TradeLocker publishes per-route limits in /trade/config (`rateLimits`:
 * {rateLimitType, measure, intervalNum, limit}); each route type gets its own sliding window — the
 * published count over a window stretched by 15% + 50 ms, so the bot always stays under the published
 * rate. Until the config has been read, every route runs at a conservative 1 per second.
 * Routes the config does not list (closing a position, cancelling an order, sign-in) get a fixed
 * conservative window. One slot of the concurrency cap is always kept for PROTECT/ENTRY work, so
 * background reads can never hold up an exit.
 *
 * A 429 pauses that route for the broker's Retry-After (or a backoff); a Cloudflare 1015 — an edge block
 * on this IP — pauses everything. Reads are retried; writes are NEVER retried here: a write that timed
 * out may have happened, and the caller reconciles (tl/api.ts returns `uncertain`).
 *
 * What it does not pretend: there is no streaming here (TradeLocker documents no public price stream),
 * no millisecond guarantee, and no idempotency (the order API has none).
 */

export type RouteType =
  | "AUTH" | "CONFIG" | "GET_ACCOUNTS" | "GET_INSTRUMENTS" | "GET_INSTRUMENT_DETAILS"
  | "QUOTES" | "QUOTES_HISTORY" | "GET_ACCOUNTS_STATE" | "GET_POSITIONS" | "GET_ORDERS"
  | "GET_ORDERS_HISTORY" | "GET_EXECUTIONS" | "PLACE_ORDER" | "MODIFY_ORDER" | "MODIFY_POSITION"
  | "CANCEL_ORDER" | "CLOSE_POSITION";

export const P = { PROTECT: 0, ENTRY: 1, SIGNAL: 2, SYNC: 3, BACKGROUND: 4 } as const;
export type Priority = (typeof P)[keyof typeof P];

type Window = { limit: number; ms: number };

/** Not published by the broker; fixed and conservative. */
const UNLISTED: Partial<Record<RouteType, Window[]>> = {
  AUTH: [{ limit: 1, ms: 2000 }],
  CONFIG: [{ limit: 1, ms: 2000 }],
  CLOSE_POSITION: [{ limit: 2, ms: 1000 }],
  CANCEL_ORDER: [{ limit: 2, ms: 1000 }],
};
const BEFORE_CONFIG: Window[] = [{ limit: 1, ms: 1000 }];
/** Published windows are stretched by 15% + 50 ms: the same count, a little more time, never more requests. */
const stretch = (ms: number) => Math.ceil(ms * 1.15) + 50;

type Item = {
  type: RouteType;
  priority: Priority;
  seq: number;
  deadline: number | null;
  start: () => void;
  fail: (e: Error) => void;
};

type Bucket = { windows: Window[]; starts: number[]; pausedUntil: number; published: string | null };

export class DeadlineError extends Error {
  constructor(type: RouteType) { super(`${type}: could not start before its deadline`); this.name = "DeadlineError"; }
}

export type RouteStats = { count: number; errors: number; limited: number; lastError: string | null; lastAt: number | null; p50: number | null; p95: number | null; window: string };

export class Scheduler {
  private queue: Item[] = [];
  private buckets = new Map<RouteType, Bucket>();
  private inFlight = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private allPausedUntil = 0;
  private lat = new Map<RouteType, number[]>();
  private counts = new Map<RouteType, { count: number; errors: number; limited: number; lastError: string | null; lastAt: number | null }>();
  configApplied = false;

  constructor(private readonly opts: { maxInFlight?: number; now?: () => number } = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private get max(): number { return this.opts.maxInFlight ?? 4; }

  private bucket(t: RouteType): Bucket {
    let b = this.buckets.get(t);
    if (!b) {
      b = { windows: UNLISTED[t] ?? BEFORE_CONFIG, starts: [], pausedUntil: 0, published: null };
      this.buckets.set(t, b);
    }
    return b;
  }

  /**
   * Apply /trade/config's `rateLimits`. Returns what was applied, by route type. A limit that cannot be
   * read is left at the conservative default rather than widened.
   */
  applyConfig(config: unknown): Record<string, string> {
    const root = ((config as { d?: unknown })?.d ?? config) as Record<string, unknown> | null;
    const raw = root?.rateLimits;
    const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
    const applied: Record<string, string> = {};
    const byType = new Map<string, Window[]>();
    for (const r of list) {
      const row = r as { rateLimitType?: unknown; measure?: unknown; intervalNum?: unknown; limit?: unknown };
      const type = String(row.rateLimitType ?? "").toUpperCase();
      const unit = String(row.measure ?? "").toUpperCase();
      const n = Number(row.intervalNum);
      const limit = Number(row.limit);
      const ms = unit.startsWith("SEC") ? n * 1000 : unit.startsWith("MIN") ? n * 60_000 : unit.startsWith("HOUR") ? n * 3_600_000 : 0;
      if (!type || !(ms > 0) || !(limit > 0)) continue;
      const w = { limit: Math.max(1, Math.floor(limit)), ms: stretch(ms) };
      byType.set(type, [...(byType.get(type) ?? []), w]);
      applied[type] = `${limit} per ${n}${unit.startsWith("SEC") ? "s" : unit.startsWith("MIN") ? "min" : "h"} (using ${w.limit} per ${(w.ms / 1000).toFixed(2)}s)`;
    }
    for (const [type, windows] of byType) {
      const b = this.bucket(type as RouteType);
      b.windows = windows;
      b.published = applied[type];
    }
    this.configApplied = byType.size > 0;
    this.kick();
    return applied;
  }

  /** Stop a route (or, for an edge block, everything) for `ms`. */
  pause(type: RouteType | "ALL", ms: number): void {
    const until = this.now() + Math.max(0, ms);
    if (type === "ALL") this.allPausedUntil = Math.max(this.allPausedUntil, until);
    else { const b = this.bucket(type); b.pausedUntil = Math.max(b.pausedUntil, until); }
    this.kick();
  }

  /** Earliest time a request of this type could start (0 = now). */
  private readyAt(t: RouteType, now: number): number {
    const b = this.bucket(t);
    let at = Math.max(now, b.pausedUntil, this.allPausedUntil);
    for (const w of b.windows) {
      const inWin = b.starts.filter((s) => s > at - w.ms);
      if (inWin.length >= w.limit) {
        // Free when the oldest start that keeps the window full ages out.
        const sorted = inWin.sort((a, c) => a - c);
        at = Math.max(at, sorted[inWin.length - w.limit] + w.ms + 1);
      }
    }
    return at;
  }

  /**
   * Run `fn` when its route has room. Rejects with DeadlineError if it could not START by `deadlineAt`
   * (an entry that cannot leave inside its signal window must not leave at all).
   */
  run<T>(type: RouteType, priority: Priority, fn: () => Promise<T>, deadlineAt: number | null = null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        type, priority, seq: this.seq++, deadline: deadlineAt,
        start: () => {
          this.inFlight++;
          const b = this.bucket(type);
          b.starts.push(this.now());
          if (b.starts.length > 200) b.starts.splice(0, b.starts.length - 200);
          fn().then(resolve, reject).finally(() => { this.inFlight--; this.kick(); });
        },
        fail: reject,
      };
      this.queue.push(item);
      this.kick();
    });
  }

  private kick(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pump();
  }

  private pump(): void {
    const now = this.now();
    // Expired items fail first.
    this.queue = this.queue.filter((it) => {
      if (it.deadline != null && now > it.deadline) { it.fail(new DeadlineError(it.type)); return false; }
      return true;
    });
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    let nextAt = Infinity;
    for (let i = 0; i < this.queue.length; ) {
      const it = this.queue[i];
      // One slot is kept free for protective and entry work — unless there is only one slot at all.
      const cap = it.priority <= P.ENTRY ? this.max : Math.max(1, this.max - 1);
      if (this.inFlight >= cap) { i++; continue; }
      const at = this.readyAt(it.type, now);
      if (at <= now) {
        this.queue.splice(i, 1);
        it.start();
        continue;
      }
      nextAt = Math.min(nextAt, at, it.deadline ?? Infinity);
      i++;
    }
    if (this.queue.length && nextAt < Infinity) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, nextAt - this.now()));
    }
  }

  /** Record how a request went, for the dashboard's latency and error figures. */
  note(type: RouteType, latencyMs: number, outcome: "ok" | "error" | "limited", error?: string): void {
    const l = this.lat.get(type) ?? [];
    l.push(latencyMs);
    if (l.length > 100) l.shift();
    this.lat.set(type, l);
    const c = this.counts.get(type) ?? { count: 0, errors: 0, limited: 0, lastError: null, lastAt: null };
    c.count++;
    c.lastAt = this.now();
    if (outcome === "error") { c.errors++; c.lastError = error ?? "error"; }
    if (outcome === "limited") { c.limited++; c.lastError = error ?? "rate limited"; }
    this.counts.set(type, c);
  }

  stats(): Record<string, RouteStats> {
    const out: Record<string, RouteStats> = {};
    for (const [t, c] of this.counts) {
      const l = [...(this.lat.get(t) ?? [])].sort((a, b) => a - b);
      const pct = (q: number) => (l.length ? l[Math.min(l.length - 1, Math.floor(q * l.length))] : null);
      const b = this.bucket(t);
      out[t] = { ...c, p50: pct(0.5), p95: pct(0.95), window: b.published ?? b.windows.map((w) => `${w.limit}/${w.ms / 1000}s (default)`).join(", ") };
    }
    return out;
  }

  queued(): number { return this.queue.length; }
}

// ---- One HTTP request -----------------------------------------------------------------------------

export type TLEnv = "live" | "demo";
export const TL_HOSTS: Record<TLEnv, string> = {
  live: "https://live.tradelocker.com/backend-api",
  demo: "https://demo.tradelocker.com/backend-api",
};

export type RawResponse = {
  status: number;
  json: unknown;
  text: string;
  latencyMs: number;
  /** The broker or its edge said too many requests. */
  limited: boolean;
  /** No HTTP response at all (network error, timeout). */
  networkError: string | null;
  /** The request never left: it could not start before its deadline. Nothing reached the broker. */
  notSent?: boolean;
};

export type RequestSpec = {
  env: TLEnv;
  type: RouteType;
  priority: Priority;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  accessToken?: string | null;
  accNum?: string | null;
  body?: unknown;
  timeoutMs?: number;
  /** The request must START by then (entries). */
  deadlineAt?: number | null;
};

const DEV_KEY = () => (process.env.TL_DEVELOPER_API_KEY || "").trim();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Is this response a rate limit, and how long does the broker want us to wait? */
export function limitedBy(status: number, text: string, retryAfter: string | null): { limited: boolean; edge: boolean; waitMs: number } {
  const edge = /error code:?\s*1015|you are being rate limited/i.test(text);
  const limited = status === 429 || edge;
  const ra = Number(retryAfter);
  return { limited, edge, waitMs: Number.isFinite(ra) && ra >= 0 ? ra * 1000 : edge ? 10_000 : 2_000 };
}

/**
 * Send one request through the scheduler. GETs are retried (network error, 5xx, rate limit) up to 3
 * attempts while the deadline allows; anything else is sent exactly once.
 */
export async function tlRequest(sched: Scheduler, spec: RequestSpec, fetchImpl: typeof fetch = fetch): Promise<RawResponse> {
  const host = TL_HOSTS[spec.env];
  const attempts = spec.method === "GET" ? 3 : 1;
  let last: RawResponse = { status: 0, json: null, text: "", latencyMs: 0, limited: false, networkError: "not sent" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
    last = await sched.run(spec.type, spec.priority, async () => {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), spec.timeoutMs ?? (spec.method === "GET" ? 6000 : 8000));
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (spec.body !== undefined) headers["content-type"] = "application/json";
        if (spec.accessToken) headers.Authorization = `Bearer ${spec.accessToken}`;
        if (spec.accNum) headers.accNum = String(spec.accNum);
        const key = DEV_KEY();
        if (key) headers["developer-api-key"] = key;
        const res = await fetchImpl(`${host}${spec.path}`, {
          method: spec.method, headers, body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          cache: "no-store", signal: ctrl.signal,
        } as RequestInit);
        const text = await res.text();
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        const lim = limitedBy(res.status, text, res.headers.get("retry-after"));
        const latencyMs = Date.now() - started;
        if (lim.limited) {
          sched.pause(lim.edge ? "ALL" : spec.type, lim.waitMs);
          sched.note(spec.type, latencyMs, "limited", lim.edge ? "edge rate limit (1015)" : "429 too many requests");
        } else {
          sched.note(spec.type, latencyMs, res.status >= 500 ? "error" : "ok", res.status >= 500 ? `HTTP ${res.status}` : undefined);
        }
        return { status: res.status, json, text, latencyMs, limited: lim.limited, networkError: null };
      } catch (e) {
        const latencyMs = Date.now() - started;
        const msg = (e as Error)?.name === "AbortError" ? "timed out" : String((e as Error)?.message ?? e);
        sched.note(spec.type, latencyMs, "error", msg);
        return { status: 0, json: null, text: "", latencyMs, limited: false, networkError: msg };
      } finally {
        clearTimeout(timer);
      }
    }, spec.deadlineAt ?? null);
    } catch (e) {
      if (e instanceof DeadlineError) {
        // Never started. If an earlier attempt got an answer, that answer stands.
        if (attempt === 1) last = { status: 0, json: null, text: "", latencyMs: 0, limited: false, networkError: e.message, notSent: true };
        break;
      }
      throw e;
    }
    const retryable = last.networkError != null || last.limited || last.status >= 500;
    if (!retryable || attempt === attempts) break;
    if (spec.deadlineAt != null && Date.now() + 250 * attempt > spec.deadlineAt) break;
    await sleep(250 * attempt);
  }
  return last;
}

/** TradeLocker answers some refusals with HTTP 200 and `{s:"error", errmsg}`. A 200 is not a success. */
export function brokerError(json: unknown): string | null {
  const b = json as { s?: unknown; errmsg?: unknown; message?: unknown } | null;
  if (!b || typeof b !== "object") return null;
  const s = String(b.s ?? "").toLowerCase();
  if (s === "error" || s === "fail" || s === "rejected") return String(b.errmsg ?? b.message ?? "the broker refused the request");
  return null;
}

/** The broker's own words for a failed response, never anything that was sent. */
export function describe(r: RawResponse, fallback: string): string {
  if (r.networkError) return `${fallback}: ${r.networkError}`;
  if (r.limited) return `${fallback}: rate limited by the broker`;
  const env = brokerError(r.json);
  if (env) return env;
  const b = r.json as Record<string, unknown> | null;
  if (b && typeof b === "object") {
    for (const k of ["errmsg", "message", "error", "detail"]) {
      const v = b[k];
      if (typeof v === "string" && v.trim()) return `${fallback}: ${v.trim().slice(0, 200)}`;
    }
  }
  if (r.status === 403) return `${fallback}: the broker refused (403) — API access may be switched off for this login`;
  if (r.status === 401) return `${fallback}: the broker session expired (401)`;
  const text = r.text.replace(/\s+/g, " ").trim();
  return text && !text.startsWith("<") ? `${fallback} (HTTP ${r.status}): ${text.slice(0, 160)}` : `${fallback} (HTTP ${r.status})`;
}
