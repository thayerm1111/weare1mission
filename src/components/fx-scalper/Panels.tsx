"use client";

import { Fragment, useState } from "react";
import { CHECK_LABELS, type SideChecks } from "@/lib/fxscalper/strategy";
import type { PairSnap, TradeSnap } from "@/lib/fxscalper/snapshot";
import { C, ago, money, num, pnlColor, px, utc, type StatusPayload, type Summary } from "./theme";
import { Card } from "./ui";


function Stat({ label, value, color, sub }: { label: string; value: React.ReactNode; color?: string; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: C.faint }}>{label}</p>
      <p className="truncate text-base font-semibold tabular-nums" style={{ color: color ?? C.ink }}>{value}</p>
      {sub && <p className="text-xs" style={{ color: C.muted }}>{sub}</p>}
    </div>
  );
}

// ---- Account --------------------------------------------------------------------------------------

export function AccountPanel({ data }: { data: StatusPayload }) {
  const a = data.worker?.snapshot?.account;
  const d = data.worker?.snapshot?.day;
  const streak = data.worker?.snapshot?.streak;
  const ccy = a?.currency ?? "";
  const pct = d?.limit ? Math.min(100, Math.max(0, (d.loss / d.limit) * 100)) : 0;
  return (
    <Card title="Account" right={<span className="text-xs" style={{ color: C.muted }}>{a?.stateAgeMs != null ? `read ${ago(a.stateAgeMs)}` : ""}</span>}>
      {!a ? <p className="text-sm" style={{ color: C.muted }}>No account data yet.</p> : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Balance" value={money(a.balance, ccy)} />
            <Stat label="Equity" value={money(a.equity, ccy)} />
            <Stat label="Risk capital" value={money(a.eligibleEquity, ccy)} sub={a.excluded ? `${money(a.excluded)} excluded` : "equity"} />
            <Stat label="Margin used" value={money(a.marginUsed, ccy)} sub={`available ${money(a.availableFunds)}`} />
            <Stat label="Broker today (whole account)" value={money(a.todayNet, ccy)} color={pnlColor(a.todayNet)} sub={`fees ${money(a.todayFees)}`} />
            <Stat label="Open P&L (whole account)" value={money(a.openNetPnL, ccy)} color={pnlColor(a.openNetPnL)} sub={`${a.positionsCount ?? "—"} positions`} />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="flex items-baseline justify-between text-sm">
                <span style={{ color: C.muted }}>Bot&apos;s day (since 17:00 New York)</span>
                <span className="font-semibold tabular-nums" style={{ color: pnlColor(d ? -d.loss : null) }}>{d ? money(-d.loss, ccy) : "—"}</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full" style={{ background: "#EEF2F7" }}>
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 100 ? C.red : pct > 60 ? C.amber : C.blue }} />
              </div>
              <p className="mt-1 text-xs" style={{ color: C.muted }}>
                Daily loss limit {d?.limit != null ? money(d.limit, ccy) : "—"} ({data.settings.values.risk.dailyLossLimitPct}% of the day&apos;s starting risk capital){d?.limitHitAt ? ` · reached ${utc(d.limitHitAt)}` : ""}. Realized {d ? money(d.realized) : "—"}, open {d ? money(d.openNet) : "—"}.
              </p>
            </div>
            <div className="text-sm" style={{ color: C.muted }}>
              <p>Losses in a row: <b style={{ color: C.ink }}>{streak?.count ?? 0}</b> (pause {data.settings.values.risk.lossStreakPauseMin} min after {data.settings.values.risk.lossStreakCount}){streak?.pauseUntil ? ` · paused until ${utc(streak.pauseUntil)}` : ""}</p>
              <p className="mt-1">Broker status: <b style={{ color: C.ink }}>{a.brokerStatus ?? "—"}</b>{a.type ? ` · ${a.type}` : ""}</p>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// ---- Open positions --------------------------------------------------------------------------------

export function PositionsPanel({ data }: { data: StatusPayload }) {
  const trades = (data.worker?.snapshot?.trades ?? []) as TradeSnap[];
  const ccy = data.worker?.snapshot?.account?.currency ?? "";
  const maxHold = data.settings.values.strategy.maxHoldSec;
  return (
    <Card title={`Bot positions (${trades.length})`} right={<span className="text-xs" style={{ color: C.muted }}>target {data.settings.values.strategy.tpPips} executable pips · exit requested at {maxHold}s</span>}>
      {!trades.length ? <p className="text-sm" style={{ color: C.muted }}>No bot trade open or in flight.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: C.faint }}>
              <th className="py-1.5 pr-3">Pair</th><th className="pr-3">Side</th><th className="pr-3">Lots</th><th className="pr-3">Fill</th><th className="pr-3">Stop</th><th className="pr-3">Target</th><th className="pr-3">At stop / target</th><th className="pr-3">Elapsed</th><th className="pr-3">Open P&amp;L</th><th className="pr-3">State</th>
            </tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t" style={{ borderColor: C.line }}>
                  <td className="py-2 pr-3 font-semibold" style={{ color: C.ink }}>{t.pair}</td>
                  <td className="pr-3 font-semibold" style={{ color: t.side === "buy" ? C.green : C.red }}>{t.side.toUpperCase()}</td>
                  <td className="pr-3 tabular-nums">{num(t.lots, 2)}</td>
                  <td className="pr-3 tabular-nums">{t.fill ?? "—"}</td>
                  <td className="pr-3 tabular-nums">{t.stop ?? "—"} <span style={{ color: C.muted }}>({num(t.stopPips)}p)</span></td>
                  <td className="pr-3 tabular-nums">{t.target ?? "—"} <span style={{ color: C.muted }}>(+{num(t.targetPips)}p)</span></td>
                  <td className="pr-3 tabular-nums">{money(t.riskCash, ccy)}<span className="block text-xs" style={{ color: C.muted }}>at target {money(t.estNetAtTarget)}</span></td>
                  <td className="pr-3 tabular-nums">{t.elapsedSec != null ? `${t.elapsedSec}s / ${maxHold}s` : "—"}</td>
                  <td className="pr-3 tabular-nums" style={{ color: pnlColor(t.unrealized) }}>{money(t.unrealized)}</td>
                  <td className="pr-3 text-xs">
                    <span style={{ color: t.state === "uncertain" ? C.amber : C.ink }}>{t.state}</span>
                    {t.state === "open" && <span style={{ color: t.protection === "verified" ? C.green : t.protection === "failed" ? C.red : C.amber }}> · {t.protection === "verified" ? "protected" : t.protection === "failed" ? "protection failed" : "checking stop/target"}</span>}
                    {t.closeReason && <span style={{ color: C.muted }}> · {t.closeReason.replace(/_/g, " ")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs" style={{ color: C.muted }}>The 120-second exit is requested at that time whatever the P&amp;L and kept requesting until the broker confirms; it is not a guaranteed maximum. The stop or the time exit can close a trade before it reaches the target.</p>
        </div>
      )}
    </Card>
  );
}

