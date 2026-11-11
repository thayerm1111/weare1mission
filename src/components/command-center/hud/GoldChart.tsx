"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { H, fmt2 } from "./theme";
import {
  CHART_ACTION_EVENT, levelIdOf,
  type ChartActionContext, type ChartTf, type FeedState, type FeedStatus, type Scenario,
} from "../../../../command-center/core/atlasContract";
import { TF_MS, withLiveCandles, type LiveTick } from "../../../../command-center/core/formingCandle";
import { FEED_STATUS_WORD, feedAgeShort, feedAgeWords, feedBasisLabel } from "../../../../command-center/core/feed";
import { marketOpen } from "../../../../command-center/core/sessions";
import { NO_CHART_ACTIONS, markNotes, receiveChartAction, settleChartActions, type ChartActionOverlay } from "./chartActions";

export type ChartBar = {
  t: number; o: number; h: number; l: number; c: number; v?: number;
  /** Built (wholly or partly) from streamed ticks — the server has not confirmed this candle yet. */
  live?: boolean;
  /** Its open is the first price the screen saw, not necessarily the period's real open. */
  partialOpen?: boolean;
};
export type ChartMarker = { at: number; price: number | null; label: string; tone: "up" | "down" | "gold" | "cold" };
export type ChartZone = { from: number; to: number; label: string; tone: "supply" | "demand" | "target" };
export type ChartLine = { price: number; label: string; color: string; dashed?: boolean; tag?: boolean };
/** A level ATLAS may point at, identified by levelIdOf(kind, price) — the same list the live read sends. */
export type ChartLevel = { kind: string; price: number; label: string };

/**
 * THE PRIMARY GOLD CHART — candles, activity, and Atlas's own overlays.
 *
 * Every overlay is something the engine produced: zones are its nearest levels above and below, markers
 * are its own perception events (structure breaks, reclaims, liquidity sweeps) placed at the bar they
 * fired on, lines are its watch / invalidation / trade levels, and the dashed path is the scenario
 * consistent with its current thesis — labelled as a conditional scenario, never as a forecast.
 *
 * LIVE CANDLES (owner 11-11: "Update the current candle as new prices arrive"). With `tf` and `ticks`
 * (hud/useLiveFeed.ts), the streamed ticks move the forming candle of the visible timeframe and open the
 * next one when a boundary passes (core/formingCandle.ts). Server bars stay the record and replace tick
 * candles by open time as they arrive. A period with no data stays empty — and, because candles sit side by
 * side, a faint "gap · no data" line marks where the market was open with nothing to show. Nothing is ever
 * drawn that no price produced.
 *
 * HONEST BASIS. A small label says whose price this is and how it is arriving — "Twelve Data · XAU/USD
 * composite (mid) · LIVE · 1s" — from `feed` (core/feed.ts). The status dot and the price tag are green ONLY
 * when the feed is LIVE; without `feed` the chart claims nothing about being live.
 *
 * ATLAS'S HANDS (owner 11-11: "Atlas should be able to use validated chart actions"). The chart listens for
 * CHART_ACTION_EVENT and draws only what validates against what it actually holds (hud/chartActions.ts): a
 * level by its ID (line + label), a zone near the price (band + label), a candle by its open time on THIS
 * timeframe (marker) — a candle on another timeframe becomes a small note, never a guess — a scenario by its
 * ID (a dashed path in a hatched projection area, labelled "Conditional scenario"), and clear. The
 * "timeframe" action is the screen's to handle (CommandCenterHud), not the chart's.
 *
 * NAVIGATION — the same gestures a broker terminal gives you:
 *   wheel / trackpad          zoom time in and out around the cursor
 *   drag on the chart         pan through time, and up and down through price
 *   wheel or drag on the axis stretch or squeeze the price scale
 *   pinch (touch)             zoom time
 *   double-click / Reset      back to the automatic fit that follows the last candle
 *   Return to live            back to the newest candle, keeping the zoom
 * The view is anchored to a candle's TIME, so new ticks, new candles and older bars dropping off the left
 * never move what the user is looking at; while panned into history the price fit ignores the moving edge.
 *
 * This is a VIEW control and nothing else. It reads the same bars the engine already sent, changes no
 * data, and reports nothing back — zooming the cockpit glass never touches the pilot.
 */
const MIN_BARS = 10;
const PHONE_BARS = 14;     // the default window on a phone-width chart       // never zoom past a handful of candles
const OVERSCROLL = 0.35;   // how far past the newest / oldest candle panning may run, as a fraction of the view
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const STATUS_COLOR: Record<FeedStatus, string> = {
  live: H.green, delayed: H.gold2, reconnecting: H.gold2, stale: H.red, closed: H.mut, demo: H.blue,
};

type Viewport = {
  /** Right-most visible candle, by its OPEN TIME (ignored while `follow` is on). */
  endT: number;
  /** How far past that candle the right edge sits, in bars (pans are smooth, not bar-snapped). */
  endOff: number;
  /** How many bars are visible. 0 means "auto: show everything the feed sent". */
  span: number;
  /** Stay pinned to the newest candle as bars arrive. */
  follow: boolean;
  /** Price-scale stretch. 1 = fit the visible candles. */
  pz: number;
  /** Vertical pan, in price units. */
  pOff: number;
};
const AUTO: Viewport = { endT: 0, endOff: 0, span: 0, follow: true, pz: 1, pOff: 0 };

