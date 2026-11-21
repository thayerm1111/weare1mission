"use client";

import { useEffect, useRef } from "react";
import { useHomepageTranslation, type HomepageTranslator } from "./homepage-i18n";

type Bar = { open: number; high: number; low: number; close: number };
type Point = { x: number; y: number };
type ChartControls = { zoom: (direction: "in" | "out") => void; reset: () => void; redraw: () => void; destroy: () => void };

/** A deterministic illustration, generated locally. It is never a price feed or a trading signal. */
const SAMPLE_BARS: Bar[] = (() => {
  const bars: Bar[] = [];
  let previous = 3389;
  for (let index = 0; index < 180; index++) {
    const drift = index < 58 ? 0.14 : index < 124 ? -0.24 : 0.11;
    const move = Math.sin(index * 1.39) * 1.35 + Math.cos(index * 0.51) * 0.8 + drift;
    const open = previous;
    const close = open + move;
    const high = Math.max(open, close) + 0.35 + (1 + Math.sin(index * 2.1)) * 0.53;
    const low = Math.min(open, close) - 0.3 - (1 + Math.cos(index * 1.7)) * 0.48;
    bars.push({ open, high, low, close });
    previous = close;
  }
  return bars;
})();

export function IllustrativeChart() {
  const { t } = useHomepageTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<ChartControls | null>(null);
  const translatorRef = useRef(t);
  translatorRef.current = t;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const tooltip = tooltipRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !wrap || !tooltip || !context) return;
    const controls = mountIllustration(canvas, context, wrap, tooltip, (copy, values) => translatorRef.current(copy, values));
    controlsRef.current = controls;
    return () => { controls.destroy(); controlsRef.current = null; };
  }, []);

  useEffect(() => { controlsRef.current?.redraw(); }, [t]);

  return <div className="demo-chart-panel">
    <div className="demo-quote">
      <div><small>{t("GOLD · SAMPLE CHART")}</small><strong>{t("XAU / USD")}</strong></div>
      <div className="chart-timeframes" aria-label={t("Illustrative chart timeframe")}><span>{t("5m")}</span><span className="selected">{t("15m")}</span><span>{t("1h")}</span></div>
    </div>
    <div className="chart-wrap" ref={wrapRef}>
      <canvas className="preview-chart" ref={canvasRef} role="img" tabIndex={0} aria-label={t("Interactive illustrative gold candlestick chart. Drag or use the left and right arrow keys to pan. Use plus and minus to zoom, or Home to reset. This is sample data.")} />
      <div className="chart-tooltip" ref={tooltipRef} hidden aria-hidden="true" data-no-i18n="" />
    </div>
    <div className="chart-help"><span>{t("Drag to explore this sample chart.")}</span>
      <div className="chart-controls">
        <button type="button" aria-label={t("Zoom chart out")} onClick={() => controlsRef.current?.zoom("out")}><svg className="icon" aria-hidden="true"><use href="#i-minus" /></svg></button>
        <button type="button" aria-label={t("Zoom chart in")} onClick={() => controlsRef.current?.zoom("in")}><svg className="icon" aria-hidden="true"><use href="#i-plus" /></svg></button>
        <button type="button" onClick={() => controlsRef.current?.reset()}>{t("Reset")}</button>
      </div>
    </div>
  </div>;
}

