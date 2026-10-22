/**
 * Cashtrap's palette — off-white, light blue, a subtle purple, and restrained green/red for direction.
 * Scoped to this module (it does not change the portal's own theme).
 */
export const C = {
  page: "#F7F7F3",
  card: "#FFFFFF",
  ink: "#1C2340",
  muted: "#6B7088",
  faint: "#9AA0B4",
  line: "#E6E8EF",
  blue: "#4F7FD8",
  blueSoft: "#EAF1FC",
  blueLine: "#9DBBEB",
  purple: "#7A6CD3",
  purpleSoft: "#F0EDFB",
  green: "#1F9A6B",
  greenSoft: "#E7F6EF",
  red: "#CF4F4A",
  redSoft: "#FBECEB",
  amber: "#B7861F",
  amberSoft: "#FBF4E3",
} as const;

export type Status = "WAIT" | "DEVELOPING" | "ARMED" | "CALL" | "PUT" | "ACTIVE" | "EXPIRED" | "DATA_UNAVAILABLE";

export const STATUS_STYLE: Record<Status, { label: string; fg: string; bg: string; border: string }> = {
  WAIT: { label: "WAIT", fg: C.muted, bg: "#F1F2F6", border: C.line },
  DEVELOPING: { label: "DEVELOPING", fg: C.blue, bg: C.blueSoft, border: C.blueLine },
  ARMED: { label: "ARMED", fg: C.purple, bg: C.purpleSoft, border: "#C9C1F0" },
  CALL: { label: "CALL", fg: "#FFFFFF", bg: C.green, border: C.green },
  PUT: { label: "PUT", fg: "#FFFFFF", bg: C.red, border: C.red },
  ACTIVE: { label: "ACTIVE", fg: C.blue, bg: C.blueSoft, border: C.blue },
  EXPIRED: { label: "EXPIRED", fg: C.muted, bg: "#F1F2F6", border: C.line },
  DATA_UNAVAILABLE: { label: "DATA UNAVAILABLE", fg: C.red, bg: "#FFFFFF", border: "#F0C9C6" },
};

export const fmtPx = (px: number | null | undefined, precision: number) => (px == null || !Number.isFinite(px) ? "—" : px.toFixed(precision));
export const fmt1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(1));
/** A time in the viewer's own time zone. */
export const localTime = (ms: number | null | undefined, withSeconds = false) =>
  ms == null ? "—" : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
export const localDateTime = (ms: number | null | undefined) =>
  ms == null ? "—" : new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const countdown = (ms: number) => {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
