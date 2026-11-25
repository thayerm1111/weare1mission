import type { AtlasIdea } from "../../../command-center/engines/idea";
import type { AtlasContext } from "./open";

/** The existing Command Center engine reads gold. A selected FX market must never receive a gold call. */
export const ATLAS_COMMAND_SIGNAL_MARKET = "XAUUSD";
export const atlasCommandSignalSupported = (symbol: string) => symbol.replace(/[\s/]/g, "").toUpperCase() === ATLAS_COMMAND_SIGNAL_MARKET;

export type AtlasCommandSignalResult = {
  idea: AtlasIdea;
  saved: boolean;
  copy: string;
  generatedAt: number;
  analysisAt: number | null;
};
export type AtlasCommandAccess = {
  active: boolean; admin: boolean; expiresAt: string | null;
  cost: number; minutes: number; balance: number | null;
};
export class AtlasCommandSignalError extends Error {
  constructor(public code: "unsupported_market" | "pass_required" | "unauthorized" | "unavailable" | "invalid_response" | "insufficient", message: string) {
    super(message); this.name = "AtlasCommandSignalError";
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown) => Array.isArray(value) && value.every(text);

/** Validate the fields rendered by the embedded card; every price remains an engine-returned number. */
export function parseAtlasCommandSignal(raw: unknown): AtlasCommandSignalResult | null {
  if (!object(raw) || raw.ok === false || !object(raw.idea)) return null;
  const idea = raw.idea;
  if (!finite(idea.at) || !Number.isFinite(new Date(idea.at).getTime()) || !text(idea.headline) || !text(idea.reasoning) || !text(idea.badge)
    || !["enter_now", "on_confirmation", "at_level", "on_break", "stand_aside"].includes(String(idea.kind))
    || ![null, "buy", "sell"].includes(idea.side as null | string)
    || ![null, "setup_engine", "read_plan", "forced_read"].includes(idea.source as null | string)
    || (idea.symbol != null && (!text(idea.symbol) || !atlasCommandSignalSupported(idea.symbol)))
    || !(idea.id === null || text(idea.id)) || !(idea.price === null || positive(idea.price))
    || !(idea.snapshotAt === null || finite(idea.snapshotAt))
    || !strings(idea.waitingFor) || !strings(idea.warnings)
    || !Array.isArray(idea.confirmations) || !idea.confirmations.every((c) => object(c) && text(c.label) && typeof c.ok === "boolean" && (c.detail === null || text(c.detail)))
    || !Array.isArray(idea.targets) || !idea.targets.every((t) => object(t) && positive(t.price) && text(t.label) && finite(t.r) && t.r >= 0)
    || !object(idea.execute) || !text(idea.execute.note) || typeof idea.execute.now !== "boolean") return null;
  if (idea.kind !== "stand_aside" && (!object(idea.entry) || !positive(idea.entry.price)
    || !positive(idea.entry.low) || !positive(idea.entry.high) || idea.entry.low > idea.entry.high || !text(idea.entry.text)
    || !(idea.entry.trigger === null || text(idea.entry.trigger))
    || !object(idea.stop) || !positive(idea.stop.price) || !text(idea.stop.what))) return null;
  if (idea.invalidation !== null && (!object(idea.invalidation) || !text(idea.invalidation.text))) return null;
  if (idea.confidence !== null && (!object(idea.confidence) || !text(idea.confidence.label))) return null;
  if (idea.rr !== null && (!object(idea.rr) || !finite(idea.rr.first) || !finite(idea.rr.best))) return null;
  const analysisAt = object(raw.analysis) && finite(raw.analysis.analysisAt) ? raw.analysis.analysisAt : idea.snapshotAt as number | null;
  return { idea: idea as unknown as AtlasIdea, saved: raw.saved === true, copy: text(raw.copy) ? raw.copy : "", generatedAt: idea.at, analysisAt };
}

type RequestOptions = { fetcher?: typeof fetch; signal?: AbortSignal; isCurrent?: () => boolean };

/** One explicit generation. No pass purchase, GENX, order, watch, or execution request is made here. */
export async function requestAtlasCommandSignal(symbol: string, options: RequestOptions = {}): Promise<AtlasCommandSignalResult | null> {
  if (!atlasCommandSignalSupported(symbol)) throw new AtlasCommandSignalError("unsupported_market", "Atlas Command Center signals currently cover Gold (XAU/USD). Market analysis and voice remain available for this market.");
  if (options.isCurrent && !options.isCurrent()) return null;
  const response = await (options.fetcher ?? fetch)("/api/command-center/idea", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "generate" }), signal: options.signal,
  });
  const raw: unknown = await response.json().catch(() => null);
  // Market changes or a closed host invalidate even a successful late response.
  if (options.isCurrent && !options.isCurrent()) return null;
  if (response.status === 401) throw new AtlasCommandSignalError("unauthorized", "Sign in to generate an Atlas Command Center signal.");
  if (response.status === 402) throw new AtlasCommandSignalError("pass_required", "Open a Command Center window to generate with Atlas. Generating is included once your window is open.");
  if (!response.ok) throw new AtlasCommandSignalError("unavailable", "Atlas could not generate a signal just now. Your existing calls remain in Command Center.");
  const result = parseAtlasCommandSignal(raw);
  if (!result) throw new AtlasCommandSignalError("invalid_response", "Atlas returned an incomplete read. No signal can be displayed from that response.");
  return result;
}

