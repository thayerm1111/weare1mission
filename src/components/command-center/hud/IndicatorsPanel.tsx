"use client";
import { ChevronDown, Gauge as GaugeIcon } from "lucide-react";
import { H, toneColor } from "./theme";
import { Gauge } from "./Gauge";
import type { Live } from "../CommandCenterLive";

/**
 * INDICATORS — the five gauges, folded into one line until asked for (owner 11-11: demote, don't delete).
 *
 * Each says what it is in its own title and, behind its ⓘ, what it measures, from which inputs, and how fresh it
 * is. Pressure is a proxy derived from price action — gold has no consolidated order flow here — and conviction
 * is ATLAS's confidence in its engine thesis, defined so anyone can recompute it. Neither is a probability.
 */
function volLevel(band?: string | null): number | null {
  const m: Record<string, number> = { compressed: 0.15, quiet: 0.3, normal: 0.45, active: 0.62, expanding: 0.78, extreme: 0.95, news_shock: 0.95 };
  return band ? m[band] ?? 0.45 : null;
}

export function IndicatorsPanel({ d, open, onToggle, freshness, className = "" }: {
  d: Live | null;
  open: boolean;
  onToggle: () => void;
  /** "Snapshot 14:30:05 · 41 s old" — every reading here comes from that one analysis snapshot. */
  freshness: string;
  className?: string;
}) {
  const intel = d?.intel ?? null;
  const thesis = d?.thesis ?? null;
  const ch = intel?.pressure.change ?? null;
  const bias = thesis?.label?.toLowerCase().includes("bear") ? "bear" : thesis?.label?.toLowerCase().includes("bull") ? "bull" : "neutral";
  const biasColor = bias === "bear" ? H.red : bias === "bull" ? H.green : H.cyan2;
  const Fresh = () => <p style={{ color: H.mut }}>Freshness: {freshness}. Refreshed with each analysis snapshot (about once a minute).</p>;

  const pressureInfo = (
    <>
      <p><b style={{ color: H.gold3 }}>A proxy, not order flow.</b> Spot gold is traded over the counter; nothing here sees an order book or real traded volume.</p>
      <p>Scored 0–100 by the engine (core/regime.ts) from price action: where candles close inside their range, which side the wicks punish, momentum, trend slope, and whether a structure break was accepted. Buyers + sellers = 100 by construction.</p>
      {ch && <p>Over {ch.horizon}: {Math.abs(ch.deltaNet) < 3 ? "flat" : `${ch.deltaNet > 0 ? "+" : ""}${Math.round(ch.deltaNet)} net, ${ch.direction}`}.</p>}
      <p>It is not a probability of a move or of a trade winning.</p>
      <Fresh />
    </>
  );

  return (
    <section data-tour="indicators" className={`hud-panel relative min-w-0 overflow-hidden rounded-[10px] ${className}`}
      style={{ background: `linear-gradient(180deg, ${H.panel2} 0%, ${H.panel} 100%)`, border: `1px solid ${H.line}` }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-3 px-3 py-[7px] text-left transition hover:brightness-125">
        <span className="inline-flex shrink-0 items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.13em]" style={{ color: H.text }}>
          <GaugeIcon className="h-3.5 w-3.5" style={{ color: H.gold2 }} />Indicators
        </span>
        {/* the one-line summary: honest labels even when folded */}
        <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden text-[10.5px] tabular-nums md:whitespace-nowrap" style={{ color: H.mut }}>
          <span className="min-w-0 md:truncate">Pressure <span style={{ color: H.mut2 }}>(derived from price action)</span>{" "}
            {intel ? <><b style={{ color: H.green, fontWeight: 600 }}>B {intel.pressure.buyers}</b> · <b style={{ color: H.red, fontWeight: 600 }}>S {intel.pressure.sellers}</b></> : "—"}</span>
          <span className="hidden truncate md:inline">Volatility {intel?.volatility.atr != null ? <b style={{ color: H.text, fontWeight: 600 }}>15m ATR ${intel.volatility.atr.toFixed(1)}</b> : "—"}</span>
          <span className="hidden truncate lg:inline">Momentum {intel?.momentum.value != null ? <b style={{ color: toneColor(intel.momentum.tone), fontWeight: 600 }}>{intel.momentum.value > 0 ? "+" : ""}{intel.momentum.value.toFixed(2)}</b> : "—"}</span>
          <span className="hidden truncate min-[1440px]:inline">Conviction {thesis ? <b style={{ color: biasColor, fontWeight: 600 }}>{thesis.confidence}/100</b> : "—"}</span>
        </span>
        <span className="hidden shrink-0 text-[9px] min-[1600px]:inline" style={{ color: H.mut2 }}>{freshness}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: H.mut, transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </button>
      {open && (
        <div className="hud-in px-2 pb-2" data-indicators-open="">
          <div className="grid grid-cols-2 gap-[8px] sm:grid-cols-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
            <Gauge title="SELLER PRESSURE (DERIVED)" display={intel?.pressure.sellers != null ? `${intel.pressure.sellers}` : "—"}
              sub={intel?.pressure.sellerLabel ?? "—"} value01={intel?.pressure.sellers != null ? intel.pressure.sellers / 100 : null} color={H.red}
              delta={ch ? -ch.deltaNet / 2 : null} deltaLabel={ch ? `over ${ch.horizon}` : null}
              infoTitle="Pressure (derived from price action)" info={pressureInfo} />
            <Gauge title="BUYER PRESSURE (DERIVED)" display={intel?.pressure.buyers != null ? `${intel.pressure.buyers}` : "—"}
              sub={intel?.pressure.buyerLabel ?? "—"} value01={intel?.pressure.buyers != null ? intel.pressure.buyers / 100 : null} color={H.green}
              delta={ch ? ch.deltaNet / 2 : null} deltaLabel={ch ? `over ${ch.horizon}` : null}
              infoTitle="Pressure (derived from price action)" info={pressureInfo} />
            <Gauge title="VOLATILITY · 15M ATR ($)" display={intel?.volatility.atr != null ? `$${intel.volatility.atr.toFixed(1)}` : "—"}
              sub={intel?.volatility.label ?? "—"} value01={volLevel(intel?.volatility.band)} color={H.gold2}
              infoTitle="Volatility (15-minute ATR)"
              info={<>
                <p>The 15-minute average true range in dollars: how far a typical 15-minute candle travels, high to low, including gaps.</p>
                <p>The band ({intel?.volatility.label ?? "—"}) is the engine&apos;s own weather reading — compressed → quiet → normal → active → expanding → extreme — from the ratio of the current range to normal.</p>
                <p>Inputs: closed 15-minute candles from the Twelve Data feed.</p>
                <Fresh />
              </>} />
            <Gauge title="MOMENTUM · 15M" display={intel?.momentum.value != null ? `${intel.momentum.value > 0 ? "+" : ""}${intel.momentum.value.toFixed(2)}` : "—"}
              sub={intel?.momentum.label ?? "—"} value01={intel?.momentum.value != null ? (intel.momentum.value + 3) / 6 : null} color={toneColor(intel?.momentum.tone)}
              infoTitle="Momentum (15-minute, in ATRs)"
              info={<>
                <p>The 15-minute frame&apos;s five-bar return measured in average ranges: −1.6 means price fell 1.6 normal ranges over the last five closed candles.</p>
                <p>Bullish at +0.5 or more, bearish at −0.5 or less, flat between. Measured by the engine (core/math.ts) on closed candles only.</p>
                <Fresh />
              </>} />
            <Gauge title="ATLAS CONVICTION (NOT A WIN %)" display={thesis ? `${thesis.confidence}` : "—"}
              sub={thesis ? (bias === "bear" ? "Downside" : bias === "bull" ? "Upside" : "No side") : "—"}
              value01={thesis ? thesis.confidence / 100 : null} color={biasColor}
              infoTitle="ATLAS conviction (0–100)"
              info={<>
                <p>ATLAS&apos;s confidence in its <b>engine thesis</b> ({thesis?.label ?? "none yet"}) — the working view the setup engine reads. <b style={{ color: H.gold3 }}>It is not a probability that a trade wins.</b></p>
                <p>Reproducible (brain/thesis.ts): start at 38; add 9 × |bullish − bearish higher timeframes| (max 22); add ½ × |net pressure| (max 18); +10 if a structure break agrees with the bias; +6 after a failed break; −8 with three or more data warnings. Capped at 58 while neutral or waiting on a breakout; clamped to 10–92.</p>
                <p>While a thesis holds, each reading is 65% the previous value and 35% the new one. A blocker reads 90 for “stand aside” — confidence in standing aside, not in a trade.</p>
                <Fresh />
              </>} />
          </div>
          <p className="mt-1.5 px-1 text-[9px] leading-snug" style={{ color: H.mut2 }}>
            All five come from the same analysis snapshot ({freshness}). Pressure is a price-action proxy, not order flow; conviction is not a win probability.
          </p>
        </div>
      )}
    </section>
  );
}
