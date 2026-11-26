"use client";

import { useMemo } from "react";
import { VisionChart } from "@/components/om/vision/VisionChart";
import { atlasGenxChart, atlasPlayChart } from "@/lib/atlas/chart";
import type { AtlasSignalResult } from "@/lib/atlas/signals";
import { actionWords } from "@/lib/genx/words";

/** A saved signal's chart opens with the result. Display and gestures make no requests. */
export function AtlasSignalChart({ signal }: { signal: AtlasSignalResult }) {
  const chart = useMemo(() => signal.kind === "plays"
    ? { ...atlasPlayChart(signal.result), zone: null }
    : atlasGenxChart(signal.result), [signal]);
  const symbol = signal.result.symbol;
  const price = Number.isFinite(signal.result.price) ? signal.result.price : null;
  const direction = signal.kind === "plays"
    ? signal.result.signal.direction === "LONG" ? "buy" : signal.result.signal.direction === "SHORT" ? "sell" : "neutral"
    : actionWords(signal.result.genx.action).side ?? "neutral";
  const tradeLevels = chart.levels.some((level) => level.kind === "entry" || level.kind === "stop" || level.kind === "target");
  const caption = chart.reference && (tradeLevels || chart.zone)
    ? "Reference levels · confirmation is still needed."
    : tradeLevels ? chart.zone ? "Entry zone, stop and targets from this read." : "Entry, stop and targets from this read."
      : chart.levels.length > 0 ? "Support and resistance from this read." : "Saved candles from this read.";
  const annotations = chart.reference && tradeLevels ? ", with unconfirmed reference levels"
    : tradeLevels ? ", with this signal's levels" : chart.levels.length > 0 ? ", with saved market levels" : "";
  return (
    <section className="om-atlas-signal-chart om-vision-atlas-chart"
      aria-label={symbol+" saved signal chart"} data-reference={chart.reference||undefined}>
      {chart.bars.length>0 ? <VisionChart bars={chart.bars} timeKnown={chart.timeKnown} tfMs={chart.tfMs}
        timeframe={chart.tfLabel} price={price} priceLive={false} symbol={symbol}
        dec={chart.dec} levels={chart.levels} zone={chart.zone}
        direction={direction==="buy"?"buy":direction==="sell"?"sell":"mixed"}
        reference={chart.reference||!tradeLevels} snapshot viewKey={chart.viewKey}
        title={symbol+" original saved candles and "+caption}/>
        : <p className="om-atlas-chart-empty" role="status">Verified candle snapshot unavailable for this saved read.</p>}
    </section>
  );

}
