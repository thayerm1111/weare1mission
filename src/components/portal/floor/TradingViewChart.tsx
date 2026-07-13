"use client";

import { useEffect, useRef } from "react";

/**
 * Embeds a TradingView "Advanced Chart" widget (free, no account needed).
 * Re-initialises when the symbol / interval / studies change so the Scanner
 * tab can swap indicator templates on the fly.
 */
export function TradingViewChart({
  symbol = "OANDA:XAUUSD",
  interval = "15",
  studies = [],
  height = 520,
}: {
  symbol?: string;
  interval?: string;
  studies?: string[];
  height?: number | string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const studiesKey = JSON.stringify(studies);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML =
      '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "rgba(10, 10, 10, 1)",
      gridColor: "rgba(255, 255, 255, 0.06)",
      hide_side_toolbar: false,
      allow_symbol_change: true,
      studies,
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(script);

    return () => {
      el.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, studiesKey]);

  return (
    <div
      className="tradingview-widget-container overflow-hidden rounded-xl"
      ref={ref}
      style={{ height, width: "100%" }}
    />
  );
}
