"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronsRight, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import {
  AUTO_VIEW, MIN_BARS, clamp, indexOfT, indexAtOrBefore, timeWindow, zoomAt, spanAround, panTo, stretchPrice, toNewest, moved, atNewest,
  type Viewport, type ViewScale,
} from "@/lib/chart/viewport";
import { axisMarks, candleTimeText, clockText, dayText, type TimedBar } from "@/lib/chart/candleTime";
import { levelTag, orderedLevelLabels } from "@/lib/chart/levelLabels";
import { candleInSessionBreak, priceBand, validStructureZone, type StructureZone } from "@/lib/chart/structure";
import { niceStep, priceText, type ChartLevel } from "@/lib/floor/chart";
import "./om-chart.css";
import "./chart-modal.css";

/**
 * THE PLATFORM'S CHART (owner 11-21: "charts that respond to the user's hands") — The Floor's and GENX's
 * gold chart, moved the way Atlas's Command Center chart moves.
 *
 * NAVIGATION is the Command Center's own (src/lib/chart/viewport.ts, shared with hud/GoldChart.tsx):
 *   drag                     move through time (and price)          Home / End      oldest / newest
 *   wheel, trackpad, pinch   zoom time around the pointer            ← →             step candle by candle
 *   wheel or drag on the axis stretch the price scale                 + −            zoom
 *   double-click / Reset     back to the automatic fit               Esc            clear / leave full screen
 *   Return to live           back to the newest candle, keeping the zoom
 * The view is anchored to a candle's open TIME, so a new price, a new candle, or the twenty-second refresh
 * never moves a view of the past. On a phone a sideways drag moves the chart and an up-and-down one still
 * scrolls the page; touch and hold to read a candle.
 *
 * WHAT IT DRAWS is only what it is given: the market-data feed's candles, the price that came with them,
 * the levels the engine produced, and — for an analysis that is not the current one — the moment it was
 * made. It invents no candle and smooths nothing. Candles the feed printed while gold was shut are shaded
 * and say so, rather than passing for trading. A level from an earlier read starts at that read's candle.
 *
 * A VIEW CONTROL AND NOTHING ELSE. No gesture here changes a candle, a level, a signal, an order or a
 * setting; nothing is fetched or charged by moving it.
 */
export type OmChartProps = {
  bars: TimedBar[];
  /** The stamps are real instants. Otherwise they only order and space the candles, and no clock time is printed. */
  timeKnown: boolean;
  /** One candle's length, and its name ("15m"). */
  tfMs: number;
  tfLabel: string;
  price: number | null;
  /** The price is a current quote: only then is its tag drawn in the "moving" colour. */
  priceLive?: boolean;
  /** A retained analysis: returning to its newest candle must not claim this is a live feed. */
  snapshot?: boolean;
  /** A self-contained dark chart treatment, including controls and fullscreen. */
  appearance?: "nitrous";
  /** Signal snapshots may fit every supplied level; other charts keep their candle-led automatic fit. */
  fitLevels?: boolean;
  dec: number;
  levels: ChartLevel[];
  /** Optional line colours for a market-specific chart; all other charts keep their existing palette. */
  levelColors?: Partial<Record<ChartLevel["kind"], string>>;
  /** Exact observed support/resistance bounds, painted beneath candles without altering them. */
  structureZones?: StructureZone[];
  /** Opt-in compact label backings. Existing charts retain their current annotation appearance. */
  labelStyle?: "backed";
  /** Optional EMA of actual loaded closes, not a projected path. */
  emaPeriod?: number;
  zone?: { low: number; high: number } | null;
  /** The analysis the levels belong to, when it is not the current one: when it was made, and what to call it. */
  analysis?: { at: number; label: string } | null;
  /** The instrument's calendar. Only wholly closed candle intervals are shaded and labelled. */
  isOpenAt?: (t: number) => boolean;
  /** Changing this (another instrument or timeframe) puts the view back to its automatic fit. */
  viewKey: string;
  /** What the picture is, for a screen reader. */
  label: string;
};

/*
 * Colours are the shell's tokens (om.css), so the chart follows the member's look — Stone or Graphite — with nothing
 * redrawn. SVG presentation attributes cannot read a CSS variable, so every colour is set through `style`.
 */
const UP = "var(--om-pos)", DOWN = "var(--om-neg)";
const LEVEL_COLOR: Record<ChartLevel["kind"], string> = {
  resistance: "var(--om-ch-level)", support: "var(--om-ch-level)", entry: "var(--om-ai)", stop: "var(--om-neg)", target: "var(--om-pos)",
};
const HALO = "var(--om-ch-halo)";
const TOP_BAND = 34, TIME_H = 24;
const PHONE_BARS = 40, DESK_BARS = 90;
const useChartLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Drag = { x: number; y: number; end: number; pOff: number; pz: number; axis: boolean; moved: boolean; touch: boolean };

