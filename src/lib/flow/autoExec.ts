import { createAdminClient } from "@/lib/supabase/admin";
import { flowDecision } from "@/lib/flow/decision";
import { placeMarketOrder } from "@/lib/flow/executor";
import type { Mode } from "@/lib/genxCompute";

/**
 * FLOW AUTO-EXECUTOR (server-only).
 *
 * For each ARMED member, run the exact same setup→confirm→entry-engine pipeline
 * the FLOW screen shows, and when it reads ENTER_NOW, place ONE market order on
 * that member's connected TradeLocker account. Deterministic and guardrailed:
 *
 *  • per-symbol COOLDOWN — a standing ENTER_NOW can't re-fire every scan tick,
 *    and it never stacks a second position on the same symbol inside the window.
 *  • HOURLY CAP — at most `max_orders_per_hour` auto orders per member.
 *  • only fires on entryState === "ENTER_NOW" && actionable (never on a limit /
 *    pullback / approaching / stand-aside state). The entry engine's chase +
 *    expiry guards still gate every fill. (Note: a CONFIRMED counter-trend setup
 *    can still reach ENTER_NOW by design — STAND_ASIDE only blocks pre-confirmation.)
 *
 * Members opt in explicitly (flow_auto_settings.enabled). This module never runs
 * for anyone who hasn't armed it.
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
};

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "NAS100"];
// Per-symbol cooldown by mode: long enough that a persistent ENTER_NOW doesn't
// re-enter on the next 5-min tick, short enough to catch a genuinely new setup.
const COOLDOWN_MIN: Record<string, number> = { quick: 90, intraday: 180, swing: 480 };

// A recent ambiguous failure (e.g. the broker filled but our request timed out
// before we saw the id) must NOT be retried on the very next tick, or it stacks
// a duplicate. So after an error we hold the symbol for a short backoff.
const ERROR_BACKOFF_MS = 8 * 60000;

type AutoEvent = { symbol: string; created_at: string; status: string };
type SymbolResult = { symbol: string; action: string; detail?: string; orderId?: string | null; side?: string };

async function recentAutoEvents(admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string): Promise<AutoEvent[]> {
  const sinceIso = new Date(Date.now() - 8 * 3600e3).toISOString();
  const { data } = await admin.from("flow_auto_events")
    .select("symbol, created_at, status")
    .eq("user_id", userId).like("reason", "auto%")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false });
  return (data ?? []) as AutoEvent[];
}

/** Run the auto-executor for a SINGLE armed member. */
export async function runAutoExecForUser(settings: AutoSettings, mdKey: string): Promise<{ userId: string; results: SymbolResult[] }> {
  const admin = createAdminClient();
  const results: SymbolResult[] = [];
  if (!admin) return { userId: settings.user_id, results: [{ symbol: "-", action: "error", detail: "no_admin_client" }] };
  if (!settings.enabled) return { userId: settings.user_id, results: [{ symbol: "-", action: "disabled" }] };

  const mode = (settings.mode === "intraday" || settings.mode === "swing" ? settings.mode : "quick") as Mode;
  const symbols = (settings.symbols && settings.symbols.length ? settings.symbols : DEFAULT_SYMBOLS).map((s) => String(s).toUpperCase());
  const maxLot = settings.max_lot && settings.max_lot > 0 ? settings.max_lot : 0.01;
  const maxPerHour = settings.max_orders_per_hour && settings.max_orders_per_hour > 0 ? settings.max_orders_per_hour : 10;
  const maxOpen = settings.max_open && settings.max_open > 0 ? settings.max_open : symbols.length;
  const cooldownMs = (COOLDOWN_MIN[mode] ?? 90) * 60000;
  // Auto-exec always reads FRESH market data — a background order decision must
  // use the most current price, and it keeps every armed member consistent
  // regardless of their data tier.
  const fresh = true;
  const now = Date.now();
  const ms = (iso: string) => now - new Date(iso).getTime();

  const events = await recentAutoEvents(admin, settings.user_id);
  const placed = events.filter((e) => e.status === "placed");
  const placedLastHour = placed.filter((p) => ms(p.created_at) < 3600e3).length;
  let hourBudget = Math.max(0, maxPerHour - placedLastHour);
  // Symbols with a placed order still inside their cooldown ≈ currently-open auto
  // positions. Used both as one-position-per-symbol and to cap total concurrency.
  const openSymbols = new Set(placed.filter((p) => ms(p.created_at) < cooldownMs).map((p) => String(p.symbol).toUpperCase()));

  for (const symbol of symbols) {
    try {
      // Per-symbol cooldown: skip if we placed an auto order on this symbol recently.
      const lastPlaced = placed.find((p) => String(p.symbol).toUpperCase() === symbol);
      if (lastPlaced && ms(lastPlaced.created_at) < cooldownMs) {
        results.push({ symbol, action: "cooldown" });
        continue;
      }
      // Error backoff: a recent ambiguous failure holds the symbol briefly so an
      // order that may have actually filled isn't duplicated on the next tick.
      const lastErr = events.find((e) => e.status === "error" && String(e.symbol).toUpperCase() === symbol);
      if (lastErr && ms(lastErr.created_at) < ERROR_BACKOFF_MS) {
        results.push({ symbol, action: "error_backoff" });
        continue;
      }
      if (hourBudget <= 0) { results.push({ symbol, action: "hour_cap" }); continue; }
      // Concurrency cap across all symbols (best-effort, log-based).
      if (!openSymbols.has(symbol) && openSymbols.size >= maxOpen) { results.push({ symbol, action: "max_open" }); continue; }

      const dec = await flowDecision({ canonical: symbol, mode, mdKey, fresh });
      if (!dec.ok) { results.push({ symbol, action: "read_skip", detail: dec.error }); continue; }

      const st = dec.entry.entryState;
      if (st !== "ENTER_NOW" || !dec.entry.actionable) {
        results.push({ symbol, action: "no_entry", detail: st });
        continue;
      }

      // ENTER NOW → place one market order with the setup's stop + first target.
      const out = await placeMarketOrder({
        userId: settings.user_id, symbol, side: dec.side, qty: maxLot,
        stop: dec.levels.stop, tp: dec.levels.tp1, source: "auto",
      });
      if (out.status === "placed") {
        hourBudget -= 1;
        openSymbols.add(symbol);
        results.push({ symbol, action: "placed", side: dec.side, orderId: out.orderId });
      } else {
        results.push({ symbol, action: "order_error", side: dec.side, detail: out.reason });
      }
    } catch (e) {
      results.push({ symbol, action: "error", detail: e instanceof Error ? e.message.slice(0, 160) : "error" });
    }
  }
  return { userId: settings.user_id, results };
}

/** Run the auto-executor for EVERY armed member (cron entry point). */
export async function runAutoExecAll(mdKey: string): Promise<{ users: number; runs: Array<{ userId: string; results: SymbolResult[] }> }> {
  const admin = createAdminClient();
  if (!admin) return { users: 0, runs: [] };
  const { data } = await admin.from("flow_auto_settings").select("*").eq("enabled", true);
  const rows = (data ?? []) as AutoSettings[];
  const runs: Array<{ userId: string; results: SymbolResult[] }> = [];
  for (const s of rows) {
    // Best-effort per user — one member's error never blocks the others.
    try { runs.push(await runAutoExecForUser(s, mdKey)); }
    catch (e) { runs.push({ userId: s.user_id, results: [{ symbol: "-", action: "error", detail: e instanceof Error ? e.message.slice(0, 160) : "error" }] }); }
  }
  return { users: rows.length, runs };
}
