import { createAdminClient } from "@/lib/supabase/admin";
import { flowDecision } from "@/lib/flow/decision";
import { placeOnActiveAccounts } from "@/lib/flow/executor";
import { activeAccounts, type ActiveAccount } from "@/lib/flow/connection";
import { flowConfirm } from "@/lib/flowEngine";
import { getInstrument } from "@/lib/flow/instruments";
import { ENTRY_TUNING } from "@/lib/entryEngine";
import type { Mode } from "@/lib/genxCompute";
import { CREDIT_COST, DAILY_FREE } from "@/lib/creditConfig";
import { hasActiveSuite } from "@/lib/subscription";

/**
 * FLOW AUTO-EXECUTOR (server-only).
 *
 * Two tiers:
 *  1. FULL SCAN (runAutoExecAll, every ~5 min) — runs the same setup→confirm→
 *     entry-engine pipeline the FLOW screen shows for each armed symbol. It places
 *     immediately on ENTER_NOW, and records any setup that is AT/near its zone into
 *     a shared watch list.
 *  2. FAST-WATCH (runFlowWatch, every ~30s) — for the at-zone setups only, it
 *     re-confirms on 1-MINUTE candles and fires the instant buyers/sellers activate,
 *     so an entry isn't missed waiting up to 5 minutes for the next full scan.
 *
 * Guardrails (per member): per-symbol COOLDOWN (a standing signal can't re-fire
 * every tick / stack a second position), an ORDERS-PER-HOUR cap, a max concurrent
 * cap, and an error backoff so an ambiguous fill isn't duplicated. Only ARMED
 * members (flow_auto_settings.enabled) are ever touched.
 */

export type AutoSettings = {
  user_id: string;
  enabled: boolean;
  mode: Mode | string | null;
  symbols: string[] | null;
  max_lot: number | null;
  max_open: number | null;
  max_orders_per_hour: number | null;
  daily_loss_limit: number | null;
  email?: string | null;
  last_credit_at?: string | null;
  credit_paused?: boolean | null;
};

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "NAS100"];

// ── FLOW auto-run billing ───────────────────────────────────────────────
// Running auto-run costs 1 credit per 30-minute window, charged only while the
// market is open (nothing fills when it's closed, so we never burn a member's
// credits overnight/weekends). When a member can't cover the charge we PAUSE
// (skip placing) but keep enabled=true, so it auto-resumes the moment they top
// up. A transient billing/system error fails OPEN — a paid member is never
// blocked by a DB blip; only a genuinely-empty balance stops auto-run.
const AUTORUN_COST = CREDIT_COST.flow_autorun ?? 1;
const AUTORUN_WINDOW_MS = 30 * 60000;

// Gold/FX cash market: open Sun 22:00 UTC → Fri 22:00 UTC, continuous. Holidays
// aren't modelled (the engine simply won't confirm on stale data), which is fine
// — this gate only decides whether to bill + place, not correctness of a fill.
function isMarketOpenNow(d: Date = new Date()): boolean {
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const h = d.getUTCHours();
  if (day === 6) return false;      // Saturday — closed
  if (day === 0) return h >= 22;    // Sunday — opens 22:00 UTC
  if (day === 5) return h < 22;     // Friday — closes 22:00 UTC
  return true;                      // Mon–Thu — open
}

/**
 * Decide whether an armed member may run THIS tick, billing the 30-min window
 * when it's due. Mutates flow_auto_settings.last_credit_at / credit_paused.
 * Returns false (skip placing for this member) when the market is closed or the
 * member is out of credits.
 */
