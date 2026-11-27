import "./boost-meter.css";

export type BoostState = "standby" | "live" | "checking" | "demo";

export function NitrousBoostMeter({ state, side, count }: {
  state: BoostState; side: "buy" | "sell" | null; count: number;
}) {
  const active = state === "live";
  const title = active ? "Nitrous activated" : state === "demo" ? "Demo mode" : state === "checking" ? "Checking position" : "Standby";
  const detail = active
    ? count === 1 ? `XAU/USD · ${side === "sell" ? "Sell" : "Buy"} trade open` : `XAU/USD · ${count} open trades`
    : state === "checking" ? "Awaiting broker confirmation" : state === "demo" ? "Simulated account" : "No open trade";

  return <div className="nt-boost" data-state={state}>
    <div className="nt-boost__dial" aria-hidden="true">
      <i className="nt-boost__scale" /><i className="nt-boost__ticks" />
      <i className="nt-boost__needle" /><span className="nt-boost__hub" /><b>N₂O</b>
    </div>
    <div className="nt-boost__readout" role="status" aria-live="polite" aria-atomic="true">
      <strong>{title}</strong><span>{detail}</span>
    </div>
    <div className="nt-boost__rail" aria-hidden="true"><i /></div>
  </div>;
}
