import { createAdminClient } from "@/lib/supabase/admin";
import { flowDecision } from "@/lib/flow/decision";
import { placeOnActiveAccounts, placeFixedLotFollower } from "@/lib/flow/executor";
import { activeAccounts, connectionToken, type ActiveAccount } from "@/lib/flow/connection";
import { listAccounts } from "@/lib/flow/tradelocker";
import { sizeFromRisk } from "@/lib/flow/sizing";
import { flowConfirm } from "@/lib/flowEngine";
import { getInstrument } from "@/lib/flow/instruments";
import { newsHold } from "@/lib/news/calendar";
import { series } from "@/lib/marketData";
import { trendOfCloses, closedBars } from "@/lib/mtf";
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

// The LEAD account everyone copies. TRADE SELECTION — which pairs, which horizon,
// how many can be open at once, how many per hour — follows the lead, so every
// member takes the EXACT same trades as the lead. Only two things stay per-member:
// SIZE (each account risk-sizes to its own equity) and whether they COPY AT ALL
// (credits: out of credits → paused → they don't copy). This makes the lead the
// single source of truth for what gets traded, so no member can drift.
const MASTER_USER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100"; // Matthew

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
  // Trade-SELECTION knobs come from the LEAD account so every member mirrors it
  // (pairs, horizon, max concurrent, hourly cap). A member's own selection settings
  // are intentionally ignored — the lead decides WHAT trades; the member only brings
  // their accounts + risk %. Falls back to the member's own settings if the lead
  // can't be read, so a lookup blip never halts trading.
  let lead = settings;
  if (settings.user_id !== MASTER_USER_ID) {
    const { data: leadRow } = await admin.from("flow_auto_settings").select("*").eq("user_id", MASTER_USER_ID).maybeSingle();
    if (leadRow) lead = leadRow as AutoSettings;
  }
  const mode = (lead.mode === "intraday" || lead.mode === "swing" ? lead.mode : "quick") as Mode;
  const symbols = (lead.symbols && lead.symbols.length ? lead.symbols : DEFAULT_SYMBOLS).map((s) => String(s).toUpperCase());
  const maxLot = lead.max_lot && lead.max_lot > 0 ? lead.max_lot : 0.01;
  const maxPerHour = lead.max_orders_per_hour && lead.max_orders_per_hour > 0 ? lead.max_orders_per_hour : 10;
  const maxOpen = lead.max_open && lead.max_open > 0 ? lead.max_open : symbols.length;
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

// ── STRICT MIRROR: one active trade per symbol, desk-wide ────────────────────
// Every account should take the SAME signal at the SAME entry/stop. If an account
// MISSES a signal's entry window (a disconnect, a broker hiccup, cooldown timing),
// it must SIT OUT that trade — never fill a LATER, different entry on the same pair
// while other accounts are still in the first one. (That's what put Matthew's
// Genesis and Josh's Crucial into two different GBPUSD trades with different stops
// and different outcomes.) We enforce it by checking, desk-wide, for an OPEN FLOW
// position on this symbol that was opened more than a few minutes ago — i.e. from
// an EARLIER signal, not this same fan-out. Same-pass placements (<5 min, so all
// accounts still enter the SAME signal together) are allowed; a later divergent
// entry is blocked until the shared trade closes.
const MIRROR_SAME_PASS_MS = 5 * 60_000;
async function deskInActiveTrade(admin: Admin, symbol: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - MIRROR_SAME_PASS_MS).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("id")
      .eq("status", "open")
      .eq("symbol", symbol)
      .lt("created_at", cutoff)
      .limit(1);
    return !!(data && data.length);
  } catch { return false; } // never block placement on a guard read error
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

  // NEWS GUARD (falling-knife): if a HIGH-impact event for this pair's currency is
  // inside the blackout window (about to drop or just dropped), HOLD — don't buy blind
  // into the volatility spike. The desk resumes automatically once the window passes.
  try { if ((await newsHold(symbol)).hold) return { symbol, action: "news_hold" }; } catch { /* feed down → don't block trading */ }

  // STRICT MIRROR: if the desk is already in an OPEN trade on this pair from an
  // earlier signal, sit this account out — don't open a later, divergent entry.
  if (await deskInActiveTrade(admin, symbol)) return { symbol, action: "mirror_wait" };

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
      // Gold is handled by the GENX engine (placeGenxGold), not FLOW's own read.
      // FLOW only takes forex/indices here; gold comes from the GENX ENTER NOW.
      if (symbol === "XAUUSD" || symbol === "GOLD") { results.push({ symbol, action: "genx_gold" }); continue; }
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
        if (c.symbol === "XAUUSD" || c.symbol === "GOLD") continue; // gold is GENX-driven
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

