/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/*
 * A harness for calling the REAL route handlers in tests: a small in-memory Supabase (auth, tables,
 * the two credit functions) and a synthetic market feed stand behind `fetch`, the clock is fixed, and
 * a handler is called inside the request scope Next gives it. Nothing leaves the process: every
 * address this file does not model throws.
 *
 * IMPORT THIS FIRST in a test file. It sets the environment the Supabase clients read when they are
 * first loaded, and it does not load any of the site's own modules until a handler is called.
 */
import { mock } from "node:test";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.TWELVEDATA_API_KEY = "td-key";
delete process.env.ANTHROPIC_API_KEY;                 // no story is ever asked for: reads use the engine's own summary
// Next sets this in its own bootstrap; its request storage will not load without it.
(globalThis as any).AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;

const ROOT = path.resolve(__dirname, "..");

/* ── the clock: fixed, and moved only when a test moves it ────────────────────────────────────── */
/** Tuesday 6 October 2026, 13:30 UTC — London and New York both open. */
export const T0 = Date.UTC(2026, 9, 6, 13, 30, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
export const setNow = (ms: number): void => { mock.timers.setTime(ms); };
export const iso = (ms: number): string => new Date(ms).toISOString();
export const ago = (ms: number): string => iso(Date.now() - ms);

/* ── the database ─────────────────────────────────────────────────────────────────────────────── */
export type Row = Record<string, any>;
export const db: Record<string, Row[]> = {};
export const T = (name: string): Row[] => (db[name] ??= []);
const tokens = new Map<string, { id: string; email: string }>();
export const balances = new Map<string, number>();
const TARIFF: Record<string, number> = { genx: 5, ghost: 5, flow_autorun: 1, command_center: 5, chat: 1, signal: 3, scan: 5 };
/** Failures a test can switch on. `spendLosesAnswer`: the spend goes through and its answer does not come back. */
export const fail = { tables: new Set<string>(), rpc: new Set<string>(), spendLosesAnswer: false };
let idSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

/** A signed-in member with a balance. Returns the token their requests carry. `id` signs them in as one particular account (the owner's). */
export function member(name: string, o: { credits?: number; role?: string; id?: string } = {}): string {
  const id = o.id ?? `11111111-1111-4111-8111-${String(tokens.size + 1).padStart(12, "0")}`, token = `tok-${name}`;
  tokens.set(token, { id, email: `${name}@example.test` });
  balances.set(id, o.credits ?? 0);
  T("profiles").push({ id, email: `${name}@example.test`, full_name: name, role: o.role ?? "member", tier: "elite", status: "active", username: null, phone: null, referred_by: null, access_expires_at: null });
  return token;
}
export const idOf = (token: string): string => tokens.get(token)!.id;
/** The ledger lines this member's spends have written, oldest first: "genx -5", "ghost -5". */
export const spends = (token: string): string[] => T("credit_transactions").filter((r) => r.user_id === idOf(token) && r.kind === "spend").map((r) => `${r.feature} ${r.amount}`);

const cmp = (a: any, b: any): number => {
  const da = typeof a === "string" ? Date.parse(a) : NaN, dbb = typeof b === "string" ? Date.parse(b) : NaN;
  if (Number.isFinite(da) && Number.isFinite(dbb) && /\d{4}-\d{2}-\d{2}/.test(String(a)) && /\d{4}-\d{2}-\d{2}/.test(String(b))) return da - dbb;
  const na = Number(a), nb = Number(b);
  if (a !== null && b !== null && a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
const lit = (v: string): any => (v === "null" ? null : v === "true" ? true : v === "false" ? false : v.replace(/^"(.*)"$/, "$1"));
const eqv = (cell: any, v: string): boolean => { const x = lit(v); if (x === null) return cell == null; if (typeof x === "boolean") return cell === x; return String(cell) === String(x); };
function matches(row: Row, col: string, expr: string): boolean {
  let neg = false;
  if (expr.startsWith("not.")) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf("."), op = expr.slice(0, dot), v = expr.slice(dot + 1), cell = row[col];
  let ok: boolean;
  switch (op) {
    case "eq": case "is": ok = eqv(cell, v); break;
    case "neq": ok = !eqv(cell, v); break;
    case "gt": ok = cell != null && cmp(cell, lit(v)) > 0; break;
    case "gte": ok = cell != null && cmp(cell, lit(v)) >= 0; break;
    case "lt": ok = cell != null && cmp(cell, lit(v)) < 0; break;
    case "lte": ok = cell != null && cmp(cell, lit(v)) <= 0; break;
    case "in": ok = v.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()).some((s) => eqv(cell, s)); break;
    case "like": case "ilike": { const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*") + "$", op === "ilike" ? "i" : ""); ok = cell != null && re.test(String(cell)); break; }
    default: throw new Error(`harness: filter ${op} is not modelled (${col}=${expr})`);
  }
  return neg ? !ok : ok;
}
function splitTop(s: string): string[] { const out: string[] = []; let depth = 0, cur = ""; for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; } if (cur) out.push(cur); return out; }

function rest(table: string, url: URL, method: string, headers: Headers, body: any): Response {
  const json = (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(o === undefined ? null : JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });
  if (fail.tables.has(table)) return json({ message: `harness: ${table} is unreadable`, code: "XX000" }, 500);
  const rows = T(table);
  const filters: [string, string][] = [], ors: string[] = [];
  let order: string | null = null, limit: number | null = null, offset = 0, select = "*";
  for (const [k, v] of url.searchParams) {
    if (k === "select") select = v; else if (k === "order") order = v; else if (k === "limit") limit = +v; else if (k === "offset") offset = +v;
    else if (k === "or") ors.push(v); else if (k === "on_conflict" || k === "columns") { /* not needed here */ } else filters.push([k, v]);
  }
  const hit = (r: Row) => filters.every(([c, e]) => matches(r, c, e)) && ors.every((o) => splitTop(o.replace(/^\(|\)$/g, "")).some((part) => { const i = part.indexOf("."); return matches(r, part.slice(0, i), part.slice(i + 1)); }));
  const pick = (r: Row) => { if (select === "*" || !select) return { ...r }; const o: Row = {}; for (const c of select.split(",").map((s) => s.trim())) o[c] = r[c] ?? null; return o; };
  const prefer = headers.get("prefer") ?? "", accept = headers.get("accept") ?? "";
  if (method === "GET" || method === "HEAD") {
    let out = rows.filter(hit);
    const total = out.length;
    if (order) for (const part of order.split(",").reverse()) { const [c, dir] = part.split("."); out = [...out].sort((a, b) => (a[c] == null && b[c] == null ? 0 : a[c] == null ? 1 : b[c] == null ? -1 : cmp(a[c], b[c])) * (dir === "desc" ? -1 : 1)); }
    out = out.slice(offset, limit != null ? offset + limit : undefined);
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `0-${Math.max(0, total - 1)}/${total}` } });
    if (accept.includes("vnd.pgrst.object")) return out.length === 1 ? json(pick(out[0])) : json({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: `${out.length} rows` }, 406);
    return json(out.map(pick), 200, { "content-range": `0-${Math.max(0, out.length - 1)}/${total}` });
  }
  if (method === "POST") {
    const made = (Array.isArray(body) ? body : [body]).map((r: Row) => ({ id: uuid(), created_at: iso(Date.now()), at: iso(Date.now()), ...r }));
    rows.push(...made);
    if (!prefer.includes("return=representation")) return json(undefined, 201);
    return accept.includes("vnd.pgrst.object") ? json(pick(made[0]), 201) : json(made.map(pick), 201);
  }
  if (method === "PATCH") { const got = rows.filter(hit); for (const r of got) Object.assign(r, body); return prefer.includes("return=representation") ? json(got.map(pick)) : json(undefined, 204); }
  if (method === "DELETE") { const keep = rows.filter((r) => !hit(r)); rows.length = 0; rows.push(...keep); return prefer.includes("return=representation") ? json([]) : json(undefined, 204); }
  throw new Error(`harness: ${method} ${table} is not modelled`);
}