/** Index of the last candle opening at or before `t` (0 when `t` is before them all). */
function indexAtOrBefore(bars: readonly { t: number }[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
/** Index of the candle opening exactly at `t`, or -1. */
function indexOfT(bars: readonly { t: number }[], t: number): number {
  const i = indexAtOrBefore(bars, t);
  return bars[i]?.t === t ? i : -1;
}

/** Was the market open for the whole of some bucket strictly between two candles? Only then is the hole
 *  missing data; a weekend or the daily break is the calendar, not a gap. Intraday timeframes only. */
function missingWhileOpen(prevT: number, nextT: number, step: number): boolean {
  const n = Math.floor((nextT - prevT) / step) - 1;
  if (n < 1) return false;
  const stride = Math.max(1, Math.ceil(n / 48));
  for (let k = 1; k <= n; k += stride) {
    const b = prevT + k * step;
    if (marketOpen(b) && marketOpen(b + step / 2) && marketOpen(b + step - 1)) return true;
  }
  return false;
}

/**
 * ATLAS's scenario, drawn to the right of the last candle in a hatched projection area: a dashed path from the
 * last close toward its trigger, the trigger and invalidation lines, and a label that says what it is —
 * "Conditional scenario" — so it can never be mistaken for price history.
 */
export function ScenarioOverlay({ scenario, x0, x1, fromX, fromY, y, priceH, compact, top = 4 }: {
  scenario: Scenario; x0: number; x1: number; fromX: number; fromY: number;
  y: (p: number) => number; priceH: number; compact: boolean;
  /** Where its label box sits — below the chart's readout band. */
  top?: number;
}) {
  if (x1 - x0 < 28) return null;          // panned into history: the overlay belongs to "now"
  const faded = scenario.status === "invalidated" || scenario.status === "expired";
  const tp = scenario.trigger.price, ip = scenario.invalidation.price;
  const xm = x0 + (x1 - x0) * 0.62;
  const title = `${scenario.title}${faded ? ` (${scenario.status})` : ""}`;
  const maxChars = Math.max(6, Math.floor((x1 - x0 - 10) / 5.2));
  return (
    <g opacity={faded ? 0.45 : 1} pointerEvents="none" className="hud-in" data-overlay="scenario">
      <rect x={x0} y={0} width={x1 - x0} height={priceH} fill="url(#hudHatch)" />
      <line x1={x0} x2={x0} y1={0} y2={priceH} stroke="rgba(39,215,242,0.4)" strokeDasharray="2 4" />
      {tp != null && scenario.direction !== "range" && (
        <path d={`M${fromX.toFixed(1)},${fromY.toFixed(1)} L${xm.toFixed(1)},${y(tp).toFixed(1)}`} fill="none" stroke={H.cyan2} strokeWidth={1.6} strokeDasharray="6 4" markerEnd="url(#hudArrow)" />
      )}
      {tp != null && (
        <g>
          <line x1={x0} x2={x1} y1={y(tp)} y2={y(tp)} stroke={H.cyan2} strokeDasharray="5 4" strokeWidth={1.1} />
          <text x={x1 - 2} y={y(tp) - 4} textAnchor="end" fontSize={compact ? 8.5 : 9.5} fill={H.cyan2} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">Trigger {fmt2(tp)}</text>
        </g>
      )}
      {ip != null && (
        <g>
          <line x1={x0} x2={x1} y1={y(ip)} y2={y(ip)} stroke={H.red} strokeDasharray="1.5 3" strokeWidth={1.1} />
          <text x={x1 - 2} y={y(ip) + 11} textAnchor="end" fontSize={compact ? 8.5 : 9.5} fill={H.red} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">Invalidation {fmt2(ip)}</text>
        </g>
      )}
      <g>
        <rect x={x0 + 3} y={top} width={Math.min(x1 - x0 - 6, 150)} height={compact ? 14 : 26} rx={3} fill="rgba(3,7,11,0.88)" stroke="rgba(39,215,242,0.55)" />
        <text x={x0 + 8} y={top + (compact ? 10 : 11)} fontSize={compact ? 8.5 : 9} fontWeight={700} fill={H.cyan2}>{x1 - x0 >= 112 ? "Conditional scenario" : "Conditional"}</text>
        {!compact && <text x={x0 + 8} y={top + 22} fontSize="8.5" fill={H.text}>{title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title}</text>}
      </g>
    </g>
  );
}

export function GoldChart({
  bars: serverBars, price, markers, zones, lines, path, pathLabel, showOverlays, showLiquidity, tfLabel, activityLabel,
  tf: tfProp, ticks, barsAsOf, feed, levels, scenarios,
}: {
  bars: ChartBar[]; price: number | null; markers: ChartMarker[]; zones: ChartZone[]; lines: ChartLine[];
  path: number[] | null; pathLabel: string; showOverlays: boolean; showLiquidity: boolean; tfLabel: string; activityLabel: string;
  /** The displayed timeframe. Needed to fold `ticks` into its candles and to place ATLAS's candle marks. */
  tf?: ChartTf;
  /** Streamed ticks, oldest first (useLiveFeed().recentTicks). They move the forming candle of `tf`. */
  ticks?: readonly LiveTick[];
  /** When the server bars were known to be current, if the screen knows it (core/formingCandle.ts MERGING). */
  barsAsOf?: number | null;
  /** The honest feed state (useLiveFeed().feed). Without it the chart claims nothing about being live. */
  feed?: FeedState | null;
  /** The levels ATLAS may point at, by ID (levelIdOf). The same list the live read sends. */
  levels?: readonly ChartLevel[];
  /** ATLAS's scenarios, for the scenario overlay action. */
  scenarios?: readonly Scenario[];
}) {
  /** Only a timeframe the chart knows the length of; anything else (the screen's disabled 1m) folds no ticks. */
  const tf: ChartTf | undefined = tfProp && Object.prototype.hasOwnProperty.call(TF_MS, tfProp) ? tfProp : undefined;
  const wrap = useRef<HTMLDivElement | null>(null);
  const [sz, setSz] = useState({ w: 900, h: 420 });
  /** The hovered candle, by its OPEN TIME — so a new candle or a dropped old one never moves the crosshair. */
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [vp, setVp] = useState<Viewport>(AUTO);
  const [actions, setActions] = useState<ChartActionOverlay>(NO_CHART_ACTIONS);

  /* The candles drawn: the server's bars, with the live ticks moving the newest (core/formingCandle.ts). */
  const bars: ChartBar[] = useMemo(
    () => (tf ? withLiveCandles(serverBars, ticks ?? [], tf, { serverAsOf: barsAsOf ?? null }) : serverBars),
    [serverBars, ticks, tf, barsAsOf],
  );
  const barsRef = useRef(bars);
  barsRef.current = bars;
  /** The price on the tag: the feed's (the freshest the screen has) when there is one. */
  const lastPx = feed?.price ?? price;

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setSz({ w: Math.max(320, e.contentRect.width), h: Math.max(220, e.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  /* ── ATLAS's chart actions: validated against what this chart actually has, or dropped ── */
  const ctxRef = useRef<ChartActionContext>({ levels: [], candles: {}, scenarios: [], price: null });
  ctxRef.current = {
    levels: (levels ?? []).map((l) => ({ kind: l.kind, price: l.price, label: l.label })),
    candles: tf ? { [tf]: bars.map((b) => b.t) } : {},
    scenarios: (scenarios ?? []).map((s) => ({ id: s.id })),
    price: lastPx,
  };
  const tfRef = useRef(tf);
  tfRef.current = tf;

  useEffect(() => {
    const onAction = (e: Event) => {
      const raw = (e as CustomEvent<unknown>).detail;
      const now = Date.now();
      setActions((o) => receiveChartAction(o, raw, ctxRef.current, tfRef.current, now).overlay);
    };
    window.addEventListener(CHART_ACTION_EVENT, onAction);
    return () => window.removeEventListener(CHART_ACTION_EVENT, onAction);
  }, []);

  // A candle ATLAS named on another timeframe (or while bars load) is drawn once it is really on this chart.
  useEffect(() => {
    const now = Date.now();
    setActions((o) => settleChartActions(o, ctxRef.current, tf, now));
  }, [bars, tf]);

  // A highlighted level the newest read no longer carries is not drawn: the price it named is no longer that level.
  const liveLevelIds = useMemo(() => (levels ? new Set(levels.map((l) => levelIdOf(l))) : null), [levels]);
  const highlights = actions.highlights.filter((h) => !liveLevelIds || liveLevelIds.has(h.levelId));
  const marks = actions.marks.filter((m) => m.tf === tf);
  const notes = markNotes(actions, tf, (t) => new Date(t).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }));
  const scenario = actions.scenarioId ? (scenarios ?? []).find((s) => s.id === actions.scenarioId) ?? null : null;
  const hasActions = highlights.length > 0 || actions.zones.length > 0 || marks.length > 0 || notes.length > 0 || !!scenario;

  const compact = sz.w < 560;               // phones: fewer words, same information
  const AXIS = compact ? 50 : 58, TIME_H = 18, VOL_FR = compact ? 0.13 : 0.17, FUTURE = 0.16;
  const plotW = sz.w - AXIS;
  const priceH = (sz.h - TIME_H) * (1 - VOL_FR) - 6;
  const volTop = priceH + 8, volH = (sz.h - TIME_H) * VOL_FR - 6;
  /** The band at the top of the plot where the OHLC readout sits. The price fit leaves it empty, and labels are
   *  kept out of it, so the readout never prints over a level's name (owner 11-11: no overlapping text). */
  const TOP_BAND = compact ? 26 : 30;
  const showPath = showOverlays && !!path && path.length > 1 && !scenario;   // one projection at a time
  const actionPrices = [
    ...highlights.map((h) => h.price), ...actions.zones.flatMap((z) => [z.from, z.to]),
    ...(scenario ? [scenario.trigger.price, scenario.invalidation.price].filter((p): p is number => p != null) : []),
  ];

  const view = useMemo(() => {
    const n = bars.length;
    if (!n) return null;
    const futurePx = scenario ? Math.max(plotW * FUTURE, compact ? 0 : 118) : showPath ? plotW * FUTURE : plotW * 0.04;
    const usable = Math.max(40, plotW - futurePx);

    /* the time window */
    // PHONES START ZOOMED IN (owner 09-21: "default the chart to this zoomed in so it's showing the candles
    // more clearly … just change the starting point"): the automatic view on a small screen is the newest
    // PHONE_BARS candles, not the whole series. Same data; pinch / drag / Reset all work as before, and
    // Reset returns here.
    const autoSpan = compact ? Math.min(n, PHONE_BARS) : n;
    const span = clamp(vp.span > 0 ? vp.span : autoSpan, Math.min(MIN_BARS, n), n);
    const anchored = indexAtOrBefore(bars, vp.endT) + vp.endOff;
    const end = vp.follow ? n - 1 : clamp(anchored, span - 1 - span * OVERSCROLL, n - 1 + span * OVERSCROLL);
    const iL = end - span + 1;
    const bw = usable / span;
    const x = (i: number) => (i - iL + 0.5) * bw;
    const i0 = Math.max(0, Math.floor(iL) - 1), i1 = Math.min(n - 1, Math.ceil(end) + 1);
    const seen = bars.slice(i0, i1 + 1);

    /* the price window — fitted to what is actually on screen (candles whose centre is inside the plot, not the
       one drawn half off each edge, so a forming candle just past the edge cannot nudge a view of the past),
       then stretched and shifted by the user */
    let lo = Infinity, hi = -Infinity;
    const f0 = Math.max(0, Math.ceil(iL - 0.5)), f1 = Math.min(n - 1, Math.floor(end + 0.5));
    for (const b of f0 <= f1 ? bars.slice(f0, f1 + 1) : seen) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = bars[n - 1].c - 1; hi = bars[n - 1].c + 1; }
    // Which overlays count toward the fit is judged from the newest close while the newest candle is on screen,
    // and from the visible candles once panned into history — so a tick can never move a view of the past.
    const ref = vp.follow || end >= n - 1 ? bars[n - 1].c : (lo + hi) / 2, base = Math.max(hi - lo, 0.5);
    const extra = [...(showPath ? (path ?? []) : []), ...lines.map((l) => l.price), ...(showLiquidity ? zones.flatMap((z) => [z.from, z.to]) : []), ...actionPrices]
      .filter((p) => Number.isFinite(p) && Math.abs(p - ref) < base * 0.9);
    for (const p of extra) { if (p < lo) lo = p; if (p > hi) hi = p; }
    const mid = (lo + hi) / 2, half = (Math.max(hi - lo, 0.5) / 2) * 1.07 / Math.max(0.05, vp.pz);
    // The top TOP_BAND pixels are headroom for the readout: the fitted range maps below it.
    const pLo = mid - half + vp.pOff, pHi = mid + half + vp.pOff + (2 * half) * TOP_BAND / Math.max(40, priceH - TOP_BAND);
    const y = (p: number) => ((pHi - p) / (pHi - pLo)) * priceH;

    const act = (b: ChartBar) => (b.v && b.v > 0 ? b.v : b.h - b.l);
    const hasVol = seen.some((b) => b.v != null && b.v > 0);
    const vals = seen.filter((b) => !(hasVol && b.v == null)).map(act).sort((a, b) => a - b);
    const vmax = Math.max(1e-6, vals[Math.floor(vals.length * 0.9)] ?? 1);
    const step = niceStep((pHi - pLo) / 7);
    const ticksY: number[] = []; for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) ticksY.push(+p.toFixed(2));
    const idxAt = (t: number) => { let best = -1, d = Infinity; bars.forEach((b, i) => { const dd = Math.abs(b.t - t); if (dd < d) { d = dd; best = i; } }); return best; };
    return { n, bw, iL, end, span, usable, futurePx, pLo, pHi, y, x, vmax, hasVol, ticks: ticksY, idxAt, i0, i1, seen, pricePerPx: (pHi - pLo) / Math.max(1, priceH) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, plotW, priceH, path, lines, zones, showOverlays, showLiquidity, vp, compact, showPath, scenario, actionPrices.join(","), TOP_BAND]);

  /* Gesture maths reads this rather than a stale closure. */
  const st = useRef({ n: 0, bw: 1, iL: 0, end: 0, span: 0, usable: 1, plotW: 1, pricePerPx: 1 });
  if (view) st.current = { n: view.n, bw: view.bw, iL: view.iL, end: view.end, span: view.span, usable: view.usable, plotW, pricePerPx: view.pricePerPx };

  /** A float bar index → the time anchor the viewport stores. */
  const anchorOf = useCallback((end: number): { endT: number; endOff: number } => {
    const b = barsRef.current;
    if (!b.length) return { endT: 0, endOff: 0 };
    const i = clamp(Math.floor(end), 0, b.length - 1);
    return { endT: b[i].t, endOff: end - i };
  }, []);

  const reset = useCallback(() => setVp(AUTO), []);
  const toLive = useCallback(() => setVp((v) => ({ ...v, follow: true, endOff: 0, pOff: 0 })), []);

  /* Wheel: over the plot it zooms time around the cursor, over the price axis it stretches price. */
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = st.current; if (!s.n) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (px > s.plotW) { setVp((v) => ({ ...v, pz: clamp(v.pz * Math.exp(-dy * 0.0018), 0.2, 30) })); return; }
      if (e.shiftKey) { setVp((v) => ({ ...v, pz: clamp(v.pz * Math.exp(-dy * 0.0018), 0.2, 30) })); return; }
      const anchor = s.iL + px / s.bw - 0.5;
      setVp((v) => {
        const cur = v.span > 0 ? v.span : s.span;
        const span = clamp(cur * Math.exp(dy * 0.0014), Math.min(MIN_BARS, s.n), s.n);
        const iL = anchor - (px / (s.usable / span) - 0.5);
        const end = iL + span - 1;
        return { ...v, span, ...anchorOf(end), follow: end >= s.n - 1.25 };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [anchorOf]);

  /* Drag to pan, two fingers to pinch, drag on the axis to stretch price. */
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; end: number; pOff: number; pz: number; axis: boolean; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; span: number; anchor: number; px: number } | null>(null);

  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current; if (!s.n) return;
    const r = e.currentTarget.getBoundingClientRect();
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const px = (a.x + b.x) / 2 - r.left;
      pinch.current = { dist: Math.max(1, Math.abs(a.x - b.x)), span: s.span, anchor: s.iL + px / s.bw - 0.5, px };
      drag.current = null;
      return;
    }
    const px = e.clientX - r.left;
    drag.current = { x: e.clientX, y: e.clientY, end: s.end, pOff: vp.pOff, pz: vp.pz, axis: px > s.plotW, moved: false };
  }, [vp.pOff, vp.pz]);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current; if (!s.n || !view) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const dist = Math.max(1, Math.abs(a.x - b.x));
      const p = pinch.current;
      const span = clamp((p.span || s.n) * (p.dist / dist), Math.min(MIN_BARS, s.n), s.n);
      const iL = p.anchor - (p.px / (s.usable / span) - 0.5);
      const end = iL + span - 1;
      setVp((v) => ({ ...v, span, ...anchorOf(end), follow: end >= s.n - 1.25 }));
      return;
    }

    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 2) d.moved = true;
      if (d.axis) { setVp((v) => ({ ...v, pz: clamp(d.pz * Math.exp(-dy * 0.006), 0.2, 30) })); return; }
      const end = d.end - dx / s.bw;
      setVp((v) => ({ ...v, span: v.span > 0 ? v.span : s.span, ...anchorOf(end), follow: end >= s.n - 1.25, pOff: d.pOff + dy * s.pricePerPx }));
      return;
    }

    const px = e.clientX - r.left, py = e.clientY - r.top;
    const i = Math.round(view.iL + px / view.bw - 0.5);
    const b = barsRef.current;
    setHoverT(px <= plotW && i >= 0 && i < b.length ? b[i].t : null);
    setHoverY(py >= 0 && py <= priceH ? py : null);
  }, [view, plotW, priceH, anchorOf]);

  const onUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    if (pts.current.size === 0) drag.current = null;
  }, []);

  /** Buttons on the chart must not start a pan (which would capture the pointer and swallow the click). */
  const noPan = (e: React.PointerEvent) => e.stopPropagation();

  if (!view) {
    return <div ref={wrap} className="grid h-full w-full place-items-center text-[12px]" style={{ color: H.mut }}>Waiting for candles from the feed…</div>;
  }
  const { n, bw, y, x, vmax, hasVol, ticks: priceTicks, idxAt, i0, i1, seen } = view;
  const last = bars[n - 1];
  const hoverIdx = hoverT == null ? -1 : indexOfT(bars, hoverT);
  const hover = hoverIdx >= 0 ? hoverIdx : null;
  const hb = hover != null ? bars[hover] : last;
  const up = (b: ChartBar) => b.c >= b.o;
  const timeTicks = pickTimeTicks(bars, i0, i1, 6);
  const lastX = x(n - 1);
  const touched = vp.span > 0 || !vp.follow || vp.pz !== 1 || vp.pOff !== 0;
  const atLive = vp.follow || view.end >= n - 1.25;
  const cw = Math.max(1, Math.min(bw * 0.62, 22));
  const tfMs = tf ? TF_MS[tf] : null;

  const statusColor = feed ? STATUS_COLOR[feed.status] : null;
  // The price tag is green only when the price is actually streaming; otherwise it does not claim to be live.
  const pxColor = !feed ? H.gold2 : feed.status === "live" ? H.green : feed.status === "demo" ? H.blue : feed.status === "stale" || feed.status === "closed" ? H.mut : H.gold2;
  const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const basisTitle = feed
    ? [
        `${FEED_STATUS_WORD[feed.status]} — ${feed.reason}`,
        feed.receivedTs != null ? `Received ${hhmmss(feed.receivedTs)}${feed.ageMs != null ? ` (${feedAgeWords(feed.ageMs)} ago)` : ""}` : "No price received yet",
        feed.providerTs != null ? `Provider time ${hhmmss(feed.providerTs)} (the provider stamps gold to the minute)` : "No provider timestamp",
        `Via ${feed.transport === "websocket_relay" ? "the WebSocket relay" : feed.transport === "poll" ? "polling" : feed.transport}`,
      ].join("\n")
    : "Feed status not connected to this chart";
  const basisShort = feed
    ? `${feed.provider} · ${feed.quoteType} · ${FEED_STATUS_WORD[feed.status]}${feed.ageMs != null && feed.status !== "closed" && feed.status !== "demo" ? ` · ${feedAgeShort(feed.ageMs)}` : ""}`
    : "Twelve Data · mid";

  /* LEFT-EDGE LABELS. Zone names (x ≈ the zone's start) and line names (x = 6) share the plot's left edge, so
     they are placed in ONE pass: sorted by where each wants to be, then pushed apart — a zone's name and the
     watch line on the same price can never print on top of each other. */
  const placeYs = (ys: number[], gap: number) => {
    const order = ys.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = ys.slice();
    let lastY = -Infinity;
    for (const o of order) { const v = Math.max(o.v, lastY + gap); out[o.i] = v; lastY = v; }
    return out;
  };
  const visLines = lines.map((l, k) => ({ l, k, y: y(l.price) })).filter((o) => o.y >= -20 && o.y <= priceH + 20);
  const zoneWant = showLiquidity && !compact ? zones.map((z) => {
    const zy1 = y(Math.max(z.from, z.to)), zy2 = y(Math.min(z.from, z.to));
    const zh = Math.max(6, zy2 - zy1);
    return zy2 > TOP_BAND + 14 && zy1 < priceH - 8 ? Math.max(TOP_BAND + 12, zy1 + (zh === 6 ? -5 : 12)) : null;
  }) : [];
  const lineWant = visLines.map((o) => (o.y < TOP_BAND + 14 ? Math.max(TOP_BAND + 11, o.y + 12) : o.y - 4));
  const zoneIdx = zoneWant.map((v, k) => (v == null ? -1 : k)).filter((k) => k >= 0);
  const leftYs = placeYs([...lineWant, ...zoneIdx.map((k) => zoneWant[k] as number)], 12);
  const lineLabelY = leftYs.slice(0, lineWant.length);
  const zoneLabelY: Record<number, number> = {};
  zoneIdx.forEach((k, j) => { zoneLabelY[k] = leftYs[lineWant.length + j]; });

  /* Missing data where the market was open: drawn as a gap, never filled. Intraday timeframes only — a daily
     or 4-hour bar spans partial sessions, so a missing one is not reliably a hole in the data. */
  const gaps: number[] = [];
  if (tfMs && tfMs <= 3_600_000) for (let i = Math.max(1, i0); i <= i1; i++) {
    if (bars[i].t - bars[i - 1].t > tfMs * 1.5 && missingWhileOpen(bars[i - 1].t, bars[i].t, tfMs)) gaps.push(i);
  }

  return (
    <div ref={wrap} className="relative h-full w-full select-none"
      style={{ touchAction: "none", cursor: drag.current?.moved ? "grabbing" : "crosshair" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onPointerLeave={() => { setHoverT(null); setHoverY(null); }}
      onDoubleClick={reset}>
      {/* OHLC readout — one line, on a backing; on phones only the close and change until you touch a candle */}
      <div className="pointer-events-none absolute left-1.5 top-1 z-10 flex items-center gap-2 overflow-hidden whitespace-nowrap rounded-[5px] px-1.5 py-[2px] tabular-nums"
        style={{ background: "rgba(3,7,11,0.72)", fontSize: compact ? 10 : 11, maxWidth: touched ? "calc(100% - 190px)" : "calc(100% - 70px)" }}>
        <span className="font-semibold" style={{ color: H.text, fontSize: compact ? 10.5 : 13 }}>{tfLabel}</span>
        {/* Feed status: green ONLY when a streamed tick arrived within seconds (core/feed.ts). */}
        <span className="inline-block h-[6px] w-[6px] shrink-0 rounded-full" title={feed ? feed.reason : undefined}
          style={{ background: statusColor ?? H.mut2, boxShadow: feed?.status === "live" ? `0 0 6px ${H.green}` : "none" }} />
        {feed && !compact && <span className="font-bold" style={{ color: statusColor ?? H.mut, fontSize: 9.5, letterSpacing: "0.1em" }}>{FEED_STATUS_WORD[feed.status]}</span>}
        {(!compact || hover != null) && (["O", "H", "L"] as const).map((k) => (
          <span key={k} style={{ color: H.mut }}>{k} <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(k === "O" ? hb.o : k === "H" ? hb.h : hb.l)}</b></span>
        ))}
        <span style={{ color: H.mut }}>C <b style={{ color: up(hb) ? H.green : H.red, fontWeight: 500 }}>{fmt2(hb.c)}</b></span>
        <span style={{ color: up(hb) ? H.green : H.red }}>{hb.c - hb.o >= 0 ? "+" : ""}{(hb.c - hb.o).toFixed(2)}{compact ? "" : ` (${(((hb.c - hb.o) / hb.o) * 100).toFixed(2)}%)`}</span>
        {hb.live && !compact && <span style={{ color: H.mut }} title="Built from streamed ticks; the server's bar replaces it when it arrives">{hb.partialOpen ? "forming · open as first seen" : "forming"}</span>}
      </div>

      {/* view controls — only once the view has been moved off its automatic fit */}
      {touched && (
        <div className="absolute right-[54px] z-20 flex items-center gap-1 text-[10px]" style={{ top: 5 }}>
          <span className="rounded-[5px] px-1.5 py-[2px] tabular-nums" style={{ color: H.mut, border: `1px solid ${H.lineSoft}`, background: "rgba(3,7,11,0.72)" }}>
            {Math.round(view.span)} bars
          </span>
          <button onClick={reset} onPointerDown={noPan} className="rounded-[5px] px-1.5 py-[2px] transition hover:opacity-80"
            style={{ color: H.gold3, border: "1px solid rgba(231,196,103,0.5)", background: "rgba(213,169,61,0.12)" }}>Reset</button>
        </div>
      )}

      {/* ATLAS's marks are on — one tap clears them */}
      {hasActions && (
        // Cleared through the same event ATLAS uses, so the screen (the open scenario card) hears it too.
        <button onClick={() => { setActions(NO_CHART_ACTIONS); window.dispatchEvent(new CustomEvent(CHART_ACTION_EVENT, { detail: { type: "clear" } })); }} onPointerDown={noPan}
          className="absolute z-20 rounded-[5px] px-1.5 py-[2px] text-[10px] transition hover:opacity-80"
          style={{ right: AXIS + 6 + (atLive ? 0 : 112), top: Math.max(TOP_BAND + 2, priceH - 26), color: H.cyan2, border: "1px solid rgba(39,215,242,0.45)", background: "rgba(3,7,11,0.8)" }}
          title="Clear what ATLAS marked on the chart">ATLAS marks ✕</button>
      )}

      {/* a candle ATLAS named on another timeframe: said, not guessed at */}
      {notes.length > 0 && (
        <div className="pointer-events-none absolute left-1.5 z-10 flex max-w-[calc(100%-80px)] flex-col gap-0.5" style={{ top: TOP_BAND + 2 }}>
          {notes.map((m) => (
            <span key={`${m.tf}${m.t}`} className="truncate rounded-[4px] px-1.5 py-[1px]" data-note="mark-elsewhere"
              style={{ color: H.gold3, background: "rgba(3,7,11,0.78)", border: "1px solid rgba(231,196,103,0.35)", fontSize: compact ? 8.5 : 9.5 }}>{m.text}</span>
          ))}
        </div>
      )}

      {/* back to the newest candle, keeping the zoom */}
      {!atLive && (
        <button onClick={toLive} onPointerDown={noPan}
          className="absolute z-20 rounded-[5px] px-2 py-[3px] text-[10px] font-semibold transition hover:opacity-80"
          style={{ right: AXIS + 6, top: Math.max(4, priceH - 26), color: H.cyan2, border: "1px solid rgba(39,215,242,0.55)", background: "rgba(3,7,11,0.86)", boxShadow: "0 0 10px rgba(0,199,232,0.18)" }}
          title="Return to the newest candle">Return to live ▸</button>
      )}

      {/* the feed's basis: whose price, which instrument, what kind of quote, its status and age */}
      <div className="absolute left-1.5 z-10 whitespace-nowrap rounded-[4px] px-1.5 py-[1px] tabular-nums" title={basisTitle} data-basis=""
        style={{ top: Math.max(22, priceH - 18), color: H.mut, background: "rgba(3,7,11,0.6)", fontSize: compact ? 8.5 : 9.5 }}>
        {compact ? basisShort : feedBasisLabel(feed)}
      </div>

      <svg width={sz.w} height={sz.h} className="block">
        <defs>
          <linearGradient id="hudPath" x1="0" x2="1"><stop offset="0" stopColor="#A9D8FF" /><stop offset="1" stopColor={H.blue} /></linearGradient>
          <filter id="hudGlow"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <clipPath id="hudPlot"><rect x={0} y={0} width={plotW} height={priceH} /></clipPath>
          <clipPath id="hudVol"><rect x={0} y={volTop} width={plotW} height={Math.max(1, volH)} /></clipPath>
          {/* the projection area is hatched: what sits on it is conditional, not history */}
          <pattern id="hudHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(39,215,242,0.09)" strokeWidth="2" />
          </pattern>
          <marker id="hudArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={H.cyan2} />
          </marker>
        </defs>

        {/* grid */}
        {priceTicks.map((p) => <line key={p} x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="rgba(89,175,255,0.06)" />)}
        {timeTicks.map((tt) => <line key={tt.i} x1={x(tt.i)} x2={x(tt.i)} y1={0} y2={priceH} stroke="rgba(89,175,255,0.045)" />)}

        <g clipPath="url(#hudPlot)">
          {/* zones */}
          {showLiquidity && zones.map((z, k) => {
            const y1 = y(Math.max(z.from, z.to)), y2 = y(Math.min(z.from, z.to));
            const h = Math.max(6, y2 - y1);
            const col = z.tone === "supply" ? "255,83,100" : z.tone === "demand" ? "41,223,166" : "89,175,255";
            const x0 = Math.max(0, z.tone === "target" ? lastX - bw * 30 : lastX - bw * 70);
            return (
              <g key={k}>
                <rect x={x0} y={y1 - (h === 6 ? 3 : 0)} width={Math.max(8, plotW - x0 - 4)} height={h} fill={`rgba(${col},0.10)`} stroke={`rgba(${col},0.45)`} strokeWidth={0.8} />
              </g>
            );
          })}

          {/* ATLAS: a zone it is discussing */}
          {actions.zones.map((z, k) => {
            const y1 = y(Math.max(z.from, z.to)), y2 = y(Math.min(z.from, z.to));
            const h = Math.max(4, y2 - y1);
            return (
              <g key={`az${k}`} className="hud-in" pointerEvents="none">
                <rect x={0} y={y1} width={plotW} height={h} fill="rgba(39,215,242,0.08)" stroke="rgba(39,215,242,0.55)" strokeDasharray="4 3" strokeWidth={0.9} />
                <text x={8} y={Math.max(TOP_BAND + 12, y1 + (h > 14 ? 12 : -4))} fontSize={compact ? 8.5 : 9.5} fontWeight={600} fill={H.cyan2} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">ATLAS · {z.label}</text>
              </g>
            );
          })}

          {/* ATLAS: a candle it is pointing at — only if that exact candle is on this chart */}
          {marks.map((m, k) => {
            const i = indexOfT(bars, m.t);
            if (i < i0 || i > i1) return null;
            const b = bars[i];
            const cx = x(i);
            return (
              <g key={`am${k}`} className="hud-in" pointerEvents="none">
                <rect x={cx - Math.max(cw, 6) / 2 - 3} y={0} width={Math.max(cw, 6) + 6} height={priceH} fill="rgba(231,196,103,0.07)" stroke="rgba(231,196,103,0.35)" strokeDasharray="2 3" />
                <path d={`M${cx},${y(b.h) - 12} l4,4 l-4,4 l-4,-4 z`} fill={H.gold2} />
                <text x={clamp(cx, 40, plotW - 40)} y={Math.max(TOP_BAND + 10, y(b.h) - 16)} textAnchor="middle" fontSize={compact ? 8.5 : 9.5} fontWeight={600} fill={H.gold3} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">{m.label}</text>
              </g>
            );
          })}

          {/* missing data while the market was open: shown as a gap, never filled */}
          {gaps.map((i) => {
            const gx = (x(i - 1) + x(i)) / 2;
            return (
              <g key={`gap${i}`} pointerEvents="none">
                <line x1={gx} x2={gx} y1={0} y2={priceH} stroke="rgba(129,144,158,0.35)" strokeDasharray="2 4" />
                {!compact && <text x={gx + 3} y={priceH - 24} fontSize="8.5" fill={H.mut2}>gap · no data</text>}
              </g>
            );
          })}

          {/* candles */}
          {seen.map((b, k) => {
            const i = i0 + k;
            const col = up(b) ? H.green : H.red;
            const cx = x(i);
            const yo = y(b.o), yc = y(b.c);
            return (
              <g key={b.t}>
                <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={cw > 3 ? 1.1 : 1} opacity={0.9} />
                <rect x={cx - cw / 2} y={Math.min(yo, yc)} width={cw} height={Math.max(1, Math.abs(yc - yo))} fill={col} opacity={up(b) ? 0.95 : 0.9} />
              </g>
            );
          })}

          {/* zone names — after the candles, so a candle body never paints over the words */}
          {showLiquidity && zones.map((z, k) => {
            if (zoneLabelY[k] == null) return null;
            const col = z.tone === "supply" ? "255,83,100" : z.tone === "demand" ? "41,223,166" : "89,175,255";
            const x0 = Math.max(0, z.tone === "target" ? lastX - bw * 30 : lastX - bw * 70);
            return <text key={`zl${k}`} x={x0 + 6} y={zoneLabelY[k]} textAnchor="start" fontSize="10" fill={`rgba(${col},0.95)`} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke" pointerEvents="none">{z.label}</text>;
          })}

          {/* markers — placed so their labels never sit on top of each other */}
          {showOverlays && (() => {
            const placed: { x: number; y: number; w: number }[] = [];
            return markers.slice(0, compact ? 3 : 6).map((m, k) => {
              const i = idxAt(m.at);
              if (i < i0 || i > i1) return null;
              const b = bars[i];
              const p = m.price ?? (m.tone === "down" ? b.h : b.l);
              const col = m.tone === "down" ? H.red : m.tone === "up" ? H.green : m.tone === "gold" ? H.gold2 : H.text;
              const above = m.tone !== "up";
              const w = m.label.length * 5.4;
              // Keep the label inside the plot and off the price axis, then walk it away from anything
              // already drawn until it has its own space. Labels are information, not decoration.
              // History stays left of a drawn scenario's hatched projection area, so its label is never covered.
              const rightEdge = scenario ? lastX + Math.max(bw * 0.7, 6) - 4 : plotW - 6;
              const cx = Math.min(rightEdge - w / 2, Math.max(w / 2 + 4, x(i)));
              // Kept inside the plot and below the readout band WHILE walking, so two labels can never be pushed
              // onto the same row by the clamp; at the edge the walk turns round.
              const yMin = TOP_BAND + 10, yMax = priceH - 4;
              let yy = Math.max(yMin, Math.min(yMax, y(p) + (above ? -9 : 13)));
              let dir = above ? -12 : 12;
              for (let guard = 0; guard < 14; guard++) {
                const clash = placed.some((q) => Math.abs(q.x - cx) < (q.w + w) / 2 + 4 && Math.abs(q.y - yy) < 12);
                if (!clash) break;
                if (yy + dir < yMin || yy + dir > yMax) dir = -dir;
                yy = Math.max(yMin, Math.min(yMax, yy + dir));
              }
              placed.push({ x: cx, y: yy, w });
              return (
                <g key={k} className="hud-in">
                  <line x1={x(i) - 18} x2={x(i) + 18} y1={y(p)} y2={y(p)} stroke={col} strokeDasharray="2 3" strokeOpacity={0.8} />
                  {Math.abs(yy - y(p)) > 16 && <line x1={cx} x2={x(i)} y1={yy + (above ? 3 : -7)} y2={y(p)} stroke={col} strokeOpacity={0.25} />}
                  <text x={cx} y={yy} textAnchor="middle" fontSize={compact ? 8.5 : 9.5} fontWeight={600} fill={col} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">{m.label}</text>
                </g>
              );
            });
          })()}

          {/* projected scenario path — conditional, and labelled so */}
          {showPath && path && (() => {
            const span = view.futurePx - 8;
            const pts2 = path.map((p, k) => [lastX + (k / (path.length - 1)) * span, y(p)] as const);
            const dd = pts2.map((q, k) => `${k ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
            const endp = pts2[pts2.length - 1];
            const label = /conditional/i.test(pathLabel) ? pathLabel : `${pathLabel} · conditional`;
            return (
              <g filter="url(#hudGlow)" className="hud-in">
                <path d={dd} fill="none" stroke="url(#hudPath)" strokeWidth={1.8} strokeDasharray="5 3" />
                <circle cx={endp[0]} cy={endp[1]} r={3} fill={H.blue} />
                <text x={Math.min(plotW - 4, endp[0])} y={endp[1] + (path[path.length - 1] < path[0] ? 16 : -8)} textAnchor="end" fontSize="9.5" fill="#A9D8FF">{label}</text>
              </g>
            );
          })()}

          {/* ATLAS: a scenario overlay — hatched projection area right of the last candle, dashed, labelled */}
          {scenario && (
            <ScenarioOverlay scenario={scenario} x0={lastX + Math.max(bw * 0.7, 6)} x1={plotW - 4}
              fromX={lastX} fromY={y(last.c)} y={y} priceH={priceH} compact={compact} top={TOP_BAND + 2} />
          )}
        </g>

        {/* horizontal lines — drawn over the candles, tagged on the axis. Tags and labels are pushed
            apart so two levels a dollar apart never print on top of each other. */}
        {(() => {
          const vis = visLines;
          const pxY = lastPx != null ? y(lastPx) : null;
          // the live price tag owns its spot; line tags move around it
          const tagYs = placeYs(vis.map((o) => (pxY != null && Math.abs(o.y - pxY) < 17 ? (o.y < pxY ? pxY - 17 : pxY + 17) : o.y)), 17);
          const labYs = lineLabelY;
          return vis.map((o, i) => {
            const { l } = o;
            return (
              <g key={o.k}>
                <line x1={0} x2={plotW} y1={o.y} y2={o.y} stroke={l.color} strokeDasharray={l.dashed === false ? undefined : "3 4"} strokeOpacity={0.75} />
                {l.tag !== false && (
                  <g>
                    <rect x={plotW + 2} y={tagYs[i] - 8} width={AXIS - 4} height={16} rx={2} fill={l.color} fillOpacity={0.9} />
                    <text x={plotW + AXIS / 2} y={tagYs[i] + 4} textAnchor="middle" fontSize={compact ? 9 : 10} fontWeight={600} fill="#04080C">{l.price.toFixed(2)}</text>
                  </g>
                )}
                <text x={6} y={labYs[i]} fontSize={compact ? 8.5 : 9.5} fill={l.color} fillOpacity={0.95} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">{l.label}</text>
              </g>
            );
          });
        })()}

        {/* ATLAS: the level it is discussing — solid, glowing, tagged */}
        {highlights.map((h) => {
          const hy = y(h.price);
          if (hy < -10 || hy > priceH + 10) return null;
          return (
            <g key={`ah${h.levelId}`} className="hud-in" pointerEvents="none">
              <line x1={0} x2={plotW} y1={hy} y2={hy} stroke={H.cyan2} strokeWidth={1.6} strokeOpacity={0.95} filter="url(#hudGlow)" />
              <rect x={plotW + 2} y={hy - 8} width={AXIS - 4} height={16} rx={2} fill={H.cyan2} />
              <text x={plotW + AXIS / 2} y={hy + 4} textAnchor="middle" fontSize={compact ? 9 : 10} fontWeight={700} fill="#04080C">{h.price.toFixed(2)}</text>
              <text x={plotW - 6} y={hy - 5} textAnchor="end" fontSize={compact ? 8.5 : 9.5} fontWeight={600} fill={H.cyan2} stroke="rgba(3,7,11,0.85)" strokeWidth={3} paintOrder="stroke">◆ ATLAS · {h.label}</text>
            </g>
          );
        })}

        {/* last price */}
        {lastPx != null && y(lastPx) >= -10 && y(lastPx) <= priceH + 10 && (
          <g>
            <line x1={0} x2={plotW} y1={y(lastPx)} y2={y(lastPx)} stroke={pxColor} strokeOpacity={0.5} strokeDasharray="1 3" />
            <rect x={plotW + 2} y={y(lastPx) - 9} width={AXIS - 4} height={18} rx={2} fill={pxColor} />
            <text x={plotW + AXIS / 2} y={y(lastPx) + 4} textAnchor="middle" fontSize={compact ? 9.5 : 10.5} fontWeight={700} fill="#04080C">{lastPx.toFixed(2)}</text>
          </g>
        )}

        {/* price axis */}
        {priceTicks.filter((p) => {
          const ty = y(p);
          if (lastPx != null && Math.abs(ty - y(lastPx)) < 12) return false;
          if (highlights.some((h) => Math.abs(ty - y(h.price)) < 11)) return false;
          return !lines.some((l) => l.tag !== false && Math.abs(ty - y(l.price)) < 11);
        }).map((p) => <text key={p} x={plotW + AXIS - 6} y={y(p) + 3} textAnchor="end" fontSize={compact ? 9 : 10} fill={H.mut}>{compact ? p.toFixed(0) : p.toFixed(2)}</text>)}

        {/* activity */}
        <text x={6} y={volTop + 10} fontSize={compact ? 8.5 : 10} fill={H.mut}>{compact ? "Activity" : activityLabel}</text>
        <g clipPath="url(#hudVol)">
          {seen.map((b, k) => {
            // A tick-built candle has no provider activity count yet; on a series that has one, it waits for the
            // server's bar rather than being drawn on a different measure.
            if (hasVol && b.v == null) return null;
            const i = i0 + k;
            const v = b.v && b.v > 0 ? b.v : b.h - b.l, hh = Math.max(2, Math.min(1, Math.sqrt(v / vmax)) * volH);
            return <rect key={`v${b.t}`} x={x(i) - cw / 2} y={volTop + volH - hh} width={cw} height={hh} fill={up(b) ? H.green : H.red} opacity={0.5} />;
          })}
        </g>

        {/* time axis */}
        {timeTicks.map((tt) => <text key={`t${tt.i}`} x={x(tt.i)} y={sz.h - 4} textAnchor="middle" fontSize="10" fill={H.mut}>{tt.label}</text>)}

        {/* crosshair — time, price, and the price the cursor sits on */}
        {hover != null && hover >= i0 && hover <= i1 && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={sz.h - TIME_H} stroke="rgba(240,244,247,0.25)" strokeDasharray="2 3" />
            <rect x={Math.max(0, Math.min(plotW - 58, x(hover) - 29))} y={sz.h - TIME_H} width={58} height={TIME_H - 2} rx={2} fill="rgba(12,22,33,0.95)" stroke={H.lineSoft} />
            <text x={Math.max(29, Math.min(plotW - 29, x(hover)))} y={sz.h - 5} textAnchor="middle" fontSize="9.5" fill={H.text}>
              {new Date(bars[hover].t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </text>
          </g>
        )}
        {hoverY != null && (
          <g pointerEvents="none">
            <line x1={0} x2={plotW} y1={hoverY} y2={hoverY} stroke="rgba(240,244,247,0.18)" strokeDasharray="2 3" />
            <rect x={plotW + 2} y={hoverY - 8} width={AXIS - 4} height={16} rx={2} fill="rgba(12,22,33,0.96)" stroke={H.lineSoft} />
            <text x={plotW + AXIS / 2} y={hoverY + 4} textAnchor="middle" fontSize="10" fill={H.text}>
              {(view.pHi - (hoverY / Math.max(1, priceH)) * (view.pHi - view.pLo)).toFixed(2)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

/** Ticks across the visible window only, labelled by date when the window spans days. */
function pickTimeTicks(bars: ChartBar[], i0: number, i1: number, want: number): { i: number; label: string }[] {
  if (i1 - i0 < 2) return [];
  const span = bars[i1].t - bars[i0].t;
  const every = Math.max(1, Math.round((i1 - i0) / want));
  const out: { i: number; label: string }[] = [];
  for (let i = i0 + every; i < i1 - 1; i += every) {
    const d = new Date(bars[i].t);
    const label = span > 3 * 86_400_000
      ? d.toLocaleDateString([], { day: "2-digit", month: "short" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    out.push({ i, label });
  }
  return out;
}