// ── GENX → FLOW gold bridge ──────────────────────────────────────────────────
// GOLD is driven by the dedicated GENX engine (the one that broadcasts ENTER NOW
// to Telegram) — NOT FLOW's own read — because that engine's gold calls play out.
// FOREX (EUR/GBP/JPY/NAS) stays on FLOW's own engine. genx-scan calls this at each
// gold ENTER NOW moment.
//
// It follows the LEAD like everything else: gold only runs when the lead account
// has gold enabled, and it copies to EVERY enabled member (gated only by credits) —
// a member's own gold toggle doesn't matter, same as the rest of the copy model.
// The atomic flow_try_claim gate + strict-mirror guard guarantee ONE gold entry
// per member per move (GENX re-fires ENTER NOW several times for one move; every
// repeat after the first is refused). Placement is free, same as any FLOW fill.
const GOLD_GENX_COOLDOWN_SEC = 120 * 60; // one gold entry per member per 2 hours

// SMART, TREND-AWARE GOLD ENTRY GATE.
// GENX still makes the call; this layer only steps aside when GENX would be FIGHTING the
// trend and stacking losses. It reads the higher-timeframe (1h) gold trend and applies a
// graduated per-side loss guard:
//   • WITH the trend  → take it freely (loose 3-loss safety net in case a trend reverses).
//   • COUNTER-trend   → allow ONE pullback shot; pause that side after a single loss.
//   • Ranging/unknown → normal read; pause a side after 2 losses in a row.
// A paused side self-resets after the cooldown (takes one probe; a win clears the streak).
const GOLD_LOSS_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h protective pause per side
const GOLD_STREAK_WITH_TREND = 3;
const GOLD_STREAK_RANGE = 2;
const GOLD_STREAK_COUNTER_TREND = 1;

/** Higher-timeframe (1h) gold trend, on CLOSED candles. null = couldn't read → treat neutral. */
async function goldTrend(): Promise<"bullish" | "bearish" | "ranging" | null> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  try {
    const rows = await series("XAU/USD", "1h", 120, key);
    if (!rows || rows === "ratelimit" || !Array.isArray(rows)) return null;
    const closed = closedBars(rows, 52) ?? rows;
    const closes = closed.map((r) => +r.close).filter((n) => Number.isFinite(n));
    if (closes.length < 52) return "ranging";
    return trendOfCloses(closes);
  } catch { return null; }
}

/** True while a gold SIDE is paused because its last `streak` trades on that side all lost. */
async function goldDirectionHalt(admin: Admin, side: "buy" | "sell", streak: number): Promise<boolean> {
  if (streak <= 0) return false;
  const wantDir = side === "buy" ? "bullish" : "bearish";
  const { data } = await admin
    .from("genx_signals")
    .select("outcome, resolved_at")
    .in("outcome", ["WIN", "LOSS"])
    .eq("direction", wantDir)
    .order("resolved_at", { ascending: false, nullsFirst: false })
    .limit(30);
  const rows = (data ?? []) as { outcome: string; resolved_at: string | null }[];
  // Collapse signals that resolved at the SAME instant (fan-out / one market event) into
  // a single outcome, newest first — so a "streak" counts distinct trades on this side.
  const events: { outcome: string; ts: number }[] = [];
  let lastKey = "";
  for (const r of rows) {
    const k = String(r.resolved_at);
    if (k === lastKey) continue;
    lastKey = k;
    events.push({ outcome: r.outcome, ts: r.resolved_at ? new Date(r.resolved_at).getTime() : 0 });
  }
  if (events.length < streak) return false;
  const recent = events.slice(0, streak);
  if (!recent.every((e) => e.outcome === "LOSS")) return false;
  return Date.now() < recent[0].ts + GOLD_LOSS_COOLDOWN_MS;
}