/** The two credit functions, as the database has them: the price comes from the tariff, and the spend writes its own ledger line. */
function rpc(name: string, args: any, caller: string | null): Response {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (fail.rpc.has(name)) return json({ message: `harness: ${name} failed`, code: "XX000" }, 500);
  if (name === "md_get_or_reserve") return json({ hit: false, ok: true });
  if (name === "md_put") return json(null);
  if (name === "get_credit_balance") { if (!caller) return json({ ok: false, error: "unauthorized" }); return json({ ok: true, daily_left: 0, purchased: balances.get(caller) ?? 0, daily_allowance: 5 }); }
  if (name === "spend_credits") {
    if (!caller) return json({ ok: false, error: "unauthorized" });
    const price = TARIFF[String(args.p_feature)];
    if (price == null) return json({ ok: false, error: "unknown_feature" });
    const bal = balances.get(caller) ?? 0;
    if (bal < price) return json({ ok: false, error: "insufficient", daily_left: 0, purchased: bal, daily_allowance: 5 });
    balances.set(caller, bal - price);
    T("credit_transactions").push({ id: uuid(), user_id: caller, kind: "spend", feature: String(args.p_feature), amount: -price, created_at: iso(Date.now()) });
    if (fail.spendLosesAnswer) return json({ message: "harness: the spend went through and its answer was lost", code: "57014" }, 504);
    return json({ ok: true, daily_left: 0, purchased: bal - price, daily_allowance: 5 });
  }
  return json(null);
}

