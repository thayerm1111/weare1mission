"use client";

/**
 * OM Charts — a full TradingView chart embedded in the member portal so members
 * can chart and mark up right on weare1mission.com. Uses TradingView's Advanced
 * Chart widget with the full left drawing toolbar, a watchlist, details and
 * symbol search. Defaults to Gold.
 *
 * Persistence: TradingView keeps a member's view and drawings in their browser,
 * so they persist between visits on the same device. Drawings that save to their
 * OM account and follow them across devices need TradingView's Charting Library
 * (a separate, free-but-gated package) — see the note in the UI.
 */
import { useEffect, useRef } from "react";
import { CandlestickChart } from "lucide-react";

const WATCHLIST = [
  "OANDA:XAUUSD", "TVC:DXY", "OANDA:EURUSD", "OANDA:GBPUSD", "OANDA:USDJPY",
  "OANDA:AUDUSD", "OANDA:USDCAD", "BITSTAMP:BTCUSD", "BITSTAMP:ETHUSD",
  "NASDAQ:NDX", "FOREXCOM:US30", "SP:SPX",
];

export function OMCharts() {
  const holder = useRef<HTMLDivElement>(null);

  // Force the TradingView iframe to fill its container (autosize sometimes
  // renders it only ~150px tall inside a flex/vh parent).
  useEffect(() => {
    const id = "om-tv-fill";
    if (!document.getElementById(id)) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = ".tradingview-widget-container__widget { width:100% !important; height:100% !important; } .tradingview-widget-container iframe { width:100% !important; height:100% !important; display:block !important; }";
      document.head.appendChild(style);
    }
  }, []);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    el.innerHTML = "";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    el.appendChild(widget);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "OANDA:XAUUSD",
      interval: "15",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      hide_side_toolbar: false,   // full drawing toolbar on the left
      allow_symbol_change: true,
      save_image: true,
      withdateranges: true,
      details: true,
      hotlist: true,
      calendar: false,
      watchlist: WATCHLIST,
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(script);

    return () => { el.innerHTML = ""; };
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
            <CandlestickChart className="h-5 w-5 text-primary" /> OM Charts
          </h1>
          <p className="text-xs text-charcoal/55">Full TradingView charting &amp; markup — right here on weare1mission.com. Search any symbol, draw, and add indicators.</p>
        </div>
      </div>

      {/* The chart fills nearly the whole screen height. */}
      <div
        ref={holder}
        className="tradingview-widget-container overflow-hidden rounded-2xl border border-[#E7E4DD] bg-[#0b0b0b] shadow-card"
        style={{ height: "82vh", minHeight: 560, width: "100%" }}
      />

      <p className="text-[11px] leading-relaxed text-charcoal/45">
        Your view and drawings are kept in this browser between visits. Note: your personal TradingView layout, custom indicators and saved watchlist live in your TradingView account and can&apos;t be pulled into an embed — for drawings that save to your OM account and follow you across every device, we can add TradingView&apos;s Charting Library next. Educational only — not financial advice.
      </p>
    </div>
  );
}