/** The smart gate: returns true to HOLD this gold entry (skip), false to allow it. */
async function goldEntryHold(admin: Admin, side: "buy" | "sell"): Promise<boolean> {
  const trend = await goldTrend();
  const wantDir = side === "buy" ? "bullish" : "bearish";
  let streak = GOLD_STREAK_RANGE; // ranging or unknown trend
  if (trend === "bullish" || trend === "bearish") {
    streak = trend === wantDir ? GOLD_STREAK_WITH_TREND : GOLD_STREAK_COUNTER_TREND;
  }
  return goldDirectionHalt(admin, side, streak);
}

export async function placeGenxGold(sig: { side: "buy" | "sell"; entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null }): Promise<{ members: number; placed: number }> {
  const admin = createAdminClient();
  if (!admin) return { members: 0, placed: 0 };
  const entry = (sig.entryLow != null && sig.entryHigh != null) ? (sig.entryLow + sig.entryHigh) / 2 : (sig.entryLow ?? sig.entryHigh);
  if (entry == null || sig.stop == null) return { members: 0, placed: 0 };

  // Gold is a LEAD decision — only copy it if the lead account is armed with gold.
  const { data: leadRow } = await admin.from("flow_auto_settings").select("enabled, symbols").eq("user_id", MASTER_USER_ID).maybeSingle();
  const lead = leadRow as { enabled?: boolean | null; symbols?: string[] | null } | null;
  const leadSyms = (lead?.symbols && lead.symbols.length ? lead.symbols : DEFAULT_SYMBOLS).map((x) => String(x).toUpperCase());
  if (!lead?.enabled || !(leadSyms.includes("XAUUSD") || leadSyms.includes("GOLD"))) return { members: 0, placed: 0 };

  // STRICT MIRROR: if the desk is already in an OPEN gold trade from an earlier
  // ENTER NOW, don't open a later divergent gold entry — everyone sits out until it
  // closes. Checked once so all members still mirror THIS same ENTER NOW.
  if (await deskInActiveTrade(admin, "XAUUSD")) return { members: 0, placed: 0 };

  // NEWS GUARD (falling-knife): gold reacts to USD data — if a HIGH-impact USD event is
  // inside the blackout window, hold this ENTER NOW. GENX will re-offer once it passes.
  try { if ((await newsHold("XAUUSD")).hold) return { members: 0, placed: 0 }; } catch { /* feed down → don't block */ }

  // SMART TREND-AWARE HALT: take with-trend entries freely, give a counter-trend entry
  // one pullback shot, and stop feeding a side that keeps losing — so gold trades WITH
  // the trend and doesn't stack losses fighting it.
  try { if (await goldEntryHold(admin, sig.side)) return { members: 0, placed: 0 }; } catch { /* read error → don't block */ }

  const { data } = await admin.from("flow_auto_settings").select("*").eq("enabled", true);
  const rows = (data ?? []) as AutoSettings[];
  let placedTotal = 0, members = 0;
  for (const s of rows) {
    try {
      if (s.credit_paused) continue; // out of credits → paused → they don't copy (the only gate)

      // Claim gold for this member. FALSE → a gold entry is already live within the
      // cooldown → skip (this blocks GENX's back-to-back ENTER NOW repeats).
      const { data: won } = await admin.rpc("flow_try_claim", { p_user: s.user_id, p_symbol: "XAUUSD", p_cooldown_secs: GOLD_GENX_COOLDOWN_SEC });
      if (won === false) continue;

      const accounts = await activeAccounts(s.user_id);
      if (!accounts.length) { await admin.rpc("flow_release_claim", { p_user: s.user_id, p_symbol: "XAUUSD" }); continue; }

      const { data: pref } = await admin.from("flow_trade_prefs").select("risk_pct").eq("user_id", s.user_id).maybeSingle();
      const p = (pref as { risk_pct?: number | null } | null) ?? null;
      const riskPct = p && typeof p.risk_pct === "number" && p.risk_pct > 0 ? p.risk_pct : 1;

      const res = await placeOnActiveAccounts({ userId: s.user_id, symbol: "XAUUSD", side: sig.side, entry, stop: sig.stop, tp: sig.tp, riskPct, source: "genx", accounts });
      if (res.placed === 0) await admin.rpc("flow_release_claim", { p_user: s.user_id, p_symbol: "XAUUSD" }); // nothing filled → let the next ENTER NOW retry
      else { placedTotal += res.placed; members += 1; }
    } catch { /* per-member best-effort */ }
  }
  return { members, placed: placedTotal };
}