async function meterAutoRun(admin: Admin, settings: AutoSettings): Promise<boolean> {
  if (!isMarketOpenNow()) return false; // never bill or place while closed
  // Trading Suite members get auto-run FREE — no per-window credit charge.
  // Non-members fall through to the pay-per-use meter below.
  if (await hasActiveSuite(settings.user_id, admin)) return true;
  const last = settings.last_credit_at ? Date.parse(settings.last_credit_at) : 0;
  const due = !!settings.credit_paused || !last || Date.now() - last >= AUTORUN_WINDOW_MS;
  if (!due) return true; // still inside an already-paid 30-min window
  let ok = true;
  try {
    const { data, error } = await admin.rpc("spend_credits_for", {
      p_user_id: settings.user_id, p_cost: AUTORUN_COST, p_daily_allowance: DAILY_FREE, p_feature: "flow_autorun",
    });
    if (error) ok = true; // system fault → fail open (don't punish a paid member)
    else ok = !!(data && (data as { ok?: boolean }).ok);
  } catch { ok = true; }
  const nowIso = new Date().toISOString();
  if (ok) {
    await admin.from("flow_auto_settings").update({ last_credit_at: nowIso, credit_paused: false }).eq("user_id", settings.user_id);
    return true;
  }
  if (!settings.credit_paused) await admin.from("flow_auto_settings").update({ credit_paused: true }).eq("user_id", settings.user_id);
  return false;
}
const COOLDOWN_MIN: Record<string, number> = { quick: 90, intraday: 180, swing: 480 };
const ERROR_BACKOFF_MS = 8 * 60000;
// The at-zone watch list lives in the shared kv (live_plays_cache) under this id.
const WATCH_CACHE_ID = "flow_watch";
const WATCH_STALE_MS = 12 * 60000; // ignore a watch list older than this (scan is 5-min)

type Levels = { entryLow: number | null; entryHigh: number | null; stop: number | null; tp1: number | null; invalidation: number | null };
type WatchSetup = { symbol: string; side: "buy" | "sell"; levels: Levels };
type AutoEvent = { symbol: string; created_at: string; status: string };
type SymbolResult = { symbol: string; action: string; detail?: string; orderId?: string | null; side?: string };
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

async function recentAutoEvents(admin: Admin, userId: string): Promise<AutoEvent[]> {
  const sinceIso = new Date(Date.now() - 8 * 3600e3).toISOString();
  const { data } = await admin.from("flow_auto_events")
    .select("symbol, created_at, status")
    .eq("user_id", userId).like("reason", "auto%")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  return (data ?? []) as AutoEvent[];
}

// Absolute per-order lot ceiling (fat-finger backstop, even after risk sizing).
const MAX_LOTS = 100;

// ── per-member guard context (shared by the ENTER_NOW and fast-watch paths) ──
type GuardCtx = {
  mode: Mode; symbols: string[]; maxLot: number; cooldownMs: number;
  now: number; events: AutoEvent[]; placed: AutoEvent[];
  hourBudget: number; openSymbols: Set<string>; maxOpen: number;
  // Risk-based sizing: each trade risks riskPct of EACH active account's own live
  // equity. `accounts` is every account the member toggled ON, across all their
  // connections — a placement fans out over all of them. Fetched once per cycle.
  riskPct: number; accounts: ActiveAccount[];
};

async function buildGuardCtx(admin: Admin, settings: AutoSettings): Promise<GuardCtx> {
  const mode = (settings.mode === "intraday" || settings.mode === "swing" ? settings.mode : "quick") as Mode;
  const symbols = (settings.symbols && settings.symbols.length ? settings.symbols : DEFAULT_SYMBOLS).map((s) => String(s).toUpperCase());
  const maxLot = settings.max_lot && settings.max_lot > 0 ? settings.max_lot : 0.01;
  const maxPerHour = settings.max_orders_per_hour && settings.max_orders_per_hour > 0 ? settings.max_orders_per_hour : 10;
  const maxOpen = settings.max_open && settings.max_open > 0 ? settings.max_open : symbols.length;
  const cooldownMs = (COOLDOWN_MIN[mode] ?? 90) * 60000;
  const now = Date.now();
  const events = await recentAutoEvents(admin, settings.user_id);
  const placed = events.filter((e) => e.status === "placed");
  const placedLastHour = placed.filter((p) => now - new Date(p.created_at).getTime() < 3600e3).length;
  const hourBudget = Math.max(0, maxPerHour - placedLastHour);
  const openSymbols = new Set(placed.filter((p) => now - new Date(p.created_at).getTime() < cooldownMs).map((p) => String(p.symbol).toUpperCase()));

  // Risk sizing inputs: the member's saved risk % + all their active accounts
  // (each carrying its own live equity, fetched once for the whole cycle).
  const { data: pref } = await admin.from("flow_trade_prefs").select("risk_pct").eq("user_id", settings.user_id).maybeSingle();
  const p = (pref as { risk_pct?: number | null } | null) ?? null;
  const riskPct = p && typeof p.risk_pct === "number" && p.risk_pct > 0 ? p.risk_pct : 1;
  const accounts = await activeAccounts(settings.user_id);

  return { mode, symbols, maxLot, cooldownMs, now, events, placed, hourBudget, openSymbols, maxOpen, riskPct, accounts };
}

