import { findAsset } from "@/data/signalAssets";
import type { PlayView } from "@/components/om/plays/PlayDetail";
import type { GenxRead } from "@/components/om/genx/GenxHome";
import { analysisOf } from "@/lib/plays/lifecycle";
import { actionWords } from "@/lib/genx/words";
import { earnMission } from "@/lib/earnMission";
import type { AtlasContext } from "@/lib/atlas/open";

/** Atlas uses the production tools. It never computes levels or places an order. */
export const SIGNALS_UPDATED_EVENT = "om:signals-updated";
export const GENX_UPDATED_EVENT = "om:genx-updated";
export const SIGNALS_STORE_KEY = "om_signals";
export const ATLAS_PLAY_CONFIRMATIONS = ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"];

export type AtlasSignalRequest =
  | { tool: "plays"; td: string; style?: "scalp" | "intraday" | "swing"; orderType?: "limit" | "market"; mode?: "institutional" | "accelerator" }
  | { tool: "genx"; mode?: "quick" | "intraday" | "swing" };

export type AtlasGenxResult = {
  ok: true; signal_id: string | null; asOf: string; symbol: string; mode: string;
  price: number; data_status: string; session?: string;
  genx: GenxRead & { lifecycle?: string; engine_state?: string; setup_type?: string };
  candles?: { t: string; o: number; h: number; l: number; c: number }[];
};
export type AtlasSignalResult =
  | { kind: "plays"; result: PlayView; saved: "synced" | "device" | "unavailable" }
  | { kind: "genx"; result: AtlasGenxResult; saved: "synced" | "unavailable" };

export class AtlasSignalError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
    this.name = "AtlasSignalError";
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown, max = 20_000): value is string => typeof value === "string" && value.length <= max;
const optionalText = (value: unknown) => value == null || text(value);
const optionalNumber = (value: unknown) => value == null || finite(value);
const optionalWords = (value: unknown) => value == null || Array.isArray(value) && value.length <= 32 && value.every((x) => text(x));

/** Keep the production response intact, including its no-trade state and market timestamp. */
export function atlasPlayResult(value: unknown, id = Date.now()): PlayView | null {
  if (!object(value) || !object(value.signal) || !["LONG", "SHORT", "NEUTRAL"].includes(String(value.signal.direction))) return null;
  if (typeof value.td !== "string" || !findAsset(value.td) || typeof value.symbol !== "string" || typeof value.asOf !== "string") return null;
  if (![value.symbol, value.asOf].every((x) => text(x, 128)) || ![value.style, value.as_of, value.orderType].every(optionalText)) return null;
  const s = value.signal;
  if (![s.rationale, s.invalidation, s.no_trade_reason, s.timeframe].every(optionalText)) return null;
  if (![s.entry, s.stopLoss].every(optionalNumber) || s.takeProfits != null && (!Array.isArray(s.takeProfits) || s.takeProfits.length > 8 || !s.takeProfits.every(finite))) return null;
  if (s.status !== undefined && s.status !== "setup" && s.status !== "no_trade") return null;
  return { ...value, id, status: "open" } as PlayView;
}

export function atlasGenxResult(value: unknown): AtlasGenxResult | null {
  if (!object(value) || value.ok !== true || !object(value.genx) || typeof value.genx.action !== "string" || typeof value.asOf !== "string") return null;
  if (typeof value.symbol !== "string" || !["XAU/USD", "XAUUSD"].includes(value.symbol)) return null;
  if (!text(value.mode, 128) || !text(value.asOf, 128) || !optionalText(value.data_status) || !optionalText(value.signal_id)) return null;
  const g = value.genx;
  if (![g.trigger_condition, g.invalidation_reason].every(optionalText) || ![g.market_story, g.trade_reasoning, g.risk_factors].every(optionalWords)) return null;
  if (![g.entry, g.stop_loss, g.tp1, g.tp2, g.tp3].every(optionalNumber)) return null;
  return value as AtlasGenxResult;
}

type Saved = { id: number | string; createdAt?: string; asOf?: string };
/** New copies replace the same id; every other saved play stays, newest first. */
export function mergeSavedPlays<T extends Saved>(existing: T[], incoming: T[], limit = 20): T[] {
  const records = new Map<string, T>();
  for (const item of [...existing, ...incoming]) if (item && item.id != null) records.set(String(item.id), item);
  const made = (item: T) => Number(item.id) > 1e12 ? Number(item.id) : Date.parse(item.createdAt ?? item.asOf ?? "") || 0;
  return [...records.values()].sort((a, b) => made(b) - made(a)).slice(0, limit);
}

function notify(name: string, detail?: unknown) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
}

/** A storage outage must never turn a successful paid read into a second generation. */
export async function saveAtlasPlay(result: PlayView): Promise<"synced" | "device" | "unavailable"> {
  let local = false;
  try {
    const raw = JSON.parse(localStorage.getItem(SIGNALS_STORE_KEY) ?? "[]");
    const previous: PlayView[] = Array.isArray(raw) ? raw : [];
    localStorage.setItem(SIGNALS_STORE_KEY, JSON.stringify(mergeSavedPlays(previous, [result])));
    local = true;
  } catch { /* The server can still keep the result if this device cannot. */ }
  notify(SIGNALS_UPDATED_EVENT, { play: result });
  try {
    const response = await fetch("/api/signals", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signals: [result] }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok === true && body.saved > 0) return "synced";
  } catch { /* Return the read with an honest save status; do not retry generation. */ }
  return local ? "device" : "unavailable";
}

