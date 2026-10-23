import { PAIRS } from "@/lib/fxscalper/pairs";
import { pipValuePerLot } from "@/lib/fxscalper/money";
import type { BotStatus, PairSnap, Snapshot, TradeSnap } from "@/lib/fxscalper/snapshot";
import type { Plan } from "@/lib/fxscalper/plan";
import type { Bot } from "./bot";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildSnapshot(bot: Bot): Snapshot {
  const now = Date.now();
  const s = bot.session;
  const c = bot.control;
  const ccy = s?.currency ?? "USD";
  const rates = bot.rates();
  const blockers = bot.entryBlockers(now);

  const pairs: PairSnap[] = [...bot.pairs.values()].map((ps) => {
    const spec = ps.spec;
    const q = ps.quote;
    const pip = spec?.pipSize ?? PAIRS[ps.key].pip;
    const spread = q ? (q.ask - q.bid) / pip : null;
    let costs: PairSnap["costs"] = null;
    if (spec && spread != null) {
      const pv = pipValuePerLot({ lotSize: spec.lotSize, pipSize: pip, quote: spec.quote, base: spec.base, leverage: spec.leverage }, ccy, rates);
      const com = bot.settings.costs.commissionPerLotPerSide;
      const commission = com == null || pv == null ? null : (com * 2) / pv;
      const other = pv == null ? 0 : bot.settings.costs.otherChargesPerLotRoundTrip / pv;
      const slippage = bot.slippageInUse();
      costs = { spread: r2(spread), commission: commission == null ? null : r2(commission), other: r2(other), slippage: r2(slippage), total: commission == null ? null : r2(spread + commission + other + slippage), max: bot.settings.pairs[ps.key].maxCostPips };
    }
    const last = ps.bars[ps.bars.length - 1];
    return {
      pair: ps.key, label: PAIRS[ps.key].label, note: PAIRS[ps.key].note ?? null, enabled: bot.settings.pairs[ps.key].enabled,
      brokerSymbol: spec?.brokerSymbol ?? null, status: spec ? "ready" : "blocked", problem: ps.problem, candidates: ps.candidates, notes: ps.notes,
      symbolStatus: ps.symbolStatus, bid: q?.bid ?? null, ask: q?.ask ?? null, decimals: spec?.decimals ?? null,
      spreadPips: spread == null ? null : r2(spread), quoteAgeMs: q ? now - q.receivedAt : null, quoteLatencyMs: q?.latencyMs ?? null,
      lastChangeAgoMs: q ? now - q.changedAt : null, costs, barT: last?.t ?? null, bars: ps.bars.length, barLagMs: ps.barLagMs, revisions: ps.revisions,
      eval: ps.eval ? { status: ps.eval.status, side: ps.eval.side, reason: ps.eval.reason, candleT: ps.eval.candleT, buy: ps.eval.buy, sell: ps.eval.sell, values: ps.eval.values } : null,
      decision: ps.decision,
    };
  });

  const trades: TradeSnap[] = [...bot.trades.values()].map((t) => {
    const pos = bot.positions?.find((p) => p.id === t.position_id);
    const plan = t.plan as unknown as Partial<Plan>;
    return {
      id: t.id, pair: t.pair, side: t.side, state: t.state, lots: Number(t.filled_qty ?? t.qty), fill: t.fill_price, stop: t.stop_price, target: t.target_price,
      stopPips: Number(t.stop_pips), targetPips: plan.targetPips ?? null, riskCash: Number(t.reserved_risk),
      estNetAtTarget: plan.estNetAtTarget != null && plan.lots ? (plan.estNetAtTarget * Number(t.filled_qty ?? t.qty)) / plan.lots : null,
      marginEst: plan.marginEst != null && plan.lots ? (plan.marginEst * Number(t.filled_qty ?? t.qty)) / plan.lots : null,
      filledAt: t.filled_at, dueAt: t.time_exit_due_at,
      elapsedSec: t.filled_at ? Math.round((now - Date.parse(t.filled_at)) / 1000) : null, unrealized: pos?.unrealizedPl ?? null,
      protection: t.protection, closeReason: t.close_reason, positionId: t.position_id, orderId: t.order_id,
    };
  });

  const st = bot.state;
  const d = bot.dayLossNow();
  let status: BotStatus;
  let headline: string;
  if (!c?.connection_id || !s) { status = "not_connected"; headline = "No broker account connected."; }
  else if (s.status === "reconnect_required") { status = "error"; headline = "The broker session needs reconnecting."; }
  else if (!s.ready) { status = "connecting"; headline = s.error ? `Connecting: ${s.error}` : "Connecting to the broker…"; }
  else if (bot.protectionAlarm || bot.qtyCheck.state === "contradicted") { status = "error"; headline = bot.protectionAlarm ?? bot.qtyCheck.detail; }
  else if (c.mode !== "live") { status = "stopped"; headline = c.stop_reason ? `Stopped: ${c.stop_reason}` : "Stopped — no orders are sent until START LIVE."; }
  else if (trades.some((t) => ["acknowledged", "uncertain", "open", "closing", "sending"].includes(t.state))) { status = "active"; headline = `${trades.length} bot trade${trades.length === 1 ? "" : "s"} in progress.`; }
  else if (blockers.length) { status = "paused"; headline = blockers[0]; }
  else { status = "scanning"; headline = "Live: watching every completed one-minute candle."; }

  return {
    at: now,
    worker: { owner: bot.owner, startedAt: bot.startedAt, fence: bot.fence, leaseValidUntil: bot.leaseValidUntil },
    bot: { status, headline, blockers },
    connection: s ? { status: s.status, server: s.server, emailMasked: s.emailMasked, lastAuthAt: s.lastAuthAt, expiresAt: s.expiresAt, error: s.error } : null,
    account: s ? {
      accountId: s.accountId, accNum: s.accNum, label: s.label, currency: s.currency, brokerStatus: s.brokerAccount?.status ?? null, type: s.brokerAccount?.type ?? null,
      rules: { ...(s.brokerAccount?.riskRules ?? {}), ...(s.brokerAccount?.tradingRules ?? {}) },
      balance: st?.balance ?? null, equity: bot.equity(), eligibleEquity: bot.eligibleEquity(), excluded: bot.settings.risk.excludedCapital + Math.max(0, bot.excludedPaid),
      availableFunds: st?.availableFunds ?? null, marginUsed: st?.initialMarginReq ?? null, maintMargin: st?.maintMarginReq ?? null,
      todayNet: st?.todayNet ?? null, todayFees: st?.todayFees ?? null, openNetPnL: st?.openNetPnL ?? null, positionsCount: st?.positionsCount ?? null,
      stateAgeMs: bot.stateAt ? now - bot.stateAt : null,
    } : null,
    day: bot.day ? { key: bot.day.day, startsAt: bot.day.starts_at, startEligible: bot.day.start_eligible_equity, limit: d.limit, loss: r2(d.loss), openNet: r2(d.openNet), realized: r2(bot.dayRealized), limitHitAt: bot.day.limit_hit_at } : null,
    streak: bot.streakInfo(),
    pairs,
    trades,
    health: {
      reconciled: bot.reconciled, reconcileNote: bot.reconcileNote, qtyCheck: bot.qtyCheck, protectionAlarm: bot.protectionAlarm,
      slippage: { configured: bot.settings.costs.slippageAllowancePips, observed: bot.observedSlipPips == null ? null : r2(bot.observedSlipPips), used: r2(bot.slippageInUse()) },
      ordersToday: bot.ordersToday, maxOrdersCount: Number.isFinite(Number(s?.brokerAccount?.riskRules?.maxOrdersCount)) ? Number(s?.brokerAccount?.riskRules?.maxOrdersCount) : null,
      errors: bot.errors.slice(0, 10), rateLimits: s?.rateLimits ?? {}, latency: bot.sched.stats(), queued: bot.sched.queued(),
      settingsWarnings: bot.settingsWarnings, settingsVersion: bot.settingsVersion,
    },
  };
}

export async function publish(bot: Bot): Promise<void> {
  await bot.store.writeStatus(bot.owner, buildSnapshot(bot) as unknown as Record<string, unknown>);
}