/* ── the market: a seeded walk, laid out against the fixed clock ──────────────────────────────── */
type Bar = { t: number; o: number; h: number; l: number; c: number };
const STEP = 300_000, MARKET_END = Math.floor(T0 / STEP) * STEP;
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function walk(seed: number, n: number, base: number, scale: number): Bar[] {
  const r = rng(seed), out: Bar[] = [];
  let p = base + r() * 100 * scale, drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 300 === 0) drift = (r() - 0.5) * 0.9 * scale;
    const o = p, c = o + drift + (r() - 0.5) * 6 * scale, h = Math.max(o, c) + r() * 2.2 * scale, l = Math.min(o, c) - r() * 2.2 * scale;
    out.push({ t: MARKET_END - (n - 1 - i) * STEP, o, h, l, c }); p = c;
  }
  return out;
}
/** `thin: true` makes a market answer with too few candles for the engine: a read with no plan in it. */
export const FEED: Record<string, { bars: Bar[]; dec: number; thin?: boolean }> = {
  "XAU/USD": { bars: walk(21, 100 * 288, 4100, 1), dec: 2 },
  "EUR/USD": { bars: walk(7, 100 * 288, 1.1, 0.0001), dec: 5 },
  "GBP/JPY": { bars: walk(9, 100 * 288, 200, 0.01), dec: 3 },
  "GBP/USD": { bars: walk(11, 100 * 288, 1.3, 0.0001), dec: 5 },
};
const MINUTES: Record<string, number> = { "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60, "4h": 240, "1day": 1440, "1week": 10080 };
function bucket(b: Bar[], mins: number): Bar[] {
  if (mins === 5) return b;
  if (mins === 1) { const out: Bar[] = []; for (const x of b.slice(-400)) for (let k = 0; k < 5; k++) { const a = x.o + ((x.c - x.o) * k) / 5, z = x.o + ((x.c - x.o) * (k + 1)) / 5; out.push({ t: x.t + k * 60_000, o: a, h: Math.max(a, z, k === 2 ? x.h : -Infinity), l: Math.min(a, z, k === 3 ? x.l : Infinity), c: z }); } return out; }
  const ms = mins * 60_000, m = new Map<number, Bar>();
  for (const x of b) { const k = Math.floor(x.t / ms) * ms, cur = m.get(k); if (!cur) m.set(k, { t: k, o: x.o, h: x.h, l: x.l, c: x.c }); else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; } }
  return [...m.values()].sort((a, c) => a.t - c.t);
}
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; };

