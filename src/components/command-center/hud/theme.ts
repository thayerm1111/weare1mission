/**
 * COMMAND CENTER HUD — palette and type, from the reference design.
 * Black / deep navy dominates; gold and cyan are accents; red and green carry direction only.
 */
export const H_CLASSIC = {
  bg0: "#03070B", bg1: "#050B11", bg2: "#071019", panel: "#07101A", panel2: "#09131D", raised: "#0C1721",
  line: "rgba(89,175,255,0.13)", lineHi: "rgba(39,215,242,0.42)", lineSoft: "rgba(89,175,255,0.08)",
  gold: "#D5A93D", gold2: "#E7C467", gold3: "#FFD875",
  cyan: "#00C7E8", cyan2: "#27D7F2", green: "#29DFA6", red: "#FF5364", blue: "#59AFFF",
  text: "#F0F4F7", mut: "#81909E", mut2: "#596773",
};

/*
 * THE PALETTE EVERY PANEL READS (owner 11-20 brief §11). Each colour is a CSS variable named after its classic
 * value, falling back to that value: nothing defines the variables for members, so they see exactly the classic
 * colours; the redesign preview defines them on <html> (nextTheme.ts). H_CLASSIC is the literal palette — for
 * the entrance sequence, which keeps Atlas's own colours, and for anything drawn on a canvas (cssColor below).
 */
const asVar = (c: string): string => {
  const hex = /^#([0-9A-Fa-f]{6})$/.exec(c);
  if (hex) return `var(--cc-${hex[1].toLowerCase()},${c})`;
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c.replace(/\s+/g, ""));
  if (!m) return c;
  const key = [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  return `rgba(var(--cc-${key}-rgb,${m[1]},${m[2]},${m[3]}),${m[4]})`;
};
export const H = Object.fromEntries(Object.entries(H_CLASSIC).map(([k, v]) => [k, asVar(v)])) as { [K in keyof typeof H_CLASSIC]: string };

/**
 * A colour with an alpha, the way the classic code wrote it ("#29DFA6" + "66"). A palette variable takes its rgb
 * twin (defined beside it), so the result is the same colour for members and follows the theme in the preview.
 */
export function alpha(c: string, hex2: string): string {
  const a = Math.round((parseInt(hex2, 16) / 255) * 1000) / 1000;
  const v = /^var\(--cc-([0-9a-f]{6}),\s*#([0-9A-Fa-f]{6})\)$/.exec(c);
  if (v) { const n = parseInt(v[2], 16); return `rgba(var(--cc-${v[1]}-rgb,${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}),${a})`; }
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) return `${c}${hex2}`;
  return `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;
}

/** A palette colour as a canvas can use it: the variable's value where the page defines one, else the classic. */
export function cssColor(el: Element | null, c: string): string {
  const m = /^var\((--[\w-]+),\s*(.+)\)$/.exec(c);
  if (!m) return c;
  try { const v = el ? getComputedStyle(el).getPropertyValue(m[1]).trim() : ""; return v || m[2]; } catch { return m[2]; }
}

export type Tone = "up" | "down" | "gold" | "cold" | "mut";
export const toneColor = (t: Tone | string | null | undefined): string =>
  t === "up" ? H.green : t === "down" ? H.red : t === "gold" ? H.gold2 : t === "cold" ? H.cyan2 : H.mut;

export const fmt2 = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const LABEL = "text-[9.5px] font-semibold uppercase tracking-[0.16em]";
