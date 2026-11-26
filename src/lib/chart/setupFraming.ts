import type { ChartLevel } from "../floor/chart";
import type { TimedBar } from "./candleTime";

const valid = (price: number) => Number.isFinite(price) && price > 0;

export function focusedLevels(levels: readonly ChartLevel[], reference: number): ChartLevel[] {
  const usable = levels.filter(level => valid(level.price));
  const closest = (kind: ChartLevel["kind"], from: number) => usable.filter(level => level.kind === kind)
    .sort((a, b) => Math.abs(a.price - from) - Math.abs(b.price - from))[0];
  const entry = closest("entry", reference);
  const stop = closest("stop", entry?.price ?? reference);
  const target = usable.find(level => level.kind === "target" && /(?:target|tp|t)\s*1\b/i.test(level.label))
    ?? closest("target", entry?.price ?? reference);
  const plan = [entry, stop, target].filter((level): level is ChartLevel => !!level);
  return plan.length ? plan : [closest("support", reference), closest("resistance", reference)].filter((level): level is ChartLevel => !!level);
}

/** Size the opening window around the setup. Every visible candle still contributes its complete wick to the scale. */
export function setupSpan(bars: readonly TimedBar[], levels: readonly ChartLevel[], price: number, compact: boolean, swingTime?: number): number {
  const n = bars.length;
  const maximum = Math.min(n, compact ? 26 : 42);
  const minimum = Math.min(n, compact ? 16 : 24);
  const marks = [price, ...levels.map(level => level.price)].filter(valid);
  if (marks.length < 2) return maximum;
  const low = Math.min(...marks), high = Math.max(...marks), tolerance = (high - low) * .35;
  if (high === low) return maximum;
  let count = minimum;
  while (count < maximum) {
    const bar = bars[n - count - 1];
    if (bar.h > high + tolerance || bar.l < low - tolerance) break;
    count++;
  }
  if (swingTime !== undefined) {
    const swing = bars.findIndex(bar => bar.t === swingTime);
    if (swing >= n - maximum && swing >= 0) count = Math.max(count, Math.min(maximum, n - swing + 2));
  }
  return count;
}

/** A shaded bracket requires a single coherent entry with its stop and first objective on opposite sides. */
export function riskBracket(levels: readonly ChartLevel[], reference: number) {
  const selected = focusedLevels(levels, reference);
  const entry = selected.find(level => level.kind === "entry")?.price;
  const stop = selected.find(level => level.kind === "stop")?.price;
  const target = selected.find(level => level.kind === "target")?.price;
  if (entry === undefined || stop === undefined || target === undefined || (target - entry) * (stop - entry) >= 0) return null;
  return { entry, stop, target };
}

export function railName(level: ChartLevel, compact = false): string {
  const name = level.label.trim();
  if (level.kind === "target") {
    const n = /(?:target|tp|t)\s*(\d+)\b/i.exec(name)?.[1];
    if (n === "1" || /^first target$/i.test(name)) return compact ? "Target 1" : "First target";
    return n ? `Target ${n}` : /trade|broker/i.test(name) ? "Trade target" : "Target";
  }
  if (level.kind === "stop") return /broker|trade|position/i.test(name) ? "Trade stop" : "Stop";
  const label = name.replace(/^Reference\s+(limit\s+)?entry/i, "Watch entry").replace(/^Reference\s+/i, "")
    .replace(/\s*·\s*\d+\s*[mhd]\b/i, "");
  if (label && label.length <= (compact ? 15 : 19)) return label;
  if (/former/i.test(label)) return level.kind === "support" ? "Old support" : level.kind === "resistance" ? "Old resistance" : "Former entry";
  if (/swept/i.test(label)) return level.kind === "support" ? "Swept low" : "Swept high";
  return level.kind === "entry" ? "Entry" : level.kind === "support" ? "Support" : "Resistance";
}

/** Bound label density on short charts. Keep all true price lines; tightly packed labels share one rail slot. */
export function railRows<T extends { ly: number }>(levels: T[], top: number, bottom: number) {
  const rows = levels.map(level => [level]).sort((a,b) => a[0].ly-b[0].ly);
  const gap = 30;
  const capacity = Math.max(1, Math.floor((bottom-top)/gap)+1);
  while (rows.length > capacity) {
    let join = 0, distance = Infinity;
    for (let i=0;i<rows.length-1;i++) {
      const apart = rows[i+1][0].ly-rows[i][rows[i].length-1].ly;
      if (apart < distance) { distance = apart; join = i; }
    }
    rows[join].push(...rows.splice(join+1,1)[0]);
  }
  const result = rows.map(items => ({ items, y: Math.min(bottom,Math.max(top,items[0].ly)) }));
  for (let i=1;i<result.length;i++) result[i].y=Math.max(result[i].y,result[i-1].y+gap);
  for (let i=result.length-1;i>=0;i--) result[i].y=Math.min(result[i].y,i+1===result.length?bottom:result[i+1].y-gap);
  return result;
}
