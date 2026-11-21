/**
 * CHART VIEWPORT — which candles are on screen, and how a hand moves them.
 *
 * This is the Command Center chart's own navigation (src/components/command-center/hud/GoldChart.tsx),
 * taken out so The Floor and GENX move the same way Atlas's chart does: the same zoom around the cursor,
 * the same pan, the same pinch, the same "follow the newest candle" rule. Pure — no browser, no React — so
 * the rules are tested on their own (tests/chart-viewport.test.ts).
 *
 * THE VIEW IS ANCHORED TO A CANDLE'S TIME, not to its position in the list. A new candle arriving, the
 * forming one changing, or an old one dropping off the left therefore never moves what someone is looking
 * at. While `follow` is on, the right edge stays on the newest candle as candles arrive; any pan into the
 * past turns it off, and "Return to live" turns it back on.
 *
 * A VIEW CONTROL AND NOTHING ELSE. Nothing here changes a candle, a level, a signal or a setting: zooming
 * the glass never touches what is behind it.
 */

export type Viewport = {
  /** Right-most visible candle, by its OPEN TIME (ignored while `follow` is on). */
  endT: number;
  /** How far past that candle the right edge sits, in bars (pans are smooth, not bar-snapped). */
  endOff: number;
  /** How many bars are visible. 0 means "auto". */
  span: number;
  /** Stay pinned to the newest candle as bars arrive. */
  follow: boolean;
  /** Price-scale stretch. 1 = fit the visible candles. */
  pz: number;
  /** Vertical pan, in price units. */
  pOff: number;
};

/** The automatic view: everything fitted, following the newest candle. */
export const AUTO_VIEW: Viewport = { endT: 0, endOff: 0, span: 0, follow: true, pz: 1, pOff: 0 };

/** Never zoom past a handful of candles. */
export const MIN_BARS = 10;
/** How far past the newest / oldest candle panning may run, as a fraction of the view. */
export const OVERSCROLL = 0.35;
/** Price stretch limits. */
export const PZ_MIN = 0.2, PZ_MAX = 30;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Index of the last candle opening at or before `t` (0 when `t` is before them all). */
export function indexAtOrBefore(bars: readonly { t: number }[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Index of the candle opening exactly at `t`, or -1. */
export function indexOfT(bars: readonly { t: number }[], t: number): number {
  const i = indexAtOrBefore(bars, t);
  return bars[i]?.t === t ? i : -1;
}

/**
 * The visible window, in (fractional) bar indexes: how many bars, the right edge, the left edge.
 * `autoSpan` is how many bars the automatic view shows.
 */
export function timeWindow(bars: readonly { t: number }[], vp: Viewport, autoSpan: number): { span: number; end: number; iL: number } {
  const n = bars.length;
  const span = clamp(vp.span > 0 ? vp.span : autoSpan, Math.min(MIN_BARS, n), n);
  const anchored = indexAtOrBefore(bars, vp.endT) + vp.endOff;
  const end = vp.follow ? n - 1 : clamp(anchored, span - 1 - span * OVERSCROLL, n - 1 + span * OVERSCROLL);
  return { span, end, iL: end - span + 1 };
}

/** The scale a gesture reads: the window as it was drawn, in pixels. */
export type ViewScale = {
  /** How many bars there are. */
  n: number;
  /** How many are visible, the right edge and the left edge (fractional bar indexes). */
  span: number; end: number; iL: number;
  /** Pixels per bar, and the pixels the bars are spread across. */
  bw: number; usable: number;
  /** Price units per vertical pixel. */
  pricePerPx: number;
};

/** A fractional bar index → the time anchor the viewport stores. */
export function anchorOf(bars: readonly { t: number }[], end: number): { endT: number; endOff: number } {
  if (!bars.length) return { endT: 0, endOff: 0 };
  const i = clamp(Math.floor(end), 0, bars.length - 1);
  return { endT: bars[i].t, endOff: end - i };
}

/** Within a quarter of a bar of the newest candle counts as "at live". */
export const atNewest = (end: number, n: number) => end >= n - 1.25;

/**
 * Show `span` bars with bar index `anchor` staying under pixel `px` — what wheel zoom and pinch both do.
 * The span is limited to [MIN_BARS, n].
 */
export function spanAround(vp: Viewport, s: ViewScale, bars: readonly { t: number }[], anchor: number, px: number, span: number): Viewport {
  const sp = clamp(span, Math.min(MIN_BARS, s.n), s.n);
  const iL = anchor - (px / (s.usable / sp) - 0.5);
  const end = iL + sp - 1;
  return { ...vp, span: sp, ...anchorOf(bars, end), follow: atNewest(end, s.n) };
}

/** Wheel zoom around the cursor at pixel `px`: positive `dy` shows more bars, negative fewer. */
export function zoomAt(vp: Viewport, s: ViewScale, bars: readonly { t: number }[], px: number, dy: number): Viewport {
  const anchor = s.iL + px / s.bw - 0.5;
  const cur = vp.span > 0 ? vp.span : s.span;
  return spanAround(vp, s, bars, anchor, px, cur * Math.exp(dy * 0.0014));
}

/** Pan so the right edge sits at bar index `end`, with the price shifted to `pOff`. */
export function panTo(vp: Viewport, s: ViewScale, bars: readonly { t: number }[], end: number, pOff: number): Viewport {
  return { ...vp, span: vp.span > 0 ? vp.span : s.span, ...anchorOf(bars, end), follow: atNewest(end, s.n), pOff };
}

/** Stretch (positive `dy` squeezes, negative stretches) the price scale by an exponential factor of `k`. */
export function stretchPrice(pz: number, dy: number, k: number): number {
  return clamp(pz * Math.exp(-dy * k), PZ_MIN, PZ_MAX);
}

/** Back to the newest candle, keeping the zoom. */
export const toNewest = (vp: Viewport): Viewport => ({ ...vp, follow: true, endOff: 0, pOff: 0 });

/** Has the view been moved off its automatic fit? */
export const moved = (vp: Viewport) => vp.span > 0 || !vp.follow || vp.pz !== 1 || vp.pOff !== 0;