/**
 * Call only after the member requests this read. An abort before launch cancels it. Once paid work has
 * started, let it finish and save the answer even if the conversation is closed in the meantime.
 */
export async function generateAtlasSignal(request: AtlasSignalRequest, signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<AtlasSignalResult> {
  if (signal?.aborted) throw new DOMException("The read was cancelled before it started.", "AbortError");
  if (!isCurrent()) throw new AtlasSignalError("session_changed", "This read belongs to the previous signed-in session. Open Atlas again to continue.");
  if (request.tool !== "plays" && request.tool !== "genx") throw new AtlasSignalError("unknown_tool", "Choose OM AI Plays or GENX.");
  if (request.tool === "plays" && !findAsset(request.td)) throw new AtlasSignalError("unknown_asset", "Choose a market supported by OM AI Plays.");
  const body = request.tool === "plays"
    ? { td: request.td, style: request.style ?? "intraday", orderType: request.orderType ?? "limit", mode: request.mode ?? "institutional", method: "best", confirmations: [...ATLAS_PLAY_CONFIRMATIONS] }
    : { mode: request.mode ?? "quick" };
  let response: Response;
  try {
    response = await fetch(request.tool === "plays" ? "/api/om-signal" : "/api/genx", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new AtlasSignalError("connection", "The connection was interrupted. Check your saved reads before generating again.");
  }
  const data: unknown = await response.json().catch(() => null);
  // The generation request belonged to its original authenticated session. Never save its answer using
  // a later member's cookie or put it in that member's device cache after an account switch.
  if (!isCurrent()) throw new AtlasSignalError("session_changed", "This read belongs to the previous signed-in session. Open Atlas again to continue.");
  const d = object(data) ? data : {};
  if (response.status === 401 || d.error === "unauthorized") throw new AtlasSignalError("unauthorized", "Your session has ended. Sign in again to continue.", 401);
  if (response.status === 402 || d.error === "insufficient_credits") {
    notify("open-credits-flyer");
    throw new AtlasSignalError("insufficient_credits", "You need more credits for this read. Your FLOW Pass, if active, is checked by the tool.", 402);
  }
  if (d.notConfigured) throw new AtlasSignalError("not_configured", "This tool is not available right now. Please try again later.", response.status);
  if (!response.ok || d.error) throw new AtlasSignalError(String(d.error ?? "tool_unavailable"), typeof d.detail === "string" ? d.detail : "The tool could not finish this read. Please try again shortly.", response.status);

  if (request.tool === "plays") {
    const result = atlasPlayResult(data);
    if (!result) throw new AtlasSignalError("invalid_result", "The tool did not return a complete signal. Check your saved plays before generating again.");
    notify("credits-updated");
    const saved = await saveAtlasPlay(result);
    void earnMission("signal");
    return { kind: "plays", result, saved };
  }
  const result = atlasGenxResult(data);
  if (!result) throw new AtlasSignalError("invalid_result", "GENX did not return a complete read. Check your GENX history before generating again.");
  notify("credits-updated");
  notify(GENX_UPDATED_EVENT, { read: result });
  return { kind: "genx", result, saved: result.signal_id ? "synced" : "unavailable" };
}

/** Only valid directional levels can open the existing ticket. Waiting never becomes confirmed here. */
export function atlasExecution(signal: AtlasSignalResult): {
  symbol: string; direction: "LONG" | "SHORT"; entry: number; stop: number; tp: number | null; unconfirmed: boolean; orderType: string;
} | null {
  if (signal.kind === "plays") {
    const r = signal.result, s = r.signal, analysis = analysisOf(s);
    if (analysis.kind === "none" || s.direction === "NEUTRAL" || !finite(s.entry) || !finite(s.stopLoss) || s.entry <= 0 || s.stopLoss <= 0 || s.entry === s.stopLoss) return null;
    return { symbol: r.symbol, direction: s.direction, entry: s.entry, stop: s.stopLoss, tp: (s.takeProfits ?? []).find(finite) ?? null, unconfirmed: analysis.kind === "idea", orderType: r.orderType };
  }
  const g = signal.result.genx, action = actionWords(g.action);
  if (!action.side || !finite(g.entry) || !finite(g.stop_loss) || g.entry <= 0 || g.stop_loss <= 0 || g.entry === g.stop_loss) return null;
  return { symbol: "XAU/USD", direction: action.side === "sell" ? "SHORT" : "LONG", entry: g.entry, stop: g.stop_loss, tp: finite(g.tp1) ? g.tp1 : null, unconfirmed: action.waiting, orderType: g.action.includes("LIMIT") ? "Limit" : "Market" };
}

export function atlasSignalContext(signal: AtlasSignalResult): AtlasContext {
  if (signal.kind === "plays") {
    const r = signal.result;
    return { source: "OM AI Plays", label: r.symbol + " · " + analysisOf(r.signal).label, data: { symbol: r.symbol, style: r.style, asOf: r.as_of ?? r.asOf, marketClosed: r.marketClosed, signal: r.signal } };
  }
  const r = signal.result;
  return { source: "GENX", label: "Gold · " + actionWords(r.genx.action).label, data: { symbol: r.symbol, mode: r.mode, asOf: r.asOf, data_status: r.data_status, genx: r.genx } };
}
