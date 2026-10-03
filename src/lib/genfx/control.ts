import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, type FxPair, type PairKey } from "@/lib/genfx/pairs";

/**
 * GEN FX — THE SWITCHES. One row (public.genfx_control, id 1), read at decision time. The owner can
 * change any of it without a deploy.
 *
 *   scan      the scanner reads the two pairs, records what it finds and grades it. Costs nothing and
 *             risks nothing; on from day one, because a track record is the thing GEN FX does not have.
 *   auto      placement. OFF means no order leaves for anyone, whatever a member has switched on.
 *   scope     who placement may reach while `auto` is on:
 *               "owner"  the owner's accounts only
 *               "demo"   the owner's accounts, plus any member's DEMO account that opted in
 *               "all"    every account whose member opted in, live included
 *             GEN FX is a new instrument for an engine whose record is all gold. It starts on demo
 *             money so the first evidence costs nobody anything.
 *   billing   OFF: reads and trades cost no credits. ON: priced exactly like GENX — the read is the
 *             "genx" credit feature (5 credits, free on the FLOW Pass), a forming setup is 1 credit
 *             and a placed trade 5.
 *   telegram  OFF: nothing is posted. ON: GEN FX calls go to the channel, labelled GEN FX.
 *
 * EVERY SWITCH FAILS SHUT. If the row cannot be read, GEN FX places nothing, bills nothing and posts
 * nothing. "I could not read my instructions" is not permission to trade.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** The owner's account. Desk-wide breadcrumbs are filed under it, and scope "owner" means this id. */
export const OWNER_USER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
/** Written to every ledger row GEN FX opens, so its trades are told apart from everything else by one column. */
export const GENFX_VERSION = "genfx-1.0";

export type AutoScope = "owner" | "demo" | "all";

/** Tunables the row may override. Anything missing or malformed falls back to the default here. */
export type GenfxConfig = {
  /** Tightest stop auto-trade takes, in pips, per pair. */
  minStopPips: Record<PairKey, number>;
  /** The minimum lot must not risk more than this share of the account, or the account sits out. */
  maxMinLotRiskPct: number;
  /** Hard ceiling on one order, in lots. */
  maxLots: number;
  /** Position notional ÷ equity may not exceed this. */
  maxLeverage: number;
  /** Hold entries around high-impact news for the pair's currencies. GENX runs with this off. */
  newsBlackout: boolean;
  /**
   * AI-written market stories a member may run per day while billing is off. Each one is a paid model
   * call that nobody is being charged for, so the allowance is small; past it the read still works and
   * the story is the engine's own summary. With billing on this does not apply — the credits meter it.
   */
  freeStoriesPerDay: number;
};

export const DEFAULT_CONFIG: GenfxConfig = {
  minStopPips: { EURUSD: PAIRS.EURUSD.minStopPips, GBPJPY: PAIRS.GBPJPY.minStopPips },
  maxMinLotRiskPct: 5,
  maxLots: 50,
  maxLeverage: 20,
  newsBlackout: false,
  freeStoriesPerDay: 10,
};

export type GenfxControl = {
  /** False when the row could not be read. Every caller treats that as "do nothing". */
  readable: boolean;
  scan: boolean;
  auto: boolean;
  scope: AutoScope;
  billing: boolean;
  telegram: boolean;
  config: GenfxConfig;
  replayRequest: Record<string, unknown> | null;
  updatedAt: string | null;
};

const SHUT: GenfxControl = { readable: false, scan: false, auto: false, scope: "owner", billing: false, telegram: false, config: DEFAULT_CONFIG, replayRequest: null, updatedAt: null };

const posNum = (v: unknown, d: number, lo: number, hi: number): number => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) && x >= lo && x <= hi ? x : d;
};

/** Pure: merge a stored config over the defaults, refusing anything out of range. */
export function configOf(raw: unknown): GenfxConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ms = (c.minStopPips && typeof c.minStopPips === "object" ? c.minStopPips : {}) as Record<string, unknown>;
  return {
    minStopPips: {
      EURUSD: posNum(ms.EURUSD, DEFAULT_CONFIG.minStopPips.EURUSD, 3, 500),
      GBPJPY: posNum(ms.GBPJPY, DEFAULT_CONFIG.minStopPips.GBPJPY, 5, 1000),
    },
    maxMinLotRiskPct: posNum(c.maxMinLotRiskPct, DEFAULT_CONFIG.maxMinLotRiskPct, 0.5, 25),
    maxLots: posNum(c.maxLots, DEFAULT_CONFIG.maxLots, 0.01, 100),
    maxLeverage: posNum(c.maxLeverage, DEFAULT_CONFIG.maxLeverage, 1, 50),
    newsBlackout: c.newsBlackout === true,
    freeStoriesPerDay: posNum(c.freeStoriesPerDay, DEFAULT_CONFIG.freeStoriesPerDay, 0, 10_000),
  };
}

/** Pure: a stored row → the switches. Anything that is not exactly `true` is off. */
export function controlOf(row: Record<string, unknown> | null | undefined): GenfxControl {
  if (!row) return SHUT;
  const scope = row.auto_scope === "all" ? "all" : row.auto_scope === "demo" ? "demo" : "owner";
  const rq = row.replay_request && typeof row.replay_request === "object" ? (row.replay_request as Record<string, unknown>) : null;
  return {
    readable: true,
    scan: row.scan_enabled === true,
    auto: row.auto_enabled === true,
    scope,
    billing: row.billing_enabled === true,
    telegram: row.telegram_enabled === true,
    config: configOf(row.config),
    replayRequest: rq,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/** Read the switches. Never throws; an unreadable row is everything off. */
export async function readControl(admin: Admin | null): Promise<GenfxControl> {
  if (!admin) return SHUT;
  try {
    // The switches only — not replay_result, which can be large and is read by the desk when it is wanted.
    const { data, error } = await admin.from("genfx_control").select("id, scan_enabled, auto_enabled, auto_scope, billing_enabled, telegram_enabled, config, replay_request, updated_at").eq("id", 1).maybeSingle();
    if (error || !data) return SHUT;
    return controlOf(data as Record<string, unknown>);
  } catch { return SHUT; }
}

/** The tightest stop auto-trade takes on this pair right now. */
export const minStopPips = (ctl: GenfxControl, pair: FxPair): number => ctl.config.minStopPips[pair.key] ?? pair.minStopPips;

/** May this account be reached by GEN FX placement, given the scope? Pure. */
export function inScope(scope: AutoScope, a: { userId: string; environment: string | null }, ownerId: string): boolean {
  if (a.userId === ownerId) return true;
  if (scope === "all") return true;
  if (scope === "demo") return String(a.environment ?? "").toLowerCase() === "demo";
  return false;
}