/** Apply the per-member guardrails and, if they pass, place ONE market order. Mutates ctx. */
async function guardAndPlace(admin: Admin, settings: AutoSettings, ctx: GuardCtx, symbol: string, side: "buy" | "sell", levels: Levels, price?: number | null): Promise<SymbolResult> {
  const ms = (iso: string) => ctx.now - new Date(iso).getTime();
  if (!ctx.symbols.includes(symbol)) return { symbol, action: "not_in_list" };
  const lastPlaced = ctx.placed.find((p) => String(p.symbol).toUpperCase() === symbol);
  if (lastPlaced && ms(lastPlaced.created_at) < ctx.cooldownMs) return { symbol, action: "cooldown" };
  const lastErr = ctx.events.find((e) => e.status === "error" && String(e.symbol).toUpperCase() === symbol);
  if (lastErr && ms(lastErr.created_at) < ERROR_BACKOFF_MS) return { symbol, action: "error_backoff" };
  if (ctx.hourBudget <= 0) return { symbol, action: "hour_cap" };
  if (!ctx.openSymbols.has(symbol) && ctx.openSymbols.size >= ctx.maxOpen) return { symbol, action: "max_open" };

  // A protective stop is REQUIRED (fall back to the invalidation), and the entry
  // falls back to the live price when a setup enters "at market" with no pullback
  // zone (common on momentum ENTER_NOW). If we can't attach a stop or don't have a
  // usable entry, we SKIP — we never place a blind, unsized order.
  const stopPx = levels.stop ?? levels.invalidation ?? null;
  const zoneMid = levels.entryLow != null && levels.entryHigh != null
    ? (levels.entryLow + levels.entryHigh) / 2
    : (levels.entryLow ?? levels.entryHigh ?? null);
  const entryPx = zoneMid ?? (price != null && price > 0 ? price : null);

  if (stopPx == null) return { symbol, action: "skip_no_stop" };
  if (entryPx == null) return { symbol, action: "skip_no_entry" };
  if (!ctx.accounts.length) return { symbol, action: "skip_no_accounts" };

  // ATOMIC anti-duplicate gate. The in-memory cooldown check above is a snapshot
  // read at run start, so two OVERLAPPING scheduler runs (Vercel 1-min cron +
  // GitHub 30s fast-watch, in separate isolates) can both pass it and double-enter
  // the same signal. This claim is decided inside Postgres under an advisory lock,
  // so exactly ONE run wins the right to place this symbol for the cooldown window.
  const claimSecs = Math.max(1, Math.floor(ctx.cooldownMs / 1000));
  try {
    const { data: won } = await admin.rpc("flow_try_claim", { p_user: settings.user_id, p_symbol: symbol, p_cooldown_secs: claimSecs });
    if (won === false) return { symbol, action: "cooldown" };
  } catch { /* if the claim RPC is unavailable, fall through to the in-memory guard */ }

  // Fan out: place the SAME setup on every active account, each risk-sized to its
  // own live equity (gold<$500 floors to 0.01 inside placeOnActiveAccounts).
  const res = await placeOnActiveAccounts({
    userId: settings.user_id, symbol, side, entry: entryPx, stop: stopPx, tp: levels.tp1,
    riskPct: ctx.riskPct, source: "auto", accounts: ctx.accounts,
  });
  if (res.placed === 0) {
    // Nothing filled — release the claim so the next tick can retry this symbol
    // (subject to the error backoff) instead of waiting out the whole cooldown.
    try { await admin.rpc("flow_release_claim", { p_user: settings.user_id, p_symbol: symbol }); } catch { /* best-effort */ }
  }
  if (res.placed > 0) {
    ctx.hourBudget -= 1;
    ctx.openSymbols.add(symbol);
    ctx.placed.unshift({ symbol, created_at: new Date(ctx.now).toISOString(), status: "placed" });
    const first = res.accounts.find((a) => a.status === "placed");
    return { symbol, action: "placed", side, orderId: first?.orderId ?? null, detail: `${res.placed}/${res.accounts.length} accounts` };
  }
  ctx.events.unshift({ symbol, created_at: new Date(ctx.now).toISOString(), status: "error" });
  const firstErr = res.accounts.find((a) => a.status === "error");
  return { symbol, action: res.accounts.length ? "order_error" : "skip_no_accounts", side, detail: firstErr?.reason || "no fills" };
}

