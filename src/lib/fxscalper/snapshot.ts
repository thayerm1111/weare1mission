import type { PairKey } from "./pairs";
import type { SideChecks, EvalValues } from "./strategy";

/**
 * What the worker writes for the dashboard every two seconds (fx_scalper_status.snapshot). Everything
 * here is observed or computed from broker data; nothing is estimated for show.
 */

export type BotStatus = "not_connected" | "connecting" | "stopped" | "scanning" | "active" | "paused" | "error";

export type PairSnap = {
  pair: PairKey;
  label: string;
  note: string | null;
  enabled: boolean;
  brokerSymbol: string | null;
  status: "ready" | "blocked";
  problem: string | null;
  candidates: string[];
  notes: string[];
  symbolStatus: string | null;
  bid: number | null;
  ask: number | null;
  decimals: number | null;
  spreadPips: number | null;
  quoteAgeMs: number | null;
  quoteLatencyMs: number | null;
  lastChangeAgoMs: number | null;
  costs: { spread: number; commission: number | null; other: number; slippage: number; total: number | null; max: number } | null;
  barT: number | null;
  bars: number;
  barLagMs: number | null;
  revisions: number;
  eval: { status: string; side: "buy" | "sell" | null; reason: string; candleT: number; buy: SideChecks; sell: SideChecks; values: EvalValues } | null;
  decision: { at: number; code: string; text: string } | null;
};

export type TradeSnap = {
  id: string;
  pair: string;
  side: "buy" | "sell";
  state: string;
  lots: number;
  fill: number | null;
  stop: number | null;
  target: number | null;
  stopPips: number;
  targetPips: number | null;
  riskCash: number;
  estNetAtTarget: number | null;
  marginEst: number | null;
  filledAt: string | null;
  dueAt: string | null;
  elapsedSec: number | null;
  unrealized: number | null;
  protection: string;
  closeReason: string | null;
  positionId: string | null;
  orderId: string | null;
};

export type Snapshot = {
  at: number;
  worker: { owner: string; startedAt: number; fence: number | null; leaseValidUntil: number };
  bot: { status: BotStatus; headline: string; blockers: string[] };
  connection: { status: string; server: string; emailMasked: string; lastAuthAt: number | null; expiresAt: number | null; error: string | null } | null;
  account: {
    accountId: string; accNum: string; label: string | null; currency: string | null; brokerStatus: string | null; type: string | null;
    rules: Record<string, unknown>; balance: number | null; equity: number | null; eligibleEquity: number | null; excluded: number;
    availableFunds: number | null; marginUsed: number | null; maintMargin: number | null; todayNet: number | null; todayFees: number | null;
    openNetPnL: number | null; positionsCount: number | null; stateAgeMs: number | null;
  } | null;
  day: { key: string; startsAt: string; startEligible: number | null; limit: number | null; loss: number; openNet: number; realized: number; limitHitAt: string | null } | null;
  streak: { count: number; pauseUntil: number | null };
  pairs: PairSnap[];
  trades: TradeSnap[];
  health: {
    reconciled: boolean;
    reconcileNote: string;
    qtyCheck: { state: string; detail: string };
    protectionAlarm: string | null;
    slippage: { configured: number; observed: number | null; used: number };
    ordersToday: number;
    maxOrdersCount: number | null;
    errors: Array<{ at: number; where: string; message: string }>;
    rateLimits: Record<string, string>;
    latency: Record<string, { count: number; errors: number; limited: number; lastError: string | null; lastAt: number | null; p50: number | null; p95: number | null; window: string }>;
    queued: number;
    settingsWarnings: string[];
    settingsVersion: number;
  };
};
