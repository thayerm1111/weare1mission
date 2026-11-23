"use client";

import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Check, Minus, Waves } from "lucide-react";
import type { ReactNode } from "react";
import "./vision.css";

export type VisionBias = "buy" | "sell" | "range" | "mixed";
export type VisionFact = {
  label: string;
  value: string;
  tone?: "up" | "down" | "ok" | "watch" | "neutral";
};
const TITLES: Record<VisionBias, string> = {
  buy: "BULLISH", sell: "BEARISH", range: "RANGING", mixed: "MIXED",
};
const ICONS = { buy: ArrowUpRight, sell: ArrowDownRight, range: ArrowLeftRight, mixed: Waves };
const px = (n: number | null | undefined, dec: number) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** Shared visual language only. It never computes, confirms or places a trade. */
export function VisionDirection({ product, bias, tagline, score, scoreName = "ENGINE SCORE",
  quote, quoteLabel, quoteSymbol = "XAU/USD", status, facts, dec = 2, eyebrow, note, children }: {
  product: string; bias: VisionBias; tagline: string;
  score?: number | null; scoreName?: string; quote?: number | null; quoteLabel?: string; quoteSymbol?: string;
  status: string; facts: VisionFact[]; dec?: number; eyebrow?: string; note?: string;
  children?: ReactNode;
}) {
  const Icon = ICONS[bias];
  const alignment = facts.filter(f => f.tone === "ok" ||
    (bias === "buy" && f.tone === "up") || (bias === "sell" && f.tone === "down") ||
    (bias === "range" && f.tone === "neutral")).length;
  return (
    <section className="om-vision-dashboard" data-bias={bias} aria-label={product + " market direction"}>
      <div className="om-vision-meta">
        <div><span className="om-vision-overline">{eyebrow ?? product + " / PRICE ACTION INTELLIGENCE"}</span>
          <div className="om-vision-meta-name">{product}<span className="om-vision-status"><i />{status}</span></div>
        </div>
        {quote !== undefined && <div className="om-vision-quote" data-no-i18n translate="no">
          <span>{quoteSymbol} · {quoteLabel ?? "RECORDED QUOTE"}</span><strong>{px(quote, dec)}</strong>
        </div>}
      </div>
      <div className="om-vision-direction" data-bias={bias}>
        <div className="om-vision-heading">
          <Icon className="om-vision-big-arrow" aria-hidden="true" strokeWidth={1.85}/>
          <div><strong>{TITLES[bias]}</strong><span>{tagline}</span></div>
        </div>
        <div className="om-vision-quality"><span>{scoreName}</span>
          <strong>{typeof score === "number" && Number.isFinite(score)
            ? Math.max(0, Math.min(100, Math.round(score))) + "/100" : "—"}</strong>
        </div>
        <svg className="om-vision-motif" viewBox="0 0 180 70" aria-hidden="true">
          <path d={bias === "buy" ? "M0 64Q25 49 42 53T83 39T135 28T180 6"
            : bias === "sell" ? "M0 8Q27 23 43 18T85 39T130 50T180 67"
            : "M0 45Q17 22 31 45T62 45T93 45T124 45T155 45T180 45"} />
        </svg>
      </div>
      <div className="om-vision-facts-top">
        <span>WHAT LINES UP</span><span>{alignment} / {facts.length} ALIGNED</span>
      </div>
      <div className="om-vision-facts" role="list" aria-label="Market confirmations">
        {facts.map((f,i)=><div key={f.label + ":" + i} role="listitem" className="om-vision-fact" data-tone={f.tone ?? "neutral"}>
          <span className="om-vision-fact-icon">
            {f.tone === "up" ? <ArrowUpRight aria-hidden="true"/> :
            f.tone === "down" ? <ArrowDownRight aria-hidden="true"/> :
            f.tone === "ok" ? <Check aria-hidden="true"/> :
            f.tone === "neutral" ? <ArrowLeftRight aria-hidden="true"/> : <Minus aria-hidden="true"/>}
          </span>
          <span><b>{f.label}</b><small>{f.value}</small></span>
        </div>)}
      </div>
      {note && <p className="om-vision-subnote">{note}</p>}
      {children}
    </section>
  );
}

export function VisionLevels({ entry, stop, targets, rr, symbol = "XAUUSD", dec: precision, reference = false }: {
  entry: number | null | undefined; stop: number | null | undefined;
  targets: (number | null | undefined)[]; rr?: number | null; symbol?: string; dec?: number; reference?: boolean;
}) {
  const dec = typeof precision === "number" && Number.isInteger(precision) && precision >= 0 && precision <= 8 ? precision :
    symbol.includes("JPY") ? 3 : symbol.includes("XAU") || symbol.includes("BTC") || symbol.includes("ETH") ? 2 : 5;
  const cells = [
    { label: "ENTRY", value: entry, kind:"entry" }, { label:"STOP", value:stop, kind:"stop" },
    { label:"TP1", value:targets[0], kind:"target" }, { label:"TP2", value:targets[1], kind:"target" },
    { label:"TP3", value:targets[2], kind:"target" },
  ];
  return <div className="om-vision-ticket">
    <div className="om-vision-ticket-head"><span>TRADE LEVELS</span>
      <span>{reference ? "CONDITIONAL REFERENCE · CONFIRMATION REQUIRED" : "ENGINE LEVELS"}</span>
      {typeof rr === "number" && Number.isFinite(rr) && rr > 0 &&
        <b>R:R {rr.toFixed(2)} : 1</b>}
    </div>
    <dl className="om-vision-levels" data-no-i18n translate="no">
      {cells.map(c=><div key={c.label} data-kind={c.kind}><dt>{c.label}</dt><dd>{px(c.value, dec)}</dd></div>)}
    </dl>
  </div>;
}
