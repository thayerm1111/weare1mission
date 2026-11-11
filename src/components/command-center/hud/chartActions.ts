/**
 * ATLAS'S HANDS ON THE CHART (owner 11-11: "Atlas should be able to use validated chart actions").
 *
 * What GoldChart draws from the actions it hears (window CustomEvent CHART_ACTION_EVENT, detail: ChartAction).
 * Every action is validated against what the chart actually holds (atlasContract.ts validateChartAction): a level
 * by its ID, a candle by its open time on the DISPLAYED timeframe, a scenario by its ID, a zone near the price.
 * Anything else is dropped rather than drawn.
 *
 * One honest exception: a candle ATLAS points at on ANOTHER timeframe cannot be checked against this chart's
 * candles, and placing it on this timeframe would be a guess. It becomes a small note ("… switch to 1h to see
 * it") and is drawn only if, once the screen is on that timeframe, the candle is really there.
 *
 * "timeframe" actions belong to the screen (CommandCenterHud switches its own timeframe); the chart ignores them.
 *
 * Pure: no React, no DOM, no clock — so it is tested (tests/cc-atlas-feed.test.ts).
 */
import { CHART_TFS, validateChartAction, type ChartAction, type ChartActionContext, type ChartTf } from "../../../../command-center/core/atlasContract";
import { TF_MS } from "../../../../command-center/core/formingCandle";

/** A candle mark that has not validated on the displayed timeframe waits this long (its bars may be loading). */
export const MARK_PENDING_MS = 15_000;
/** A note about a candle on another timeframe is kept this long. */
export const MARK_NOTE_TTL_MS = 5 * 60_000;

export type ChartMark = { tf: ChartTf; t: number; label: string };
export type ChartActionOverlay = {
  highlights: { levelId: string; price: number; label: string }[];
  zones: { from: number; to: number; label: string }[];
  /** Candles ATLAS pointed at that this chart holds (validated against its own candle times). */
  marks: ChartMark[];
  /** Candles not (yet) validated: on another timeframe (shown as a note), or on this one while its bars load.
   *  `matchedAt`: when the chart first looked for it on its own timeframe. */
  elsewhere: (ChartMark & { at: number; matchedAt: number | null })[];
  scenarioId: string | null;
};
export const NO_CHART_ACTIONS: ChartActionOverlay = { highlights: [], zones: [], marks: [], elsewhere: [], scenarioId: null };

const sameMark = (a: { tf: ChartTf; t: number }, b: { tf: ChartTf; t: number }) => a.tf === b.tf && a.t === b.t;

/** Fold one VALIDATED action into what the chart shows. The newest of each kind first; a few of each at most. */
export function applyChartAction(o: ChartActionOverlay, a: ChartAction): ChartActionOverlay {
  switch (a.type) {
    case "clear": return NO_CHART_ACTIONS;
    case "highlight_level":
      return { ...o, highlights: [{ levelId: a.levelId, price: a.price, label: a.label }, ...o.highlights.filter((h) => h.levelId !== a.levelId)].slice(0, 3) };
    case "show_zone":
      return { ...o, zones: [{ from: a.from, to: a.to, label: a.label }, ...o.zones.filter((z) => z.from !== a.from || z.to !== a.to)].slice(0, 2) };
    case "mark_candle":
      return {
        ...o,
        marks: [{ tf: a.tf, t: a.t, label: a.label }, ...o.marks.filter((m) => !sameMark(m, a))].slice(0, 3),
        elsewhere: o.elsewhere.filter((m) => !sameMark(m, a)),
      };
    case "scenario":
      return { ...o, scenarioId: a.scenarioId };
    default:
      return o;   // "timeframe" belongs to the screen
  }
}

export type ActionOutcome = "drawn" | "timeframe" | "elsewhere" | "pending" | "rejected";

/** Is this a candle that could exist at all: a known timeframe, a whole-minute open time, not in the future,
 *  not absurdly old? Only used to decide whether a not-yet-verifiable mark deserves a note. */