// ── GENX FOLLOWER accounts ─────────────────────────────────────────────────────
// A completely SEPARATE path from FLOW. Any account flagged genx_follower=true (its
// own toggle, independent of autotrade_enabled / credits / the lead) takes EVERY
// gold ENTER NOW — no caps, no cooldown, no news or trend guard, no strict-mirror.
// It rides the signal's broker-held SL/TP raw (the trade-manager never touches it).
// GENX is gold-only, so "every GENX signal" = every gold ENTER NOW. Dedup
// (genx_follower_fills, unique signal_key+account_id) makes it idempotent across the
// scanner's overlapping runs / repeated ENTER NOWs.
//
// SIZING: each follower account is risk-sized to ITS OWN risk % — the per-account
// risk_pct override if one is set, else the owner's default risk (flow_trade_prefs),
// else a 1% fallback — off that account's live equity and the signal's entry→stop
// distance. So one follower can ride GENX aggressively and another conservatively.
// FOLLOWER_LOT (0.01) is only the safety floor: if we can't read the entry, stop, or
// equity to size a trade, the follower still takes the signal at the broker minimum
// rather than silently sitting out.
const FOLLOWER_LOT = 0.01;
const FOLLOWER_DEFAULT_RISK = 1; // % of equity when no per-account and no owner default is set

