"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * THE XAUUSD PRICE MAP.
 *
 * Not a chart widget dropped into a box — the candles THE BRAIN actually read, with its intelligence drawn
 * on top of them: the levels it is watching, the level that would prove it wrong, and the two paths it
 * thinks the market can take from here.
 *
 * It draws only what was measured. No bars means an empty frame that says so, never a generated shape.
 */
export type MapBar = { t: number; o: number; h: number; l: number; c: number };
export type MapLevel = { price: number; label: string; kind: string; distanceAtr?: number };

export type PriceMapProps = {
  bars: MapBar[];
  levels: MapLevel[];
  price: number | null;
  /** Level THE BRAIN (or the user) asked to highlight. */
  focusPrice?: number | null;
  /** Where the current read stops being right. Drawn in red, dashed. */
  invalidation?: number | null;
  lean: number;
  live: boolean;
  /**
   * The open position, when there is one — or the trade THE BRAIN is PROPOSING, when there is not.
   *
   * `proposed` is what keeps those two honest. A member glancing at the chart must never mistake a level
   * THE BRAIN is thinking about for money that is actually at risk, so a proposal is drawn dimmer, always
   * dashed, and labelled WOULD ENTER rather than ENTRY. Drawn subtly either way: the chart is not handed
   * over to the trade.
   */
  trade?: { side: "buy" | "sell"; entry: number; stop: number | null; takeProfit: number | null; proposed?: boolean } | null;
  className?: string;
};

const C = {
  bg: "#080B11", grid: "rgba(255,255,255,0.045)", text: "#E8EFF7",
  mut: "rgba(232,239,247,0.52)", mut2: "rgba(232,239,247,0.32)",
  up: "#3FD9A0", down: "#F4737B", gold: "#F0C475", cold: "#6FA8DC", red: "#F4737B",
};