function plausibleMark(raw: unknown, now: number): ChartMark | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (a.type !== "mark_candle") return null;
  const tf = String(a.tf ?? "") as ChartTf;
  const t = typeof a.t === "number" ? a.t : typeof a.t === "string" && a.t.trim() !== "" ? Number(a.t) : NaN;
  if (!CHART_TFS.includes(tf) || !Number.isFinite(t) || t <= 0 || t % 60_000 !== 0) return null;
  if (t > now + TF_MS[tf] || t < now - 400 * 86_400_000) return null;
  const label = String(a.label ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80) || "Candle";
  return { tf, t, label };
}

/**
 * One raw action, as heard. Validated against `ctx` (what the chart holds on its displayed timeframe `tf`);
 * a candle on another timeframe becomes a note; a candle on this timeframe that is not found waits briefly in
 * case the bars are still loading; anything else that does not validate is rejected — never drawn on a guess.
 */
export function receiveChartAction(
  o: ChartActionOverlay,
  raw: unknown,
  ctx: ChartActionContext,
  tf: ChartTf | null | undefined,
  now: number,
): { overlay: ChartActionOverlay; outcome: ActionOutcome } {
  const a = validateChartAction(raw, ctx);
  if (a) {
    if (a.type === "timeframe") return { overlay: o, outcome: "timeframe" };
    return { overlay: applyChartAction(o, a), outcome: "drawn" };
  }
  const m = plausibleMark(raw, now);
  // A chart that does not know its own timeframe can neither verify the candle nor say where to look.
  if (!m || tf == null) return { overlay: o, outcome: "rejected" };
  const here = m.tf === tf;
  const elsewhere = [{ ...m, at: now, matchedAt: here ? now : null }, ...o.elsewhere.filter((x) => !sameMark(x, m))].slice(0, 3);
  return { overlay: { ...o, elsewhere }, outcome: here ? "pending" : "elsewhere" };
}

/**
 * Re-check waiting candle marks against what the chart holds now (call when its bars or timeframe change): a
 * mark whose candle is now on screen is drawn; one on the displayed timeframe that still is not there after
 * MARK_PENDING_MS is dropped; notes expire after MARK_NOTE_TTL_MS. Returns the same object when nothing changed.
 */
export function settleChartActions(o: ChartActionOverlay, ctx: ChartActionContext, tf: ChartTf | null | undefined, now: number): ChartActionOverlay {
  if (!o.elsewhere.length) return o;
  let changed = false;
  let marks = o.marks;
  const keep: ChartActionOverlay["elsewhere"] = [];
  for (const n of o.elsewhere) {
    if (now - n.at > MARK_NOTE_TTL_MS) { changed = true; continue; }
    if (tf == null || n.tf !== tf) {
      if (n.matchedAt != null) { changed = true; keep.push({ ...n, matchedAt: null }); } else keep.push(n);
      continue;
    }
    const a = validateChartAction({ type: "mark_candle", tf: n.tf, t: n.t, label: n.label }, ctx);
    if (a && a.type === "mark_candle") {
      changed = true;
      marks = [{ tf: a.tf, t: a.t, label: a.label }, ...marks.filter((x) => !sameMark(x, a))].slice(0, 3);
      continue;
    }
    const since = n.matchedAt ?? now;
    if (now - since > MARK_PENDING_MS) { changed = true; continue; }   // not on this chart: dropped, not guessed
    if (n.matchedAt == null) changed = true;
    keep.push(n.matchedAt == null ? { ...n, matchedAt: since } : n);
  }
  return changed ? { ...o, marks, elsewhere: keep } : o;
}

const utcHhmm = (t: number): string => `${new Date(t).toISOString().slice(11, 16)} UTC`;

/** The notes to show on a chart displaying `tf`: candles ATLAS pointed at on other timeframes. */
export function markNotes(
  o: ChartActionOverlay,
  tf: ChartTf | null | undefined,
  fmtTime: (t: number) => string = utcHhmm,
): (ChartMark & { text: string })[] {
  return o.elsewhere
    .filter((n) => tf == null || n.tf !== tf)
    .map((n) => ({ ...n, text: `ATLAS · ${n.label}: the ${n.tf} candle of ${fmtTime(n.t)} — switch to ${n.tf} to see it` }));
}