export async function placeGenxFollower(sig: {
  signalKey: string; side: "buy" | "sell";
  entryLow?: number | null; entryHigh?: number | null;
  stop: number | null; tp: number | null;
}): Promise<{ accounts: number; placed: number }> {
  const admin = createAdminClient();
  if (!admin) return { accounts: 0, placed: 0 };
  const signalKey = String(sig.signalKey || "").slice(0, 200);
  if (!signalKey) return { accounts: 0, placed: 0 };

  // Entry price for risk sizing: midpoint of the zone (fallbacks handle a one-sided
  // zone). null → we can't size, so those accounts fall back to the 0.01 floor.
  const entry = (sig.entryLow != null && sig.entryHigh != null)
    ? (sig.entryLow + sig.entryHigh) / 2
    : (sig.entryLow ?? sig.entryHigh ?? null);

  // Every follower account, across every user/connection (independent of FLOW).
  // Pull the per-account risk override + management toggle when those columns exist;
  // fall back to a bare select so the follower never breaks before the migration is run.
  type FollowRow = { user_id: string; account_id: string; acc_num: string | null; connection_id: string; risk_pct?: number | null; manage_trades?: boolean | null };
  let accts: FollowRow[] = [];
  const withCols = await admin.from("flow_broker_accounts")
    .select("user_id, account_id, acc_num, connection_id, risk_pct, manage_trades").eq("genx_follower", true);
  if (!withCols.error) accts = (withCols.data ?? []) as FollowRow[];
  else {
    const fb = await admin.from("flow_broker_accounts")
      .select("user_id, account_id, acc_num, connection_id").eq("genx_follower", true);
    accts = (fb.data ?? []) as FollowRow[];
  }
  if (!accts.length) return { accounts: 0, placed: 0 };

  // Mint one token per connection (a connection can hold several follower accounts),
  // and read that connection's live account equities ONCE (cached) for risk sizing.
  const tokenCache = new Map<string, { token: string; env: "demo" | "live" } | null>();
  async function tokenFor(connId: string) {
    if (tokenCache.has(connId)) return tokenCache.get(connId)!;
    const t = await connectionToken(connId);
    const v = t.ok ? { token: t.token, env: t.env } : null;
    tokenCache.set(connId, v);
    return v;
  }
  const equityCache = new Map<string, Map<string, number>>(); // connId → (accountId → equity)
  async function equityFor(connId: string, accountId: string, tok: { token: string; env: "demo" | "live" }): Promise<number | null> {
    let m = equityCache.get(connId);
    if (!m) {
      m = new Map();
      try {
        const res = await listAccounts(tok.env, tok.token);
        if (res.ok) for (const x of res.data) {
          const eq = x.equity ?? x.balance;
          if (typeof eq === "number") m.set(String(x.accountId), eq);
        }
      } catch { /* equity read failed → callers fall back to the 0.01 floor */ }
      equityCache.set(connId, m);
    }
    const v = m.get(String(accountId));
    return typeof v === "number" ? v : null;
  }
  // Owner default risk (flow_trade_prefs.risk_pct), cached per user_id.
  const defaultRiskCache = new Map<string, number>();
  async function defaultRiskFor(userId: string): Promise<number> {
    if (defaultRiskCache.has(userId)) return defaultRiskCache.get(userId)!;
    let risk = FOLLOWER_DEFAULT_RISK;
    try {
      const { data: pref } = await admin!.from("flow_trade_prefs").select("risk_pct").eq("user_id", userId).maybeSingle();
      const p = (pref as { risk_pct?: number | null } | null) ?? null;
      if (p && typeof p.risk_pct === "number" && p.risk_pct > 0) risk = p.risk_pct;
    } catch { /* keep fallback */ }
    defaultRiskCache.set(userId, risk);
    return risk;
  }

  let placed = 0, touched = 0;
  for (const a of accts) {
    if (!a.acc_num) continue;
    touched += 1;
    try {
      // Idempotent claim: one fill per (signal, account). A duplicate row → already
      // handled this ENTER NOW on this account → skip.
      const { error: dupErr } = await admin.from("genx_follower_fills").insert({ signal_key: signalKey, account_id: a.account_id });
      if (dupErr) continue;

      const tok = await tokenFor(a.connection_id);
      if (!tok) { await admin.from("genx_follower_fills").delete().eq("signal_key", signalKey).eq("account_id", a.account_id); continue; }

      // Risk-size this account to its own % (override → owner default → 1% fallback).
      // If we can't size (missing entry/stop/equity), take the 0.01 floor so the
      // follower still records the signal instead of sitting it out.
      let qty = FOLLOWER_LOT;
      if (entry != null && sig.stop != null) {
        const equity = await equityFor(a.connection_id, a.account_id, tok);
        if (equity != null && equity > 0) {
          const acctRisk = (typeof a.risk_pct === "number" && a.risk_pct > 0) ? a.risk_pct : await defaultRiskFor(a.user_id);
          const s = sizeFromRisk({ canonical: "XAUUSD", entry, stop: sig.stop, equity, riskPct: acctRisk, floorToMinLot: true });
          if (s.ok && s.lots > 0) qty = Math.min(s.lots, 100); // fat-finger backstop
        }
      }

      const r = await placeFixedLotFollower({
        userId: a.user_id, env: tok.env, token: tok.token, connId: a.connection_id,
        accountId: a.account_id, accNum: String(a.acc_num),
        symbol: "XAUUSD", side: sig.side, qty, stop: sig.stop, tp: sig.tp, source: "genx_follow",
      });
      if (r.ok) {
        placed += 1;
        // MANAGEMENT: when this account has breakeven+partials turned on (manage_trades,
        // default on), hand the follower fill to the trade-manager just like a FLOW fill —
        // so it gets SL→breakeven and a 50% partial. With management off (or no stop) the
        // fill is left unregistered and rides the raw signal SL/TP to its outcome.
        const manageOn = a.manage_trades !== false;
        if (manageOn && r.positionId && entry != null && sig.stop != null) {
          try {
            await admin.from("flow_managed_positions").insert({
              user_id: a.user_id, connection_id: a.connection_id, account_id: a.account_id, acc_num: String(a.acc_num), environment: tok.env,
              position_id: r.positionId, symbol: "XAUUSD", side: sig.side,
              entry, init_stop: sig.stop, tp1: sig.tp ?? null,
              r: Math.abs(entry - sig.stop), qty: r.qty, cur_stop: sig.stop, best_price: entry,
            });
          } catch { /* management is best-effort; the trade still stands unmanaged */ }
        }
      } else {
        // Nothing filled (session closed / token blip) → release the claim so a later
        // ENTER NOW re-fire for this same signal can retry on this account.
        await admin.from("genx_follower_fills").delete().eq("signal_key", signalKey).eq("account_id", a.account_id);
      }
    } catch { /* per-account best-effort */ }
  }
  return { accounts: touched, placed };
}
