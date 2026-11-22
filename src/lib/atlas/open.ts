/** A conversation opens over the current app screen. No navigation, charge, or trade is made here. */
export type AtlasContext = { source: string; label: string; data?: Record<string, unknown> };
export type AtlasOpenRequest = {
  question?: string;
  voice?: boolean;
  tool?: "plays" | "genx" | "pulse";
  context?: AtlasContext;
};

export const ATLAS_OPEN_EVENT = "om:atlas:open";

export function openAtlas(request: AtlasOpenRequest = {}) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ATLAS_OPEN_EVENT, { detail: request }));
}
