/**
 * TradeLocker transport for Rapid.
 *
 * Three things this does that matter, and one honest limitation.
 *
 *  1. It derives its request budget from the broker's OWN published `/trade/config` rateLimits
 *     rather than from a guessed constant, and it honours `Retry-After`.
 *  2. Protective work outranks everything. Amending a stop or closing a position is never queued
 *     behind a quote poll, because the consequence of a late quote is a missed trade and the
 *     consequence of a late stop amendment is a loss.
 *  3. A non-idempotent write is never blind-retried. A 5xx or a timeout on an order returns
 *     `uncertain`, and the caller reconciles rather than sending it again.
 *
 * The limitation: this is a FOURTH TradeLocker client in this repository (FLOW, Command Center and
 * AURIC have their own). Each keeps its own budget, so the true spend against one broker edge limit
 * is the sum of four budgets that cannot see each other. Rapid's isolation contract is what forces
 * that; the right long-term fix is one shared transport, and it is recorded as such.
 */

export type TLEnv = "demo" | "live";

export const TL_HOSTS: Record<TLEnv, string> = {
  demo: "https://demo.tradelocker.com/backend-api",
  live: "https://live.tradelocker.com/backend-api",
};

export type TLResult<T> =
  | { ok: true; data: T; status: number; latencyMs: number }
  | { ok: false; status: number; error: string; latencyMs: number; raw?: unknown; uncertain?: boolean };

export type Priority = "critical" | "auth" | "normal" | "background";
const PRIORITY_ORDER: Priority[] = ["critical", "auth", "normal", "background"];

const DEV_KEY = (process.env.TL_DEVELOPER_API_KEY || "").trim();
const TIMEOUT_MS = Number(process.env.RAPID_TL_TIMEOUT_MS || 15_000);

/** A non-GET on /trade/* is protective or order work: it goes first, always. */
export function priorityFor(method: string, path: string, ctx?: Priority): Priority {
  if (method !== "GET" && path.startsWith("/trade/")) return "critical";
  if (path.startsWith("/auth/jwt/")) return "auth";
  return ctx ?? "normal";
}

// ---- Budget ---------------------------------------------------------------------------------------

type Bucket = { minSpacingMs: number; lastAt: number; pausedUntil: number };
const buckets = new Map<string, Bucket>();

const DEFAULT_SPACING_MS = Number(process.env.RAPID_TL_MIN_SPACING_MS || 120);

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) { b = { minSpacingMs: DEFAULT_SPACING_MS, lastAt: 0, pausedUntil: 0 }; buckets.set(key, b); }
  return b;
}

/**
 * Apply the broker's published limits. `/trade/config` returns entries shaped
 * `{ rateLimitType, measure, intervalNum, limit }`; the tightest requests-per-interval becomes the
 * minimum spacing. A limit we cannot parse is left alone rather than optimistically widened.
 */
export function applyPublishedRateLimits(budgetKey: string, config: unknown): { applied: boolean; spacingMs: number } {
  const b = bucket(budgetKey);
  const limits = extractLimits(config);
  if (!limits.length) return { applied: false, spacingMs: b.minSpacingMs };
  let spacing = b.minSpacingMs;
  for (const l of limits) {
    if (!(l.limit > 0) || !(l.intervalMs > 0)) continue;
    spacing = Math.max(spacing, Math.ceil(l.intervalMs / l.limit));
  }
  b.minSpacingMs = spacing;
  return { applied: true, spacingMs: spacing };
}

function extractLimits(config: unknown): Array<{ limit: number; intervalMs: number }> {
  const out: Array<{ limit: number; intervalMs: number }> = [];
  const root = (config as { d?: unknown })?.d ?? config;
  const arr = (root as { rateLimits?: unknown })?.rateLimits;
  if (!Array.isArray(arr)) return out;
  for (const r of arr) {
    const row = r as { measure?: string; intervalNum?: number; limit?: number };
    const n = Number(row.intervalNum ?? 0);
    const unit = String(row.measure ?? "").toUpperCase();
    const ms = unit.startsWith("SEC") ? n * 1000 : unit.startsWith("MIN") ? n * 60_000 : unit.startsWith("HOUR") ? n * 3_600_000 : 0;
    if (ms > 0) out.push({ limit: Number(row.limit ?? 0), intervalMs: ms });
  }
  return out;
}

type Waiter = { priority: Priority; resolve: () => void };
const queues = new Map<string, Waiter[]>();
const pumping = new Set<string>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function takeSlot(budgetKey: string, priority: Priority): Promise<void> {
  const q = queues.get(budgetKey) ?? [];
  queues.set(budgetKey, q);
  await new Promise<void>((resolve) => {
    q.push({ priority, resolve });
    void pump(budgetKey);
  });
}

async function pump(budgetKey: string): Promise<void> {
  if (pumping.has(budgetKey)) return;
  pumping.add(budgetKey);
  try {
    const q = queues.get(budgetKey)!;
    while (q.length) {
      const b = bucket(budgetKey);
      const now = Date.now();
      const readyAt = Math.max(b.pausedUntil, b.lastAt + b.minSpacingMs);
      if (now < readyAt) { await sleep(readyAt - now); continue; }
      // Strict priority: a stop amendment is never behind a quote poll.
      q.sort((a, c) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(c.priority));
      const next = q.shift();
      if (!next) break;
      b.lastAt = Date.now();
      next.resolve();
    }
  } finally {
    pumping.delete(budgetKey);
  }
}

