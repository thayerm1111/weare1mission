"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { IllustrativeChart } from "./IllustrativeChart";

export const PRODUCT_KEYS = ["floor", "atlas", "genx", "plays", "pulse", "flow"] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];
type MarketKey = "gold" | "eurusd" | "btcusd";
type Product = {
  name: string;
  icon: string;
  headline: string;
  description: string;
  href: string;
  cta: string;
  labels: readonly string[];
};

export const PRODUCTS: Record<ProductKey, Product> = {
  floor: {
    name: "The Floor", icon: "grid", headline: "Your whole session, in focus.",
    description: "Market charts, Atlas, GENX results and your FLOW activity, together on one clear screen.",
    href: "/portal/trading", cta: "Open The Floor",
    labels: ["Market overview", "Gold intelligence", "Connected accounts"],
  },
  atlas: {
    name: "Atlas", icon: "atlas", headline: "Understand the story behind gold.",
    description: "Ask questions, explore key levels and follow conditional scenarios in the Atlas Command Center.",
    href: "/command-center", cta: "Open Command Center",
    labels: ["Plain-language analysis", "Chart context", "Text & voice"],
  },
  genx: {
    name: "GENX", icon: "gold", headline: "Gold intelligence, with a clear plan.",
    description: "Explore the engine’s read, the conditions it is watching, and the record of its trades.",
    href: "/portal/genx", cta: "Open GENX",
    labels: ["Gold analysis", "Entry conditions", "Recorded results"],
  },
  plays: {
    name: "OM AI Plays", icon: "spark", headline: "Choose a market. Build your analysis.",
    description: "A clear path from a supported market and trading style to a structured AI-generated setup.",
    href: "/portal/signals", cta: "Open OM AI Plays",
    labels: ["Choose a market", "Set your style", "Generate a play"],
  },
  pulse: {
    name: "Market Pulse", icon: "pulse", headline: "A wider view. A sharper focus.",
    description: "Explore ranked markets, understand the read, and choose where to take a closer look.",
    href: "/portal/trading?view=pulse", cta: "Open Market Pulse",
    labels: ["Market scan", "Ranked candidates", "Analysis context"],
  },
  flow: {
    name: "FLOW", icon: "flow", headline: "Your accounts. Your execution settings.",
    description: "Connect supported accounts, review source permissions and follow your positions and results.",
    href: "/portal/trading?view=flow", cta: "Open FLOW",
    labels: ["Account connection", "Execution settings", "Personal results"],
  },
};

function Icon({ name }: { name: string }) {
  return <svg className="icon" aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}

export function ProductPreview({ product, onSelectProduct }: {
  product: ProductKey;
  onSelectProduct: (product: ProductKey) => void;
}) {
  const [requestedMarket, setRequestedMarket] = useState<MarketKey | null>(null);

  useEffect(() => {
    if (product !== "plays") setRequestedMarket(null);
  }, [product]);

  if (product === "floor" || product === "atlas" || product === "genx") {
    return <ChartStage key={product} kind={product} />;
  }
  if (product === "plays") return <PlaysPreview initialMarket={requestedMarket ?? "gold"} focusStyle={requestedMarket !== null} />;
  if (product === "pulse") return <PulsePreview onChoose={(market) => { setRequestedMarket(market); onSelectProduct("plays"); }} />;
  return <FlowPreview />;
}

const CHART_COPY = {
  atlas: {
    title: "Atlas’s read", icon: "atlas", read: "The pullback is testing support. The next close matters.",
    firstLabel: "What changed", first: "Momentum slowed as price returned to a watched area.",
    nextLabel: "Watching next", next: "A confirmed response at support, or a close below it.",
    footerA: "Scenarios", footerAV: "Conditional, with context", footerB: "Ask Atlas", footerBV: "Explore the Command Center",
  },
  genx: {
    title: "GENX · Gold intelligence", icon: "gold", read: "A setup forming. A clear condition to watch.",
    firstLabel: "Current stage", first: "Watching for a confirmed response at a key level.",
    nextLabel: "The plan", next: "Entry conditions, stop and targets are shown with the read.",
    footerA: "GENX record", footerAV: "Explore the trade history", footerB: "Your account", footerBV: "Execution settings in FLOW",
  },
  floor: {
    title: "Atlas", icon: "atlas", read: "A clearer view of what matters next.",
    firstLabel: "Gold intelligence", first: "Understand the current read and the levels behind it.",
    nextLabel: "Your workspace", next: "Move from analysis to your connected account activity.",
    footerA: "GENX results", footerAV: "The engine’s recorded trades", footerB: "My FLOW", footerBV: "Your account’s activity",
  },
};

function ChartStage({ kind }: { kind: "floor" | "atlas" | "genx" }) {
  const copy = CHART_COPY[kind];
  return <>
    <div className="demo-layout">
      <IllustrativeChart />
      <aside className="demo-sidebar">
        <h4><Icon name={copy.icon} />{copy.title}</h4>
        <p className="read">{copy.read}</p>
        <div className="demo-detail"><span>{copy.firstLabel}</span><p>{copy.first}</p></div>
        <div className="demo-detail"><span>{copy.nextLabel}</span><p>{copy.next}</p></div>
        <div className="demo-input">Illustrative product experience <Icon name="spark" /></div>
      </aside>
    </div>
    <div className="demo-footer">
      <div className="mini-stat"><span>{copy.footerA}</span><strong>{copy.footerAV}</strong></div>
      <div className="mini-stat"><span>{copy.footerB}</span><strong>{copy.footerBV}</strong></div>
    </div>
  </>;
}

