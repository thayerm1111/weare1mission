import { createAdminClient } from "@/lib/supabase/admin";
import { flowDecision } from "@/lib/flow/decision";
import { placeOnActiveAccounts, placeFixedLotFollower } from "@/lib/flow/executor";
import { activeAccounts, connectionToken, type ActiveAccount } from "@/lib/flow/connection";
import { listAccounts, listPositions, type TLEnv } from "@/lib/flow/tradelocker";
import { sizeFromRisk, floorStop } from "@/lib/flow/sizing";
import { flowConfirm } from "@/lib/flowEngine";
import { getInstrument } from "@/lib/flow/instruments";
import { newsHold } from "@/lib/news/calendar";
import { series, livePrice } from "@/lib/marketData";
import { trendOfCloses, closedBars } from "@/lib/mtf";
import { sendTelegram } from "@/lib/telegram";
import { BE_DISPLAY_PIPS } from "@/lib/genx/goldRecord";
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

// WEEKEND-CLOSE ENTRY BLACKOUT (owner rule, 08-28): never open a NEW trade in the last
// 30 minutes before the Friday close (17:00 New York, DST-aware). A fill taken that late
// has no time to work, gets marked-to-market across the weekend gap, and often reopens
// Sunday straight into a stop. Open positions are still managed normally — this blocks
// fresh ENTRIES only. Applies to every automated path (GENX gold, followers, FLOW auto);
// nothing here touches manual plays.
export function inWeekendCloseWindow(d: Date = new Date()): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (get("weekday") !== "Fri") return false;
    const h = Number(get("hour")) % 24; // some ICU builds report midnight as "24"
    const m = Number(get("minute"));
    return h > 16 || (h === 16 && m >= 30); // 4:30pm NY → the 5pm close (and past it)
  } catch {
    // Intl unavailable → UTC approximation of the same window (22:00 UTC close).
    return d.getUTCDay() === 5 && (d.getUTCHours() > 21 || (d.getUTCHours() === 21 && d.getUTCMinutes() >= 30));
  }
}

/**
 * Decide whether an armed member may run THIS tick, billing the 30-min window
 * when it's due. Mutates flow_auto_settings.last_credit_at / credit_paused.
 * Returns false (skip placing for this member) when the market is closed or the
 * member is out of credits.
 */
async function meterAutoRun(admin: Admin, settings: AutoSettings): Promise<boolean> {
  if (!isMarketOpenNow()) return false; // never bill or place while closed
  if (inWeekendCloseWindow()) return false; // no new entries (or billing) in the last 30 min before Friday close
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

// ── HARD REWARD:RISK FLOOR (placement backstop) ──────────────────────────────
// Never fan a trade out to the desk when its TARGET is closer than its STOP — i.e. a
// reward:risk below this. Computed from the ACTUAL entry / stop / TP about to be sent (not the
// signal-time price), so a setup that got chased or filled into an inverted R:R — target already
// reached, stop parked far away — is rejected on EVERY account instead of placed and sized at
// full risk. This is the guard that was missing when a GBPUSD sell went out at ~0.16 R:R and
// stopped the whole desk out. It is NOT the broker-min-lot gate and NOT spread protection — it
// is purely "don't take a trade whose target is nearer than its stop". Lives only at the single
// placement chokepoint, so it touches nothing in sizing / mirror / management.
const MIN_PLACEMENT_RR = 1.2;
export function rewardRisk(entry: number | null, stop: number | null, tp: number | null): number | null {
  if (entry == null || stop == null || tp == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (!(risk > 0)) return null;
  return reward / risk;
}

// ── per-member guard context (shared by the ENTER_NOW and fast-watch paths) ──
type GuardCtx = {
  mode: Mode; symbols: string[]; maxLot: number; cooldownMs: number;
  now: number; events: AutoEvent[]; placed: AutoEvent[];
  hourBudget: number; openSymbols: Set<string>; maxOpen: number;
  // Risk-based sizing: each trade risks riskPct of EACH active account's own live
  // equity. `accounts` is every account the member toggled ON, across all their
  // connections — a placement fans out over all of them. Fetched once per cycle.
  riskPct: number; accounts: ActiveAccount[];
  // NOTE: safety mode (conservative/aggressive) is authoritative PER-ACCOUNT
  // (flow_broker_accounts.risk_mode → ActiveAccount.riskMode, consumed in
  // filterAccountsForAsset). There is intentionally NO member-level mode in the
  // decision path — a member sets it on each account — so there is a single source of truth.
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

// ── MIRROR: one active AUTOMATED trade per symbol, PER MEMBER ────────────────
// A member already IN an open AUTOMATED (FLOW/GENX) trade on a pair never stacks
// a second automated entry on that pair — they sit out until it closes. Manual
// trades ("play" from OM AI Plays, "test") never block a member's autotrading.
// This was previously enforced DESK-WIDE (any one member's open position blocked
// every other account), which froze the whole desk for hours whenever one member
// held a long-running trade or a personal play: on 08-27 two members' open gold
// sells blocked all other (flat) accounts from every GENX entry from 14:22 to
// past 23:30. Per-member + automated-only keeps the anti-stacking protection
// where it matters while letting flat accounts take new signals. Same-pass
// placements (<5 min, so all accounts still enter the SAME signal) are allowed.
//
// HOW ORIGIN IS RESOLVED: the executor stamps its `source` into the
// flow_auto_events "placed" row's reason — "auto" (FLOW scan), "genx" (GENX
// fan-out), "genx_follow" (followers) are automated; "play"/"test" are manual.
// A position with no placement event nearby (e.g. adopted by the recovery
// sweep) is treated as automated so anti-stacking stays safe.
const MIRROR_SAME_PASS_MS = 5 * 60_000;
const AUTO_REASON_RE = /^(auto|genx)/i;
async function userInActiveAutoTrade(admin: Admin, userId: string, symbol: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - MIRROR_SAME_PASS_MS).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("created_at")
      .eq("status", "open")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .lt("created_at", cutoff)
      .limit(5);
    const rows = (data ?? []) as { created_at: string }[];
    if (!rows.length) return false;
    for (const row of rows) {
      const t = new Date(row.created_at).getTime();
      if (!Number.isFinite(t)) return true; // unreadable timestamp → play it safe
      const { data: evs } = await admin
        .from("flow_auto_events")
        .select("reason")
        .eq("user_id", userId)
        .eq("symbol", symbol)
        .eq("status", "placed")
        .gte("created_at", new Date(t - 3 * 60_000).toISOString())
        .lte("created_at", new Date(t + 60_000).toISOString())
        .limit(10);
      const reasons = ((evs ?? []) as { reason?: string | null }[]).map((e) => String(e.reason ?? ""));
      // No event → can't prove manual → treat as automated. Any auto-source
      // placement in the window → automated. Only proven-manual skips the block.
      if (!reasons.length || reasons.some((r) => AUTO_REASON_RE.test(r))) return true;
    }
    return false;
  } catch { return false; } // never block placement on a guard read error
}

/** Apply the per-member guardrails and, if they pass, place ONE market order. Mutates ctx. */
// ── FOREX CIRCUIT BREAKER ────────────────────────────────────────────────────
// After this many consecutive LOSING forex signals (desk-wide — one count per signal even
// though it fanned out to many accounts), pause NEW forex entries for a cooldown so a bad
// run can't stack losses. Gold + indices are never affected, and a single forex WIN resets
// the streak. Fails OPEN — a read error never blocks trading.
const FOREX_BREAKER_STREAK = 3;
const FOREX_BREAKER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const FOREX_BREAKER_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"];

function isForexSymbol(symbol: string): boolean {
  try { return getInstrument(symbol)?.assetClass === "forex"; } catch { return false; }
}

// Collapse fan-out legs into distinct SIGNALS. A signal fans out across many accounts
// within seconds, but that burst can straddle a clock-minute boundary — so bucketing by
// minute would count ONE trade as two. Instead we group by symbol+side and cluster legs
// whose OPEN times fall within SIGNAL_CLUSTER_MS of each other. A signal WINS if any leg
// won; only an all-stop cluster is a loss. Entry cooldowns keep genuinely distinct signals
// far more than this window apart, so real back-to-back losses are never merged.
const SIGNAL_CLUSTER_MS = 180_000; // 3 min — wider than any fan-out, tighter than entry cooldowns
type SigRow = { symbol?: string | null; side: string; outcome: string; created_at: string; resolved_at: string | null };
function collapseSignals(rows: SigRow[]): { closedAt: number; win: boolean }[] {
  const groups = new Map<string, { openAt: number; closedAt: number; win: boolean }[]>();
  for (const r of rows) {
    const openAt = new Date(r.created_at).getTime();
    if (!Number.isFinite(openAt)) continue;
    const key = `${r.symbol ?? ""}|${r.side}`;
    const closedAt = r.resolved_at ? new Date(r.resolved_at).getTime() : openAt;
    const arr = groups.get(key) ?? [];
    arr.push({ openAt, closedAt, win: r.outcome !== "stop" });
    groups.set(key, arr);
  }
  const signals: { closedAt: number; win: boolean }[] = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => b.openAt - a.openAt); // newest open first
    let cur: { anchor: number; closedAt: number; win: boolean } | null = null;
    for (const l of arr) {
      if (cur && Math.abs(l.openAt - cur.anchor) <= SIGNAL_CLUSTER_MS) {
        cur.win = cur.win || l.win;
        cur.closedAt = Math.max(cur.closedAt, l.closedAt);
        cur.anchor = Math.min(cur.anchor, l.openAt);
      } else {
        if (cur) signals.push({ closedAt: cur.closedAt, win: cur.win });
        cur = { anchor: l.openAt, closedAt: l.closedAt, win: l.win };
      }
    }
    if (cur) signals.push({ closedAt: cur.closedAt, win: cur.win });
  }
  return signals.sort((a, b) => b.closedAt - a.closedAt); // newest close first, for streak counting
}

