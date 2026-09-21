/**
 * COMMAND CENTER HUD — palette and type, from the reference design.
 * Black / deep navy dominates; gold and cyan are accents; red and green carry direction only.
 */
export const H = {
  bg0: "#03070B", bg1: "#050B11", bg2: "#071019", panel: "#07101A", panel2: "#09131D", raised: "#0C1721",
  line: "rgba(89,175,255,0.13)", lineHi: "rgba(39,215,242,0.42)", lineSoft: "rgba(89,175,255,0.08)",
  gold: "#D5A93D", gold2: "#E7C467", gold3: "#FFD875",
  cyan: "#00C7E8", cyan2: "#27D7F2", green: "#29DFA6", red: "#FF5364", blue: "#59AFFF",
  text: "#F0F4F7", mut: "#81909E", mut2: "#596773",
};

export type Tone = "up" | "down" | "gold" | "cold" | "mut";
export const toneColor = (t: Tone | string | null | undefined): string =>
  t === "up" ? H.green : t === "down" ? H.red : t === "gold" ? H.gold2 : t === "cold" ? H.cyan2 : H.mut;

export const fmt2 = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const LABEL = "text-[9.5px] font-semibold uppercase tracking-[0.16em]";