/* ── everything the handlers reach for over the network ───────────────────────────────────────── */
/** Every request made, as "METHOD host/path": for tests that count what was asked. */
export const calls: string[] = [];
/**
 * The service that writes a read's story. With no key in the environment (the default here) it is
 * never asked. A test that sets ANTHROPIC_API_KEY sets `story.reply` too: what the service answers
 * (it is handed the request as the handler made it), or a function that throws for a service that is down.
 */
export const story: { reply: null | ((init: any) => Response | Promise<Response>) } = { reply: null };
/** A story as the service returns it. */
export const storyOf = (sentences: string[]): Response => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(sentences) }] }), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (input: any, init: any = {}): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method ?? (typeof input === "object" && input.method) ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? (typeof input === "object" ? input.headers : undefined));
  const bearer = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const caller = tokens.get(bearer)?.id ?? null;
  let body: any; if (init.body != null) { try { body = JSON.parse(String(init.body)); } catch { body = init.body; } }
  calls.push(`${method} ${url.host}${url.pathname}`);
  if (url.host === "supabase.invalid") {
    if (url.pathname === "/auth/v1/user") {
      const u = tokens.get(bearer);
      return u ? new Response(JSON.stringify({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: {}, created_at: iso(T0) }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ code: 401, msg: "invalid JWT" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    const fn = /^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname); if (fn) return rpc(fn[1], body ?? {}, caller);
    const tb = /^\/rest\/v1\/([a-z0-9_]+)$/.exec(url.pathname); if (tb) return rest(tb[1], url, method, headers, body);
    throw new Error(`harness: supabase path is not modelled: ${url.pathname}`);
  }
  if (url.host === "api.twelvedata.com") {
    const sym = url.searchParams.get("symbol") ?? "", f = FEED[sym];
    if (!f) return new Response(JSON.stringify({ status: "error", code: 404, message: `harness: no feed for ${sym}` }), { status: 200 });
    if (url.pathname === "/price") return new Response(JSON.stringify({ price: f.bars[f.bars.length - 1].c.toFixed(f.dec) }), { status: 200 });
    if (url.pathname === "/time_series") {
      let size = +(url.searchParams.get("outputsize") ?? 30);
      if (f.thin) size = Math.min(size, 25);
      const bars = bucket(f.bars, MINUTES[url.searchParams.get("interval") ?? ""]).slice(-size).reverse();
      return new Response(JSON.stringify({ status: "ok", values: bars.map((x) => ({ datetime: stamp(x.t), open: x.o.toFixed(f.dec), high: x.h.toFixed(f.dec), low: x.l.toFixed(f.dec), close: x.c.toFixed(f.dec) })) }), { status: 200 });
    }
  }
  if (url.host === "api.anthropic.com" && story.reply) return story.reply(init);
  throw new Error(`harness: no network — ${method} ${url.host}${url.pathname}`);
};

/* ── calling a handler as Next would ──────────────────────────────────────────────────────────── */
const { requestAsyncStorage } = require("next/dist/client/components/request-async-storage.external.js");
const { NextRequest } = require("next/server");
const noCookies = { getAll: () => [], get: () => undefined, has: () => false, set: () => {}, delete: () => {}, [Symbol.iterator]: function* () {} };
export type Answer = { status: number; json: any; text: string };
/** `route` is the folder under src/app/api ("floor/setup"); `token` is a member()'s, or null for nobody signed in. */
export async function call(route: string, method: "GET" | "POST", pathAndQuery: string, token: string | null, body?: unknown): Promise<Answer> {
  const mod = require(path.join(ROOT, "src/app/api", route, "route.ts"));
  const h = new Headers(token ? { authorization: `Bearer ${token}` } : {});
  if (body !== undefined) h.set("content-type", "application/json");
  const req = new NextRequest(`http://site.invalid${pathAndQuery}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res: Response = await requestAsyncStorage.run({ headers: h, cookies: noCookies, mutableCookies: noCookies, draftMode: { isEnabled: false } }, () => mod[method](req));
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
