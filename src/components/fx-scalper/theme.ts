import type { ControlRow, TradeRow } from "@/lib/fxscalper/store";
import type { Settings } from "@/lib/fxscalper/settings";
import type { Snapshot } from "@/lib/fxscalper/snapshot";

/** The FX Scalper's palette: white, light blue, restrained green — and red/amber only where they mean something. */
export const C = {
  card: "#FFFFFF",
  ink: "#13213C",
  muted: "#5B6B85",
  faint: "#94A3B8",
  line: "#E3E8F0",
  blue: "#2563EB",
  blueDeep: "#1D4ED8",
  blueSoft: "#EFF5FF",
  blueLine: "#C7D9FB",
  green: "#15803D",
  greenSoft: "#ECF8F0",
  red: "#B42318",
  redSoft: "#FEF2F1",
  amber: "#A15C07",
  amberSoft: "#FFF8EB",
} as const;

export type Connection = { id: string; server: string; emailMasked: string; status: string; lastError: string | null; lastAuthAt: string | null; createdAt: string; staysConnected: boolean; accounts: Array<{ accountId: string; accNum: string; name: string | null; currency: string | null; status: string | null; balance: number | null }> };

export type Summary = { trades: number; unpriced: number; wins: number; losses: number; gross: number; charges: number; net: number; closedLots: number; eligibleLots: number };

export type StatusPayload = {
  now: number;
  control: ControlRow;
  settings: { values: Settings; version: number; warnings: string[]; blockers: string[]; updatedAt: string | null };
  worker: { at: string | null; ageMs: number | null; worker: string | null; snapshot: Partial<Snapshot> } | null;
  connections: Connection[];
  instruments: Array<Record<string, unknown>>;
  trades: { live: TradeRow[]; recent: TradeRow[] };
  results: { today: Summary; all: Summary; dayStartsAt: string };
  compensation: { estimated: number; confirmed: number; paid: number; reversed: number; termsEntered: boolean; rows: Array<Record<string, unknown>> };
  events: Array<{ id: number; at: string; level: string; kind: string; pair: string | null; trade_id: string | null; message: string }>;
  commands: Array<{ id: string; kind: string; created_at: string; status: string; result: Record<string, unknown> | null; finished_at: string | null }>;
};

export const money = (n: number | null | undefined, ccy = "") => (n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${ccy ? ` ${ccy}` : ""}`);
export const num = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
export const px = (n: number | null | undefined, d: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d ?? 5));
export const ago = (ms: number | null | undefined) => (ms == null ? "—" : ms < 1500 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`);
export const utc = (v: string | number | null | undefined) => (v == null ? "—" : new Date(v).toISOString().slice(11, 19) + " UTC");
export const pnlColor = (n: number | null | undefined) => (n == null || n === 0 ? C.ink : n > 0 ? C.green : C.red);

export async function post(url: string, payload: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, data };
  } catch (e) {
    return { ok: false, data: { error: (e as Error).message } };
  }
}