/**
 * Consecutive-loss streak from the most recent CLOSED signals, per the conservative rule.
 * Only a broker-confirmed 'stop' is a LOSS; every other outcome — a win / target / trail, a
 * true break-even, or a MANUAL close — BREAKS the streak. So LOSS→LOSS reaches two-in-a-row
 * (cooldown), while LOSS→WIN→LOSS, LOSS→BE→LOSS and LOSS→MANUAL→LOSS never do. Pure + tested.
 */
export function consecutiveLossStreak(rows: SigRow[]): { streak: number; lastClosedAt: number } {
  const signals = collapseSignals(rows);
  if (!signals.length) return { streak: 0, lastClosedAt: 0 };
  let streak = 0;
  for (const s of signals) { if (s.win) break; streak += 1; }
  return { streak, lastClosedAt: signals[0].closedAt };
}

async function forexBreakerHalt(admin: Admin): Promise<{ halt: boolean; streak: number; until?: string }> {
  try {
    const sinceIso = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("symbol, side, outcome, created_at, resolved_at")
      .in("symbol", FOREX_BREAKER_SYMBOLS)
      .eq("status", "closed")
      .not("outcome", "is", null)
      .gte("created_at", sinceIso)
      .order("resolved_at", { ascending: false })
      .limit(500);
    const rows = (data ?? []) as SigRow[];
    if (!rows.length) return { halt: false, streak: 0 };
    const signals = collapseSignals(rows); // cluster fan-out legs → distinct signals (see helper)
    if (!signals.length) return { halt: false, streak: 0 };
    let streak = 0;
    for (const s of signals) { if (s.win) break; streak += 1; }
    if (streak >= FOREX_BREAKER_STREAK) {
      const until = signals[0].closedAt + FOREX_BREAKER_COOLDOWN_MS; // cooldown from the latest loss
      if (Date.now() < until) return { halt: true, streak, until: new Date(until).toISOString() };
    }
    return { halt: false, streak };
  } catch {
    return { halt: false, streak: 0 }; // fail open — never block trading on a read error
  }
}

// ── PER-MEMBER RISK MODE (Aggressive / Conservative) ──────────────────────────
// Each member picks their OWN protection. CONSERVATIVE (the default) is a hard
// personal breaker: after 2 losing trades IN A ROW on an asset class, it pauses
// that asset class for 4h — GOLD and FOREX are tracked SEPARATELY, so a bad gold
// run never touches forex and vice-versa. AGGRESSIVE removes the per-member cap
// (desk-wide guards like the forex breaker + gold trend gate still apply to both).
// A single win resets the streak. Fails OPEN — a read error never blocks trading.
const MEMBER_BREAKER_STREAK = 2;
const MEMBER_BREAKER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const GOLD_SYMS = ["XAUUSD", "GOLD"];

type MemberAsset = "gold" | "forex";
function memberAssetOf(symbol: string): MemberAsset | null {
  const s = symbol.toUpperCase();
  if (GOLD_SYMS.includes(s)) return "gold";
  if (isForexSymbol(s) || FOREX_BREAKER_SYMBOLS.includes(s)) return "forex";
  return null; // indices etc. are not covered by the per-member toggle
}
/** Default is CONSERVATIVE — only an explicit 'aggressive' opts out of the cap. */
function isConservative(mode: unknown): boolean {
  return String(mode ?? "conservative").toLowerCase() !== "aggressive";
}

/** Per-ACCOUNT consecutive-loss cutoff for ONE asset class (gold or forex). Fails open. */
async function accountAssetCutoff(admin: Admin, accountId: string, asset: MemberAsset): Promise<{ halt: boolean; streak: number }> {
  try {
    const symbols = asset === "gold" ? GOLD_SYMS : FOREX_BREAKER_SYMBOLS;
    // Look back at recently CLOSED trades by RESOLVE time (not open time) — so a loss on a
    // longer-held position is counted even if it opened >12h ago. Broker-confirmed only:
    // status closed + a non-null outcome (never a rejected/cancelled/duplicate order).
    const sinceIso = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("symbol, side, outcome, created_at, resolved_at")
      .eq("account_id", accountId)
      .in("symbol", symbols)
      .eq("status", "closed")
      .not("outcome", "is", null)
      .gte("resolved_at", sinceIso)
      .order("resolved_at", { ascending: false })
      .limit(200);
    const rows = (data ?? []) as SigRow[];
    const { streak, lastClosedAt } = consecutiveLossStreak(rows);
    if (streak >= MEMBER_BREAKER_STREAK && Date.now() < lastClosedAt + MEMBER_BREAKER_COOLDOWN_MS) {
      return { halt: true, streak };
    }
    return { halt: false, streak };
  } catch {
    return { halt: false, streak: 0 }; // fail open
  }
}

/** Drop CONSERVATIVE accounts that are in a loss-cutoff for this symbol's asset class.
 *  Aggressive accounts, and symbols that aren't gold/forex, pass through untouched. */
async function filterAccountsForAsset(admin: Admin, accounts: ActiveAccount[], symbol: string): Promise<ActiveAccount[]> {
  const asset = memberAssetOf(symbol);
  if (!asset || !accounts.length) return accounts;
  const keep: ActiveAccount[] = [];
  for (const a of accounts) {
    if (!isConservative(a.riskMode)) { keep.push(a); continue; } // aggressive → no cap
    const cut = await accountAssetCutoff(admin, a.accountId, asset);
    if (!cut.halt) keep.push(a);
  }
  return keep;
}

// ── GLOBAL KILL SWITCH (admin) ────────────────────────────────────────────────
// The owner can pause FLOW and/or GENX for EVERYONE from the admin panel (e.g. to
// fix something). Reads the single flow_switches row; fails OPEN (both ON) so a DB
// blip never silently halts trading.
async function systemSwitches(admin: Admin): Promise<{ flow: boolean; genx: boolean }> {
  try {
    const { data } = await admin.from("flow_switches").select("flow_enabled, genx_enabled").eq("id", 1).maybeSingle();
    const r = data as { flow_enabled?: boolean | null; genx_enabled?: boolean | null } | null;
    return { flow: r?.flow_enabled !== false, genx: r?.genx_enabled !== false };
  } catch {
    return { flow: true, genx: true };
  }
}

