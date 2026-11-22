import type { AtlasContext } from "./types";
import { normalizePlayDiagnostics } from "@/lib/plays/diagnostics";

/** Bounded display facts only. Quoted values carry no instruction, user identity or execution authority. */
export function atlasContext(raw: unknown): AtlasContext {
  if (!raw || typeof raw !== "object") return {};
  const v = raw as Record<string, unknown>, out: AtlasContext = {};
  if (typeof v.screen === "string") out.screen = v.screen.slice(0, 120);
  const account = v.account as Record<string, unknown> | null;
  if (account && typeof account.id === "string") out.account = { id: account.id.slice(0, 120), ...(account.environment === "live" || account.environment === "demo" ? { environment: account.environment } : {}) };
  const result = v.result as Record<string, unknown> | null;
  if (result && ["plays", "genx", "pulse", "floor"].includes(String(result.kind)) && result.data && typeof result.data === "object") {
    const fields = new Set(["id", "symbol", "td", "name", "market", "style", "mode", "interval", "orderType", "asOf", "as_of", "price", "live_price", "marketClosed", "status", "signal", "genx", "g", "gold", "direction", "dir", "entry", "entry_low", "entry_high", "stopLoss", "stop_loss", "takeProfits", "tp1", "tp2", "tp3", "rationale", "invalidation", "no_trade_reason", "confidence", "confidence_score", "grade", "timeframe", "verdict", "action", "reason", "headline", "trigger", "trigger_condition", "invalidation_reason", "market_story", "directional_bias", "lifecycle", "data_status", "candidates", "setups", "scannedAt", "at", "score", "confirmations", "confirmed", "total", "checklist", "label", "ok", "riskReward", "rr", "bias", "confirmedSetup", "stage", "levels", "kind", "low", "high", "waitingFor", "entryZone", "levelsLocked", "locked", "session", "triggerTf", "contextTf", "timeframes", "tf", "trend", "setup", "poi", "liquidityTarget", "stop", "targets", "target", "value", "side"]);
    for (const field of ["timeframeConfirmations", "aligned", "closed", "unavailable", "flow", "h4", "h1", "mtf"]) fields.add(field);
    let nodes = 0, textLeft = 10000;
    const clean = (value: unknown, depth = 0): unknown => {
      if (depth > 6 || ++nodes > 350) return null;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "boolean" || value == null) return value;
      if (typeof value === "string") { const text = value.slice(0, Math.min(700, Math.max(0, textLeft))); textLeft -= text.length; return text; }
      if (Array.isArray(value)) return value.slice(0, 8).map((x) => clean(x, depth + 1));
      if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const frames = Array.isArray(record.timeframeConfirmations) ? normalizePlayDiagnostics(record).timeframeConfirmations : undefined;
        // Prioritize the five displayed reads within the existing budget. Old copies of the same checks
        // add no context; omit those only from this quoted copy, never from the saved signal.
        const entries = Object.entries(record).filter(([key]) => fields.has(key) && (!frames?.length || !["timeframeConfirmations", "timeframes", "checklist", "mtf"].includes(key)));
        if (frames?.length) entries.unshift(["timeframeConfirmations", frames]);
        return Object.fromEntries(entries.slice(0, 40).map(([key, item]) => [key, clean(item, depth + 1)]));
      }
      return null;
    };
    out.result = { kind: result.kind as "plays" | "genx" | "pulse" | "floor", data: clean(result.data) };
  }
  return out;
}

const OPEN = "[[ATLAS_APP_CONTEXT_V1]]", CLOSE = "[[/ATLAS_APP_CONTEXT_V1]]";

/** ElevenLabs' documented contextual_update: background data, without asking for or billing another answer. */
export function appVoiceContextUpdate(context: AtlasContext) {
  return { type: "contextual_update" as const, text: `${OPEN}${JSON.stringify(atlasContext(context))}${CLOSE}` };
}

/** Contextual updates may arrive in tool-call arguments or tool text. Only a bounded data marker is read. */
export function latestAppVoiceContext(messages: unknown, initial: unknown): AtlasContext {
  let latest = atlasContext(initial), visited = 0;
  const scan = (value: unknown, depth = 0) => {
    if (++visited > 1200 || depth > 8) return;
    if (typeof value === "string") {
      const text = value.slice(0, 30000);
      // Tool-call arguments are often JSON strings containing the contextual update's text.
      if (/^[\s]*[\[{]/.test(text) && !text.startsWith(OPEN)) {
        try { scan(JSON.parse(text), depth + 1); } catch { /* ordinary message */ }
      }
      let offset = 0;
      while (offset < text.length) {
        const start = text.indexOf(OPEN, offset); if (start < 0) break;
        const end = text.indexOf(CLOSE, start + OPEN.length); if (end < 0) break;
        try { latest = atlasContext(JSON.parse(text.slice(start + OPEN.length, end))); } catch { /* partial update is not a new context */ }
        offset = end + CLOSE.length;
      }
    } else if (Array.isArray(value)) for (const x of value.slice(-50)) scan(x, depth + 1);
    else if (value && typeof value === "object") for (const x of Object.values(value).slice(0, 12)) scan(x, depth + 1);
  };
  scan(messages);
  return latest;
}