function accessOf(raw: unknown): AtlasCommandAccess | null {
  if (!object(raw) || typeof raw.active !== "boolean" || typeof raw.admin !== "boolean"
    || !finite(raw.cost) || raw.cost < 0 || !finite(raw.minutes) || raw.minutes <= 0
    || !(raw.balance === null || finite(raw.balance))) return null;
  return { active: raw.active, admin: raw.admin, cost: raw.cost, minutes: raw.minutes, balance: raw.balance as number | null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null };
}

/** Read-only pricing/access lookup, shown before any separate credit purchase. */
export async function loadAtlasCommandAccess(options: RequestOptions = {}): Promise<AtlasCommandAccess | null> {
  const response = await (options.fetcher ?? fetch)("/api/command-center/pass", { cache: "no-store", signal: options.signal });
  if (!response.ok) return null;
  return accessOf(await response.json().catch(() => null));
}

/** Only called by the separate button displaying the server's price and window duration. */
export async function openAtlasCommandWindow(options: Pick<RequestOptions, "fetcher"> = {}): Promise<AtlasCommandAccess> {
  const response = await (options.fetcher ?? fetch)("/api/command-center/pass", { method: "POST" });
  const raw: unknown = await response.json().catch(() => null);
  const access = accessOf(raw);
  if (response.status === 401) throw new AtlasCommandSignalError("unauthorized", "Sign in again before opening Command Center.");
  if (object(raw) && raw.error === "insufficient") throw new AtlasCommandSignalError("insufficient", access
    ? `You need ${access.cost} credits and have ${access.balance ?? 0}. Add credits before opening this window.`
    : "You do not have enough credits to open this Command Center window.");
  if (!response.ok || !access || !access.active) throw new AtlasCommandSignalError("unavailable", "The Command Center window could not be opened. Check your credit balance before trying again.");
  return access;
}

/** Quoted, timestamped display facts for Explain/voice; execution authority is deliberately excluded. */
export function atlasCommandSignalContext(result: AtlasCommandSignalResult): AtlasContext {
  const i = result.idea;
  return { source: "floor", label: "Atlas Command Center · XAU/USD signal", data: {
    source: "Atlas Command Center engine", symbol: "XAUUSD", td: "XAU/USD", id: i.id, at: i.at,
    asOf: new Date(i.at).toISOString(), price: i.price, kind: i.kind, direction: i.side,
    confirmedSetup: i.source === "setup_engine", headline: i.headline, reason: i.reasoning,
    entry: i.entry ? { price: i.entry.price, low: i.entry.low, high: i.entry.high, trigger: i.entry.trigger } : null,
    stop: i.stop?.price ?? null, targets: i.targets.map((target) => ({ label: target.label, price: target.price, rr: target.r })),
    invalidation: i.invalidation?.text ?? null, waitingFor: i.waitingFor, confirmations: i.confirmations,
    status: i.kind === "stand_aside" ? "No trade" : "Generated call; current execution eligibility must be checked in Command Center",
  } };
}
