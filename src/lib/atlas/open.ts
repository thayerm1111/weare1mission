/** A conversation opens over the current app screen. No navigation, charge, or trade is made here. */
export type AtlasContext = { source: string; label: string; data?: Record<string, unknown> };
export type AtlasOpenRequest = {
  question?: string;
  voice?: boolean;
  tool?: "plays" | "genx" | "pulse";
  context?: AtlasContext;
  /** An explicitly opened conversation may follow this screen's display updates without sending new questions. */
  followContext?: string;
};

export const ATLAS_OPEN_EVENT = "om:atlas:open";
export const ATLAS_CONTEXT_EVENT = "om:atlas:context";
export type AtlasContextUpdate = { key: string; context: AtlasContext };

export function openAtlas(request: AtlasOpenRequest = {}) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ATLAS_OPEN_EVENT, { detail: request }));
}

/** Display facts only. Updating an existing conversation never opens it, starts voice, or sends a question. */
export function updateAtlasContext(key: string, context: AtlasContext) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<AtlasContextUpdate>(ATLAS_CONTEXT_EVENT, { detail: { key, context } }));
}
