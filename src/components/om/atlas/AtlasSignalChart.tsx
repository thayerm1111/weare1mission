"use client";

import { useMemo } from "react";
import { SignalFocusChart } from "@/components/om/chart/SignalFocusChart";
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
    <section className="om-atlas-signal-chart" aria-label={`${symbol} saved signal chart`} data-reference={chart.reference || undefined}>
      <header><h4>Chart at generation</h4><span data-no-i18n translate="no">{chart.tfLabel}</span></header>
      <p className="om-atlas-chart-caption">{caption}</p>
      {chart.bars.length >= 1 ? (
        <div className="om-atlas-chart-canvas">
          <SignalFocusChart bars={chart.bars} timeKnown={chart.timeKnown} tfMs={chart.tfMs} tfLabel={chart.tfLabel}
            price={price} priceLive={false} dec={chart.dec} levels={chart.levels} zone={chart.zone} viewKey={chart.viewKey}
            direction={direction} reference={chart.reference}
            snapshot fitLevels label={`${symbol}, saved candles at generation${annotations}`} />
        </div>
      ) : <p className="om-atlas-chart-empty" role="status">Candle chart unavailable for this saved read.</p>}
      {chart.bars.length >= 2 && <p className="om-atlas-chart-caption">Saved snapshot · open Full chart to inspect all saved candles.</p>}
    </section>
  );
}