/** Pause a budget after the broker says to. `Retry-After` wins over any local guess. */
export function noteRateLimited(budgetKey: string, retryAfterSec: number | null): number {
  const b = bucket(budgetKey);
  const waitMs = retryAfterSec != null && retryAfterSec >= 0 ? retryAfterSec * 1000 : Math.min(5000, b.minSpacingMs * 8);
  b.pausedUntil = Date.now() + waitMs;
  b.minSpacingMs = Math.min(2000, Math.ceil(b.minSpacingMs * 1.5));
  return waitMs;
}

export const budgetStats = () =>
  Object.fromEntries([...buckets.entries()].map(([k, b]) => [k, { spacingMs: b.minSpacingMs, pausedForMs: Math.max(0, b.pausedUntil - Date.now()), queued: queues.get(k)?.length ?? 0 }]));

// ---- Request --------------------------------------------------------------------------------------

export type FetchInit = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  accessToken?: string;
  accNum?: string;
  body?: string;
  priority?: Priority;
  /** Retries are only ever applied to idempotent reads. */
  idempotent?: boolean;
};

export type RawResponse = { status: number; json: unknown; text: string; latencyMs: number };

export async function tlFetch(env: TLEnv, path: string, init: FetchInit = {}): Promise<RawResponse> {
  const host = TL_HOSTS[env];
  const method = init.method ?? "GET";
  const budgetKey = `rapid:${host}`;
  const priority = priorityFor(method, path, init.priority);
  const isGet = method === "GET";
  const maxAttempts = init.idempotent ?? isGet ? 4 : 1;

  let last: RawResponse = { status: 0, json: null, text: "", latencyMs: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await takeSlot(budgetKey, priority);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`;
      if (init.accNum) headers.accNum = String(init.accNum);
      if (DEV_KEY) headers["tl-developer-api-key"] = DEV_KEY;

      const res = await fetch(`${host}${path}`, { method, headers, body: init.body, cache: "no-store", signal: controller.signal });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      last = { status: res.status, json, text, latencyMs: Date.now() - started };

      const limited = res.status === 429 || (res.status === 503 && isGet) || /1015|being rate limited/i.test(text);
      if (limited) {
        const ra = Number(res.headers.get("retry-after"));
        noteRateLimited(budgetKey, Number.isFinite(ra) ? ra : null);
        // A Cloudflare 1015 is an edge block: the request never reached the broker, so even a
        // non-idempotent call can be retried. Anything else non-idempotent is left to the caller.
        const edgeBlocked = /1015|being rate limited/i.test(text);
        if (attempt < maxAttempts || edgeBlocked) { if (attempt < 6) continue; }
      }
      return last;
    } catch (e) {
      last = { status: 0, json: null, text: String((e as Error)?.message ?? e), latencyMs: Date.now() - started };
      if (attempt < maxAttempts) { await sleep(150 * attempt); continue; }
      return last;
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** TradeLocker answers HTTP 200 with `{s:"error"}` bodies. A 200 is not a success. */
export function brokerError(body: unknown): string | null {
  const b = body as { s?: string; errmsg?: string; message?: string } | null;
  if (!b || typeof b !== "object") return null;
  const s = String(b.s ?? "").toLowerCase();
  if (s === "error" || s === "fail" || s === "rejected") return String(b.errmsg ?? b.message ?? "broker rejected the request");
  return null;
}

/** Rows arrive as objects OR as positional arrays described by `/trade/config`. */
export function readCollection(body: unknown, ...fields: string[]): { ok: true; data: unknown[] } | { ok: false; error: string } {
  if (Array.isArray(body)) return { ok: true, data: body };
  const root = (body as { d?: unknown })?.d ?? body;
  for (const f of fields) {
    const v = (root as Record<string, unknown> | null)?.[f] ?? (body as Record<string, unknown> | null)?.[f];
    if (Array.isArray(v)) return { ok: true, data: v };
  }
  return { ok: false, error: `unreadable broker ${fields[0]} response` };
}

/** Column map for a positional-array section of `/trade/config`. */
export function columnMap(config: unknown, section: string): Record<string, number> {
  const root = (config as { d?: unknown })?.d ?? config;
  const sec = (root as Record<string, unknown> | null)?.[section] as { columns?: Array<{ id?: string }> } | undefined;
  const cols = sec?.columns;
  const out: Record<string, number> = {};
  if (Array.isArray(cols)) cols.forEach((c, i) => { if (c?.id) out[String(c.id)] = i; });
  return out;
}

/** Read a field from a row that may be an object or a positional array. */
export function field(row: unknown, cols: Record<string, number>, keys: string[]): unknown {
  if (Array.isArray(row)) {
    for (const k of keys) { const i = cols[k]; if (i != null && i < row.length) return row[i]; }
    return undefined;
  }
  const r = row as Record<string, unknown> | null;
  if (!r) return undefined;
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
}
