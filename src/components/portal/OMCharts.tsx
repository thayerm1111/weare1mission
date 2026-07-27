"use client";

/**
 * OM Charts — a full-screen TradingView chart embedded in the member portal so
 * members can chart and mark up right on weare1mission.com (full drawing
 * toolbar, watchlist, indicators, symbol search). Defaults to Gold.
 *
 * We render TradingView's embed iframe DIRECTLY (rather than via their injector
 * script) so we control its size — it fills a concrete, near-full-viewport
 * container instead of collapsing to a thin strip.
 *
 * Persistence: TradingView keeps a member's view and drawings in their browser,
 * so they persist between visits on the same device. Drawings that save to their
 * OM account and follow them across devices need TradingView's Charting Library
 * (a separate, free-but-gated package) — see the note in the UI.
 */
import { CandlestickChart } from "lucide-react";
import { ChartRead } from "./ChartRead";

const CONFIG = {
  autosize: true,
  symbol: "OANDA:XAUUSD",
  interval: "15",
  timezone: "Etc/UTC",
  theme: "dark",
  style: "1",
  locale: "en",
  hide_side_toolbar: false,     // full drawing toolbar on the left
  allow_symbol_change: true,
  save_image: true,
  withdateranges: true,
  details: true,
  hotlist: true,
  calendar: false,
  watchlist: [
    "OANDA:XAUUSD", "TVC:DXY", "OANDA:EURUSD", "OANDA:GBPUSD", "OANDA:USDJPY",
    "OANDA:AUDUSD", "OANDA:USDCAD", "BITSTAMP:BTCUSD", "BITSTAMP:ETHUSD",
    "NASDAQ:NDX", "FOREXCOM:US30", "SP:SPX",
  ],
  support_host: "https://www.tradingview.com",
};

const SRC = "https://www.tradingview-widget.com/embed-widget/advanced-chart/?locale=en#" + encodeURIComponent(JSON.stringify(CONFIG));

export function OMCharts() {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
          <CandlestickChart className="h-5 w-5 text-primary" /> OM Charts
        </h1>
        <p className="text-xs text-charcoal/55">Full TradingView charting &amp; markup — right here on weare1mission.com. Search any symbol, draw, and add indicators.</p>
      </div>

      {/* Near-full-viewport chart. The iframe fills this concrete-height box. */}
      <div
        className="overflow-hidden rounded-2xl border border-[#E7E4DD] bg-[#0b0b0b] shadow-card"
        style={{ height: "calc(100vh - 200px)", minHeight: 620 }}
      >
        <iframe
          src={SRC}
          title="OM Charts — TradingView"
          allow="fullscreen"
          style={{ width: "100%", height: "100%", border: 0, display: "block" }}
        />
      </div>

      <p className="text-[11px] leading-relaxed text-charcoal/45">
        Your view and drawings are kept in this browser between visits. Note: your personal TradingView layout, custom indicators and saved watchlist live in your TradingView account and can&apos;t be pulled into an embed — for drawings that save to your OM account and follow you across every device, we can add TradingView&apos;s Charting Library next. Educational only — not financial advice.
      </p>

      {/* AI read of the member's marked-up chart */}
      <ChartRead />
    </div>
  );
}