async function guardAndPlace(admin: Admin, settings: AutoSettings, ctx: GuardCtx, symbol: string, side: "buy" | "sell", levels: Levels, price?: number | null): Promise<SymbolResult> {
  const ms = (iso: string) => ctx.now - new Date(iso).getTime();
  if (!ctx.symbols.includes(symbol)) return { symbol, action: "not_in_list" };
  const lastPlaced = ctx.placed.find((p) => String(p.symbol).toUpperCase() === symbol);
  if (lastPlaced && ms(lastPlaced.created_at) < ctx.cooldownMs) return { symbol, action: "cooldown" };
  const lastErr = ctx.events.find((e) => e.status === "error" && String(e.symbol).toUpperCase() === symbol);
  if (lastErr && ms(lastErr.created_at) < ERROR_BACKOFF_MS) return { symbol, action: "error_backoff" };
  if (ctx.hourBudget <= 0) return { symbol, action: "hour_cap" };
  if (!ctx.openSymbols.has(symbol) && ctx.openSymbols.size >= ctx.maxOpen) return { symbol, action: "max_open" };

  // FOREX CIRCUIT BREAKER — after a run of losing forex signals, sit forex out for the
  // cooldown so a bad patch doesn't stack losses. Gold + indices are never gated here.
  if (isForexSymbol(symbol)) {
    const brk = await forexBreakerHalt(admin);
    if (brk.halt) return { symbol, action: "forex_cooldown", detail: `${brk.streak} losses in a row` };
  }

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

  // REWARD:RISK FLOOR — reject a trade whose target is closer than its stop before it ever
  // reaches an account. Uses the entry/stop/TP about to be sent, so a chased/inverted setup
  // (the GBPUSD ~0.16 R:R that stopped the desk out) is skipped desk-wide. A setup with no TP
  // (rr == null) is not blocked here — the stop still protects it.
  const rrAtPlacement = rewardRisk(entryPx, stopPx, levels.tp1);
  if (rrAtPlacement != null && rrAtPlacement < MIN_PLACEMENT_RR) {
    return { symbol, action: "skip_bad_rr", side, detail: `R:R ${rrAtPlacement.toFixed(2)} < ${MIN_PLACEMENT_RR}` };
  }

  // NEWS GUARD (falling-knife): if a HIGH-impact event for this pair's currency is
  // inside the blackout window (about to drop or just dropped), HOLD — don't buy blind
  // into the volatility spike. The desk resumes automatically once the window passes.
  try { if ((await newsHold(symbol)).hold) return { symbol, action: "news_hold" }; } catch { /* feed down → don't block trading */ }

  // MIRROR (per member, automated-only): if THIS member is already in an open
  // AUTOMATED trade on this pair from an earlier signal, they sit out — never a
  // later, divergent automated entry on top. Manual plays don't block, and other
  // (flat) members are unaffected.
  if (await userInActiveAutoTrade(admin, settings.user_id, symbol)) return { symbol, action: "mirror_wait" };

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

  // PER-ACCOUNT SAFETY MODE: drop this member's accounts that are conservative AND in a
  // loss-cutoff for this symbol's asset (aggressive accounts pass). If none survive, the
  // claim was taken above — release it so a later tick/account can still enter.
  const acctsForSymbol = await filterAccountsForAsset(admin, ctx.accounts, symbol);
  if (!acctsForSymbol.length) {
    try { await admin.rpc("flow_release_claim", { p_user: settings.user_id, p_symbol: symbol }); } catch { /* best-effort */ }
    return { symbol, action: "safety_cooldown", detail: "all eligible accounts paused (2 losses in a row)" };
  }

  // Fan out: place the SAME setup on every eligible account, each risk-sized to its
  // own live equity (gold<$500 floors to 0.01 inside placeOnActiveAccounts).
  const res = await placeOnActiveAccounts({
    userId: settings.user_id, symbol, side, entry: entryPx, stop: stopPx, tp: levels.tp1,
    riskPct: ctx.riskPct, source: "auto", accounts: acctsForSymbol,
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
  if (!(await systemSwitches(admin)).flow) return { users: 0, runs: [], watching: [] }; // admin FLOW kill switch
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
  if (!(await systemSwitches(admin)).flow) return { watched: 0, confirmed: [], runs: [], states: [] }; // admin FLOW kill switch
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
// Placement is free, same as any FLOW fill. The ONE-open-gold-trade-per-account rule is
// enforced by a BROKER-VERIFIED open-position check (only a GENX/FLOW gold the broker
// confirms is still open blocks a new one) — NOT by a time throttle. GOLD_CLAIM_SEC below is only a short
// idempotency window that dedupes the SAME ENTER NOW across the overlapping scanner runs
// (1-min cron + 30s fast-watch). Once a position CLOSES, the account takes the next signal
// immediately — the only cap is "max one OPEN at a time".
const GOLD_CLAIM_SEC = 90;

// How many members' fan-out legs run CONCURRENTLY when a gold signal places. The desk grew to
// ~57 autotrade members and the old one-at-a-time loop (several broker calls each) ran past the
// scanner's time budget, so most members silently missed every signal. A modest cap places every
// member within a few seconds while staying well under TradeLocker's per-connection rate limits
// (the executor already caches instruments per connection and retries on 429).
const FANOUT_CONCURRENCY = 8;

/** Run `fn` over `items` with a bounded number in flight at once, preserving result order.
 *  Single-threaded JS: the shared cursor is incremented synchronously, so no two workers ever
 *  take the same index. This is what lets a gold signal reach ALL members inside the function's
 *  time budget instead of timing out partway through a long sequential loop. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// CHASE GUARD floor — the MINIMUM reward:risk, measured at the LIVE price, for a gold ENTER
// NOW to be placed at all. Gold fills at MARKET, so if price has already run toward TP by the
// time the fill lands, the reward:risk collapses (e.g. filled ~4666 on a 4655 signal: +2 to
// TP, −14 to SL ≈ 0.15 R:R). We reject any such entry desk-wide.
//
// Set to 0.65 — the owner's floor (08-28): "I don't want it to enter unless it's at least a
// 1 to .65." The scanner still PREFERS a full 1:1: it holds a chased entry (R:R below this
// floor) as 'forming' for a short retrace window and fills the moment price traces back to a
// takeable R:R (see GOLD_RETRY_WINDOW_MS in the scanner); only a fill still under the floor
// after the window is skipped. Combined with sizing off the live entry, the dollar risk is
// still capped at the member's risk %.
const GOLD_MIN_PLACEMENT_RR = 0.65;

/** Does a recorded GENX/FLOW gold position still count as OPEN for the "max one" cap? TRUE
 *  only when the broker's live open set actually contains one of this account's ledger gold
 *  ids. brokerOpen === null (broker unreadable) → FALSE, so we DON'T block and DON'T miss the
 *  trade. Empty ledger → FALSE. Manual trades are never in the ledger, so they never reach
 *  here. Pure + unit-tested. */
export function genxGoldStillOpen(ledgerPids: Iterable<string>, brokerOpen: Set<string> | null): boolean {
  if (!brokerOpen) return false;
  for (const pid of ledgerPids) if (brokerOpen.has(pid)) return true;
  return false;
}

/** Manual gold placements ("play" from OM AI Plays, "test") in the recent window, keyed by
 *  account + placement time. The executor stamps its `source` into the flow_auto_events
 *  "placed" reason, and manual placements insert the SAME flow_managed_positions rows as
 *  automated ones — so the one-open cap uses this to drop manual rows: the owner's rule is
 *  that only an AUTOMATED (GENX/FLOW) open trade blocks the next automated entry. */
const MANUAL_REASON_RE = /^(play|test)/i;
async function manualGoldPlacements(admin: Admin): Promise<{ acct: string; ts: number }[]> {
  try {
    const sinceIso = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data } = await admin.from("flow_auto_events")
      .select("account_id, reason, created_at")
      .eq("symbol", "XAUUSD").eq("status", "placed")
      .gte("created_at", sinceIso).limit(2000);
    return ((data ?? []) as { account_id: string | null; reason: string | null; created_at: string }[])
      .filter((e) => MANUAL_REASON_RE.test(String(e.reason ?? "")))
      .map((e) => ({ acct: String(e.account_id ?? ""), ts: new Date(e.created_at).getTime() }))
      .filter((e) => !!e.acct && Number.isFinite(e.ts));
  } catch { return []; } // unreadable events → treat nothing as manual (cap stays safe)
}
function isManualGoldRow(manuals: { acct: string; ts: number }[], acct: string, createdAt: string): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return manuals.some((m) => m.acct === acct && Math.abs(m.ts - t) < 3 * 60_000);
}

/** Live OPEN position ids on the BROKER for one account (TradeLocker). Returns null when the
 *  broker can't be read — callers treat null as "can't confirm", and (per the owner's "don't
 *  miss trades" rule) fall through to TAKING the trade rather than blocking on a failed read.
 *  This is the source of truth for whether a recorded GENX/FLOW gold trade is ACTUALLY still
 *  open, so a stale ledger row can never cause a missed entry. */
async function brokerOpenPosIds(a: { env: TLEnv; token: string; accNum: string; accountId: string }): Promise<Set<string> | null> {
  try {
    const pos = await listPositions(a.env, a.token, a.accNum, a.accountId);
    if (!pos.ok) return null;
    const idOf = (p: unknown): string =>
      Array.isArray(p) ? (p.length ? String(p[0]) : "")
      : (p && typeof p === "object" ? String((p as Record<string, unknown>).id ?? (p as Record<string, unknown>).positionId ?? (p as Record<string, unknown>).positionID ?? "") : "");
    return new Set((pos.data as unknown[]).map(idOf).filter(Boolean));
  } catch { return null; }
}

/** Current gold price for the chase check (own key, like goldTrend). null on any failure. */
async function goldLivePrice(): Promise<number | null> {
  try {
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const p = await livePrice("XAU/USD", key, true);
    return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** True when price has already run so far toward TP that the R:R at the LIVE fill price is
 *  below the floor (or price is already at/through TP) — a chased entry that should be
 *  skipped desk-wide. FAILS OPEN (returns false) when the feed is down, so a feed blip never
 *  halts gold entirely; the trade still carries its protective stop either way. */
function goldChasedAt(side: "buy" | "sell", stop: number | null, tp: number | null, lp: number | null): boolean {
  if (stop == null || tp == null || lp == null) return false; // feed down / no levels → don't block
  if (side === "buy" && lp >= tp) return true;   // already at/through target — no reward left
  if (side === "sell" && lp <= tp) return true;
  const rr = rewardRisk(lp, stop, tp);
  return rr != null && rr < GOLD_MIN_PLACEMENT_RR;
}

// SMART, TREND-AWARE GOLD ENTRY GATE.
// GENX still makes the call; this layer only steps aside when GENX would be FIGHTING the
// trend and stacking losses. It reads the higher-timeframe (1h) gold trend and applies a
// graduated per-side loss guard:
//   • WITH the trend  → take it freely (loose 3-loss safety net in case a trend reverses).
//   • COUNTER-trend   → allow ONE pullback shot; pause that side after a single loss.
//   • Ranging/unknown → normal read; pause a side after 2 losses in a row.
// A paused side self-resets after the cooldown (takes one probe; a win clears the streak).
const GOLD_LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // OWNER RULE 1: ~2h pause on a side after ONE real stop-out
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

// Lead/owner user id — used only as a stable marker on the desk-wide halt breadcrumb
// written to flow_auto_events (the pause is desk-wide, so it has no single member).
const GOLD_HALT_MARKER_UID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";

/** LAYER 1 — the signal-grade loss streak. Counts how many of the most recent DISTINCT
 *  genx_signals on this side lost in a row, and whether that streak (a) meets the threshold
 *  and (b) is still inside the cooldown window. This is the "the system is calculating
 *  losses" read the owner wanted to KEEP — but on its own it no longer halts anything. */
async function goldSignalLossStreak(admin: Admin, side: "buy" | "sell", streak: number): Promise<{ hit: boolean; count: number }> {
  if (streak <= 0) return { hit: false, count: 0 };
  const wantDir = side === "buy" ? "bullish" : "bearish";
  const { data } = await admin
    .from("genx_signals")
    .select("outcome, resolved_at, mfe_pips")
    .in("outcome", ["WIN", "LOSS"])
    .eq("direction", wantDir)
    .order("resolved_at", { ascending: false, nullsFirst: false })
    .limit(30);
  const rows = (data ?? []) as { outcome: string; resolved_at: string | null; mfe_pips: number | null }[];
  // Collapse signals that resolved at the SAME instant (fan-out / one market event) into
  // a single outcome, newest first — so a "streak" counts distinct trades on this side.
  // A "LOSS" that ran ≥ BE_DISPLAY_PIPS into profit first is a BREAK-EVEN scratch, NOT a loss —
  // count it the SAME way the board and the account do (owner's rule), so the streak reflects
  // only GENUINE losing signals and never inflates off break-even-saved ones.
  const events: { outcome: string; ts: number }[] = [];
  let lastKey = "";
  for (const r of rows) {
    const k = String(r.resolved_at);
    if (k === lastKey) continue;
    lastKey = k;
    const isBreakEven = r.outcome === "LOSS" && Number(r.mfe_pips) >= BE_DISPLAY_PIPS;
    events.push({ outcome: isBreakEven ? "WIN" : r.outcome, ts: r.resolved_at ? new Date(r.resolved_at).getTime() : 0 });
  }
  // How many losses in a row from the newest signal (for the visibility note).
  let run = 0;
  for (const e of events) { if (e.outcome !== "LOSS") break; run += 1; }
  if (events.length < streak) return { hit: false, count: run };
  const recent = events.slice(0, streak);
  if (!recent.every((e) => e.outcome === "LOSS")) return { hit: false, count: run };
  const withinCooldown = Date.now() < recent[0].ts + GOLD_LOSS_COOLDOWN_MS;
  return { hit: withinCooldown, count: run };
}

// A "loss" smaller than this (in pips) is a BREAK-EVEN scratch — the broker still labels a
// stop-order exit "Stop loss" even when the stop was at entry and the trade only gave back
// slippage + fees. That is NOT a real losing trade and must not feed the halt.
const GOLD_REAL_LOSS_MIN_PIPS = 5;

// OWNER "better level" exception to the post-loss cooldown: a new same-side entry must be at least
// this many pips BEYOND where the last trade stopped out (a sell higher than the old stop, a buy
// lower than it) to count as a genuinely NEW liquidity area worth taking during the cooldown —
// otherwise it's revenge-trading the same failed level and stays blocked. Tunable.
const GOLD_BETTER_LEVEL_PIPS = 30; // ~$3 beyond the prior stop

/** LAYER 2 — a REAL account trade on this side actually LOST money. Reads flow_managed_positions
 *  (engine-placed gold only), this side, closed inside the cooldown window. A row counts as a
 *  real loss ONLY when BOTH: (a) NO partial was banked — a banked partial means the trade already
 *  took profit on the way (owner's case: partials + a break-even runner = a WIN), and (b) the net
 *  result is a MEANINGFUL loss, not a slippage/fee-sized break-even scratch that the broker still
 *  tags "Stop loss". So a scratch, a trailing-stop win, or a partial-and-scratch never pauses a
 *  side — only a genuine stop-out does. */
async function goldRealLossOnSide(admin: Admin, side: "buy" | "sell"): Promise<{ lost: boolean; whenMs: number; stopPx: number | null }> {
  try {
    const sinceIso = new Date(Date.now() - GOLD_LOSS_COOLDOWN_MS).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("resolved_at, result_pips, partial_taken, outcome, init_stop, account_id, created_at")
      .in("symbol", GOLD_SYMS)
      .eq("side", side)
      .eq("status", "closed")
      .eq("outcome", "stop")
      .neq("environment", "demo")   // OWNER RULE 1: only a REAL (live) stop-out cools the side — a demo/test loss never pauses live trading
      .gte("resolved_at", sinceIso)
      .order("resolved_at", { ascending: false })
      .limit(20);
    const rows = (data ?? []) as { resolved_at: string | null; result_pips: number | null; partial_taken: boolean | null; init_stop: number | null; account_id: string | null; created_at: string }[];
    // OWNER RULE: only an AUTOMATED (GENX/FLOW) trade's stop-out cools the desk. A member's
    // hand-clicked "play"/"test" stopping out is THEIR trade, not a desk read failing — it
    // must never pause every account's entries (live case 08-28: one member's $8-stop play
    // clipped at 02:32 froze all sells for the whole desk while the GENX trades never came
    // near their stops). Origin is resolved from the placement event, same as the one-open cap.
    const manuals = await manualGoldPlacements(admin);
    // Newest genuine AUTOMATED stop-out that lost real money (no partial banked + meaningful negative).
    const real = rows.find((r) =>
      !r.partial_taken &&
      Number(r.result_pips) <= -GOLD_REAL_LOSS_MIN_PIPS &&
      !isManualGoldRow(manuals, String(r.account_id ?? ""), r.created_at),
    );
    if (!real) return { lost: false, whenMs: 0, stopPx: null };
    return { lost: true, whenMs: real.resolved_at ? new Date(real.resolved_at).getTime() : Date.now(), stopPx: typeof real.init_stop === "number" ? real.init_stop : null };
  } catch {
    return { lost: false, whenMs: 0, stopPx: null }; // read error → treat as "no real loss" (don't halt on layer 2)
  }
}

// OWNER "RE-ANALYZE AFTER A WIN" RULE. After a full gold win on a side, pause NEW entries on
// that side for this long so the engine reads FRESH price action before re-entering — instead of
// instantly re-firing the same read at an extended price and giving the win straight back (the
// "sold the bottom of the range right after a TP and got stopped" case). Short by design: it
// blocks the immediate machine-gun re-entry but still lets a genuinely new setup develop. The
// opposite side is never touched. Tunable.
const GOLD_POST_WIN_REANALYZE_MS = 15 * 60 * 1000; // ~15 min re-analysis pause after a win

// PROTECT-THE-PROFITS (owner directive 08-31: "if there's been wins in a direction, be a little
// pickier on the next setup — don't give profits back to the market"). After a banked automated
// WIN on a side, the SAME side gets a HIGHER quality bar for a while: only a premium setup
// re-enters. Layered with the re-analyze pause above: 0–15 min after a win = full hold;
// 15–90 min = premium-only (live R:R ≥ 1:1 and engine confidence ≥ 68 when the signal has one).
const GOLD_WIN_PICKY_MS = 90 * 60 * 1000;  // how long the higher bar applies after a win
const GOLD_WIN_PICKY_RR = 1.0;             // live R:R must clear a full 1:1 (normal floor 0.65)
const GOLD_WIN_PICKY_CONF = 68;            // engine confidence must clear this when provided
// SAME-SETUP BREAK-EVEN ESCALATION (owner directive 08-31 v2): break-evens are judged per
// SETUP (zone), not as a blanket count. A zone that scratched once may be re-entered — but
// only at a genuinely BETTER price or on a premium read. A zone that scratched TWICE is done:
// the desk sits it out and waits for a NEW setup to form somewhere else.
const GOLD_SAME_SETUP_PIPS = 15;   // a new entry within this many pips of a scratched entry = the SAME setup
const GOLD_RETRY_BETTER_PIPS = 10; // a retry must improve the entry by ≥ this many pips (else it must be premium)

/** Entry prices of distinct automated break-even exits on this side within the window (live
 *  only). Rows from one fan-out (many accounts, same signal) are bucketed to ONE scratch by
 *  placement minute; each bucket contributes its entry price, which is what identifies the
 *  SETUP for the same-zone escalation. Manual plays never count. */
async function goldRecentBeEntries(admin: Admin, side: "buy" | "sell", windowMs: number): Promise<number[]> {
  try {
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("account_id, created_at, entry")
      .in("symbol", GOLD_SYMS)
      .eq("side", side)
      .eq("status", "closed")
      .eq("outcome", "breakeven")
      .neq("environment", "demo")
      .gte("resolved_at", sinceIso)
      .limit(60);
    const rows = (data ?? []) as { account_id: string | null; created_at: string; entry: number | null }[];
    const manuals = await manualGoldPlacements(admin);
    const buckets = new Map<string, number>(); // minute bucket → entry price
    for (const r of rows) {
      if (isManualGoldRow(manuals, String(r.account_id ?? ""), r.created_at)) continue; // manual plays never count
      if (r.entry == null || !(r.entry > 0)) continue;
      const key = String(r.created_at).slice(0, 16); // minute bucket ≈ one signal's fan-out
      if (!buckets.has(key)) buckets.set(key, r.entry);
    }
    return [...buckets.values()];
  } catch { return []; }
}

/** The per-setup break-even gate. Given where the NEW signal wants to enter, checks the
 *  scratched entries on this side: unrelated zones don't interfere (a NEW setup trades on
 *  normal rules); one scratch at this zone → retry allowed only at a better price or on a
 *  premium read; two scratches at this zone → sit the setup out entirely. */
async function goldBeSetupGate(
  admin: Admin, side: "buy" | "sell", newEntry: number | null,
  rrLive: number | null, confidence: number | null | undefined,
): Promise<{ block: boolean; kind?: "exhausted" | "retry"; detail?: string }> {
  if (newEntry == null || !(newEntry > 0)) return { block: false };
  const scratched = await goldRecentBeEntries(admin, side, GOLD_WIN_PICKY_MS);
  const near = scratched.filter((e) => Math.abs(e - newEntry) <= GOLD_SAME_SETUP_PIPS * 0.1);
  if (!near.length) return { block: false }; // a NEW setup — normal rules apply
  if (near.length >= 2) {
    return { block: true, kind: "exhausted", detail: `this zone already went to break-even ${near.length} times` };
  }
  // One scratch at this zone → the retry needs to EARN it: a better entry, or a premium read.
  const old = near[0];
  const betterByPips = (side === "sell" ? newEntry - old : old - newEntry) * 10; // pips the location improved
  if (betterByPips >= GOLD_RETRY_BETTER_PIPS) return { block: false }; // genuinely better level → take it
  const rrOk = rrLive == null ? true : rrLive >= GOLD_WIN_PICKY_RR;
  const confOk = confidence == null ? true : confidence >= GOLD_WIN_PICKY_CONF;
  if (rrOk && confOk) return { block: false }; // premium read → take it
  return {
    block: true, kind: "retry",
    detail: `same zone as the break-even scratch (entry ${betterByPips >= 0 ? "+" : ""}${betterByPips.toFixed(0)}p vs last try${rrLive != null ? `, R:R ${rrLive.toFixed(2)}` : ""}${confidence != null ? `, conf ${confidence}` : ""})`,
  };
}

/** A recent FULL WIN on this side (a hit target or a positive trailing-stop exit) within the
 *  given window (default: the short re-analysis window). Live trades only. Triggers the post-win
 *  pause and, over the longer window, the protect-the-profits quality bar. */
async function goldRecentWinOnSide(admin: Admin, side: "buy" | "sell", windowMs: number = GOLD_POST_WIN_REANALYZE_MS): Promise<{ won: boolean; whenMs: number }> {
  try {
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("resolved_at, result_pips, outcome, account_id, created_at")
      .in("symbol", GOLD_SYMS)
      .eq("side", side)
      .eq("status", "closed")
      .in("outcome", ["target", "trail"])   // a TP hit or a positive trailing-stop exit = a win
      .neq("environment", "demo")
      .gte("resolved_at", sinceIso)
      .order("resolved_at", { ascending: false })
      .limit(5);
    const rows = (data ?? []) as { resolved_at: string | null; result_pips: number | null; account_id: string | null; created_at: string }[];
    // Same origin rule as the loss cooldown: only an AUTOMATED trade's win triggers the
    // desk-wide re-analysis pause — a member's personal play banking a TP never holds the desk.
    const manuals = await manualGoldPlacements(admin);
    const win = rows.find((r) => Number(r.result_pips) > 0 && !isManualGoldRow(manuals, String(r.account_id ?? ""), r.created_at));
    if (!win) return { won: false, whenMs: 0 };
    return { won: true, whenMs: win.resolved_at ? new Date(win.resolved_at).getTime() : Date.now() };
  } catch {
    return { won: false, whenMs: 0 }; // read error → don't hold
  }
}

/** MARKET AWARENESS — the short-term direction gold is ACTUALLY moving right now, on closed
 *  15-min candles (latest close vs ~1.5h ago). "down"/"up" only when the move clears a small
 *  noise band; else "flat". null = couldn't read. Lets the gate SEE that the market is still
 *  falling/rising so it doesn't pause a side the market is currently proving right. */
async function goldShortMomentum(): Promise<"up" | "down" | "flat" | null> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  try {
    const rows = await series("XAU/USD", "15min", 12, key);
    if (!rows || rows === "ratelimit" || !Array.isArray(rows)) return null;
    const closed = closedBars(rows, 8) ?? rows;
    const closes = closed.map((r) => +r.close).filter((n) => Number.isFinite(n));
    if (closes.length < 4) return null;
    const last = closes[closes.length - 1];
    const back = closes[Math.max(0, closes.length - 6)]; // ~1.5h ago
    const band = Math.max(last * 0.0008, 1.5); // ~0.08% of price (≈$3.6 at 4500), min $1.5
    if (last <= back - band) return "down";
    if (last >= back + band) return "up";
    return "flat";
  } catch { return null; }
}

// CHANGE OF CHARACTER (structure break). A trend "changes character" when price reclaims the swing
// that preceded the leg's extreme: a HIGHER HIGH after a down-leg = bullish flip; a LOWER LOW after
// an up-leg = bearish flip. We use it to STOP taking a new entry that fights a fresh flip — no new
// SELL once a bullish change-of-character has printed, no new BUY once a bearish one has — so the
// desk quits selling into a confirmed reversal instead of following the lagging trend read down. A
// NORMAL pullback inside a trend does NOT reclaim the prior swing, so it is not treated as a flip;
// and the leg must clear CHOCH_MIN_USD so noise never trips it. Reads closed 5-min candles; null (no
// block) on any failure so a feed blip never halts trading.
const CHOCH_MIN_USD = 4.0; // FLOOR only — the live threshold is volatility-normalized below
async function goldChangeOfCharacter(): Promise<"bullish" | "bearish" | null> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  try {
    const raw = await series("XAU/USD", "5min", 60, key);
    if (!raw || raw === "ratelimit" || !Array.isArray(raw)) return null;
    const bars = (closedBars(raw, 30) ?? raw)
      .map((r) => ({ h: +r.high, l: +r.low, c: +r.close }))
      .filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
    if (bars.length < 8) return null;
    const lastClose = bars[bars.length - 1].c;
    let loIdx = 0, hiIdx = 0;
    for (let i = 1; i < bars.length; i++) { if (bars[i].l < bars[loIdx].l) loIdx = i; if (bars[i].h > bars[hiIdx].h) hiIdx = i; }
    // VOLATILITY-NORMALIZED structural threshold: a fixed $4 leg is chop in a wild
    // session and a huge move in tight overnight compression. The leg must clear
    // ~5× the recent 5-min bar range (clamped 2.5–8 USD) to count as a real flip.
    const tr14 = bars.slice(-15).map((b) => b.h - b.l).filter((v) => Number.isFinite(v) && v >= 0);
    const atr5 = tr14.length ? tr14.reduce((a, b) => a + b, 0) / tr14.length : 0;
    const legMin = Math.max(2.5, Math.min(8, atr5 > 0 ? atr5 * 5 : CHOCH_MIN_USD));
    if (bars[hiIdx].h - bars[loIdx].l < legMin) return null; // leg too small → no real reversal
    // Bullish: price bottomed FIRST (loIdx earlier), then rallied and the latest close reclaimed the
    // swing high that PRECEDED the low — a higher high vs the down-leg's structure.
    if (loIdx < hiIdx) {
      const priorHigh = Math.max(...bars.slice(0, loIdx + 1).map((b) => b.h));
      if (lastClose > priorHigh) return "bullish";
    }
    // Bearish: price topped FIRST, then sold off and the latest close broke the swing low that
    // preceded the high — a lower low vs the up-leg's structure.
    if (hiIdx < loIdx) {
      const priorLow = Math.min(...bars.slice(0, hiIdx + 1).map((b) => b.l));
      if (lastClose < priorLow) return "bearish";
    }
    return null;
  } catch { return null; }
}

/**
 * THE gold entry gate — OWNER RULE 1 (simple + predictable).
 *
 * A side pauses ONLY when a trade the desk ACTUALLY TOOK on that side hit its stop and lost real
 * money — a genuine stop-out, NOT a break-even scratch and NOT a ≤5-pip slippage exit. That single
 * real loss cools THAT DIRECTION for ~2h (GOLD_LOSS_COOLDOWN_MS) so a bad read can't stack losers.
 * Everything else is intentionally gone: no signal-grade streak, no 1h-trend model, no
 * market-direction guard — those over-paused a side (off break-evens / whipsaw signals) and cost
 * the desk real winners. The opposite side is never touched; a win / break-even / partial never
 * pauses anything; the pause self-clears the moment the cooldown elapses (or on the other side).
 * `goldRealLossOnSide` is the single source of truth for "a real stop-out" (outcome='stop', no
 * partial banked, result_pips <= -GOLD_REAL_LOSS_MIN_PIPS), and it only looks back
 * GOLD_LOSS_COOLDOWN_MS — so the lookback window and the cooldown are the same ~2h.
 */
async function goldEntryHold(admin: Admin, side: "buy" | "sell", newEntry?: number | null): Promise<{ hold: boolean; reason: string; scope?: "desk" | "conservative" }> {
  const dir = side === "sell" ? "SELL" : "BUY";

  // WEEKEND-CLOSE BLACKOUT — no new entries in the final 30 min before Friday's close.
  if (inWeekendCloseWindow()) {
    return {
      hold: true, scope: "desk",
      reason: `Weekend-close blackout: no new ${dir} entries in the final 30 minutes before Friday's close. Open positions keep being managed; fresh setups resume at the Sunday reopen.`,
    };
  }

  // RULE 1 — a real stop-out cools THIS side for ~2h so losers can't stack.
  const real = await goldRealLossOnSide(admin, side);
  if (real.lost && Date.now() < real.whenMs + GOLD_LOSS_COOLDOWN_MS) {
    // BETTER-LEVEL EXCEPTION (owner): the cooldown blocks re-selling the SAME level that just
    // failed — but if price has since run PAST where the last trade stopped out and the engine now
    // calls a fresh entry at a genuinely BETTER level (a NEW higher resistance for a sell / lower
    // support for a buy, clear of the old stop by GOLD_BETTER_LEVEL_PIPS), that is new liquidity,
    // not a revenge trade, so we allow it. The change-of-character guard below still blocks it if
    // structure has actually flipped, so this can't turn into selling a confirmed reversal.
    const betterLevel = newEntry != null && real.stopPx != null && (
      side === "sell" ? newEntry >= real.stopPx + GOLD_BETTER_LEVEL_PIPS * 0.1
                      : newEntry <= real.stopPx - GOLD_BETTER_LEVEL_PIPS * 0.1
    );
    if (!betterLevel) {
      const mins = Math.max(1, Math.round((real.whenMs + GOLD_LOSS_COOLDOWN_MS - Date.now()) / 60000));
      return {
        hold: true, scope: "desk",
        reason: `Pausing ${dir} gold ~${mins} min: a real ${side} trade just hit its stop and lost money (a genuine stop-out — not a break-even or ≤${GOLD_REAL_LOSS_MIN_PIPS}-pip scratch). Cooling this direction so losers don't stack. Resumes after the cooldown, on a better-located level, a win, or a ${side === "sell" ? "BUY" : "SELL"} setup.`,
      };
    }
    // else: a fresh, better-located ${dir} at new liquidity — fall through and let it trade.
  }

  // RE-ANALYZE AFTER A WIN — after a full win on this side, pause new same-side entries briefly
  // so the engine re-reads fresh price before re-entering, instead of instantly re-firing the same
  // read at an extended price and giving the win back (owner's directive).
  const win = await goldRecentWinOnSide(admin, side);
  if (win.won && Date.now() < win.whenMs + GOLD_POST_WIN_REANALYZE_MS) {
    const mins = Math.max(1, Math.round((win.whenMs + GOLD_POST_WIN_REANALYZE_MS - Date.now()) / 60000));
    return {
      hold: true, scope: "desk",
      reason: `Re-analyzing after a ${dir} win — holding new ${dir} gold entries ~${mins} min so the engine reads fresh price before re-entering (instead of re-selling straight into a bounce right after banking the win). Resumes once the market re-develops or on the opposite side.`,
    };
  }

  // CHANGE OF CHARACTER — don't take a NEW entry that fights a fresh structure flip. Once gold has
  // reclaimed the swing it fell from (bullish flip), stop taking sells; once it breaks the swing it
  // rose from (bearish flip), stop taking buys. This is what keeps it from continuing to sell a
  // confirmed reversal (the exact case: caught the down-move, then kept selling as price turned up).
  const choch = await goldChangeOfCharacter();
  if ((side === "sell" && choch === "bullish") || (side === "buy" && choch === "bearish")) {
    // MODE SPLIT: an unconfirmed flip against the entry is a CONSERVATIVE hold, not
    // a desk hold. Conservative waits for the reclaim to confirm; AGGRESSIVE is
    // allowed the earlier sweep-reversal entry (its defined role) — with the same
    // stop, sizing, and all desk-wide guards (Rule-1 cooldown, post-win, news,
    // chase floor) still applying to it.
    return {
      hold: true, scope: "conservative",
      reason: `Change of character: gold structure just flipped ${choch} (a ${choch === "bullish" ? "higher high — price reclaimed the level it fell from" : "lower low — price broke the level it rose from"}). Conservative accounts wait for confirmation; aggressive accounts may take the early reversal entry.`,
    };
  }

  return { hold: false, reason: "" };
}
// NOTE: goldTrend / goldSignalLossStreak / goldShortMomentum / GOLD_STREAK_* remain defined below
// but are no longer part of the entry gate after the Rule-1 simplification (kept for reference /
// possible future use; they make no API calls unless invoked).

/**
 * RESTING-LIMIT ENTRY PRICE — where to sit a limit order so it fills at the CALLED zone
 * instead of chasing to a bad market price. We rest at the zone edge CLOSEST to where price
 * currently is, so it fills the moment price returns to the zone (max fill-probability while
 * still an in-zone, full-R:R price):
 *   • sell  → the LOWER edge (a sell-limit fills at its price or higher → fills as price rises back up)
 *   • buy   → the UPPER edge (a buy-limit fills at its price or lower  → fills as price dips back down)
 * Pure + unit-tested. Returns null if the zone is unusable.
 */
export function genxLimitPrice(side: "buy" | "sell", entryLow: number | null, entryHigh: number | null): number | null {
  const num = (v: number | null): number => (v == null ? NaN : Number(v)); // Number(null)===0, so guard nulls first
  const lo = num(entryLow), hi = num(entryHigh);
  const loOk = Number.isFinite(lo), hiOk = Number.isFinite(hi);
  if (!loOk && !hiOk) return null;
  const a = loOk ? lo : hi, b = hiOk ? hi : lo;
  const zLo = Math.min(a, b), zHi = Math.max(a, b);
  return side === "sell" ? zLo : zHi;
}

export type GoldRoute = "copy" | "follower" | "none";
/**
 * THE single routing rule for a gold signal, so the two placement paths can never
 * disagree about which accounts they own:
 *   - autotrade_enabled → "copy"     (risk-sized fill via placeGenxGold)
 *   - else genx_follower → "follower" (fill via placeGenxFollower)
 *   - else               → "none"     (opted out — left alone)
 * Exactly ONE route per account. autotrade wins over follower so an account that has
 * BOTH toggles takes the copy fill only (never both). Union of copy+follower = every
 * opted-in account, covered once, with no gap and no double-fill. Pure + unit-tested.
 */
export function goldRoute(acc: { autotrade_enabled?: boolean | null; genx_follower?: boolean | null }): GoldRoute {
  if (acc.autotrade_enabled === true) return "copy";
  if (acc.genx_follower === true) return "follower";
  return "none";
}

export async function placeGenxGold(sig: { side: "buy" | "sell"; entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null; conservativeOk?: boolean; confidence?: number | null }): Promise<{ members: number; placed: number }> {
  const admin = createAdminClient();
  if (!admin) return { members: 0, placed: 0 };
  if (!(await systemSwitches(admin)).genx) return { members: 0, placed: 0 }; // admin GENX kill switch
  const entry = (sig.entryLow != null && sig.entryHigh != null) ? (sig.entryLow + sig.entryHigh) / 2 : (sig.entryLow ?? sig.entryHigh);
  if (entry == null || sig.stop == null) return { members: 0, placed: 0 };

  // GENX is the single gold authority: the admin genx switch (checked above) is the ONE
  // global gate. We deliberately do NOT gate the whole userbase on the lead account's
  // personal symbol toggle any more — that was a single point of failure that could
  // silently stop gold for EVERY account if the lead's own gold toggle was off.

  // MAX ONE OPEN GENX/FLOW GOLD PER ACCOUNT — candidates from the ledger, CONFIRMED on the
  // broker below. We map each account to its ledger-"open" gold position ids; before
  // blocking an account we check TradeLocker to see if any of those are ACTUALLY still
  // open (a stale row the broker already closed must NOT block, or the account misses the
  // next signal). Per-account, so no account can freeze another.
  //
  // OWNER RULE: only an AUTOMATED (GENX/FLOW) open trade counts toward the cap. The ledger
  // also holds member-clicked "play"/"test" placements (they insert the same rows), so we
  // drop any row whose placement event was manual before it can occupy the cap.
  const { data: openGoldRows } = await admin.from("flow_managed_positions").select("account_id, position_id, created_at").eq("status", "open").eq("symbol", "XAUUSD");
  const manualGold = await manualGoldPlacements(admin);
  const ledgerGoldByAcct = new Map<string, Set<string>>();
  for (const r of ((openGoldRows ?? []) as { account_id: string | null; position_id: string | null; created_at: string }[])) {
    const aid = String(r.account_id ?? ""); const pid = String(r.position_id ?? "");
    if (!aid || !pid) continue;
    if (isManualGoldRow(manualGold, aid, r.created_at)) continue; // manual play/test → never blocks
    if (!ledgerGoldByAcct.has(aid)) ledgerGoldByAcct.set(aid, new Set());
    ledgerGoldByAcct.get(aid)!.add(pid);
  }

  // A desk-wide breadcrumb for the guards that have no single member — so a "no trade" is NEVER
  // silent: every drop leaves a row in flow_auto_events explaining exactly why.
  const deskDrop = async (reason: string): Promise<void> => {
    try { await admin.from("flow_auto_events").insert({ user_id: GOLD_HALT_MARKER_UID, symbol: "XAUUSD", side: sig.side, status: "skipped", reason: `genx: ${reason}` }); } catch { /* breadcrumb best-effort */ }
  };

  // NEWS GUARD (falling-knife): gold reacts to USD data — if a HIGH-impact USD event is
  // inside the blackout window, hold this ENTER NOW. GENX will re-offer once it passes.
  try { if ((await newsHold("XAUUSD")).hold) { await deskDrop(`news_blackout ${sig.side}`); return { members: 0, placed: 0 }; } } catch { /* feed down → don't block */ }

  // OWNER RULE 1 HALT (see goldEntryHold): a side pauses ONLY after a real stop-out on that side
  // within the ~2h cooldown. A pause is VISIBLE: it posts a Telegram note ("why it didn't enter")
  // and logs a breadcrumb, instead of silently dropping.
  let conservativeHold = false; // choch conflict: conservative sits out, aggressive takes the early reversal
  try {
    const gate = await goldEntryHold(admin, sig.side, entry);
    if (gate.hold && gate.scope === "conservative") {
      conservativeHold = true;
      try { await sendTelegram(`⏸️ <b>GENX gold — conservative accounts held</b>\n${gate.reason}`); } catch { /* note best-effort */ }
      try { await admin.from("flow_auto_events").insert({ user_id: GOLD_HALT_MARKER_UID, symbol: "XAUUSD", side: sig.side, status: "skipped", reason: `genx: choch_conservative_hold ${sig.side} (aggressive proceeding)` }); } catch { /* breadcrumb best-effort */ }
    } else if (gate.hold) {
      try { await sendTelegram(`⏸️ <b>GENX gold — entry paused</b>\n${gate.reason}`); } catch { /* note best-effort */ }
      await deskDrop(`gold_halt ${sig.side}`);
      return { members: 0, placed: 0 };
    }
  } catch { /* read error → don't block */ }

  // Live gold price, fetched ONCE. Used for BOTH the chase guard AND position sizing.
  let goldLp: number | null = null;
  try { goldLp = await goldLivePrice(); } catch { goldLp = null; }

  // CHASE GUARD (desk-wide): if price has already run toward TP so the live-price R:R is below the
  // 0.5 floor, this ENTER NOW is chased — skip it for everyone rather than fill a tiny-TP / huge-SL
  // trade. (Owner rule 2: a sub-0.5 fill is never chased; the scanner arms it for a 5-min pullback.)
  if (goldChasedAt(sig.side, sig.stop, sig.tp, goldLp)) {
    const rr = rewardRisk(goldLp, sig.stop, sig.tp);
    await deskDrop(`chased_below_${GOLD_MIN_PLACEMENT_RR}RR${rr != null ? ` (rr ${rr.toFixed(2)})` : ""} ${sig.side}`);
    return { members: 0, placed: 0 };
  }

  // SELECTIVITY GATES (owner directives 08-31):
  //   1. SAME-SETUP BE ESCALATION — a zone that scratched to break-even once may be retried
  //      only at a better price or on a premium read; a zone that scratched twice is DONE
  //      (sit out, wait for a new setup to form). Unrelated zones trade on normal rules.
  //   2. PROTECT THE PROFITS — after a banked win on this side, only a premium same-side
  //      setup (live R:R ≥ 1:1, confidence ≥ 68 when carried) re-enters for a while.
  // The opposite side is untouched, and a genuinely premium setup still fires immediately.
  try {
    const rrLive = rewardRisk(goldLp != null ? goldLp : entry, sig.stop, sig.tp);
    const beGate = await goldBeSetupGate(admin, sig.side, entry, rrLive, sig.confidence);
    if (beGate.block) {
      const dir = sig.side.toUpperCase();
      const msg = beGate.kind === "exhausted"
        ? `⛔️ <b>GENX gold — sitting this one out</b>\nThis ${dir} zone already hit break-even twice — the setup is done. Waiting for a NEW setup to form.`
        : `🎯 <b>GENX gold — retry needs to earn it</b>\nThis ${dir} zone already went to break-even once. Re-entering only at a better price (≥${GOLD_RETRY_BETTER_PIPS}p improvement) or on a premium read${beGate.detail ? `.\nThis one: ${beGate.detail}` : ""}.`;
      try { await sendTelegram(msg); } catch { /* note best-effort */ }
      await deskDrop(`${beGate.kind === "exhausted" ? "setup_exhausted" : "be_retry_not_earned"} ${sig.side}${beGate.detail ? ` (${beGate.detail})` : ""}`);
      return { members: 0, placed: 0 };
    }
    const w = await goldRecentWinOnSide(admin, sig.side, GOLD_WIN_PICKY_MS);
    // OWNER RULE 09-02: the premium bar applies after a recent WIN — or a recent BREAK-EVEN
    // scratch — on this side. Either way the next same-side entry must be no worse than 1:1.
    let raisedBar = w.won;
    if (!raisedBar) { try { raisedBar = (await goldRecentBeEntries(admin, sig.side, GOLD_WIN_PICKY_MS)).length > 0; } catch { /* read error → no raise */ } }
    if (raisedBar) {
      const rrOk = rrLive == null ? true : rrLive >= GOLD_WIN_PICKY_RR;       // feed down → judge on confidence alone
      const confOk = sig.confidence == null ? true : sig.confidence >= GOLD_WIN_PICKY_CONF;
      if (!rrOk || !confOk) {
        const detail = [
          rrLive != null ? `R:R ${rrLive.toFixed(2)} (needs ≥ ${GOLD_WIN_PICKY_RR.toFixed(1)})` : null,
          sig.confidence != null ? `confidence ${sig.confidence} (needs ≥ ${GOLD_WIN_PICKY_CONF})` : null,
        ].filter(Boolean).join(" · ");
        try { await sendTelegram(`🎯 <b>GENX gold — protecting profits</b>\n${w.won ? `Just banked a ${sig.side.toUpperCase()} win` : `Just scratched a ${sig.side.toUpperCase()} at break-even`}, so the next ${sig.side.toUpperCase()} needs a premium entry (min 1:1)${detail ? `.\nThis one: ${detail}` : ""}. A top-quality setup still fires immediately.`); } catch { /* note best-effort */ }
        await deskDrop(`post_win_picky ${sig.side}${rrLive != null ? ` rr=${rrLive.toFixed(2)}` : ""}${sig.confidence != null ? ` conf=${sig.confidence}` : ""}`);
        return { members: 0, placed: 0 };
      }
    }
  } catch { /* read error → don't block */ }

  // SIZING ENTRY = the LIVE price, not the (possibly stale) signal zone. This is the fix for
  // the $8k-risk trade: the position is risk-sized off where it will ACTUALLY fill, so the
  // dollar risk always equals the member's risk % — a chased fill can no longer balloon the
  // real entry→stop distance (and the loss) beyond what was intended. Falls back to the
  // signal entry only if the feed is down.
  const sizeEntry = goldLp != null ? goldLp : entry;
  const goldStop: number = sig.stop; // narrowed non-null above; captured so the closure keeps the type

  // UNIFIED FAN-OUT: drive off the ACCOUNT table, not the auto-run settings table. EVERY
  // member who owns at least one autotrade-enabled account is included — even if they have
  // no `flow_auto_settings` row at all. This closes the gap where an autotrade-enabled
  // account with no settings row fell through BOTH paths and silently took nothing. Pure
  // genx_follower accounts (autotrade OFF) are handled by placeGenxFollower; together the
  // two partitions cover every opted-in account exactly once — no gap, no double-fill.
  const { data: onRows } = await admin.from("flow_broker_accounts").select("user_id").eq("autotrade_enabled", true);
  const userIds = [...new Set(((onRows ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((x): x is string => !!x))];
  // Credit state per user (absent row → NOT paused, so a no-settings member still trades).
  // We KEEP the credits gate per the owner's decision, but a credit-paused skip is now
  // LOGGED to flow_auto_events instead of being silently dropped, so it is never invisible.
  const { data: setRows } = userIds.length
    ? await admin.from("flow_auto_settings").select("user_id, credit_paused, last_credit_at").in("user_id", userIds)
    : { data: [] as { user_id: string; credit_paused?: boolean | null; last_credit_at?: string | null }[] };
  const setRowBy = new Map(((setRows ?? []) as AutoSettings[]).map((r) => [r.user_id, r]));
  const pausedBy = new Map(((setRows ?? []) as { user_id: string; credit_paused?: boolean | null }[]).map((r) => [r.user_id, !!r.credit_paused]));
  let placedTotal = 0, members = 0;
  // PARALLEL FAN-OUT (concurrency-capped). The old sequential loop did several broker
  // round-trips PER MEMBER one member at a time; on a 57-member desk that ran past the
  // scanner's function budget, so members late in the order silently missed every signal
  // (only a handful got filled per signal). Running members concurrently (cap below) fans a
  // signal out to EVERY eligible member in seconds. Same per-member logic, just not serial.
  const perMember = async (userId: string): Promise<number> => {
    try {
      if (pausedBy.get(userId)) {
        // RE-CHECK through the meter instead of trusting the stale flag (live case 09-02:
        // the flag only cleared on the FLOW auto-run billing path, so a member who ran dry
        // then TOPPED BACK UP kept being skipped signal after signal). meterAutoRun bills
        // the 30-min window when due and clears the pause the moment they can pay; only a
        // member who STILL can't pay is skipped — and that skip stays logged, never silent.
        const row = setRowBy.get(userId);
        const revived = row ? await meterAutoRun(admin, row) : false;
        if (!revived) {
          try { await admin.from("flow_auto_events").insert({ user_id: userId, symbol: "XAUUSD", side: sig.side, status: "skipped", reason: "genx: credit_paused" }); } catch { /* log best-effort */ }
          return 0;
        }
      }
      // Claim gold for this member. FALSE → a gold entry is already live within the
      // cooldown → skip (this blocks GENX's back-to-back ENTER NOW repeats).
      const { data: won } = await admin.rpc("flow_try_claim", { p_user: userId, p_symbol: "XAUUSD", p_cooldown_secs: GOLD_CLAIM_SEC });
      if (won === false) return 0;

      const allAccounts = await activeAccounts(userId);
      // PER-ACCOUNT SAFETY MODE: drop this member's accounts that are conservative AND in
      // a gold loss-cutoff. Aggressive accounts still take it. None left → release claim.
      let accounts = await filterAccountsForAsset(admin, allAccounts, "XAUUSD");
      // CONSERVATIVE QUALITY GATE: when this setup FAILED the conservative confluence
      // checks, drop conservative accounts for THIS entry (aggressive accounts are never
      // touched — they take every gold ENTER NOW). conservativeOk defaults to true so an
      // ungraded call still behaves exactly as before.
      if (sig.conservativeOk === false || conservativeHold) accounts = accounts.filter((a) => !isConservative(a.riskMode));
      // MAX ONE OPEN GENX/FLOW GOLD PER ACCOUNT — broker-verified. An account is dropped ONLY
      // when it has a GENX/FLOW gold position the BROKER confirms is still open.
      const verified: ActiveAccount[] = [];
      for (const a of accounts) {
        const ledgerPids = ledgerGoldByAcct.get(String(a.accountId));
        if (!ledgerPids || !ledgerPids.size) { verified.push(a); continue; }
        const brokerOpen = await brokerOpenPosIds({ env: a.env, token: a.token, accNum: a.accNum, accountId: a.accountId });
        // FAIL CLOSED (owner incident 08-31, double gold entry on one account): the ledger says
        // this account already holds an automated gold trade. If the broker can't be read to
        // confirm it closed, we DO NOT place — a missed entry is recoverable, a stacked double
        // position is not. Stale rows still never block: a READABLE broker that shows the
        // position closed frees the account instantly.
        if (brokerOpen === null) continue;
        if (genxGoldStillOpen(ledgerPids, brokerOpen)) continue; // genuinely open → max 1, skip
        verified.push(a); // broker confirms it closed → free for the next signal
      }
      accounts = verified;
      if (!accounts.length) { await admin.rpc("flow_release_claim", { p_user: userId, p_symbol: "XAUUSD" }); return 0; }

      const { data: pref } = await admin.from("flow_trade_prefs").select("risk_pct").eq("user_id", userId).maybeSingle();
      const p = (pref as { risk_pct?: number | null } | null) ?? null;
      const riskPct = p && typeof p.risk_pct === "number" && p.risk_pct > 0 ? p.risk_pct : 1;

      const res = await placeOnActiveAccounts({ userId, symbol: "XAUUSD", side: sig.side, entry: sizeEntry, stop: goldStop, tp: sig.tp, riskPct, source: "genx", accounts });
      if (res.placed === 0) { await admin.rpc("flow_release_claim", { p_user: userId, p_symbol: "XAUUSD" }); return 0; } // nothing filled → let the next ENTER NOW retry
      return res.placed;
    } catch { return 0; } // per-member best-effort
  };
  const placedPer = await mapPool(userIds, FANOUT_CONCURRENCY, perMember);
  for (const n of placedPer) { if (n > 0) { placedTotal += n; members += 1; } }
  // COVERAGE BREADCRUMB — how many of the eligible members this signal actually reached, so an
  // under-fan-out can never hide again. With the parallel fan-out this should be ~all of them.
  try { await admin.from("flow_auto_events").insert({ user_id: GOLD_HALT_MARKER_UID, symbol: "XAUUSD", side: sig.side, status: "fanout", reason: `genx: fanout ${members}/${userIds.length} members` }); } catch { /* best-effort */ }
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
  stop: number | null; tp: number | null; conservativeOk?: boolean; confidence?: number | null;
}): Promise<{ accounts: number; placed: number }> {
  const admin = createAdminClient();
  if (!admin) return { accounts: 0, placed: 0 };
  if (inWeekendCloseWindow()) return { accounts: 0, placed: 0 }; // no new entries near Friday close
  if (!(await systemSwitches(admin)).genx) return { accounts: 0, placed: 0 }; // admin GENX kill switch
  const signalKey = String(sig.signalKey || "").slice(0, 200);
  if (!signalKey) return { accounts: 0, placed: 0 };

  // Entry price for risk sizing: midpoint of the zone (fallbacks handle a one-sided
  // zone). null → we can't size, so those accounts fall back to the 0.01 floor.
  const entry = (sig.entryLow != null && sig.entryHigh != null)
    ? (sig.entryLow + sig.entryHigh) / 2
    : (sig.entryLow ?? sig.entryHigh ?? null);
  // Widen a too-tight signal stop to gold's minimum distance before sizing + placing, so the
  // follower isn't over-sized off a noise-width stop (same risk %, professional position size).
  const fstop = (entry != null && sig.stop != null) ? floorStop("XAUUSD", sig.side, entry, sig.stop) : sig.stop;

  // Live gold price, fetched ONCE — used for the chase guard AND for risk-sizing below.
  let goldLp: number | null = null;
  try { goldLp = await goldLivePrice(); } catch { goldLp = null; }

  // CHASE GUARD (desk-wide): same reward:risk floor as the copy path — if price has run
  // toward TP so the live-price R:R is below the floor, this ENTER NOW is chased; no
  // follower takes a tiny-TP / huge-SL fill. Fails open if the feed is down.
  if (goldChasedAt(sig.side, fstop, sig.tp, goldLp)) return { accounts: 0, placed: 0 };

  // SELECTIVITY GATES — same desk rules as the copy path (owner directives 08-31): the
  // same-setup break-even escalation (retry must earn it; twice-scratched zone sits out)
  // plus the post-win premium bar. Followers skip silently; the copy path posts the note.
  try {
    const rrLive = rewardRisk(goldLp != null ? goldLp : entry, fstop, sig.tp);
    const beGate = await goldBeSetupGate(admin, sig.side, entry, rrLive, sig.confidence);
    if (beGate.block) return { accounts: 0, placed: 0 };
    const w = await goldRecentWinOnSide(admin, sig.side, GOLD_WIN_PICKY_MS);
    // OWNER RULE 09-02: premium bar after a recent win OR break-even scratch (min 1:1).
    let raisedBar = w.won;
    if (!raisedBar) { try { raisedBar = (await goldRecentBeEntries(admin, sig.side, GOLD_WIN_PICKY_MS)).length > 0; } catch { /* read error → no raise */ } }
    if (raisedBar) {
      const rrOk = rrLive == null ? true : rrLive >= GOLD_WIN_PICKY_RR;
      const confOk = sig.confidence == null ? true : sig.confidence >= GOLD_WIN_PICKY_CONF;
      if (!rrOk || !confOk) return { accounts: 0, placed: 0 }; // copy path posts the Telegram note
    }
  } catch { /* read error → don't block */ }

  // SIZING ENTRY = the LIVE price (falls back to the signal zone only if the feed is down),
  // so each follower's risk is off where it ACTUALLY fills — a chased fill can't balloon the
  // dollar risk past the account's risk %.
  const sizeEntry = goldLp != null ? goldLp : entry;

  // Every follower account, across every user/connection (independent of FLOW).
  // Pull the per-account risk override + management toggle when those columns exist;
  // fall back to a bare select so the follower never breaks before the migration is run.
  type FollowRow = { user_id: string; account_id: string; acc_num: string | null; connection_id: string; risk_pct?: number | null; manage_trades?: boolean | null; risk_mode?: string | null; autotrade_enabled?: boolean | null };
  let accts: FollowRow[] = [];
  const withCols = await admin.from("flow_broker_accounts")
    .select("user_id, account_id, acc_num, connection_id, risk_pct, manage_trades, risk_mode, autotrade_enabled").eq("genx_follower", true);
  if (!withCols.error) accts = (withCols.data ?? []) as FollowRow[];
  else {
    const fb = await admin.from("flow_broker_accounts")
      .select("user_id, account_id, acc_num, connection_id").eq("genx_follower", true);
    accts = (fb.data ?? []) as FollowRow[];
  }
  // ONE PATH PER ACCOUNT: an account that is ALSO autotrade-enabled routes to the risk-sized
  // GENX copy (placeGenxGold) instead — drop it here so it never gets both the copy fill AND
  // this follower fill for the same setup. Pure-follower accounts (autotrade off) route here.
  // Uses the shared goldRoute() rule so the two paths can never disagree on ownership.
  accts = accts.filter((a) => goldRoute(a) === "follower");
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

  // PARALLEL FAN-OUT (same fix as the copy path): follower accounts also fan out concurrently
  // (capped) so a signal reaches EVERY follower account within the function budget instead of
  // timing out partway through a long sequential loop. The shared token/equity caches only ever
  // double-fetch on a race (harmless), and genx_follower_fills' unique (signal_key, account_id)
  // makes each fill idempotent even under concurrency.
  const perAccount = async (a: FollowRow): Promise<{ touched: number; placed: number }> => {
    if (!a.acc_num) return { touched: 0, placed: 0 };
    try {
      // PER-ACCOUNT SAFETY MODE: a CONSERVATIVE follower account sits gold out for 4h
      // after 2 losing gold trades in a row. Aggressive follower accounts take it raw.
      if (isConservative(a.risk_mode)) {
        // CONSERVATIVE QUALITY GATE: skip this setup on conservative followers when it
        // failed the confluence checks (aggressive followers below still take it).
        if (sig.conservativeOk === false) return { touched: 1, placed: 0 };
        const cut = await accountAssetCutoff(admin, a.account_id, "gold");
        if (cut.halt) return { touched: 1, placed: 0 };
      }
      // MAX ONE OPEN GENX/FLOW GOLD PER ACCOUNT — broker-verified (same rule as the copy
      // path). The ledger holds only engine-placed trades, so a MANUAL gold trade never
      // counts. A stale ledger row (already closed on the broker) does not block — but when
      // the ledger shows an open automated gold and the broker CANNOT be read to confirm,
      // we FAIL CLOSED and skip (owner incident 08-31): a missed entry is recoverable, a
      // stacked double position is not.
      const { data: openGold } = await admin.from("flow_managed_positions")
        .select("position_id, created_at").eq("account_id", a.account_id).eq("symbol", "XAUUSD").eq("status", "open");
      const manualGoldF = await manualGoldPlacements(admin);
      const ledgerPids = ((openGold ?? []) as { position_id: string | null; created_at: string }[])
        .filter((r) => !isManualGoldRow(manualGoldF, String(a.account_id), r.created_at)) // manual play/test → never blocks
        .map((r) => String(r.position_id ?? "")).filter(Boolean);
      if (ledgerPids.length) {
        const tokChk = await tokenFor(a.connection_id);
        if (!tokChk) return { touched: 1, placed: 0 }; // can't verify → fail closed, never stack
        const brokerOpen = await brokerOpenPosIds({ env: tokChk.env, token: tokChk.token, accNum: String(a.acc_num), accountId: a.account_id });
        if (brokerOpen === null) return { touched: 1, placed: 0 }; // broker unreadable → fail closed, never stack
        if (genxGoldStillOpen(ledgerPids, brokerOpen)) return { touched: 1, placed: 0 }; // genuinely open → skip
      }
      // Idempotent claim: one fill per (signal, account). A duplicate row → already
      // handled this ENTER NOW on this account → skip.
      const { error: dupErr } = await admin.from("genx_follower_fills").insert({ signal_key: signalKey, account_id: a.account_id });
      if (dupErr) return { touched: 1, placed: 0 };

      const tok = await tokenFor(a.connection_id);
      if (!tok) { await admin.from("genx_follower_fills").delete().eq("signal_key", signalKey).eq("account_id", a.account_id); return { touched: 1, placed: 0 }; }

      // Risk-size this account to its own % (override → owner default → 1% fallback).
      // If we can't size (missing entry/stop/equity), take the 0.01 floor so the
      // follower still records the signal instead of sitting it out.
      let qty = FOLLOWER_LOT;
      if (sizeEntry != null && fstop != null) {
        const equity = await equityFor(a.connection_id, a.account_id, tok);
        if (equity != null && equity > 0) {
          const acctRisk = (typeof a.risk_pct === "number" && a.risk_pct > 0) ? a.risk_pct : await defaultRiskFor(a.user_id);
          const s = sizeFromRisk({ canonical: "XAUUSD", entry: sizeEntry, stop: fstop, equity, riskPct: acctRisk, floorToMinLot: true });
          if (s.ok && s.lots > 0) qty = Math.min(s.lots, 100); // fat-finger backstop
        }
      }

      const r = await placeFixedLotFollower({
        userId: a.user_id, env: tok.env, token: tok.token, connId: a.connection_id,
        accountId: a.account_id, accNum: String(a.acc_num),
        symbol: "XAUUSD", side: sig.side, qty, stop: fstop, tp: sig.tp, source: "genx_follow",
      });
      if (r.ok) {
        // Record the fill in the manager's ledger REGARDLESS of the management toggle. The
        // trade-manager books a CONFIRMED closed-trade outcome for every tracked row (its
        // gone/close detection runs before the management steps), and that outcome is what the
        // conservative 2-loss cutoff reads — so a follower with management OFF must still be
        // recorded, or it could lose repeatedly on gold and never trip the cutoff. When
        // management is off the manager only books the outcome; per-account manage_trades=false
        // still means it does NOT move breakeven / take partials / trail (the position rides
        // its raw broker SL/TP, untouched). Needs a real positionId + stop to be manageable.
        if (r.positionId && sizeEntry != null && fstop != null) {
          try {
            await admin.from("flow_managed_positions").insert({
              user_id: a.user_id, connection_id: a.connection_id, account_id: a.account_id, acc_num: String(a.acc_num), environment: tok.env,
              position_id: r.positionId, symbol: "XAUUSD", side: sig.side,
              entry: sizeEntry, init_stop: fstop, tp1: sig.tp ?? null,
              r: Math.abs(sizeEntry - fstop), qty: r.qty, cur_stop: fstop, best_price: sizeEntry,
            });
          } catch { /* best-effort; the trade still stands even if the ledger insert fails */ }
        }
        return { touched: 1, placed: 1 };
      }
      // Nothing filled (session closed / token blip) → release the claim so a later
      // ENTER NOW re-fire for this same signal can retry on this account.
      await admin.from("genx_follower_fills").delete().eq("signal_key", signalKey).eq("account_id", a.account_id);
      return { touched: 1, placed: 0 };
    } catch { return { touched: 1, placed: 0 }; } // per-account best-effort
  };
  const results = await mapPool(accts, FANOUT_CONCURRENCY, perAccount);
  let placed = 0, touched = 0;
  for (const r of results) { touched += r.touched; placed += r.placed; }
  return { accounts: touched, placed };
}
