"use client";

import { useState } from "react";
import { Activity, ArrowUpRight, Check, Layers3, Loader2, Sparkles } from "lucide-react";
import { MARKETS, findAsset } from "@/data/signalAssets";
import { CREDIT_COST } from "@/lib/creditConfig";
import type { AtlasAction, AtlasDestination, AtlasStyle } from "@/lib/atlas/types";
import type { AtlasPulseResult } from "@/lib/atlas/pulse";

export const ATLAS_LINKS: Record<AtlasDestination, { href: string; label: string }> = {
  floor: { href: "/portal/trading", label: "OM OS" },
  plays: { href: "/portal/signals", label: "Saved OM AI Plays" },
  genx: { href: "/portal/genx", label: "GENX workspace" },
  pulse: { href: "/portal/trading?view=pulse", label: "Market Pulse" },
  flow: { href: "/portal/trading?view=flow", label: "FLOW accounts" },
  credits: { href: "/portal/credits", label: "Credits" },
  tools: { href: "/portal/tools", label: "All tools" },
  "command-center": { href: "/command-center", label: "Gold Command Center" },
};

export function AtlasActionCard({ action, busy, disabled, completed, pass, onRun, onNavigate }: {
  action: AtlasAction; busy: boolean; disabled: boolean; completed: boolean; pass: boolean;
  onRun: (action: AtlasAction) => void; onNavigate: (destination: AtlasDestination) => void;
}) {
  const [td, setTd] = useState(action.type === "plays" ? action.td ?? "" : "");
  const [style, setStyle] = useState<AtlasStyle>(action.type === "plays" ? action.style ?? "intraday" : "intraday");
  const [mode, setMode] = useState<"quick" | "intraday" | "swing">(action.type === "genx" ? action.mode ?? "quick" : "quick");
  if (action.type === "navigate") {
    return <button type="button" className="om-atlas-link" disabled={disabled} onClick={() => onNavigate(action.destination)}>{ATLAS_LINKS[action.destination].label}<ArrowUpRight aria-hidden="true" /></button>;
  }
  const kind = action.type;
  const Icon = kind === "plays" ? Sparkles : kind === "genx" ? Layers3 : Activity;
  const title = kind === "plays" ? "OM AI Plays" : kind === "genx" ? "GENX · Gold" : "Market Pulse";
  const covered = pass && kind !== "pulse";
  const cost = kind === "plays" ? CREDIT_COST.signal : kind === "genx" ? CREDIT_COST.genx : CREDIT_COST.scan;
  const verb = kind === "pulse" ? "Scan markets" : kind === "genx" ? "Analyze gold" : "Generate play";
  return <section className="om-atlas-action" aria-label={`${title} action`}>
    <header><Icon aria-hidden="true" /><div><strong>{title}</strong><p>{kind === "plays" ? "Choose a market. Get its entry, stop and targets when a setup qualifies." : kind === "genx" ? "A fresh read from the gold engine, with its trigger and invalidation." : "Find the markets with the most confirmations, then build a full play."}</p></div></header>
    {kind === "plays" && <div className="om-atlas-fields">
      <label>Market<select aria-label="Market for Atlas play" value={td} disabled={disabled || completed} onChange={(e) => setTd(e.target.value)}><option value="">Choose a market</option>{MARKETS.map((market) => <optgroup key={market.id} label={market.name}>{market.assets.map((asset) => <option key={asset.td} value={asset.td}>{asset.name} · {asset.symbol}</option>)}</optgroup>)}</select></label>
      <label>Style<select aria-label="Style for Atlas play" value={style} disabled={disabled || completed} onChange={(e) => setStyle(e.target.value as AtlasStyle)}><option value="scalp">Scalp</option><option value="intraday">Intraday</option><option value="swing">Swing</option></select></label>
    </div>}
    {kind === "genx" && <label className="om-atlas-mode">Horizon<select aria-label="GENX horizon in Atlas" value={mode} disabled={disabled || completed} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="quick">Quick · 5-minute chart</option><option value="intraday">Intraday · 15-minute chart</option><option value="swing">Swing · 1-hour chart</option></select></label>}
    {kind === "plays" && <p className="om-atlas-action-note">Institutional · Best confirmations · Limit entry</p>}
    <button type="button" className="om-atlas-primary" disabled={disabled || completed || (kind === "plays" && !findAsset(td))} onClick={() => onRun(kind === "plays" ? { type: "plays", td, style } : kind === "genx" ? { type: "genx", mode } : { type: "pulse" })}>
      {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : completed ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
      {busy ? kind === "pulse" ? "Scanning markets…" : "Reading the market…" : completed ? "Result added below" : `${verb} · ${covered ? "Included" : `${cost} credits`}`}
    </button>
    {!completed && <p className="om-atlas-action-note">{covered ? "Included with your FLOW Pass." : kind === "pulse" ? "The scan runs when you tap. It does not place an order." : "Included with FLOW Pass. A signal is generated only when you tap."}</p>}
  </section>;
}

export function AtlasPulseCard({ result, onPlay, onNavigate }: { result: AtlasPulseResult; onPlay: (td: string) => void; onNavigate: () => void }) {
  const date = Date.parse(result.asOf);
  return <section className="om-atlas-pulse" aria-label="Atlas market scan results">
    <header><Activity aria-hidden="true" /><div><h3>Your market scan</h3><p>{Number.isFinite(date) ? `Scanned ${new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : `Scan time: ${result.asOf || "unavailable"}`}</p></div></header>
    {result.setups.length === 0 ? <p>No qualifying candidates came back from this scan. There is no signal to act on.</p> : <><p>Ranked by the scanner’s confirmations. Choose a market for a full OM AI Play.</p><ol>{result.setups.slice(0, 6).map((setup) => <li key={setup.td}>
      <div><strong>{setup.symbol}</strong><span>{setup.dir === "LONG" ? "Long" : "Short"} lean · {setup.confirmed}/{setup.total} confirmations</span></div>
      <button type="button" onClick={() => onPlay(setup.td)}>Build play<ArrowUpRight aria-hidden="true" /></button>
    </li>)}</ol></>}
    <button type="button" className="om-atlas-link" onClick={onNavigate}>Open full scan<ArrowUpRight aria-hidden="true" /></button>
  </section>;
}
