"use client";

import Link from "next/link";
import { ChevronRight, Activity, ArrowUpRight, Layers3, Mic, Sparkles, Waves } from "lucide-react";
import { ProductIcon } from "./ProductIcon";
import { openAtlas } from "@/lib/atlas/open";
import { CREDIT_COST } from "@/lib/creditConfig";

const tools = [
  { key: "plays", name: "OM AI Plays", line: "Choose a market. Get an entry, stop, and targets when a setup is available.", href: "/portal/signals", icon: Sparkles, action: "Build a play", cost: `${CREDIT_COST.signal} credits · included with FLOW Pass` },
  { key: "genx", name: "GENX", line: "Analyze gold with the engine’s rules, triggers, and invalidation levels.", href: "/portal/genx", icon: Layers3, action: "Analyze gold", cost: `${CREDIT_COST.genx} credits · included with FLOW Pass` },
  { key: "pulse", name: "Pulse", line: "Scan the markets for confirmations, then build a full play on your pick.", href: "/portal/trading?view=pulse", icon: Activity, action: "Scan markets", cost: `${CREDIT_COST.scan} credits per scan` },
] as const;

const context = { source: "tools", label: "Find a signal" };

export function ToolsHome() {
  return <div className="om-tools-home">
    <header><p className="om-label">AI-powered trading</p><h1>Find your next signal.</h1><p className="om-tools-intro">Your tools work together, with Atlas alongside you.</p></header>

    <a href="/command-center" className="om-gold-center-feature" aria-label="Open Atlas Gold Command Center">
      <div className="om-gold-center-art" aria-hidden="true"><svg viewBox="0 0 200 200" fill="none"><circle cx="100" cy="100" r="83"/><circle cx="100" cy="100" r="62"/><circle cx="100" cy="100" r="40"/><path d="M100 6v188M6 100h188M34 34l132 132M166 34L34 166" strokeDasharray="3 9"/><path d="M100 34l48 93H52z" strokeWidth="1.5"/><circle cx="100" cy="100" r="9" fill="currentColor" stroke="none"/></svg></div>
      <div className="om-gold-center-feature-top"><ProductIcon kind="atlas" size="md"/><span>ATLAS / XAUUSD</span><ArrowUpRight aria-hidden="true"/></div>
      <div className="om-gold-center-feature-body"><span>GOLD INTELLIGENCE</span><h2>Gold Command Center</h2><p>Live market direction, interactive gold charts and Atlas-generated trade setups.</p></div>
      <div className="om-gold-center-feature-bottom"><span><Activity size={15} aria-hidden="true"/> Market read</span><span><Sparkles size={15} aria-hidden="true"/> Generate signal</span><strong>Open <ChevronRight size={16} aria-hidden="true"/></strong></div>
    </a>

    <section className="om-tools-start" aria-label="Start with Atlas">
      <div className="om-tools-start-heading"><ProductIcon kind="atlas" size="md" /><div><h2>Start with Atlas</h2><p>Tell Atlas what you want to trade. Build and review the signal right here.</p></div></div>
      <div className="om-tools-start-actions">
        <button type="button" className="om-btn" onClick={() => openAtlas({ voice: true, context })}><Mic width={17} height={17} aria-hidden="true" />Talk to Atlas</button>
        <button type="button" className="om-btn-quiet" onClick={() => openAtlas({ context })}>Ask a question<ChevronRight width={15} height={15} aria-hidden="true" /></button>
      </div>
      <ol className="om-signal-journey" aria-label="From idea to trade">
        <li><span aria-hidden="true">1</span>Find a signal</li>
        <li><span aria-hidden="true">2</span>Review the setup</li>
        <li><span aria-hidden="true">3</span>Confirm execution</li>
      </ol>
    </section>

    <Link href="/portal/strata" className="om-tools-atlas" style={{ margin: "0 0 18px", display: "flex", gap: 13, alignItems: "center", padding: "18px", borderRadius: 16, border: "1px solid var(--om-edge)", background: "rgb(var(--om-ai-rgb) / .065)", textDecoration: "none" }}>
      <ProductIcon kind="strata" size="md" />
      <span style={{ flex: "1 1 auto" }}><span className="om-label">NEW · PRICE ACTION AI</span><strong style={{ display:"block",fontSize:18,marginTop:3,color:"var(--om-text)" }}>STRATA</strong>
        <small style={{ display:"block",color:"var(--om-text-2)",marginTop:4 }}>Gold structure, break-and-retest setups, range reversals, and paper automation.</small>
      </span><ChevronRight aria-hidden="true" />
    </Link>
    <div className="om-tools-list om-connected-tools" role="group" aria-label="Signal tools">
      {tools.map(({ key, name, line, href, icon: Icon, action, cost }) => <article key={key}>
        <Link href={href} className="om-tool-destination">
          <span className="om-tools-symbol"><Icon aria-hidden="true" /></span>
          <span><strong>{name}</strong><small>{line}</small></span>
          <ChevronRight aria-hidden="true" />
        </Link>
        <div className="om-tool-action">
          <button type="button" className="om-btn-quiet" onClick={() => openAtlas({ tool: key, context })}>{action}<ArrowUpRight width={14} height={14} aria-hidden="true" /></button>
          <span>{cost}</span>
        </div>
      </article>)}
    </div>

    <div className="om-tools-connections">
      <Link className="om-tools-atlas" href="/portal/trading?view=flow"><Waves aria-hidden="true" /><span>Connected accounts and risk<strong>Manage FLOW</strong></span><ChevronRight aria-hidden="true" /></Link>
    </div>
  </div>;
}

