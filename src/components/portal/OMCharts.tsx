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
 * Mobile drawing: on a phone, dragging a drawing inside the embed can be read by
 * the browser as a page scroll ("the whole screen moves"). The Fullscreen /
 * Draw mode fixes that — it blows the chart up to the whole viewport and locks
 * page scroll, so there's nothing behind to scroll and every touch goes straight
 * to the chart. The SAME iframe node is reused (only its container's CSS changes),
 * so toggling fullscreen never reloads the chart or loses drawings. (We do NOT
 * set touch-action:none on the iframe — on iOS Safari that can swallow the drag
 * before TradingView gets it, which is what made drawings impossible to move.)
 *
 * Persistence: TradingView keeps a member's view and drawings in their browser,
 * so they persist between visits on the same device. Drawings that save to their
 * OM account and follow them across devices need TradingView's Charting Library
 * (a separate, free-but-gated package) — see the note in the UI.
 */
import { useEffect, useState } from "react";
import { CandlestickChart, Maximize2, Minimize2 } from "lucide-react";
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
  const [full, setFull] = useState(false);

  // Lock the page while fullscreen so a touch-drag on the chart never scrolls
  // the page behind it (the mobile "it moves the screen" problem).
  useEffect(() => {
    if (!full) return;
    const prevOverflow = document.body.style.overflow;
    const prevOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.overscrollBehavior = prevOverscroll;
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  return (
    <div className="space-y-3">
      {/* Header + fullscreen toggle. Hidden (not unmounted) in fullscreen so the
          chart container keeps its position and the iframe never remounts. */}
      <div className={full ? "hidden" : "flex flex-wrap items-start justify-between gap-3"}>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
            <CandlestickChart className="h-5 w-5 text-primary" /> OM Charts
          </h1>
          <p className="text-xs text-charcoal/55">Full TradingView charting &amp; markup — right here on weare1mission.com. On a phone, tap <span className="font-semibold text-navy">Fullscreen</span> to move drawings without the screen scrolling.</p>
        </div>
        <button
          onClick={() => setFull(true)}
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-cream transition-opacity hover:opacity-90"
        >
          <Maximize2 className="h-4 w-4" /> Fullscreen
        </button>
      </div>

      {/* Chart container. Its CLASS/STYLE flip between an inline box and a fixed
          full-viewport overlay — the same <iframe> stays mounted either way. */}
      <div
        className={
          full
            ? "fixed inset-0 z-[60] bg-[#0b0b0b]"
            : "overflow-hidden rounded-2xl border border-[#E7E4DD] bg-[#0b0b0b] shadow-card"
        }
        style={full ? { overscrollBehavior: "none" } : { height: "calc(100vh - 200px)", minHeight: 620 }}
      >
        <iframe
          src={SRC}
          title="OM Charts — TradingView"
          allow="fullscreen"
          style={{ width: "100%", height: "100%", border: 0, display: "block" }}
        />
        {full && (
          <>
            <button
              onClick={() => setFull(false)}
              className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-navy/85 px-4 py-2 text-xs font-bold uppercase tracking-wide text-cream shadow-lg backdrop-blur transition-colors hover:bg-navy"
            >
              <Minimize2 className="h-4 w-4" /> Exit
            </button>
            {/* Non-interactive gesture hint so it never blocks the chart's own touches. */}
            <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[60%] rounded-full bg-navy/70 px-3 py-1.5 text-[11px] font-medium text-cream/90 shadow backdrop-blur">
              Tap a drawing to select, then drag · pinch to zoom
            </div>
          </>
        )}
      </div>

      <p className={full ? "hidden" : "text-[11px] leading-relaxed text-charcoal/45"}>
        Your view and drawings are kept in this browser between visits. Note: your personal TradingView layout, custom indicators and saved watchlist live in your TradingView account and can&apos;t be pulled into an embed — for drawings that save to your OM account and follow you across every device, we can add TradingView&apos;s Charting Library next. Educational only — not financial advice.
      </p>

      {/* AI read of the member's marked-up chart */}
      <div className={full ? "hidden" : ""}>
        <ChartRead />
      </div>
    </div>
  );
}
