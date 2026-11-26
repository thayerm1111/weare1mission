"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import type { TimedBar } from "@/lib/chart/candleTime";
import { completedBrokerBars, type FlowPositionChart as BrokerSnapshot } from "@/lib/flow/positionChart";
import type { ChartLevel } from "@/lib/floor/chart";
import { ageText, FIGURES_FRESH_MS, money, type FloorAccount, type FlowPosition } from "@/lib/floor/overview";
import { decimalsFor, pairName, priceFor } from "@/lib/flow/display";
import "./flow-position-chart.css";

const FIVE_MINUTES = 300_000;
type Props = {
  accountId: string; environment: FloorAccount["environment"]; position: FlowPosition;
  currency: string | null; hide: boolean; simple: boolean; now: number;
};
type Snapshot = {
  observedAt: string; brokerSymbol: string | null; bars: TimedBar[]; levels: ChartLevel[]; pnl: number | null;
};
type Reading = { key: string; snapshot: Snapshot | null };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function FlowPositionChart({ accountId, environment, position, currency, hide, simple, now }: Props) {
  const { id, symbol, side } = position;
  const key = JSON.stringify([environment, accountId, id, symbol, side]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [attempt, retry] = useState(0);

  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    const clear = () => {
      request?.abort();
      request = null;
      setReading({ key, snapshot: null });
    };
    const read = async () => {
      if (navigator.onLine === false) { clear(); return; }
      if (document.hidden || request) return;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await fetch("/api/flow/position-chart", {
          method: "GET", cache: "no-store", signal: controller.signal,
          headers: { "x-floor-account": accountId, "x-floor-env": environment, "x-flow-position": id },
        });
        if (!response.ok) throw new Error("Position unavailable");
        const data: Partial<BrokerSnapshot> | null = await response.json();
        const observed = Date.parse(data?.observedAt ?? "");
        if (data?.accountId !== accountId || data?.environment !== environment || data?.positionId !== id
          || data.symbol !== symbol || data.side !== side || !data.observedAt || !Number.isFinite(observed) || !Array.isArray(data.bars)) {
          throw new Error("Position unavailable");
        }
        const levels: ChartLevel[] = [];
        if (finite(data.entry) && data.entry > 0) levels.push({ kind: "entry", label: "Broker fill", price: data.entry });
        if (finite(data.stop) && data.stop > 0) levels.push({ kind: "stop", label: "Broker stop", price: data.stop });
        if (finite(data.target) && data.target > 0) levels.push({ kind: "target", label: "Broker target", price: data.target });
        const bars = completedBrokerBars(data.bars, observed);
        if (active && request === controller && !controller.signal.aborted) {
          setReading({ key, snapshot: {
            observedAt: data.observedAt, brokerSymbol: data.brokerSymbol?.trim() || null, levels, bars,
            pnl: finite(data.unrealizedPnl) ? data.unrealizedPnl : null,
          } });
        }
      } catch {
        if (active && request === controller) setReading({ key, snapshot: null });
      } finally {
        clearTimeout(timeout);
        if (request === controller) request = null;
      }
    };
    void read();
    const timer = setInterval(read, 60_000);
    window.addEventListener("online", read);
    window.addEventListener("offline", clear);
    return () => {
      active = false;
      request?.abort();
      clearInterval(timer);
      window.removeEventListener("online", read);
      window.removeEventListener("offline", clear);
    };
  }, [key, accountId, environment, id, symbol, side, attempt]);

  const current = reading?.key === key ? reading : null;
  const snapshot = current?.snapshot;
  const last = snapshot?.bars.at(-1);
  const clock = now || Date.now();
  const displaySymbol = snapshot?.brokerSymbol || pairName(symbol);
  const stale = snapshot && clock - Date.parse(snapshot.observedAt) > FIGURES_FRESH_MS;
  const SideIcon = side === "buy" ? ArrowUpRight : ArrowDownRight;
  return <section className="om-flow-position-chart" aria-label="Broker position chart">
    <header>
      <div className="om-flow-position-heading">
        <span className="om-flow-position-direction" data-side={side}><SideIcon size={19} aria-hidden="true"/></span>
        <div><strong data-no-i18n translate="no">{displaySymbol}</strong><small>{side === "buy" ? "Buy" : "Sell"} position</small></div>
      </div>
      {snapshot && <div className="om-flow-position-profit">
        <small>{stale ? "P&L at snapshot" : "Open P&L"}</small><strong data-no-i18n translate="no" data-tone={hide || snapshot.pnl == null || snapshot.pnl === 0 ? undefined : snapshot.pnl > 0 ? "up" : "down"}>
          {hide ? "••••" : money(snapshot.pnl, currency, { sign: true })}
        </strong>
      </div>}
    </header>
    {snapshot ? <>
      {last && snapshot.bars.length >= 2 ? <div className="om-flow-position-plot">
        <OmChart bars={snapshot.bars} timeKnown tfMs={FIVE_MINUTES} tfLabel="5m" price={last.c} priceLabel="Last candle close"
          priceLive={false} snapshot simpleView={simple} framing={simple ? "setup" : "context"}
          dec={decimalsFor(symbol, last.c)} levels={snapshot.levels} fitLevels viewKey={key}
          label={`${displaySymbol} ${side} position, broker candles and reported levels`} />
      </div> : <>
        <p className="om-flow-position-status">Broker candles unavailable.</p>
        {snapshot.levels.length > 0 && <dl className="om-flow-confirmed-levels">{snapshot.levels.map(level =>
          <div key={level.kind}><dt>{level.label}</dt><dd data-no-i18n translate="no">{priceFor(symbol, level.price)}</dd></div>
        )}</dl>}
      </>}
      <footer><time dateTime={snapshot.observedAt} title={new Date(snapshot.observedAt).toLocaleString()}>Broker snapshot · {ageText(snapshot.observedAt, clock)}</time>
        {last && <time dateTime={new Date(last.t + FIVE_MINUTES).toISOString()}>Candle closed {ageText(new Date(last.t + FIVE_MINUTES).toISOString(), clock)}</time>}
      </footer>
    </> : <div className="om-flow-position-status" role="status">
      {current ? <>Broker position chart unavailable.<button type="button" onClick={() => { setReading(null); retry(value => value + 1); }}><RefreshCw size={14} aria-hidden="true"/> Retry</button></> : "Reading broker snapshot…"}
    </div>}
  </section>;
}