const MARKETS: { key: MarketKey; label: string; name: string; symbol: string; focus: string; width: string }[] = [
  { key: "gold", label: "Gold · XAU / USD", name: "Gold", symbol: "XAU / USD", focus: "Watching support", width: "85%" },
  { key: "eurusd", label: "Euro · EUR / USD", name: "Euro", symbol: "EUR / USD", focus: "Range conditions", width: "64%" },
  { key: "btcusd", label: "Bitcoin · BTC / USD", name: "Bitcoin", symbol: "BTC / USD", focus: "Momentum shift", width: "46%" },
];

function PlaysPreview({ initialMarket, focusStyle }: { initialMarket: MarketKey; focusStyle: boolean }) {
  const [market, setMarket] = useState(initialMarket);
  const [style, setStyle] = useState("Intraday");
  const [preview, setPreview] = useState<{ label: string; style: string } | null>(null);
  const styleRef = useRef<HTMLSelectElement>(null);

  useEffect(() => { if (focusStyle) styleRef.current?.focus({ preventScroll: true }); }, [focusStyle]);

  return <>
    <div className="stage-intro"><h3>Your next play starts here.</h3><p>Try the steps. This preview does not generate a live signal or use credits.</p></div>
    <div className="play-builder">
      <div className="builder-fields">
        <label><span>1. Choose your market</span><select id="demo-market" value={market} onChange={(event) => setMarket(event.target.value as MarketKey)}>
          {MARKETS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select></label>
        <label><span>2. Choose your style</span><select id="demo-style" ref={styleRef} value={style} onChange={(event) => setStyle(event.target.value)}>
          <option>Intraday</option><option>Scalp</option><option>Swing</option>
        </select></label>
        <button type="button" id="preview-play" className="button button-light" onClick={() => setPreview({ label: MARKETS.find((option) => option.key === market)!.label, style })}>
          <span key={preview ? "again" : "first"}>{preview ? "Preview another play" : "3. Preview a play"}</span> <Icon name="spark" />
        </button>
        <p>Live analysis and its credit cost are available inside OM AI Plays.</p>
      </div>
      <div className="play-result" id="play-result" aria-live="polite">
        <Fragment key={preview ? `${preview.label}:${preview.style}` : "empty"}>
        {preview ? <>
          <span className="ready-tag">ILLUSTRATIVE PLAY</span><h4>{preview.label}</h4>
          <p>{preview.style} · A structured view of the setup and the conditions to watch.</p>
          <div className="example-levels">
            <div><span>Entry</span><strong>On confirmation</strong></div>
            <div><span>Stop</span><strong>Defined by structure</strong></div>
            <div><span>Targets</span><strong>Shown in the plan</strong></div>
          </div>
          <p className="demo-disclaimer">Example only. No market analysis was run, no credits were used and no order was placed.</p>
        </> : <><Icon name="spark" /><h4>A clear path to your analysis.</h4><p>Select a market and style, then preview how a structured play is presented.</p></>}
        </Fragment>
      </div>
    </div>
  </>;
}

function PulsePreview({ onChoose }: { onChoose: (market: MarketKey) => void }) {
  return <>
    <div className="pulse-demo-head"><h3>Find a market to explore.</h3><p>Example scan layout. These are illustrative candidates, not current rankings.</p></div>
    <table className="pulse-table">
      <thead><tr><th>Rank</th><th>Market</th><th>Focus</th><th>Read</th><th><span className="sr-only">Action</span></th></tr></thead>
      <tbody>{MARKETS.map((market, index) => <tr key={market.key}>
        <td>0{index + 1}</td><td>{market.name}<small>{market.symbol}</small></td><td>{market.focus}</td>
        <td><div className="pulse-rank"><span><i style={{ width: market.width }} /></span></div></td>
        <td><button type="button" className="button button-outline" onClick={() => onChoose(market.key)} aria-label={`Preview ${market.name} in OM AI Plays`}>Preview</button></td>
      </tr>)}</tbody>
    </table>
    <p className="demo-disclaimer">Inside the platform, check the read’s timestamp and context before exploring a setup.</p>
  </>;
}

function FlowPreview() {
  return <>
    <div className="demo-account">
      <div><h3>Your trading account</h3><small>Supported broker · Account details stay private</small></div>
      <div className="account-amounts"><span>Balance<strong>••••••</strong></span><span>Equity<strong>••••••</strong></span></div>
    </div>
    <div className="flow-demo-layout">
      <div className="flow-demo-box"><h4>Execution, on your terms.</h4>
        <div className="account-result"><span>Eligible signal sources</span><strong>Your selection</strong></div>
        <div className="account-result"><span>Risk per trade</span><strong>Your settings</strong></div>
        <div className="account-result"><span>Trade management</span><strong>Account-specific</strong></div>
        <span className="state-chip">Connection and trading are separate</span>
      </div>
      <div className="flow-demo-box"><h4>Follow your account.</h4>
        <div className="account-result"><span>Realized P&L</span><strong>Closed positions</strong></div>
        <div className="account-result"><span>Open P&L</span><strong>Current positions</strong></div>
        <div className="account-result"><span>Execution history</span><strong>Account activity</strong></div>
        <span className="state-chip">Illustrative account preview</span>
      </div>
    </div>
  </>;
}

export function OverviewChapter({ product }: { product: ProductKey }) {
  const item = PRODUCTS[product];
  return <><Icon name={item.icon} /><h3>{item.name}</h3><p>{item.description}</p><div className="tour-labels">{item.labels.map((label) => <span key={label}>{label}</span>)}</div></>;
}