// A setup is "in the area" (worth fast-watching) when price has reached the zone
// or the entry engine has it armed/approaching, and it carries usable levels.
function nearZone(dec: Extract<Awaited<ReturnType<typeof flowDecision>>, { ok: true }>): boolean {
  const st = dec.entry.entryState;
  const atZone = dec.confirm.state === "AT_ZONE" || st === "ARMED" || st === "APPROACHING";
  const hasLevels = dec.levels.entryLow != null && dec.levels.entryHigh != null && dec.levels.invalidation != null;
  return atZone && hasLevels;
}

// ── shared at-zone watch list (live_plays_cache, id=WATCH_CACHE_ID) ──
async function writeWatchList(admin: Admin, setups: WatchSetup[]): Promise<void> {
  try { await admin.from("live_plays_cache").upsert({ id: WATCH_CACHE_ID, payload: { setups }, generated_at: new Date().toISOString() }, { onConflict: "id" }); }
  catch { /* best-effort */ }
}
async function readWatchList(admin: Admin): Promise<WatchSetup[]> {
  try {
    const { data } = await admin.from("live_plays_cache").select("payload, generated_at").eq("id", WATCH_CACHE_ID).maybeSingle();
    if (!data?.payload) return [];
    if (Date.now() - new Date(data.generated_at as string).getTime() > WATCH_STALE_MS) return [];
    const setups = (data.payload as { setups?: unknown }).setups;
    return Array.isArray(setups) ? (setups as WatchSetup[]) : [];
  } catch { return []; }
}

/** FULL SCAN for a single member. Returns results + the setups that are at/near their zone. */
async function scanUser(admin: Admin, settings: AutoSettings, mdKey: string): Promise<{ userId: string; results: SymbolResult[]; near: WatchSetup[] }> {
  const results: SymbolResult[] = [];
  const near: WatchSetup[] = [];
  if (!settings.enabled) return { userId: settings.user_id, results: [{ symbol: "-", action: "disabled" }], near };
  const ctx = await buildGuardCtx(admin, settings);

  for (const symbol of ctx.symbols) {
    try {
      const dec = await flowDecision({ canonical: symbol, mode: ctx.mode, mdKey, fresh: true });
      if (!dec.ok) { results.push({ symbol, action: "read_skip", detail: dec.error }); continue; }
      if (dec.entry.entryState === "ENTER_NOW" && dec.entry.actionable) {
        results.push(await guardAndPlace(admin, settings, ctx, symbol, dec.side, dec.levels, dec.price));
      } else {
        results.push({ symbol, action: "no_entry", detail: dec.entry.entryState });
        if (nearZone(dec)) near.push({ symbol, side: dec.side, levels: dec.levels });
      }
    } catch (e) {
      results.push({ symbol, action: "error", detail: e instanceof Error ? e.message.slice(0, 160) : "error" });
    }
  }
  return { userId: settings.user_id, results, near };
}

/** Back-compat single-user entry point (member on-demand run = full scan). */
export async function runAutoExecForUser(settings: AutoSettings, mdKey: string): Promise<{ userId: string; results: SymbolResult[] }> {
  const admin = createAdminClient();
  if (!admin) return { userId: settings.user_id, results: [{ symbol: "-", action: "error", detail: "no_admin_client" }] };
  const r = await scanUser(admin, settings, mdKey);
  return { userId: r.userId, results: r.results };
}

/** FULL SCAN for every armed member; refreshes the at-zone watch list for the fast-watch. */
export async function runAutoExecAll(mdKey: string): Promise<{ users: number; runs: Array<{ userId: string; results: SymbolResult[] }>; watching: string[] }> {
  const admin = createAdminClient();
  if (!admin) return { users: 0, runs: [], watching: [] };
  const { data } = await admin.from("flow_auto_settings").select("*").eq("enabled", true);
  const rows = (data ?? []) as AutoSettings[];
  const runs: Array<{ userId: string; results: SymbolResult[] }> = [];
  const nearBySymbol = new Map<string, WatchSetup>();
  for (const s of rows) {
    try {
      if (!(await meterAutoRun(admin, s))) {
        runs.push({ userId: s.user_id, results: [{ symbol: "-", action: isMarketOpenNow() ? "paused_no_credits" : "market_closed" }] });
        continue;
      }
      const r = await scanUser(admin, s, mdKey);
      runs.push({ userId: r.userId, results: r.results });
      for (const n of r.near) nearBySymbol.set(n.symbol, n); // setup is global per symbol
    } catch (e) {
      runs.push({ userId: s.user_id, results: [{ symbol: "-", action: "error", detail: e instanceof Error ? e.message.slice(0, 160) : "error" }] });
    }
  }
  const watching = [...nearBySymbol.values()];
  await writeWatchList(admin, watching);
  return { users: rows.length, runs, watching: watching.map((w) => w.symbol) };
}

