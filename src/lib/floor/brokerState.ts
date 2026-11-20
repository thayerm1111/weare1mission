/**
 * THE BROKER'S ACCOUNT STATE — reading it, and deciding what may be shown (The Floor's Balance and Equity).
 *
 * The pure half of src/lib/floor/accountState.ts: no database, no broker, no clock but the one passed in,
 * so every rule here is tested as it stands (tests/floor-broker-state.test.ts).
 *   • the broker's state row is positional; it is read by the column NAMES the broker's own config gives,
 *     and not at all when those names are missing;
 *   • only a reading — numbers with the time the broker gave them — is ever shown as current, and only
 *     inside the freshness window (overview.figuresState);
 *   • a display read steps aside whenever an order or a login is waiting on the same connection.
 */
import { figuresState, type AccountFigures } from "./overview";

export const STATE_TTL_MS = 90_000;
export const CONFIG_TTL_MS = 12 * 3600_000;
export type ParsedState = { balance: number | null; equity: number | null; openPnl: number | null; positions: number | null };

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const root = (body: unknown): Record<string, unknown> | null => {
  if (!body || typeof body !== "object") return null;
  const d = (body as { d?: unknown }).d;
  return (d && typeof d === "object" ? d : body) as Record<string, unknown>;
};

/** The names of the account-state columns, in the order the broker sends them. Empty when the config does not say. */
export function detailColumns(config: unknown): string[] {
  const sec = root(config)?.accountDetailsConfig as { columns?: Array<{ id?: unknown }> } | undefined;
  return Array.isArray(sec?.columns) ? sec.columns.map((c) => String(c?.id ?? "")).filter(Boolean) : [];
}

/**
 * The account's state, read by column NAME. A positional row with no column names is not read at all: the
 * order differs between broker builds, and a balance read from the wrong position is worse than none.
 */
export function parseAccountState(body: unknown, columns: string[]): ParsedState | null {
  const d = root(body);
  if (!d) return null;
  const arr = d.accountDetailsData;
  let get: (...ids: string[]) => number | null;
  if (Array.isArray(arr)) {
    if (!columns.length) return null;
    get = (...ids) => { for (const id of ids) { const i = columns.indexOf(id); const v = i >= 0 ? num(arr[i]) : null; if (v != null) return v; } return null; };
  } else {
    get = (...ids) => { for (const id of ids) { const v = num(d[id]); if (v != null) return v; } return null; };
  }
  const out: ParsedState = {
    balance: get("balance", "accountBalance"),
    equity: get("projectedBalance", "equity"),
    openPnl: get("openNetPnL", "openGrossPnL"),
    positions: get("positionsCount"),
  };
  if (out.positions != null) out.positions = Math.max(0, Math.round(out.positions));
  return out.balance == null && out.equity == null ? null : out;
}

/** The member's account as FLOW holds it: which logins carry it, and the balance taken when it was connected. */
export type AccountRow = { connection_id: string; account_id: string; acc_num: string | null; environment: string | null; balance?: number | string | null };
/** One reading, as stored. */
export type StateRow = { balance?: number | string | null; equity?: number | string | null; open_pl?: number | string | null; positions?: number | null; read_at?: string | null };

/**
 * What the database holds for the account, as figures. Only a READING counts — numbers stored with the
 * time the broker gave them. The balance kept from the day the account was connected has no time of its
 * own, so it is offered only as "an earlier balance" when nothing has been read yet, with no equity.
 */
export function figuresFromStored(reading: StateRow | null, rows: Pick<AccountRow, "balance">[], nowMs: number): AccountFigures {
  if (reading?.read_at && Number.isFinite(Date.parse(String(reading.read_at)))) {
    const balance = num(reading.balance), equity = num(reading.equity);
    const state = figuresState(reading.read_at, nowMs, balance != null || equity != null);
    if (state !== "unavailable") {
      const positions = num(reading.positions);
      return { balance, equity, openPnl: num(reading.open_pl), positions: positions == null ? null : Math.max(0, Math.round(positions)), at: reading.read_at, state, note: state === "last_known" ? "The last reading from your broker." : null };
    }
  }
  const first = rows.find((r) => num(r.balance) != null);
  if (first) return { balance: num(first.balance), equity: null, openPnl: null, positions: null, at: null, state: "last_known", note: "An earlier balance. Your broker has not been read yet." };
  return { balance: null, equity: null, openPnl: null, positions: null, at: null, state: "unavailable", note: "Your broker has not reported this account's figures yet." };
}

/** Is an order or a login waiting on the broker right now? Then a display read does not go out. */
export function brokerBusy(stats: Record<string, { queued: number[] }>): boolean {
  return Object.values(stats).some((h) => (h.queued[0] ?? 0) > 0 || (h.queued[1] ?? 0) > 0);
}