function mountIllustration(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, wrap: HTMLDivElement, tooltip: HTMLDivElement, t: HomepageTranslator): ChartControls {
  const controller = new AbortController();
  const listen = { signal: controller.signal };
  const bars = SAMPLE_BARS;
  let count = 72;
  let end = bars.length;
  let width = 0;
  let height = 0;
  let hover: Point | null = null;
  let dragging: { x: number; end: number } | null = null;
  const margin = { left: 4, right: 59, top: 15, bottom: 28 };
  let drawFrame = 0;

  function scheduleDraw() { cancelAnimationFrame(drawFrame); drawFrame = requestAnimationFrame(draw); }

  function draw() {
    if (!width || !height) return;
    const start = Math.max(0, Math.round(end - count));
    const visible = bars.slice(start, Math.round(end));
    if (!visible.length) return;
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    if (plotWidth <= 0 || plotHeight <= 0) return;
    const rawMin = Math.min(...visible.map((bar) => bar.low));
    const rawMax = Math.max(...visible.map((bar) => bar.high));
    const pad = (rawMax - rawMin) * 0.16;
    const min = rawMin - pad;
    const max = rawMax + pad;
    const y = (price: number) => margin.top + (max - price) / (max - min) * plotHeight;
    const spacing = plotWidth / visible.length;
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    ctx.lineWidth = 1;
    for (let index = 0; index < 5; index++) {
      const level = min + (max - min) * index / 4;
      const yy = Math.round(y(level)) + 0.5;
      ctx.strokeStyle = "#ffffff09";
      ctx.beginPath(); ctx.moveTo(margin.left, yy); ctx.lineTo(width - margin.right, yy); ctx.stroke();
      ctx.fillStyle = "#686c79"; ctx.fillText(level.toFixed(2), width - margin.right + 10, yy + 3);
    }
    const timeTicks = width < 420 ? 3 : 5;
    for (let index = 0; index < timeTicks; index++) {
      const fraction = index / (timeTicks - 1);
      const x = margin.left + plotWidth * fraction;
      ctx.strokeStyle = "#ffffff06";
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, height - margin.bottom); ctx.stroke();
      const hours = Math.round((bars.length - (start + visible.length * fraction)) / 4);
      ctx.fillStyle = "#626675";
      ctx.textAlign = index === 0 ? "left" : index === timeTicks - 1 ? "right" : "center";
      ctx.fillText(hours > 0 ? t("{hours}h earlier", { hours }) : t("Sample end"), x, height - 7);
    }
    ctx.textAlign = "left";
    visible.forEach((bar, index) => {
      const x = margin.left + spacing * (index + 0.5);
      const up = bar.close >= bar.open;
      ctx.strokeStyle = up ? "#8bb3a4" : "#bb929c";
      ctx.fillStyle = up ? "#a0c8b7" : "#c29aa3";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y(bar.high)); ctx.lineTo(x, y(bar.low)); ctx.stroke();
      const bodyY = Math.min(y(bar.open), y(bar.close));
      const bodyWidth = Math.max(1.4, spacing * 0.54);
      ctx.fillRect(x - bodyWidth / 2, bodyY, bodyWidth, Math.max(1.4, Math.abs(y(bar.close) - y(bar.open))));
    });
    const support = rawMin + (rawMax - rawMin) * 0.14;
    const yy = y(support);
    ctx.fillStyle = "#9dbfaa08"; ctx.fillRect(margin.left, yy - 5, plotWidth, 10);
    ctx.strokeStyle = "#9dbfaa44";
    ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(margin.left, yy); ctx.lineTo(width - margin.right, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#89a494"; ctx.fillText(t("Sample support zone"), margin.left + 7, yy - 10);
    if (hover && !dragging && hover.x >= margin.left && hover.x <= width - margin.right) {
      const index = Math.max(0, Math.min(visible.length - 1, Math.floor((hover.x - margin.left) / spacing)));
      const bar = visible[index];
      const x = margin.left + spacing * (index + 0.5);
      ctx.strokeStyle = "#d8d6e455"; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, height - margin.bottom); ctx.moveTo(margin.left, hover.y); ctx.lineTo(width - margin.right, hover.y); ctx.stroke(); ctx.setLineDash([]);
      tooltip.hidden = false;
      tooltip.textContent = `${t("O")} ${bar.open.toFixed(2)}  ${t("H")} ${bar.high.toFixed(2)}  ${t("L")} ${bar.low.toFixed(2)}  ${t("C")} ${bar.close.toFixed(2)}`;
      tooltip.style.left = Math.min(Math.max(4, hover.x - 100), Math.max(4, width - 280)) + "px";
      tooltip.style.top = "2px";
    } else tooltip.hidden = true;
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    width = rect.width; height = rect.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    scheduleDraw();
  }

  function point(event: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = { x: point(event).x, end }; hover = null;
    canvas.setPointerCapture(event.pointerId); canvas.style.cursor = "grabbing";
  }, listen);
  canvas.addEventListener("pointermove", (event) => {
    const cursor = point(event);
    if (dragging) end = Math.max(count, Math.min(bars.length, dragging.end - (cursor.x - dragging.x) / Math.max(1, width - margin.right) * count));
    else hover = cursor;
    scheduleDraw();
  }, listen);
  function stopDrag() { dragging = null; canvas.style.cursor = "crosshair"; scheduleDraw(); }
  canvas.addEventListener("pointerup", stopDrag, listen);
  canvas.addEventListener("pointercancel", stopDrag, listen);
  canvas.addEventListener("pointerleave", () => { hover = null; scheduleDraw(); }, listen);

  function zoom(direction: "in" | "out") {
    count = Math.max(24, Math.min(140, Math.round(count * (direction === "in" ? 0.78 : 1.28))));
    end = Math.max(count, end); hover = null; scheduleDraw();
  }
  function reset() { count = 72; end = bars.length; hover = null; scheduleDraw(); }
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); end = Math.max(count, Math.min(bars.length, end + (event.key === "ArrowLeft" ? -8 : 8))); hover = null; scheduleDraw();
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom("in"); }
    else if (event.key === "-") { event.preventDefault(); zoom("out"); }
    else if (event.key === "Home") { event.preventDefault(); reset(); }
  }, listen);

  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(resize); observer.observe(wrap); }
  else window.addEventListener("resize", resize, listen);
  resize();

  return { zoom, reset, redraw: scheduleDraw, destroy() { controller.abort(); observer?.disconnect(); cancelAnimationFrame(drawFrame); } };
}
