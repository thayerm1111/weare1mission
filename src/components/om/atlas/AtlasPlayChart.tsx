"use client";

import { useMemo } from "react";
import { OmChart } from "@/components/om/chart/OmChart";
import type { PlayView } from "@/components/om/plays/PlayDetail";
import { atlasPlayChart } from "@/lib/atlas/chart";

/** A saved signal's chart opens with the result. Display and gestures make no requests. */
export function AtlasPlayChart({ play }: { play: PlayView }) {
  const chart = useMemo(() => atlasPlayChart(play), [play]);
  return (
    <section className="om-atlas-play-chart" aria-label={`${play.symbol} saved signal chart`} data-reference={chart.reference || undefined}>
      <header><h4>Chart at generation</h4><span data-no-i18n translate="no">{chart.tfLabel}</span></header>
      <p className="om-atlas-chart-caption">{chart.reference ? "Reference levels · confirmation is still needed." : chart.levels.length > 0 ? "Entry, stop and targets from this read." : "Saved candles from this read."}</p>
      {chart.bars.length >= 2 ? (
        <div className="om-atlas-chart-canvas">
          <OmChart bars={chart.bars} timeKnown={chart.timeKnown} tfMs={chart.tfMs} tfLabel={chart.tfLabel}
            price={chart.price} priceLive={false} dec={chart.dec} levels={chart.levels} viewKey={chart.viewKey}
            snapshot fitLevels label={`${play.symbol}, saved candles at generation${chart.reference ? ", with unconfirmed reference levels" : ", with this signal's levels"}`} />
        </div>
      ) : <p className="om-atlas-chart-empty" role="status">Candle chart unavailable for this saved read.</p>}
      {chart.bars.length >= 2 && <p className="om-atlas-chart-caption">Saved snapshot · pan, zoom or select a candle to inspect it.</p>}
    </section>
  );
}