/** FAST-WATCH: re-confirm the at-zone setups on 1-min candles and fire on CONFIRMED. */
export async function runFlowWatch(mdKey: string): Promise<{ watched: number; confirmed: string[]; runs: Array<{ userId: string; results: SymbolResult[] }>; states: Array<{ symbol: string; state: string }> }> {
  const admin = createAdminClient();
  if (!admin) return { watched: 0, confirmed: [], runs: [], states: [] };
  const setups = await readWatchList(admin);
  if (!setups.length) return { watched: 0, confirmed: [], runs: [], states: [] };

  // Confirm each setup ONCE (setups are global per symbol), on 1-minute closes.
  const confirmed: WatchSetup[] = [];
  const states: Array<{ symbol: string; state: string }> = [];
  for (const s of setups) {
    try {
      const inst = getInstrument(s.symbol);
      const lo = s.levels.entryLow, hi = s.levels.entryHigh, inv = s.levels.invalidation;
      if (lo == null || hi == null || inv == null) { states.push({ symbol: s.symbol, state: "no_levels" }); continue; }
      const conf = await flowConfirm({
        tdSymbol: inst.twelveDataSymbol, pip: inst.pipSize, side: s.side,
        entryLow: lo, entryHigh: hi, watch: lo, invalidation: inv,
        mode: "quick", mdKey, fresh: true, interval: "1min",
      });
      if (conf.state !== "CONFIRMED") { states.push({ symbol: s.symbol, state: conf.state }); continue; }
      // Don't chase a spent move: require real reward left (the SAME R:R floor the
      // full entry engine applies) so the 1-min speed-up can't fire a late entry
      // that has already run most of the way to target.
      const px = conf.price ?? conf.enter;
      const tp1 = s.levels.tp1;
      let rr: number | null = null;
      if (px != null && tp1 != null) {
        const risk = Math.abs(px - inv);
        const reward = Math.abs(tp1 - px);
        rr = risk > 0 ? reward / risk : null;
      }
      if (rr != null && rr < ENTRY_TUNING.quick.minRemainingRR) {
        states.push({ symbol: s.symbol, state: `chase_skip_rr_${rr.toFixed(2)}` });
        continue;
      }
      states.push({ symbol: s.symbol, state: rr != null ? `confirmed_rr_${rr.toFixed(2)}` : "confirmed" });
      confirmed.push(s);
    } catch (e) {
      states.push({ symbol: s.symbol, state: e instanceof Error ? e.message.slice(0, 60) : "error" });
    }
  }
  if (!confirmed.length) return { watched: setups.length, confirmed: [], runs: [], states };

  // A 1-min confirmation fired → place for every armed member (guardrails apply).
  const { data } = await admin.from("flow_auto_settings").select("*").eq("enabled", true);
  const rows = (data ?? []) as AutoSettings[];
  const runs: Array<{ userId: string; results: SymbolResult[] }> = [];
  for (const settings of rows) {
    try {
      if (!(await meterAutoRun(admin, settings))) {
        runs.push({ userId: settings.user_id, results: [{ symbol: "-", action: isMarketOpenNow() ? "paused_no_credits" : "market_closed" }] });
        continue;
      }
      const ctx = await buildGuardCtx(admin, settings);
      const results: SymbolResult[] = [];
      for (const c of confirmed) {
        if (!ctx.symbols.includes(c.symbol)) continue;
        results.push(await guardAndPlace(admin, settings, ctx, c.symbol, c.side, c.levels));
      }
      runs.push({ userId: settings.user_id, results });
    } catch (e) {
      runs.push({ userId: settings.user_id, results: [{ symbol: "-", action: "error", detail: e instanceof Error ? e.message.slice(0, 160) : "error" }] });
    }
  }
  return { watched: setups.length, confirmed: confirmed.map((c) => c.symbol), runs, states };
}