export function PriceMap({ bars, levels, price, focusPrice, invalidation, lean, live, trade = null, className = "" }: PriceMapProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 360 });
  const [hover, setHover] = useState<{ x: number; bar: MapBar } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    if (!bars.length) return null;
    const shown = bars.slice(-110);
    let lo = Infinity, hi = -Infinity;
    for (const b of shown) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
    for (const l of levels) {
      // Only stretch the frame for levels that are actually near the traded range — a weekly level
      // twenty dollars away would flatten every candle into a line.
      if (l.price > lo - (hi - lo) * 0.6 && l.price < hi + (hi - lo) * 0.6) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); }
    }
    if (price != null) { lo = Math.min(lo, price); hi = Math.max(hi, price); }
    // The trade's own levels must always be on screen — a stop you cannot see is a stop you forget.
    for (const v of [trade?.entry, trade?.stop, trade?.takeProfit]) {
      if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    const pad = Math.max(0.4, (hi - lo) * 0.10);
    return { shown, lo: lo - pad, hi: hi + pad };
  }, [bars, levels, price, trade]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !view) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = size;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padR = 66, padL = 8, padT = 12, padB = 22;
    const plotW = Math.max(40, w - padR - padL);
    const plotH = Math.max(40, h - padT - padB);
    const { shown, lo, hi } = view;
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
    const bw = plotW / Math.max(1, shown.length);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // horizontal grid + price axis
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const p = lo + ((hi - lo) * i) / steps;
      const yy = Math.round(y(p)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillStyle = C.mut2;
      ctx.textAlign = "left";
      ctx.fillText(p.toFixed(2), padL + plotW + 8, yy);
    }

    // scenario shading: above the nearest level is the bull path, below is the bear path.
    if (price != null) {
      const above = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
      const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
      // The scenario bands hint at the paths; they are capped so a distant level does not wash a third
      // of the chart in colour and drown the candles.
      const cap = plotH * 0.11;
      if (above) {
        const yb = y(above.price);
        const top = Math.max(padT, yb - cap);
        const gy = ctx.createLinearGradient(0, top, 0, yb);
        gy.addColorStop(0, "rgba(63,217,160,0)");
        gy.addColorStop(1, "rgba(63,217,160,0.10)");
        ctx.fillStyle = gy;
        ctx.fillRect(padL, top, plotW, Math.max(0, yb - top));
      }
      if (below) {
        const yb = y(below.price);
        const bot = Math.min(padT + plotH, yb + cap);
        const gy = ctx.createLinearGradient(0, yb, 0, bot);
        gy.addColorStop(0, "rgba(244,115,123,0.10)");
        gy.addColorStop(1, "rgba(244,115,123,0)");
        ctx.fillStyle = gy;
        ctx.fillRect(padL, yb, plotW, Math.max(0, bot - yb));
      }
    }

    // candles
    shown.forEach((b, i) => {
      const cx = padL + i * bw + bw / 2;
      const up = b.c >= b.o;
      ctx.strokeStyle = up ? C.up : C.down;
      ctx.fillStyle = up ? C.up : C.down;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(b.h)); ctx.lineTo(cx, y(b.l)); ctx.stroke();
      const bodyTop = y(Math.max(b.o, b.c));
      const bodyH = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      ctx.fillRect(cx - Math.max(1, bw * 0.3), bodyTop, Math.max(2, bw * 0.6), bodyH);
      ctx.globalAlpha = 1;
    });

    // Levels. Gold clusters its own highs — the day high, the London high and the Asia high are often
    // within a dollar of each other — so labels are placed only where they can be read. The LINE is
    // always drawn; it is the text that yields, because four labels stacked on top of each other is
    // worse than none.
    ctx.setLineDash([]);
    const placed: number[] = [];
    const sorted = [...levels.slice(0, 8)].sort((a, b) => Math.abs(a.price - (price ?? a.price)) - Math.abs(b.price - (price ?? b.price)));
    for (const l of sorted) {
      if (l.price < lo || l.price > hi) continue;
      const yy = Math.round(y(l.price)) + 0.5;
      const focused = focusPrice != null && Math.abs(focusPrice - l.price) < 0.02;
      ctx.strokeStyle = focused ? C.gold : "rgba(232,239,247,0.18)";
      ctx.lineWidth = focused ? 1.6 : 1;
      ctx.setLineDash(focused ? [] : [4, 5]);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.setLineDash([]);

      const room = placed.every((p) => Math.abs(p - yy) >= 13);
      if (!room && !focused) continue;
      placed.push(yy);
      ctx.fillStyle = focused ? C.gold : C.mut;
      ctx.textAlign = "left";
      ctx.font = focused ? "600 11px ui-sans-serif, system-ui" : "11px ui-sans-serif, system-ui";
      const label = `${l.label} ${l.price.toFixed(2)}`;
      const w2 = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(8,11,17,0.78)";
      ctx.fillRect(padL + 4, yy - 18, w2 + 8, 14);
      ctx.fillStyle = focused ? C.gold : C.mut;
      ctx.fillText(label, padL + 8, yy - 11);
    }

    // the open position: entry, stop and target, drawn quietly on top of the market
    if (trade) {
      const band = (from: number, to: number, colour: string) => {
        const y1 = y(Math.max(from, to)), y2 = y(Math.min(from, to));
        ctx.fillStyle = colour;
        ctx.fillRect(padL, y1, plotW, Math.max(1, y2 - y1));
      };
      // Only a REAL position shades the ground between entry and price. A proposal has no P&L to show.
      if (price != null && !trade.proposed) {
        const winning = trade.side === "buy" ? price >= trade.entry : price <= trade.entry;
        band(trade.entry, price, winning ? "rgba(63,217,160,0.07)" : "rgba(244,115,123,0.07)");
      }
      if (trade.proposed && trade.stop != null) {
        // Shade the risk instead: the distance the member would actually be putting up.
        band(trade.entry, trade.stop, "rgba(244,115,123,0.05)");
      }
      const mark = (v: number | null, colour: string, label: string, dash: number[]) => {
        if (v == null || v < lo || v > hi) return;
        const yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.2;
        ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "700 10px ui-sans-serif, system-ui";
        ctx.textAlign = "right";
        const text = `${label} ${v.toFixed(2)}`;
        const w2 = ctx.measureText(text).width;
        ctx.fillStyle = "rgba(8,11,17,0.82)";
        ctx.fillRect(padL + plotW - w2 - 10, yy - 15, w2 + 8, 13);
        ctx.fillStyle = colour;
        ctx.fillText(text, padL + plotW - 6, yy - 8.5);
        ctx.textAlign = "left";
      };
      if (trade.proposed) ctx.globalAlpha = 0.62;
      mark(trade.entry, C.gold, trade.proposed ? "WOULD ENTER" : "ENTRY", trade.proposed ? [5, 4] : []);
      mark(trade.stop, C.red, trade.proposed ? "WOULD RISK TO" : "STOP", [3, 3]);
      mark(trade.takeProfit, C.up, trade.proposed ? "OBJECTIVE" : "TARGET", [3, 3]);
      ctx.globalAlpha = 1;
    }

    // invalidation
    if (invalidation != null && invalidation >= lo && invalidation <= hi) {
      const yy = Math.round(y(invalidation)) + 0.5;
      ctx.strokeStyle = C.red;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.red;
      ctx.font = "600 10px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.fillText("READ FAILS HERE", padL + 6, yy + 10);
    }

    // live price
    if (price != null) {
      const yy = Math.round(y(price)) + 0.5;
      ctx.strokeStyle = lean >= 0 ? C.up : C.down;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 3]);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lean >= 0 ? C.up : C.down;
      ctx.fillRect(padL + plotW + 2, yy - 9, padR - 6, 18);
      ctx.fillStyle = "#06090E";
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillText(price.toFixed(2), padL + plotW + 8, yy);
      if (live) {
        ctx.beginPath();
        ctx.fillStyle = lean >= 0 ? C.up : C.down;
        ctx.arc(padL + plotW - 2, yy, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [view, size, levels, price, focusPrice, invalidation, lean, live, trade]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!view || !wrap.current) return;
    const rect = wrap.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = Math.max(40, rect.width - 66 - 8);
    const idx = Math.floor(((x - 8) / plotW) * view.shown.length);
    const bar = view.shown[Math.max(0, Math.min(view.shown.length - 1, idx))];
    if (bar) setHover({ x, bar });
  };

  return (
    <div ref={wrap} className={`relative h-full w-full ${className}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <canvas ref={ref} className="block h-full w-full" />
      {!bars.length && (
        <div className="absolute inset-0 grid place-items-center text-[12px]" style={{ color: C.mut2 }}>
          No candles to draw — THE BRAIN has not read the market yet.
        </div>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border px-2.5 py-1.5 text-[11px] tabular-nums backdrop-blur"
          style={{
            left: Math.min(Math.max(8, hover.x - 70), (wrap.current?.clientWidth ?? 400) - 160),
            borderColor: "rgba(255,255,255,0.10)", background: "rgba(10,14,20,0.92)", color: C.text,
          }}
        >
          <div style={{ color: C.mut2 }}>{new Date(hover.bar.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <div>O {hover.bar.o.toFixed(2)} · H {hover.bar.h.toFixed(2)}</div>
          <div>L {hover.bar.l.toFixed(2)} · C {hover.bar.c.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
}

export default PriceMap;
