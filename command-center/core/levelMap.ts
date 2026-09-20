/**
 * THE LEVEL MAP — where price has turned before, going back weeks, above AND below.
 *
 * `snapshot.levels` is built from today's and yesterday's 5-minute bars only. That is the set the setup
 * engine targets, and it stays exactly as it is — this file changes nothing about how the engine trades.
 *
 * What it could not do was answer "when 4371 breaks, where next?". On 09-20 the voice said it had nothing
 * below 4371, because the nearest-eight list held today's high and a handful of session levels, all of
 * them above. The 1h, 4h and daily bars the worker already fetches go back days and weeks; this reads
 * them for the prices that mattered:
 *
 *   • each of the last five trading days' high and low        (daily bars)
 *   • this week's and last week's high and low                (daily bars, grouped by ISO week)
 *   • 4h swing highs and lows over the whole series (~20 days)
 *   • 1h swing highs and lows over the whole series (~6 days)
 *
 * Levels closer together than a small tolerance are merged into one line that names every reason it
 * matters — "Thu high · 4h swing high" is a stronger level than either on its own, and saying so is
 * the useful part.
 *
 * Pure. Bars in, levels out. No network, no clock except the `now` passed in.
 */
import type { Bar, Level } from "./types";

type Cand = { price: number; kind: Level["kind"]; label: string; weight: number };

const NY = "America/New_York";
const dayKey = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const dayName = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** Monday-anchored week key in New York time. */
function weekKey(ms: number): string {
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: NY }));
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Fractal swings: a high with `k` lower highs either side (and the mirror for lows). Closed bars only. */
export function swings(bars: Bar[], k: number): { highs: Bar[]; lows: Bar[] } {
  const highs: Bar[] = [], lows: Bar[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) hi = false;
      if (bars[j].l <= bars[i].l) lo = false;
    }
    if (hi) highs.push(bars[i]);
    if (lo) lows.push(bars[i]);
  }
  return { highs, lows };
}

export type LevelMapInput = { d1?: Bar[]; h4?: Bar[]; h1?: Bar[]; nowMs: number; price: number; atr: number };

export function levelMap(i: LevelMapInput): Level[] {
  const out: Cand[] = [];
  const add = (price: number, kind: Level["kind"], label: string, weight: number) => {
    if (Number.isFinite(price) && price > 0) out.push({ price: +price.toFixed(2), kind, label, weight });
  };
  const today = dayKey(i.nowMs);
  const thisWeek = weekKey(i.nowMs);

  /* days and weeks, from daily bars */
  const d1 = (i.d1 ?? []).filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l));
  const past = d1.filter((b) => dayKey(b.t) < today);
  for (const b of past.slice(-5)) {
    add(b.h, "pdh", `${dayName(b.t)} high`, 3);
    add(b.l, "pdl", `${dayName(b.t)} low`, 3);
  }
  const byWeek = new Map<string, Bar[]>();
  for (const b of d1) { const k = weekKey(b.t); byWeek.set(k, [...(byWeek.get(k) ?? []), b]); }
  const weeks = [...byWeek.keys()];
  const lastWeek = weeks.filter((w) => w !== thisWeek).pop();
  const wk = (bs: Bar[] | undefined, hiKind: Level["kind"], loKind: Level["kind"], name: string) => {
    if (!bs?.length) return;
    add(Math.max(...bs.map((b) => b.h)), hiKind, `${name} high`, 4);
    add(Math.min(...bs.map((b) => b.l)), loKind, `${name} low`, 4);
  };
  wk(byWeek.get(thisWeek), "wh", "wl", "this week's");
  if (lastWeek) wk(byWeek.get(lastWeek), "pwh", "pwl", "last week's");

  /* swings */
  const sw = (bars: Bar[] | undefined, k: number, tf: string, weight: number) => {
    if (!bars || bars.length < 2 * k + 1) return;
    const { highs, lows } = swings(bars, k);
    for (const b of highs) add(b.h, "swing_high", `${tf} swing high (${dayName(b.t)})`, weight);
    for (const b of lows) add(b.l, "swing_low", `${tf} swing low (${dayName(b.t)})`, weight);
  };
  sw(i.h4, 3, "4h", 2);
  sw(i.h1, 3, "1h", 1);

  /*
   * MERGE CONFLUENCE. Strongest first, so the surviving line leads with its best reason. Tolerance is a
   * fifth of the 1h-ish ATR we were given, floored at 50 cents — close enough that a trader would call
   * them the same level.
   */
  const tol = Math.max(0.5, (i.atr > 0 ? i.atr : 2) * 0.2);
  out.sort((a, b) => b.weight - a.weight);
  const kept: (Cand & { extra: string[] })[] = [];
  for (const c of out) {
    const near = kept.find((k) => Math.abs(k.price - c.price) <= tol);
    if (near) { if (!near.extra.includes(c.label) && near.label !== c.label) near.extra.push(c.label); continue; }
    kept.push({ ...c, extra: [] });
  }

  return kept.map((k) => ({
    price: k.price,
    kind: k.kind,
    label: k.extra.length ? `${k.label} · ${k.extra.slice(0, 2).join(" · ")}` : k.label,
    ...(i.atr > 0 ? { distanceAtr: +(Math.abs(k.price - i.price) / i.atr).toFixed(2) } : {}),
  }));
}

/**
 * Nearest `n` above and nearest `n` below price, from any number of level lists. Duplicates within 10
 * cents collapse to the first one seen, so pass the live session levels first.
 */
export function aboveBelow(price: number, lists: Level[][], n = 8): { above: Level[]; below: Level[] } {
  const all: Level[] = [];
  for (const l of lists.flat()) if (!all.some((x) => Math.abs(x.price - l.price) < 0.1)) all.push(l);
  const above = all.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, n);
  const below = all.filter((l) => l.price <= price).sort((a, b) => b.price - a.price).slice(0, n);
  return { above, below };
}