export function OmChart(p: OmChartProps) {
  const { bars, timeKnown, dec } = p;
  const backed = p.labelStyle === "backed";
  const nitrousAppearance = p.appearance === "nitrous";
  // Reserve one stable header area for inspection; selecting a candle never moves the chart.
  const topBand = nitrousAppearance ? 76 : TOP_BAND;
  const ema = useMemo(() => {
    const period = p.emaPeriod;
    if (!period || !Number.isInteger(period) || period < 2 || period > 100 || bars.length < period) return null;
    const alpha = 2/(period+1);
    let previous = bars[0].c;
    return bars.map(b => { previous += alpha*(b.c-previous); return previous; });
  }, [bars,p.emaPeriod]);
  const structureZones = useMemo(() => (p.structureZones ?? []).filter(validStructureZone), [p.structureZones]);
  const sessionBreaks = useMemo(() => {
    if (!timeKnown || !p.isOpenAt) return new Set<number>();
    return new Set(bars.filter((bar) => candleInSessionBreak(bar.t, p.tfMs, p.isOpenAt!)).map((bar) => bar.t));
  }, [bars, timeKnown, p.tfMs, p.isOpenAt]);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const wrap = useRef<HTMLDivElement | null>(null);
  const [sz, setSz] = useState<{ w: number; h: number } | null>(null);
  const [vp, setVp] = useState<Viewport>(AUTO_VIEW);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  /** The candle being read: tapped, held, or stepped to with the keyboard. */
  const [selT, setSelT] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const fullHost = useRef<Element | null>(null);
  const fullOwner = useRef<HTMLDialogElement | null>(null);
  const fullDialog = useRef<HTMLDialogElement | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [said, setSaid] = useState("");
  const barsRef = useRef(bars);
  barsRef.current = bars;

  // Another instrument or timeframe: a fresh view, nothing carried over.
  useEffect(() => { setVp(AUTO_VIEW); setSelT(null); setHoverT(null); setHoverY(null); }, [p.viewKey]);
  // An earlier analysis opens with its own moment and the newest candle both on screen.
  const aKey = p.analysis && timeKnown ? p.analysis.at : null;
  const hasBars = bars.length >= 2;
  useEffect(() => {
    const b = barsRef.current;
    if (aKey == null || b.length < 2 || aKey < b[0].t) return;
    const i = indexAtOrBefore(b, aKey);
    setVp({ ...AUTO_VIEW, span: Math.min(b.length, Math.max(MIN_BARS, b.length - i + 12)) });
  }, [aKey, p.viewKey, hasBars]);

  const measure = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    const w = Math.round(r.width), h = Math.round(r.height);
    setSz((previous) => previous?.w === w && previous.h === h ? previous : { w, h });
  }, []);
  useChartLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full, measure]);

  const compact = !!sz && sz.w < 560;
  const AXIS = compact ? 62 : 76;
  const plotW = sz ? sz.w - AXIS : 0;
  const priceH = sz ? sz.h - TIME_H : 0;

  /* ── the window: which candles, and the price range they need ── */
  const view = useMemo(() => {
    const n = bars.length;
    if (!sz || n < 2 || plotW < 60 || priceH < 60) return null;
    const usable = plotW - Math.max(6, plotW * 0.025);
    const autoSpan = Math.min(n, compact ? PHONE_BARS : DESK_BARS);
    const { span, end, iL } = timeWindow(bars, vp, autoSpan);
    const bw = usable / span;
    const x = (i: number) => (i - iL + 0.5) * bw;
    const i0 = Math.max(0, Math.floor(iL) - 1), i1 = Math.min(n - 1, Math.ceil(end) + 1);
    let lo = Infinity, hi = -Infinity;
    const f0 = Math.max(0, Math.ceil(iL - 0.5)), f1 = Math.min(n - 1, Math.floor(end + 0.5));
    for (let i = f0 <= f1 ? f0 : i0; i <= (f0 <= f1 ? f1 : i1); i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = bars[n - 1].c; hi = bars[n - 1].c; }
    const atEdge = vp.follow || end >= n - 1;
    // The price that came with the candles counts toward the fit only while the newest candle is on screen,
    // so a new quote can never move a view of the past. Levels count when they are near enough not to
    // squeeze the candles into a sliver.
    if (atEdge && p.price != null && Number.isFinite(p.price)) { lo = Math.min(lo, p.price); hi = Math.max(hi, p.price); }
    const base = Math.max(hi - lo, Math.abs(hi) * 0.0004, 10 ** -dec);
    const near = (v: number) => Number.isFinite(v) && v >= lo - base * 0.6 && v <= hi + base * 0.6;
    for (const v of [...p.levels.map((l) => l.price), ...(p.zone ? [p.zone.low, p.zone.high] : []), ...structureZones.flatMap((zone) => [zone.low, zone.high])]) if (Number.isFinite(v) && (p.fitLevels || near(v))) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const mid = (lo + hi) / 2, half = (Math.max(hi - lo, base) / 2) * 1.1 / Math.max(0.05, vp.pz);
    const pLo = mid - half + vp.pOff;
    const pHi = mid + half + vp.pOff + (2 * half) * topBand / Math.max(40, priceH - topBand);
    const y = (v: number) => ((pHi - v) / (pHi - pLo)) * priceH;
    return { n, usable, span, end, iL, bw, x, y, i0, i1, pLo, pHi, pricePerPx: (pHi - pLo) / Math.max(1, priceH) };
  }, [bars, sz, plotW, priceH, compact, vp, p.price, p.levels, p.zone, p.fitLevels, structureZones, dec, topBand]);

  /* Gesture maths reads this rather than a stale closure. */
  const st = useRef<ViewScale & { plotW: number; priceH: number }>({ n: 0, span: 0, end: 0, iL: 0, bw: 1, usable: 1, pricePerPx: 1, plotW: 1, priceH: 1 });
  if (view) st.current = { n: view.n, span: view.span, end: view.end, iL: view.iL, bw: view.bw, usable: view.usable, pricePerPx: view.pricePerPx, plotW, priceH };

  const reset = useCallback(() => { setVp(AUTO_VIEW); setSelT(null); }, []);
  const toLive = useCallback(() => { setVp(toNewest); setSelT(null); }, []);

  /* Wheel and trackpad: zoom time around the pointer (a sideways swipe pans); over the price axis, or with
     Shift, stretch the price scale. Only over the chart — the page scrolls as usual everywhere else. */
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = st.current;
      if (!s.n) return;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (py > s.priceH + TIME_H || py < 0) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (px > s.plotW || e.shiftKey) { setVp((v) => ({ ...v, pz: stretchPrice(v.pz, dy || dx, 0.0018) })); return; }
      if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) { setVp((v) => panTo(v, s, barsRef.current, s.end + dx / s.bw, v.pOff)); return; }
      // A trackpad pinch arrives as a wheel with ctrlKey and small steps: the same zoom, scaled up.
      setVp((v) => zoomAt(v, s, barsRef.current, Math.min(px, s.plotW), e.ctrlKey ? dy * 6 : dy));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [full]);

  /* Drag to pan, two fingers to pinch, drag on the axis to stretch, touch-and-hold to read a candle. */
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag | null>(null);
  const pinch = useRef<{ dist: number; span: number; anchor: number; px: number } | null>(null);
  const hold = useRef<{ timer: number | null; on: boolean }>({ timer: null, on: false });
  const endHold = () => { if (hold.current.timer != null) window.clearTimeout(hold.current.timer); hold.current = { timer: null, on: false }; };

  const candleAt = (px: number): number | null => {
    const s = st.current, b = barsRef.current;
    if (!s.n || px < 0 || px > s.plotW) return null;
    const i = Math.round(s.iL + px / s.bw - 0.5);
    return i >= 0 && i < b.length ? b[i].t : null;
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current;
    if (!s.n || (e.pointerType === "mouse" && e.button !== 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (py > s.priceH + TIME_H) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    if (pts.current.size === 2) {
      endHold();
      const [a, b] = [...pts.current.values()];
      const mx = (a.x + b.x) / 2 - r.left;
      pinch.current = { dist: Math.max(1, Math.abs(a.x - b.x)), span: s.span, anchor: s.iL + mx / s.bw - 0.5, px: mx };
      drag.current = null;
      return;
    }
    const touch = e.pointerType !== "mouse";
    drag.current = { x: e.clientX, y: e.clientY, end: s.end, pOff: vp.pOff, pz: vp.pz, axis: px > s.plotW, moved: false, touch };
    if (touch) {
      endHold();
      hold.current.timer = window.setTimeout(() => {
        if (drag.current && !drag.current.moved) { hold.current.on = true; setSelT(candleAt(px)); }
      }, 320);
    }
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current;
    if (!s.n) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const pc = pinch.current;
      setVp((v) => spanAround(v, s, barsRef.current, pc.anchor, pc.px, (pc.span || s.n) * (pc.dist / Math.max(1, Math.abs(a.x - b.x)))));
      return;
    }
    const d = drag.current;
    if (d && hold.current.on) { setSelT(candleAt(px)); return; }       // reading candles, not moving the chart
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > (d.touch ? 6 : 3)) { d.moved = true; endHold(); setGrabbing(true); }
      if (!d.moved) return;
      if (d.axis) { setVp((v) => ({ ...v, pz: stretchPrice(d.pz, dy, 0.006) })); return; }
      // A finger moves time only: up and down stays the page's. A mouse moves price too, as Atlas's chart does.
      setVp((v) => panTo(v, s, barsRef.current, d.end - dx / s.bw, d.touch ? v.pOff : d.pOff + dy * s.pricePerPx));
      return;
    }
    if (e.pointerType === "mouse") {
      setHoverT(candleAt(px));
      setHoverY(py >= 0 && py <= s.priceH && px <= s.plotW ? py : null);
    }
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && !d.moved && !d.axis && !hold.current.on && pts.current.size === 1) {
      const r = e.currentTarget.getBoundingClientRect();
      const t = candleAt(e.clientX - r.left);
      setSelT((cur) => (t == null || cur === t ? null : t));     // a tap reads a candle; a second tap lets it go
    }
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    if (pts.current.size === 0) { drag.current = null; endHold(); setGrabbing(false); }
  };

  /* The keyboard reads and moves the chart too. */
  const stepTo = (i: number) => {
    const b = barsRef.current, s = st.current;
    if (!b.length) return;
    const k = clamp(i, 0, b.length - 1);
    setSelT(b[k].t);
    // Keep the candle being read on screen.
    if (k < s.iL + 0.5 || k > s.end - 0.5) setVp((v) => panTo(v, s, b, k < s.iL + 0.5 ? k + s.span - 1.5 : k + 0.5, v.pOff));
    const c = b[k];
    setSaid(`${candleTimeText(c.t, timeKnown, b[b.length - 1].t)}. Open ${priceText(c.o, dec)}, high ${priceText(c.h, dec)}, low ${priceText(c.l, dec)}, close ${priceText(c.c, dec)}.`);
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const b = barsRef.current, s = st.current;
    if (!b.length || !s.n || e.altKey || e.metaKey || e.ctrlKey) return;
    const cur = selT != null ? indexOfT(b, selT) : -1;
    const from = cur >= 0 ? cur : Math.min(b.length - 1, Math.floor(s.end));
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      const dir = k === "ArrowLeft" ? -1 : 1;
      if (e.shiftKey) setVp((v) => panTo(v, s, b, s.end + dir * Math.max(5, s.span * 0.25), v.pOff));
      else stepTo(cur >= 0 ? from + dir : from);
    } else if (k === "+" || k === "=" || k === "-" || k === "_") {
      e.preventDefault();
      setVp((v) => zoomAt(v, s, b, s.plotW / 2, k === "-" || k === "_" ? 160 : -160));
    } else if (k === "Home") { e.preventDefault(); stepTo(0); }
    else if (k === "End") { e.preventDefault(); toLive(); setSaid("The newest candle."); }
    else if (k === "0") { e.preventDefault(); reset(); setSaid("View reset."); }
    else if (k === "Escape") {
      if (selT != null) { e.preventDefault(); setSelT(null); }
      else if (full) { e.preventDefault(); setFull(false); }
    }
  };

  const toggleFull = () => {
    if (!full && typeof document !== "undefined") {
      fullOwner.current = wrap.current?.closest<HTMLDialogElement>("dialog[open]") ?? null;
      fullHost.current = fullOwner.current ?? wrap.current?.closest<HTMLElement>("[data-om-chart-host]") ?? document.querySelector(".om-app") ?? document.body;
    }
    setFull((value) => !value);
  };

  // A chart opened inside Atlas needs its own top-layer dialog: a portal into the page is inert behind
  // Atlas. Native modal focus keeps Tab inside the chart; closing it never closes its owning dialog.
  useEffect(() => {
    if (!full) return;
    const owner = fullOwner.current, sheet = fullDialog.current;
    if (owner && !owner.open) { setFull(false); return; }
    if (sheet && !sheet.open) {
      try { sheet.showModal(); } catch { setFull(false); return; }
      measure();
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setFull(false); }
    };
    const closeWithOwner = (event: Event) => { if (event.target === owner) setFull(false); };
    document.addEventListener("keydown", esc, true);
    owner?.addEventListener("close", closeWithOwner);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    wrap.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", esc, true);
      owner?.removeEventListener("close", closeWithOwner);
      if (sheet?.open) sheet.close();
      document.body.style.overflow = prev;
      if (!owner || owner.open) wrap.current?.focus({ preventScroll: true });
    };
  }, [full, measure]);

  const stop = (e: React.PointerEvent) => e.stopPropagation();
  const n = bars.length;
  const last = n ? bars[n - 1] : null;
  const hintId = `omch-hint-${uid}`;

  let body: React.ReactNode = null;
  if (view && last && sz) {
    const { x, y, i0, i1, bw } = view;
    const cw = Math.max(1, Math.min(bw * 0.62, 14));
    const shownT = hoverT ?? selT;
    const si = shownT != null ? indexOfT(bars, shownT) : -1;
    const hb = si >= 0 ? bars[si] : last;
    const up = (b: TimedBar) => b.c >= b.o;
    const ch = hb.c - hb.o;
    const forming = si < 0 || si === n - 1;
    const shut = (t: number) => sessionBreaks.has(t);
    const atLive = vp.follow || atNewest(view.end, n);
    const closedNow = !!p.isOpenAt && timeKnown && Date.now() > 0 && !p.isOpenAt(Date.now());

    // Price grid
    const step = niceStep(view.pHi - view.pLo, Math.max(3, Math.min(8, Math.round(priceH / 56))));
    const yTicks: number[] = [];
    for (let v = Math.ceil(view.pLo / step) * step; v <= view.pHi; v += step) { const yy = y(v); if (yy > topBand - 4 && yy < priceH - 4) yTicks.push(Number(v.toFixed(Math.max(dec, 6)))); }
    const tTicks = axisMarks(bars, Math.max(i0, Math.ceil(view.iL)), Math.min(i1, Math.floor(view.end)), Math.max(2, Math.floor(plotW / 120)), timeKnown);

    // Where an earlier analysis starts: its own candle, if it is on the chart.
    const aIdx = p.analysis && timeKnown ? indexAtOrBefore(bars, p.analysis.at) : -1;
    const aInRange = p.analysis != null && aIdx >= 0 && p.analysis.at >= bars[0].t;
    const aX = aInRange ? x(aIdx) : null;
    // Without real times an earlier read cannot be placed: its levels are drawn across, as before.
    const before = !!p.analysis && timeKnown && p.analysis.at < bars[0].t;
    const levelX0 = !p.analysis || !timeKnown || before ? 0 : aX == null ? 0 : Math.max(0, aX);

    // The earlier analysis's label sits left of its line (level labels are to the right of it), at the foot.
    const aText = p.analysis?.label ?? "";
    const aW = aText.length * 6.3;
    const aLeft = aX != null && aX - 8 - aW >= 4;
    const aSpan: [number, number] | null = aX == null || aX < 0 || aX > plotW ? null : aLeft ? [aX - 8 - aW, aX] : [aX, aX + 8 + aW];

    // Shaded runs whose whole candle interval falls in a scheduled closure.
    const closedRuns: { a: number; b: number }[] = [];
    for (let i = i0; i <= i1; i++) {
      if (!shut(bars[i].t)) continue;
      const lastRun = closedRuns[closedRuns.length - 1];
      if (lastRun && lastRun.b === i - 1) lastRun.b = i; else closedRuns.push({ a: i, b: i });
    }

    // Saved signals and backed labels keep actual price-line order when levels crowd the plot's edge.
    // Backings need more vertical space than plain text. Other charts retain their placement rule.
    const used: number[] = [];
    const visibleLevels = (levelX0 == null ? [] : p.levels)
      .map((l) => ({ l, ly: y(l.price) }))
      .filter((o) => o.ly >= topBand - 6 && o.ly <= priceH + 2)
      .sort((a, b) => a.ly - b.ly);
    const lv = backed ? orderedLevelLabels(visibleLevels, topBand + 15, priceH - 9, 25)
      : p.fitLevels ? orderedLevelLabels(visibleLevels, topBand + 12, priceH - 6)
      : visibleLevels.map(({ l, ly }) => {
        const clash = (v: number) => used.some((u) => Math.abs(u - v) < 15);
        let labelY = ly - 6;
        if (labelY < topBand + 8 || clash(labelY)) labelY = ly + 15;
        // Never below the plot (it would be cut off at the time axis): back above its line, and up past any neighbour.
        if (labelY > priceH - 6) { labelY = Math.min(ly - 6, priceH - 6); for (let k = 0; k < 6 && clash(labelY); k++) labelY -= 15; }
        used.push(labelY);
        return { l, ly, labelY };
      });
    const pxY = p.price != null ? y(p.price) : null;
    // Said only once the view has been moved there: a chart showing all it has needs no note.
    const leftEdge = view.iL <= 0.5 && moved(vp);
    // The readout keeps clear of the view's buttons: beside them on a desk, above them on a phone.
    const toolsW = nitrousAppearance ? 48 + (moved(vp) ? 46 : 0) : compact ? AXIS : 44 + (moved(vp) ? 92 : 0) + (!atLive ? 146 : 0);
    const crossX = si >= 0 ? x(si) : null;

    body = (
      <>
        {/* the candle being read — one line, on a backing */}
        <div className="om-ch-read" data-no-i18n translate="no" style={{ maxWidth: `calc(100% - ${toolsW}px)` }}>
          <span className="om-ch-tf">{p.tfLabel}</span>
          <span className="om-ch-when">{forming && si < 0 ? (timeKnown ? clockText(hb.t) : "Newest candle") : candleTimeText(hb.t, timeKnown, last.t)}</span>
          {!nitrousAppearance && <>
            {(!compact || si >= 0) && (["O", "H", "L"] as const).map((k) => (
              <span key={k} className="om-ch-ohlc">{k} <b className={up(hb) ? "om-pos" : "om-neg"}>{priceText(k === "O" ? hb.o : k === "H" ? hb.h : hb.l, dec)}</b></span>
            ))}
            <span className="om-ch-ohlc">C <b className={up(hb) ? "om-pos" : "om-neg"}>{priceText(hb.c, dec)}</b></span>
            <span className={up(hb) ? "om-pos" : "om-neg"}>{ch >= 0 ? "+" : "−"}{priceText(Math.abs(ch), dec)}{compact ? "" : ` (${((ch / hb.o) * 100).toFixed(2)}%)`}</span>
          </>}
          {shut(hb.t) && <span className="om-ch-tag">{closedNow && Date.now() >= hb.t && Date.now() < hb.t + p.tfMs ? "Market closed" : "Session break"}</span>}
        </div>

        {nitrousAppearance && <div className="om-ch-inspect" data-selected={si >= 0} data-no-i18n translate="no">
          {si >= 0 ? (["Open", "High", "Low", "Close"] as const).map((key) => <span key={key}><small>{key}</small><b className={up(hb) ? "om-pos" : "om-neg"}>{priceText(key === "Open" ? hb.o : key === "High" ? hb.h : key === "Low" ? hb.l : hb.c, dec)}</b></span>)
            : <><span><small>{p.snapshot ? "Last closed candle" : "Latest candle"}</small><b>Close {priceText(hb.c, dec)}</b></span><span className="om-ch-inspect-hint">Hold a candle to inspect</span></>}
        </div>}

        {/* the view's own controls */}
        <div className="om-ch-tools" onPointerDown={stop} style={compact && !nitrousAppearance ? { top: "auto", bottom: TIME_H + 8, right: AXIS + 4 } : undefined}>
          {moved(vp) && <button type="button" onClick={reset} aria-label="Reset chart view" title="Back to the automatic view (double-click the chart, or press 0)"><RotateCcw aria-hidden="true" />{!compact && !nitrousAppearance && "Reset"}</button>}
          {!atLive && !nitrousAppearance && (
            <button type="button" onClick={toLive} className="om-ch-live" title={p.snapshot ? "Back to the newest candle in this saved snapshot (End)" : closedNow ? "To the newest candle the feed has. The market is closed, so it is the last one before the close." : "Back to the newest candle, keeping the zoom (End)"}>
              {p.snapshot ? compact ? "Latest" : "Latest candle" : closedNow ? "Latest candle" : "Return to live"}<ChevronsRight aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={toggleFull} aria-pressed={full} aria-label={full ? "Leave full screen" : "Full screen"} title={full ? "Leave full screen (Esc)" : "Full screen"}>
            {full ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
        </div>

        {nitrousAppearance && !atLive && <div className="om-ch-latest" onPointerDown={stop} style={{ bottom: TIME_H + 8, right: AXIS + 4 }}>
          <button type="button" onClick={toLive} aria-label="Show latest available candle" title="Back to the newest available candle, keeping the zoom (End)">Latest <ChevronsRight aria-hidden="true" /></button>
        </div>}

        {(leftEdge || before) && (
          <div className="om-ch-edge" data-no-i18n translate="no">
            {before
              ? `${p.analysis!.label} — made before the first candle loaded, so its levels are drawn across`
              : `Start of the loaded history${timeKnown ? ` · ${dayText(bars[0].t)}, ${clockText(bars[0].t)}` : ""}`}
          </div>
        )}

        <svg role="img" aria-label={p.label} width={sz.w} height={sz.h} className="om-ch-svg">
          <defs>
            <clipPath id={`omch-plot-${uid}`}><rect x={0} y={0} width={plotW} height={priceH} /></clipPath>
            <pattern id={`omch-shut-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--om-ch-hatch)" }} strokeWidth="2" />
            </pattern>
          </defs>

          {/* grid */}
          {yTicks.map((v) => <line key={`h${v}`} x1={0} x2={plotW} y1={y(v)} y2={y(v)} style={{ stroke: "var(--om-ch-grid)" }} />)}
          {tTicks.map((t) => <line key={`v${t.i}`} x1={x(t.i)} x2={x(t.i)} y1={topBand - 6} y2={priceH} style={{ stroke: "var(--om-ch-grid-2)" }} />)}
          <line x1={0} x2={plotW} y1={priceH} y2={priceH} style={{ stroke: "var(--om-ch-base)" }} />

          <g clipPath={`url(#omch-plot-${uid})`}>
            {/* scheduled closure throughout the candle interval: said, not hidden */}
            {closedRuns.map((r) => {
              const x0 = x(r.a) - bw / 2, x1 = x(r.b) + bw / 2;
              // Its caption at the foot of the band, right-aligned, where it fits and the analysis label is not. Where
              // the whole line does not fit, the two words that matter. On a phone the foot of the plot holds the view's
              // buttons and there is no room for a caption that candles and levels would cross: there the hatching and
              // the readout's own session-break tag (on the candle being read) say it.
              const capR = Math.min(x1, plotW) - 8;
              const room = (w: number) => capR - w >= Math.max(0, x0) && !(aSpan && aSpan[0] < capR && aSpan[1] > capR - w);
              const longCaption = "Session break · feed quotes, not trading", shortCaption = "Session break";
              const cap = compact ? null : room(longCaption.length * 6 + 16) ? longCaption : room(shortCaption.length * 6 + 16) ? shortCaption : null;
              return (
                <g key={`c${r.a}`} pointerEvents="none">
                  <rect x={x0} y={0} width={Math.max(1, x1 - x0)} height={priceH} fill={`url(#omch-shut-${uid})`} />
                  {cap && <>{backed && <rect x={capR - (cap.length * 6 + 12)} y={priceH - 24} width={cap.length * 6 + 16} height={21} rx="5" style={{ fill: "var(--om-surface)", stroke: "var(--om-edge)" }} />}
                    <text x={capR} y={priceH - 9} textAnchor="end" fontSize="11.5" style={{ fill: "var(--om-text-3)", stroke: backed ? "none" : HALO }} strokeWidth={backed ? 0 : 4} paintOrder="stroke">{cap}</text></>}
                </g>
              );
            })}

            {/* Actual structural ranges; neither candle prices nor zone thickness are embellished. */}
            {structureZones.map((zone, index) => {
              const band = priceBand(zone.low, zone.high, view.pLo, view.pHi, priceH);
              if (!band || levelX0 == null) return null;
              const tone = zone.kind === "support" ? "var(--om-pos)" : "var(--om-neg)";
              return <g key={`${zone.kind}:${zone.low}:${zone.high}:${index}`} pointerEvents="none">
                <title>{zone.label ?? (zone.kind === "support" ? "Support zone" : "Resistance zone")} {priceText(zone.low, dec)} – {priceText(zone.high, dec)}</title>
                <rect x={levelX0} y={band.top} width={Math.max(0, plotW - levelX0)} height={band.height} style={{ fill: tone }} fillOpacity="0.085" />
                <line x1={levelX0} x2={plotW} y1={y(zone.high)} y2={y(zone.high)} style={{ stroke: tone }} strokeOpacity="0.25" strokeWidth="0.75" />
                <line x1={levelX0} x2={plotW} y1={y(zone.low)} y2={y(zone.low)} style={{ stroke: tone }} strokeOpacity="0.25" strokeWidth="0.75" />
              </g>;
            })}

            {/* the entry zone */}
            {p.zone && levelX0 != null && (() => {
              const zt = y(p.zone.high), zb = y(p.zone.low);
              return zb - zt >= 1 ? <rect x={levelX0} y={zt} width={Math.max(0, plotW - levelX0)} height={zb - zt} style={{ fill: "rgb(var(--om-ai-rgb) / 0.09)" }} /> : null;
            })()}

            {/* candles */}
            {bars.slice(i0, i1 + 1).map((b, k) => {
              const i = i0 + k, cx = x(i), col = up(b) ? UP : DOWN;
              const yo = y(b.o), yc = y(b.c);
              return (
                <g key={b.t} opacity={shut(b.t) ? 0.55 : 1}>
                  <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} style={{ stroke: col }} strokeWidth="1" />
                  <rect x={cx - cw / 2} y={Math.min(yo, yc)} width={cw} height={Math.max(1, Math.abs(yc - yo))} rx="0.6" style={{ fill: col }} />
                </g>
              );
            })}

            {ema && i1 > i0 && <polyline pointerEvents="none" points={ema.slice(i0,i1+1).map((v,k)=>`${x(i0+k)},${y(v)}`).join(" ")}
              fill="none" strokeWidth="1.4" style={{stroke:"var(--om-ai)"}} strokeOpacity=".85" />}
            {/* the moment an earlier analysis was made */}
            {aX != null && aX >= 0 && aX <= plotW && (
              <g pointerEvents="none" data-analysis-mark="">
                <line x1={aX} x2={aX} y1={topBand - 4} y2={priceH} style={{ stroke: "rgb(var(--om-ai-rgb) / 0.55)" }} strokeDasharray="3 4" />
                <text x={aLeft ? aX - 8 : aX + 8} y={priceH - 9} textAnchor={aLeft ? "end" : "start"} fontSize="11.5" style={{ fill: "var(--om-ai)", stroke: HALO }} strokeWidth="4" paintOrder="stroke">{aText}</text>
              </g>
            )}

            {/* levels the engine produced */}
            {levelX0 != null && lv.map(({ l, ly, labelY }) => {
              const tone = p.levelColors?.[l.kind] ?? LEVEL_COLOR[l.kind];
              const tag = levelTag(l.label, priceText(l.price, dec), plotW - 12);
              const tagX = clamp(levelX0 + 6, 4, Math.max(4, plotW - tag.width - 4));
              return <g key={`${l.kind}${l.price}`} opacity={p.analysis ? 0.85 : 1} pointerEvents="none">
                <line x1={levelX0} x2={plotW} y1={ly} y2={ly} style={{ stroke: tone }} strokeWidth="1" strokeDasharray={p.analysis ? "2 4" : "4 4"} />
                {(p.fitLevels || backed) && Math.abs(labelY - (ly - 6)) > 2 && <line x1={levelX0 + 3} x2={backed ? tagX + 4 : levelX0 + 8} y1={ly} y2={labelY - 4} style={{ stroke: tone }} strokeWidth="0.75" opacity="0.8" />}
                {backed ? <g className="om-ch-level-tag">
                  <title>{l.label} {priceText(l.price, dec)}</title>
                  <rect x={tagX} y={labelY - 14} width={tag.width} height={22} rx="5" style={{ fill: "var(--om-surface)", stroke: tone }} strokeWidth="0.75" strokeOpacity="0.45" />
                  <text x={tagX + 9} y={labelY} fontSize="11.5" style={{ fill: "var(--om-text)", fontVariantNumeric: "tabular-nums" }}>{tag.text}</text>
                </g> : <text x={levelX0 + 10} y={labelY} fontSize="12.5" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke" style={{ fill: "var(--om-text)", stroke: HALO, fontVariantNumeric: "tabular-nums" }}>{l.label} {priceText(l.price, dec)}</text>}
              </g>;
            })}

            {/* the last price */}
            {pxY != null && pxY >= 0 && pxY <= priceH && <line x1={0} x2={plotW} y1={pxY} y2={pxY} style={{ stroke: p.priceLive ? "rgb(var(--om-pos-rgb) / 0.4)" : "var(--om-ch-price)" }} strokeDasharray="1 4" />}
          </g>

          {/* price axis */}
          {yTicks.filter((v) => pxY == null || Math.abs(y(v) - pxY) > 14).map((v) => (
            <text key={`p${v}`} x={plotW + 10} y={y(v) + 4} fontSize="12" style={{ fill: "var(--om-text-2)", fontVariantNumeric: "tabular-nums" }}>{priceText(v, dec)}</text>
          ))}
          {pxY != null && pxY >= -10 && pxY <= priceH + 10 && (
            <g>
              <rect x={plotW + 3} y={clamp(pxY, 11, priceH - 11) - 11} width={AXIS - 6} height={22} rx="6" style={{ fill: p.priceLive ? UP : "var(--om-ch-tag)" }} />
              <text x={plotW + AXIS / 2} y={clamp(pxY, 11, priceH - 11) + 4.5} textAnchor="middle" fontSize="12" fontWeight="500" style={{ fill: "var(--om-ch-tag-text)", fontVariantNumeric: "tabular-nums" }}>{priceText(p.price!, dec)}</text>
            </g>
          )}

          {/* time axis */}
          {tTicks.filter((t) => crossX == null || !timeKnown || Math.abs(x(t.i) - crossX) > 64).map((t) => <text key={`t${t.i}`} x={x(t.i)} y={sz.h - 7} fontSize="12" textAnchor="middle" style={{ fill: "var(--om-text-2)" }}>{t.text}</text>)}

          {/* crosshair */}
          {si >= 0 && x(si) >= 0 && x(si) <= plotW && (
            <g pointerEvents="none">
              <rect x={x(si) - bw / 2} y={topBand - 4} width={bw} height={priceH - topBand + 4} style={{ fill: "var(--om-ch-col)" }} />
              <line x1={x(si)} x2={x(si)} y1={topBand - 4} y2={priceH} style={{ stroke: "var(--om-ch-cross)" }} strokeDasharray="2 3" />
              {timeKnown && (
                <g>
                  <rect x={clamp(x(si) - 34, 0, plotW - 68)} y={priceH + 2} width={68} height={TIME_H - 4} rx="5" style={{ fill: "var(--om-ch-tip)", stroke: "var(--om-ch-tip-edge)" }} />
                  <text x={clamp(x(si), 34, plotW - 34)} y={priceH + 16} textAnchor="middle" fontSize="11.5" style={{ fill: "var(--om-text)" }}>{clockText(bars[si].t, false)}</text>
                </g>
              )}
            </g>
          )}
          {hoverY != null && (
            <g pointerEvents="none">
              <line x1={0} x2={plotW} y1={hoverY} y2={hoverY} style={{ stroke: "var(--om-ch-cross-2)" }} strokeDasharray="2 3" />
              <rect x={plotW + 3} y={hoverY - 10} width={AXIS - 6} height={20} rx="5" style={{ fill: "var(--om-ch-tip)", stroke: "var(--om-ch-tip-edge)" }} />
              <text x={plotW + AXIS / 2} y={hoverY + 4} textAnchor="middle" fontSize="11.5" style={{ fill: "var(--om-text)", fontVariantNumeric: "tabular-nums" }}>{priceText(view.pHi - (hoverY / Math.max(1, priceH)) * (view.pHi - view.pLo), dec)}</text>
            </g>
          )}
        </svg>
      </>
    );
  }

  const chart = (
    <div
      ref={wrap}
      className="om-ch"
      data-appearance={p.appearance}
      data-compact={compact || undefined}
      data-full={full || undefined}
      data-grabbing={grabbing || undefined}
      tabIndex={0}
      role="group"
      aria-roledescription="interactive chart"
      aria-label={p.label}
      aria-describedby={hintId}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") { setHoverT(null); setHoverY(null); } }}
      onDoubleClick={reset}
      onKeyDown={onKey}
    >
      {body}
      <span id={hintId} className="om-sr">Drag, or use the arrow keys, to move through the candles. Scroll, pinch, or press plus and minus to zoom. Home goes to the oldest candle, End to the newest, and 0 resets the view.</span>
      <span className="om-sr" aria-live="polite">{said}</span>
    </div>
  );

  // Keep the chart inside its owning dialog/shell for colours, and above Atlas in the native top layer.
  if (full && typeof document !== "undefined") {
    const host = fullHost.current ?? wrap.current?.closest<HTMLElement>("[data-om-chart-host]") ?? document.querySelector(".om-app") ?? document.body;
    const sheet = fullOwner.current
      ? <dialog ref={fullDialog} className="om-ch-sheet om-ch-modal" data-appearance={p.appearance} aria-label={`${p.label}, full screen`}
        onCancel={(event) => { event.preventDefault(); event.stopPropagation(); setFull(false); }}
        onClose={(event) => { event.stopPropagation(); setFull(false); }}>{chart}</dialog>
      : <div className="om-ch-sheet" data-appearance={p.appearance} role="dialog" aria-modal="true" aria-label={`${p.label}, full screen`}>{chart}</div>;
    return (
      <>
        <div className="om-ch-hold" aria-hidden="true" />
        {createPortal(sheet, host)}
      </>
    );
  }
  return chart;
}
