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
      <a className="om-tools-atlas" href="/command-center"><GlobeMark /><span>Atlas’s dedicated gold desk<strong>Gold Command Center</strong></span><ArrowUpRight aria-hidden="true" /></a>
      <Link className="om-tools-atlas" href="/portal/trading?view=flow"><Waves aria-hidden="true" /><span>Connected accounts and risk<strong>Manage FLOW</strong></span><ChevronRight aria-hidden="true" /></Link>
    </div>
  </div>;
}

function GlobeMark() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5c4 2 10 2 14 0M5 17.5c4-2 10-2 14 0" /></svg>;
}
