import { findAsset } from "@/data/signalAssets";
import type { PulseSetup } from "@/components/om/pulse/PulseHome";
import { scanMs } from "@/lib/pulse/scan";

export type AtlasPulseResult = { setups: PulseSetup[]; asOf: string };
export const PULSE_UPDATED_EVENT = "om:pulse-updated";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Same bounded parser for a fresh tool response and a restored conversation; neither can supply actions. */
export function parseAtlasPulseResult(raw: unknown): AtlasPulseResult | null {
  if (!object(raw) || !text(raw.asOf, 128) || scanMs(raw.asOf) == null || !Array.isArray(raw.setups)) return null;
  const setups: PulseSetup[] = [], seen = new Set<string>();
  for (const s of raw.setups.slice(0, 32)) {
    if (!object(s) || !text(s.td, 40) || !findAsset(s.td) || seen.has(s.td)) continue;
    if (!text(s.symbol, 40) || !text(s.name, 160) || (s.dir !== "LONG" && s.dir !== "SHORT")) continue;
    if (!finite(s.price) || s.price <= 0 || !finite(s.confirmed) || !finite(s.total) || !Number.isInteger(s.confirmed) || !Number.isInteger(s.total) || s.total < 1 || s.total > 64 || s.confirmed < 0 || s.confirmed > s.total) continue;
    if ((s.zone !== "discount" && s.zone !== "premium") || (s.rsi !== null && (!finite(s.rsi) || s.rsi < 0 || s.rsi > 100))) continue;
    if (!Array.isArray(s.checklist) || s.checklist.length > 32 || s.checklist.some((c) => !object(c) || !text(c.label, 240) || typeof c.ok !== "boolean")) continue;
    if (s.entry != null && (!finite(s.entry) || s.entry <= 0) || s.stopLoss != null && (!finite(s.stopLoss) || s.stopLoss <= 0)) continue;
    if (s.takeProfits != null && (!Array.isArray(s.takeProfits) || s.takeProfits.length > 8 || s.takeProfits.some((n) => !finite(n) || n <= 0))) continue;
    if (s.riskReward != null && !text(s.riskReward, 80)) continue;
    const row: PulseSetup = {
      td: s.td, symbol: s.symbol, name: s.name, dir: s.dir, price: s.price, confirmed: s.confirmed, total: s.total,
      checklist: s.checklist.map((c) => ({ label: c.label, ok: c.ok })), zone: s.zone, rsi: s.rsi as number | null,
      ...(finite(s.entry) ? { entry: s.entry } : {}), ...(finite(s.stopLoss) ? { stopLoss: s.stopLoss } : {}),
      ...(Array.isArray(s.takeProfits) ? { takeProfits: [...s.takeProfits] as number[] } : {}),
      ...(typeof s.riskReward === "string" ? { riskReward: s.riskReward } : {}),
    };
    seen.add(row.td); setups.push(row);
  }
  // Malformed candidates are not evidence that the scanner found no opportunities.
  if (raw.setups.length > 0 && setups.length === 0) return null;
  return { asOf: raw.asOf, setups };
}

/** Called only from the member's priced Scan markets action. The scanner owns its data and billing. */
export async function scanWithAtlas(isCurrent: () => boolean = () => true): Promise<AtlasPulseResult> {
  if (!isCurrent()) throw new Error("This scan belongs to the previous signed-in session. Open Atlas again to continue.");
  const response = await fetch("/api/om-scan", { method: "POST" });
  const data = await response.json().catch(() => null);
  if (!isCurrent()) throw new Error("This scan belongs to the previous signed-in session. Open Atlas again to continue.");
  if (response.status === 401) throw new Error("Your session has ended. Sign in again to scan markets.");
  if (response.status === 402 || data?.error === "insufficient_credits") throw new Error("You need more credits for this scan. Open Credits to check your balance.");
  if (data?.notConfigured) throw new Error("The market data service is unavailable. Your previous scan is still saved.");
  const result = parseAtlasPulseResult(data);
  if (!response.ok || data?.error || !result) {
    throw new Error(typeof data?.detail === "string" ? data.detail : "The scanner could not complete this read. Your previous scan is still saved.");
  }
  try { localStorage.setItem("om_pulse_v1", JSON.stringify(result)); } catch { /* The result is still available in this conversation. */ }
  window.dispatchEvent(new CustomEvent(PULSE_UPDATED_EVENT, { detail: result }));
  window.dispatchEvent(new Event("credits-updated"));
  return result;
}