// ---- Pairs ------------------------------------------------------------------------------------------

function Checks({ title, c, active }: { title: string; c: SideChecks; active: boolean }) {
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: active ? C.blueLine : C.line }}>
      <p className="text-xs font-semibold" style={{ color: active ? C.blue : C.muted }}>{title}</p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {(Object.keys(CHECK_LABELS) as Array<keyof SideChecks>).map((k) => (
          <li key={k} style={{ color: c[k] ? C.green : C.muted }}>{c[k] ? "✓" : "·"} {CHECK_LABELS[k]}</li>
        ))}
      </ul>
    </div>
  );
}

export function PairsPanel({ data }: { data: StatusPayload }) {
  const pairs = (data.worker?.snapshot?.pairs ?? []) as PairSnap[];
  const [open, setOpen] = useState<string | null>(null);
  if (!pairs.length) return <Card title="Pairs"><p className="text-sm" style={{ color: C.muted }}>The worker has not reported the pairs yet.</p></Card>;
  return (
    <Card title="Pairs" right={<span className="text-xs" style={{ color: C.muted }}>costs = spread + round-trip commission + other + slippage allowance</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: C.faint }}>
            <th className="py-1.5 pr-3">Pair</th><th className="pr-3">Bid / Ask</th><th className="pr-3">Spread</th><th className="pr-3">Costs</th><th className="pr-3">Quote</th><th className="pr-3">Last candle</th><th className="pr-3">Signal</th>
          </tr></thead>
          <tbody>
            {pairs.map((p) => {
              const over = p.costs?.total != null && p.costs.total > p.costs.max;
              const ev = p.eval;
              const lean = ev?.buy.m1Trend ? "buy" : ev?.sell.m1Trend ? "sell" : null;
              return (
                <Fragment key={p.pair}>
                  <tr className="cursor-pointer border-t align-top hover:bg-[#FAFCFF]" style={{ borderColor: C.line }} onClick={() => setOpen(open === p.pair ? null : p.pair)}>
                    <td className="py-2 pr-3">
                      <span className="font-semibold" style={{ color: p.enabled ? C.ink : C.faint }}>{p.label}</span>
                      <span className="block text-xs" style={{ color: p.status === "ready" ? C.muted : C.red }}>{p.status === "ready" ? p.brokerSymbol : p.problem}</span>
                      {!p.enabled && <span className="block text-xs" style={{ color: C.faint }}>switched off</span>}
                    </td>
                    <td className="pr-3 tabular-nums">{px(p.bid, p.decimals)} / {px(p.ask, p.decimals)}</td>
                    <td className="pr-3 tabular-nums">{num(p.spreadPips)}p</td>
                    <td className="pr-3 tabular-nums" style={{ color: over ? C.red : C.ink }}>{p.costs?.total != null ? `${num(p.costs.total, 2)}p` : "—"}<span className="block text-xs" style={{ color: C.muted }}>max {p.costs?.max ?? data.settings.values.pairs[p.pair]?.maxCostPips}p</span></td>
                    <td className="pr-3 text-xs" style={{ color: C.muted }}>{ago(p.quoteAgeMs)}<span className="block">{p.quoteLatencyMs != null ? `${p.quoteLatencyMs} ms` : ""}</span></td>
                    <td className="pr-3 text-xs" style={{ color: C.muted }}>{p.barT ? utc(p.barT).slice(0, 5) : "—"}<span className="block">{p.barLagMs != null ? `in ${(p.barLagMs / 1000).toFixed(1)}s` : ""}</span></td>
                    <td className="pr-3 text-xs" style={{ color: ev?.status === "signal" ? C.blue : C.ink }}>
                      {p.decision ? p.decision.text : ev?.reason ?? "—"}
                      {lean && ev?.status !== "signal" && <span className="block" style={{ color: C.muted }}>trend: {lean === "buy" ? "up" : "down"}</span>}
                    </td>
                  </tr>
                  {open === p.pair && (
                    <tr style={{ background: "#FAFCFF" }}>
                      <td colSpan={7} className="px-2 py-3">
                        {ev ? (
                          <div className="grid gap-3 md:grid-cols-3">
                            <Checks title="BUY rules" c={ev.buy} active={lean === "buy"} />
                            <Checks title="SELL rules" c={ev.sell} active={lean === "sell"} />
                            <div className="text-xs" style={{ color: C.muted }}>
                              <p>Candle {utc(ev.candleT).slice(0, 5)} · EMA50 {num(ev.values.ema50, 5)} · EMA100 {num(ev.values.ema100, 5)}</p>
                              <p>Slow %K {num(ev.values.kPrev)} → {num(ev.values.k)} · %D {num(ev.values.d)}</p>
                              <p>ATR14 {num(ev.values.atr, 5)} · M5 EMA20 {num(ev.values.m5Fast, 5)} / EMA50 {num(ev.values.m5Slow, 5)} (3 back {num(ev.values.m5FastBack, 5)})</p>
                              {p.costs && <p className="mt-1">Costs: spread {p.costs.spread} + commission {p.costs.commission ?? "not set"} + other {p.costs.other} + slippage {p.costs.slippage} pips</p>}
                              {p.revisions > 0 && <p className="mt-1" style={{ color: C.amber }}>{p.revisions} candle revision(s) after a decision</p>}
                              {p.notes.map((n, i) => <p key={i} className="mt-1">{n}</p>)}
                              {p.candidates.length > 1 && <p className="mt-1">Symbols on this account: {p.candidates.join(", ")}</p>}
                            </div>
                          </div>
                        ) : <p className="text-xs" style={{ color: C.muted }}>No evaluation yet.</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---- Results ------------------------------------------------------------------------------------------

function SummaryRow({ label, s, ccy }: { label: string; s: Summary; ccy: string }) {
  return (
    <tr className="border-t" style={{ borderColor: C.line }}>
      <td className="py-2 pr-3 font-semibold" style={{ color: C.ink }}>{label}</td>
      <td className="pr-3 tabular-nums">{s.trades}{s.unpriced ? <span style={{ color: C.amber }}> ({s.unpriced} unpriced)</span> : null}</td>
      <td className="pr-3 tabular-nums">{s.wins} / {s.losses}</td>
      <td className="pr-3 tabular-nums" style={{ color: pnlColor(s.gross) }}>{money(s.gross, ccy)}</td>
      <td className="pr-3 tabular-nums">{money(-s.charges, ccy)}</td>
      <td className="pr-3 font-semibold tabular-nums" style={{ color: pnlColor(s.net) }}>{money(s.net, ccy)}</td>
      <td className="pr-3 tabular-nums">{num(s.closedLots, 2)}</td>
      <td className="pr-3 tabular-nums">{num(s.eligibleLots, 2)}</td>
    </tr>
  );
}

export function ResultsPanel({ data }: { data: StatusPayload }) {
  const ccy = data.worker?.snapshot?.account?.currency ?? data.control.account_currency ?? "";
  const comp = data.compensation;
  const combined = data.results.all.net + comp.paid - comp.reversed;
  return (
    <Card title="Results (closed bot trades, from actual fills)">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: C.faint }}>
            <th className="py-1.5 pr-3"></th><th className="pr-3">Trades</th><th className="pr-3">Won / lost</th><th className="pr-3">Gross</th><th className="pr-3">Charges</th><th className="pr-3">Net</th><th className="pr-3">Closed lots</th><th className="pr-3">Eligible lots</th>
          </tr></thead>
          <tbody>
            <SummaryRow label="Today" s={data.results.today} ccy={ccy} />
            <SummaryRow label="All time" s={data.results.all} ccy={ccy} />
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Compensation (estimate)" value={money(comp.estimated, ccy)} sub={comp.termsEntered ? "from the entered terms" : "terms not entered → 0"} />
        <Stat label="Broker-confirmed" value={money(comp.confirmed, ccy)} />
        <Stat label="Paid" value={money(comp.paid, ccy)} />
        <Stat label="Reversed" value={money(comp.reversed, ccy)} />
        <Stat label="Trading net + paid − reversed" value={money(combined, ccy)} color={pnlColor(combined)} />
      </div>
      <p className="mt-2 text-xs" style={{ color: C.muted }}>Trading results and compensation are kept apart: compensation never turns a losing trade into a winning one. Charges are the configured commission and other charges per lot; the spread and slippage are already in the fill prices.</p>
    </Card>
  );
}

export function RecentTradesPanel({ data }: { data: StatusPayload }) {
  const rows = data.trades.recent;
  const ccy = data.control.account_currency ?? "";
  return (
    <Card title="Recent bot trades">
      {!rows.length ? <p className="text-sm" style={{ color: C.muted }}>None yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: C.faint }}>
              <th className="py-1.5 pr-3">When</th><th className="pr-3">Pair</th><th className="pr-3">Side</th><th className="pr-3">Lots</th><th className="pr-3">Fill → exit</th><th className="pr-3">How it ended</th><th className="pr-3">Net</th>
            </tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-t" style={{ borderColor: C.line }}>
                  <td className="py-2 pr-3 text-xs" style={{ color: C.muted }}>{new Date(t.created_at).toISOString().slice(5, 16).replace("T", " ")}</td>
                  <td className="pr-3 font-semibold">{t.pair}</td>
                  <td className="pr-3" style={{ color: t.side === "buy" ? C.green : C.red }}>{t.side.toUpperCase()}</td>
                  <td className="pr-3 tabular-nums">{num(t.filled_qty ?? t.qty, 2)}</td>
                  <td className="pr-3 tabular-nums">{t.fill_price ?? "—"} → {t.exit_price ?? "—"}</td>
                  <td className="pr-3 text-xs">{t.state === "closed" ? (t.close_reason ?? "closed").replace(/_/g, " ") : `${t.state.replace(/_/g, " ")}${t.error ? `: ${t.error}` : ""}`}</td>
                  <td className="pr-3 tabular-nums" style={{ color: pnlColor(t.net_pnl) }}>{t.state === "closed" ? (t.pnl_final ? money(t.net_pnl, ccy) : "pending") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---- Health and journal ---------------------------------------------------------------------------------

export function HealthPanel({ data }: { data: StatusPayload }) {
  const h = data.worker?.snapshot?.health;
  const w = data.worker?.snapshot?.worker;
  const conn = data.worker?.snapshot?.connection;
  if (!h) return <Card title="Health"><p className="text-sm" style={{ color: C.muted }}>The worker has not reported yet.</p></Card>;
  return (
    <Card title="Health">
      <div className="grid gap-4 text-sm md:grid-cols-2">
        <div className="space-y-1" style={{ color: C.muted }}>
          <p>Worker: <b style={{ color: C.ink }}>{data.worker?.worker ?? "—"}</b> · lease fence {w?.fence ?? "—"} · started {w?.startedAt ? utc(w.startedAt) : "—"}</p>
          <p>Broker session: <b style={{ color: conn?.status === "connected" ? C.green : C.red }}>{conn?.status ?? "none"}</b>{conn?.server ? ` · ${conn.server} · ${conn.emailMasked}` : ""}{conn?.error ? ` · ${conn.error}` : ""}</p>
          <p>Reconciliation: <b style={{ color: h.reconciled ? C.green : C.amber }}>{h.reconciled ? "clean" : "pending"}</b> · {h.reconcileNote}</p>
          <p>Order size convention (lots): <b style={{ color: h.qtyCheck.state === "verified" ? C.green : h.qtyCheck.state === "contradicted" ? C.red : C.ink }}>{h.qtyCheck.state}</b> · {h.qtyCheck.detail}</p>
          <p>Slippage allowance: configured {h.slippage.configured}p · measured {h.slippage.observed ?? "—"}p · in use <b style={{ color: C.ink }}>{h.slippage.used}p</b></p>
          <p>Bot orders today: {h.ordersToday}{h.maxOrdersCount ? ` (broker cap ${h.maxOrdersCount} orders/day, all tools)` : ""} · requests queued {h.queued}</p>
          {h.protectionAlarm && <p style={{ color: C.red }}>{h.protectionAlarm}</p>}
          {h.settingsWarnings.map((x, i) => <p key={i} style={{ color: C.amber }}>{x}</p>)}
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: C.faint }}>Broker requests (latency p50 / p95, errors, rate-limited)</p>
          <table className="mt-1 w-full text-xs tabular-nums">
            <tbody>
              {Object.entries(h.latency).sort().map(([k, v]) => (
                <tr key={k} className="border-t" style={{ borderColor: C.line }}>
                  <td className="py-1 pr-2" style={{ color: C.ink }}>{k}</td>
                  <td className="pr-2">{v.p50 ?? "—"} / {v.p95 ?? "—"} ms</td>
                  <td className="pr-2" style={{ color: v.errors ? C.red : C.muted }}>{v.errors} err</td>
                  <td className="pr-2" style={{ color: v.limited ? C.amber : C.muted }}>{v.limited} lim</td>
                  <td className="pr-2" style={{ color: C.muted }}>{v.window}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {h.errors.length > 0 && (
        <div className="mt-3 text-xs">
          <p className="font-semibold" style={{ color: C.red }}>Recent worker errors</p>
          {h.errors.map((e, i) => <p key={i} style={{ color: C.muted }}>{utc(e.at)} · {e.where}: {e.message}</p>)}
        </div>
      )}
    </Card>
  );
}

export function JournalPanel({ data }: { data: StatusPayload }) {
  const [filter, setFilter] = useState<"all" | "trades" | "problems">("all");
  const rows = data.events.filter((e) => filter === "all" || (filter === "problems" ? e.level !== "info" : ["order_acknowledged", "filled", "closed", "protected", "close_requested", "signal_skipped", "order_rejected", "order_uncertain"].includes(e.kind)));
  return (
    <Card title="Journal" right={
      <div className="flex gap-1 text-xs">
        {(["all", "trades", "problems"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className="rounded px-2 py-0.5" style={{ background: filter === f ? C.blueSoft : "transparent", color: filter === f ? C.blue : C.muted }}>{f}</button>
        ))}
      </div>
    }>
      <div className="max-h-[520px] space-y-1 overflow-y-auto text-xs">
        {rows.map((e) => (
          <p key={e.id} style={{ color: e.level === "error" ? C.red : e.level === "warn" ? C.amber : C.ink }}>
            <span style={{ color: C.faint }}>{new Date(e.at).toISOString().slice(5, 19).replace("T", " ")}</span> {e.pair ? <b>{e.pair} </b> : null}{e.message}
          </p>
        ))}
        {!rows.length && <p style={{ color: C.muted }}>Nothing yet.</p>}
      </div>
    </Card>
  );
}
