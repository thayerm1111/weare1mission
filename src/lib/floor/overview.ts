/**
 * THE FLOOR — what the first screen shows, as plain data (owner 11-20: "When customers log in, they
 * immediately enter The Floor … display the selected connected account's balance and equity … GENX results
 * prominently … current FLOW results for the signed-in customer's connected accounts").
 *
 * Pure: rows in, the screen's numbers out. No network, no clock except the `now` passed in, so every rule
 * here is tested without a broker or a database (tests/floor-overview.test.ts).
 *
 * THE SCOPES ARE KEPT APART, because they are different facts:
 *   • GENX results are the DESK RECORD: what the engine's real gold trades did, each fire counted once at the
 *     average result of the accounts that took it (src/lib/genx/realResults.ts). They are not any one
 *     customer's return.
 *   • My FLOW is ONE CONNECTED ACCOUNT: trades FLOW itself placed and managed on it. A trade the member put
 *     on by hand at the broker is not in it.
 *   • Balance and Equity are the BROKER'S figures for that account, with the time they were read.
 * Nothing is carried from one scope into another, and a missing number is null — never zero.
 */
import { contractKey, valuePerPricePerLot } from "@/lib/flow/sizing";
import { INSTRUMENTS } from "@/lib/flow/instruments";

/* ── periods ───────────────────────────────────────────────────────────────────────────────────── */

export type FloorPeriod = "today" | "7d" | "30d" | "all";
export const FLOOR_PERIODS: { key: FloorPeriod; label: string; short: string }[] = [
  { key: "today", label: "Today", short: "Today" },
  { key: "7d", label: "7 days", short: "7D" },
  { key: "30d", label: "30 days", short: "30D" },
  { key: "all", label: "All", short: "All" },
];
export const periodOf = (raw: unknown, fallback: FloorPeriod = "7d"): FloorPeriod =>
  (FLOOR_PERIODS.find((p) => p.key === String(raw ?? "").toLowerCase())?.key ?? fallback);

const DAY = 86_400_000;

/**
 * The window a period covers, half-open [from, to).
 *   today — from the member's own local midnight (their clock's offset, minutes WEST of UTC as
 *           Date.getTimezoneOffset() gives it; clamped to a real offset);
 *   7d/30d — the last 7 or 30 times 24 hours, rolling;
 *   all — from the point the site's record was restarted (owner 09-16: "everything 0 — start recording now").
 * No window ever starts before that restart: a period cannot bring back what the record no longer counts.
 */
export function periodWindow(p: FloorPeriod, nowMs: number, sinceIso: string, tzOffsetMin = 0): { from: number; to: number } {
  const since = Date.parse(sinceIso);
  const floor = Number.isFinite(since) ? since : 0;
  const off = Number.isFinite(tzOffsetMin) ? Math.max(-14 * 60, Math.min(12 * 60, Math.round(tzOffsetMin))) : 0;
  let from: number;
  if (p === "today") {
    const local = nowMs - off * 60_000;                      // the member's wall clock, as if it were UTC
    from = Math.floor(local / DAY) * DAY + off * 60_000;     // their midnight, back in real time
  } else if (p === "7d") from = nowMs - 7 * DAY;
  else if (p === "30d") from = nowMs - 30 * DAY;
  else from = floor;
  return { from: Math.max(from, floor), to: nowMs };
}

/* ── connected accounts ────────────────────────────────────────────────────────────────────────── */

export type FloorAccount = {
  /** The broker's account id. Sent back to choose which account the screen shows — never to trade. */
  id: string;
  name: string;
  /** The account number with all but its last four characters hidden. */
  masked: string;
  broker: string;
  environment: "live" | "demo";
  currency: string | null;
  connection: "connected" | "attention";
  /** The member's own default in FLOW. Choosing an account to LOOK at here never changes it. */
  isDefault: boolean;
};

export type AccountRowIn = {
  account_id: unknown; acc_num?: unknown; name?: unknown; currency?: unknown; environment?: unknown;
  is_selected?: unknown; connection_id?: unknown;
};
export type ConnRowIn = { id: unknown; broker?: unknown; environment?: unknown; status?: unknown };

/**
 * The end of the account's own number — the one the member sees at their broker. (TradeLocker also gives
 * each account a small position on its login, 1, 2, 3…; that says nothing about which account it is, and
 * is used only when there is no number at all.)
 */
export function maskAccount(accountId: unknown, accNum?: unknown): string {
  const s = String(accountId ?? "").trim() || String(accNum ?? "").trim();
  if (!s) return "••••";
  return s.length <= 4 ? `•••• ${s}` : `•••• ${s.slice(-4)}`;
}

const MACHINE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * What the account is called on screen. The broker's own label is used when it reads like a name. Some
 * brokers label an account with a machine identifier ("GENFX#95e9f433-…#3#3"): a person is never shown
 * that. Its leading word is kept when it has one ("GENFX account"); otherwise the account is named by
 * what it is and the end of its number.
 */
export function accountName(raw: unknown, environment: "live" | "demo", masked: string): string {
  const s = String(raw ?? "").trim();
  const plain = `${environment === "live" ? "Live" : "Demo"} account ${masked.replace(/^[•\s]+/, "")}`.trim();
  if (!s) return plain;
  if (!MACHINE_ID.test(s) && s.length <= 40) return s;
  const lead = s.match(/^([A-Za-z][A-Za-z0-9 ]{1,15}?)\s*[#:_/|-]/)?.[1]?.trim();
  return lead && !/^[0-9a-f]+$/i.test(lead) ? `${lead} account` : plain;
}

const BROKER_NAME: Record<string, string> = { tradelocker: "TradeLocker" };

/**
 * The member's accounts as the selector lists them. One broker account connected on two logins is ONE
 * account here (the trade manager runs those rows as one — manageSettings.mergeMgmt), and a Live account
 * and a Demo account are never merged even if a broker reused the number.
 */
export function accountsFrom(conns: ConnRowIn[], rows: AccountRowIn[]): FloorAccount[] {
  const byConn = new Map(conns.map((c) => [String(c.id), c]));
  const out = new Map<string, FloorAccount>();
  for (const r of rows) {
    const id = String(r.account_id ?? "").trim();
    if (!id) continue;
    const c = byConn.get(String(r.connection_id ?? ""));
    const env = String(r.environment ?? c?.environment ?? "").toLowerCase() === "live" ? "live" : "demo";
    const key = `${env}:${id}`;
    const connected = String(c?.status ?? "") === "connected";
    const prev = out.get(key);
    if (prev) {
      // The same account on a second login: connected if either login is, the default if either row is.
      if (connected) prev.connection = "connected";
      if (r.is_selected === true) prev.isDefault = true;
      continue;
    }
    const masked = maskAccount(id, r.acc_num);
    const broker = BROKER_NAME[String(c?.broker ?? "").toLowerCase()] ?? (String(c?.broker ?? "").trim() || "Broker");
    out.set(key, {
      id, masked, broker, environment: env,
      name: accountName(r.name, env, masked),
      currency: String(r.currency ?? "").trim().toUpperCase() || null,
      connection: connected ? "connected" : "attention",
      isDefault: r.is_selected === true,
    });
  }
  return [...out.values()];
}

/** Which account the screen shows: the one asked for when the member owns it, else their FLOW default, else the first. */
export function pickAccount(accounts: FloorAccount[], wanted?: string | null, wantedEnv?: string | null): FloorAccount | null {
  if (!accounts.length) return null;
  const w = String(wanted ?? "").trim();
  if (w) {
    const env = String(wantedEnv ?? "").toLowerCase();
    const hit = accounts.find((a) => a.id === w && (!env || a.environment === env)) ?? null;
    if (hit) return hit;
  }
  return accounts.find((a) => a.isDefault && a.connection === "connected") ?? accounts.find((a) => a.isDefault) ?? accounts.find((a) => a.connection === "connected") ?? accounts[0];
}

/* ── GENX results: the desk record, for a period ───────────────────────────────────────────────── */

/** One GENX trade as the desk record holds it (realResults.FireRec): fired once, taken by many accounts. */
export type GenxFireIn = { at: string; side: string; open: number; avgPips: number | null };

export type GenxResults = {
  /** GENX trades opened inside the window that have fully closed. Each is counted once. */
  trades: number;
  wins: number; losses: number; breakeven: number;
  /** Wins out of wins and losses, as a whole percent. Null until one has been decided. */
  winRate: number | null;
  netPips: number;
  /** GENX trades open right now (whatever the window). */
  open: number;
  recent: { at: string; side: "buy" | "sell"; pips: number }[];
  /** Running net pips across the window's closed trades, oldest first, starting from 0 — the small line beside the figures. */
  series: number[];
  /** The window's closed trades, newest first — at most GENX_HISTORY_MAX; `historyMore` counts the rest. */
  history?: { at: string; side: "buy" | "sell"; pips: number }[];
  historyMore?: number;
};
export const GENX_HISTORY_MAX = 100;

/**
 * The desk record for a window. The arithmetic is the desk record's own (realResults.buildRealResults'
 * summary): a trade is a fire every account has closed, graded at the average realized result across
 * those accounts, a win above zero and a loss below. A trade belongs to the window it was OPENED in.
 * Over "All" this is the desk record itself.
 */
export function genxPeriod(fires: GenxFireIn[], win: { from: number; to: number }): GenxResults {
  const decided: { at: number; side: "buy" | "sell"; pips: number }[] = [];
  let open = 0;
  for (const f of fires) {
    if (f.open > 0) { open += 1; continue; }
    if (f.avgPips == null || !Number.isFinite(f.avgPips)) continue;
    const at = Date.parse(f.at);
    if (!Number.isFinite(at) || at < win.from || at >= win.to) continue;
    decided.push({ at, side: String(f.side).toLowerCase() === "sell" ? "sell" : "buy", pips: f.avgPips });
  }
  decided.sort((a, b) => a.at - b.at);
  const wins = decided.filter((d) => d.pips > 0).length, losses = decided.filter((d) => d.pips < 0).length;
  let run = 0;
  const series = [0, ...decided.map((d) => (run += d.pips))];
  return {
    trades: decided.length, wins, losses, breakeven: decided.length - wins - losses,
    winRate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : null,
    netPips: Math.round(run), open,
    recent: decided.slice(-8).reverse().map((d) => ({ at: new Date(d.at).toISOString(), side: d.side, pips: d.pips })),
    series,
    history: decided.slice(-GENX_HISTORY_MAX).reverse().map((d) => ({ at: new Date(d.at).toISOString(), side: d.side, pips: d.pips })),
    historyMore: Math.max(0, decided.length - GENX_HISTORY_MAX),
  };
}

/* ── My FLOW: one account's own executions ─────────────────────────────────────────────────────── */

export type FlowPosIn = {
  position_id?: unknown; id?: unknown; account_id: unknown; environment?: unknown; symbol?: unknown; side?: unknown;
  qty?: unknown; exit_price?: unknown; result_pips?: unknown; status?: unknown; outcome?: unknown;
  created_at?: unknown; resolved_at?: unknown; signal_id?: unknown;
  entry?: unknown; fill_price?: unknown; init_stop?: unknown; cur_stop?: unknown; tp1?: unknown; strategy_version?: unknown;
};

/** Which engine a trade on the account came from. */
export type FlowSource = "genx" | "genfx" | "flow";
export const SOURCE_LABEL: Record<FlowSource, string> = { genx: "GENX", genfx: "GEN FX", flow: "FLOW" };

/**
 * The trade ledger has no column that names its source, so it is read from what each writer leaves:
 * GEN FX stamps its strategy version on every row it writes; every gold row is a GENX trade (the desk
 * record counts them so, and a ticket a member places from OM AI Plays or Find a trade is never entered
 * in this ledger); anything else is FLOW's own forex and index trading.
 */
export function flowSource(r: { symbol?: unknown; strategy_version?: unknown }): FlowSource {
  if (/^genfx/i.test(String(r.strategy_version ?? "").trim())) return "genfx";
  if (contractKey(String(r.symbol ?? "")) === "XAUUSD") return "genx";
  return "flow";
}

/** One trade FLOW is looking after on the account right now. */
export type FlowPosition = {
  id: string; at: string | null; symbol: string; side: "buy" | "sell"; source: FlowSource;
  /** Lots, as placed. */
  qty: number | null;
  /** The fill when the broker reported one, else the price the trade was sent at. */
  entry: number | null;
  /** Where the stop is now (the trade manager may have moved it), else where it was placed. */
  stop: number | null;
  target: number | null;
};

/** One trade that closed in the window. */
export type FlowClosed = {
  id: string; at: string; symbol: string; side: "buy" | "sell"; source: FlowSource;
  qty: number | null; pips: number | null; amount: number | null;
};

/** How many closed trades a window lists; the rest are counted, not listed. */
export const HISTORY_MAX = 50;

export type FlowResults = {
  /** FLOW trades closed inside the window. */
  closed: number;
  wins: number; losses: number; breakeven: number;
  /** Closed with no recorded result (the broker's close could not be read): counted, never graded. */
  ungraded: number;
  netPips: number;
  /**
   * The same closed trades in money — an ESTIMATE from the recorded result and size, before the broker's
   * commission, swap and fees. Null when none of them can be priced in the account's currency. `left`
   * says how many closed trades are not in the amount (a cross pair, a missing size).
   */
  realized: { amount: number; currency: string; counted: number; left: number } | null;
  /** FLOW trades still open on this account right now (whatever the window). */
  open: number;
  recent: { at: string; symbol: string; side: "buy" | "sell"; pips: number | null; amount: number | null }[];
  /** The open trades themselves, newest first. */
  positions?: FlowPosition[];
  /** The window's closed trades, newest first — at most HISTORY_MAX; `historyMore` counts the rest. */
  history?: FlowClosed[];
  historyMore?: number;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
/** A price or a size: a real positive number, or nothing. */
const positive = (v: unknown): number | null => { const n = num(v); return n != null && n > 0 ? n : null; };

/** One closed trade in the account's money, when it can honestly be worked out; otherwise null. */
export function estimateAmount(p: { symbol: unknown; qty: unknown; result_pips: unknown; exit_price: unknown }, accountCurrency: string | null): number | null {
  if (String(accountCurrency ?? "").toUpperCase() !== "USD") return null;
  const key = contractKey(String(p.symbol ?? ""));
  // Only a pair quoted in dollars: its move per lot is a fixed dollar amount. A cross (GBP/JPY) needs a
  // conversion rate this record does not hold, so it is left out rather than guessed.
  if (!/USD$/.test(key)) return null;
  const pips = num(p.result_pips), qty = num(p.qty);
  if (pips == null || qty == null || !(qty > 0)) return null;
  // An instrument this site has no pip size for is left out — never priced with another market's pip.
  const pip = INSTRUMENTS[key]?.pipSize ?? 0;
  if (!(pip > 0)) return null;
  const perLot = valuePerPricePerLot(key, num(p.exit_price) ?? 0);
  if (!(perLot > 0)) return null;
  return round2(pips * pip * qty * perLot);
}

/**
 * One account's FLOW results for a window. A position is counted once however many rows carry it (its
 * broker position id is its identity), and only rows of THIS account in THIS environment are read.
 */
export function foldFlow(rows: FlowPosIn[], account: Pick<FloorAccount, "id" | "environment" | "currency">, win: { from: number; to: number }): FlowResults {
  const seen = new Set<string>();
  const mine: FlowPosIn[] = [];
  for (const r of rows) {
    if (String(r.account_id ?? "") !== account.id) continue;
    const env = String(r.environment ?? "").toLowerCase();
    if (env && env !== account.environment) continue;
    const key = String(r.position_id ?? "").trim() || `row:${String(r.id ?? "")}`;
    if (key === "row:" || seen.has(key)) continue;
    seen.add(key);
    mine.push(r);
  }
  const out: FlowResults = { closed: 0, wins: 0, losses: 0, breakeven: 0, ungraded: 0, netPips: 0, realized: null, open: 0, recent: [], positions: [], history: [], historyMore: 0 };
  let amount = 0, counted = 0, left = 0;
  const closed: { at: number; r: FlowPosIn; pips: number | null; amt: number | null }[] = [];
  const open: { at: number; r: FlowPosIn }[] = [];
  for (const r of mine) {
    const status = String(r.status ?? "").toLowerCase();
    if (status === "open") { out.open += 1; const t = Date.parse(String(r.created_at ?? "")); open.push({ at: Number.isFinite(t) ? t : 0, r }); continue; }
    if (status !== "closed") continue;
    const at = Date.parse(String(r.resolved_at ?? ""));
    if (!Number.isFinite(at) || at < win.from || at >= win.to) continue;
    const pips = num(r.result_pips);
    out.closed += 1;
    if (pips == null) { out.ungraded += 1; left += 1; closed.push({ at, r, pips: null, amt: null }); continue; }
    out.netPips += pips;
    if (pips > 0) out.wins += 1; else if (pips < 0) out.losses += 1; else out.breakeven += 1;
    const amt = estimateAmount(r as never, account.currency);
    if (amt == null) left += 1; else { amount += amt; counted += 1; }
    closed.push({ at, r, pips, amt });
  }
  out.netPips = Math.round(out.netPips * 10) / 10;
  if (counted > 0) out.realized = { amount: round2(amount), currency: String(account.currency).toUpperCase(), counted, left };
  const sideOf = (r: FlowPosIn): "buy" | "sell" => (String(r.side ?? "").toLowerCase() === "sell" ? "sell" : "buy");
  const idOf = (r: FlowPosIn) => String(r.position_id ?? "").trim() || String(r.id ?? "");
  closed.sort((a, b) => b.at - a.at);
  out.recent = closed.slice(0, 5).map((c) => ({
    at: new Date(c.at).toISOString(), symbol: contractKey(String(c.r.symbol ?? "")),
    side: sideOf(c.r), pips: c.pips, amount: c.amt,
  }));
  out.history = closed.slice(0, HISTORY_MAX).map((c) => ({
    id: idOf(c.r), at: new Date(c.at).toISOString(), symbol: contractKey(String(c.r.symbol ?? "")), side: sideOf(c.r),
    source: flowSource(c.r), qty: positive(c.r.qty), pips: c.pips, amount: c.amt,
  }));
  out.historyMore = Math.max(0, closed.length - HISTORY_MAX);
  out.positions = open.sort((a, b) => b.at - a.at).map(({ at, r }) => ({
    id: idOf(r), at: at > 0 ? new Date(at).toISOString() : null, symbol: contractKey(String(r.symbol ?? "")), side: sideOf(r),
    source: flowSource(r), qty: positive(r.qty), entry: positive(r.fill_price) ?? positive(r.entry),
    stop: positive(r.cur_stop) ?? positive(r.init_stop), target: positive(r.tp1),
  }));
  return out;
}

/* ── broker figures ────────────────────────────────────────────────────────────────────────────── */

export type AccountFigures = {
  balance: number | null;
  equity: number | null;
  /** The broker's own open profit and loss on the account — every open position, FLOW's or not. */
  openPnl: number | null;
  /** How many positions the broker holds open on the account. */
  positions: number | null;
  /** When these were read from the broker. Null: never. */
  at: string | null;
  /** live: read inside the freshness window. last_known: older — shown with its age, never as current. unavailable: nothing to show. */
  state: "live" | "last_known" | "unavailable";
  /** Why it is not live, in words a member can read. */
  note: string | null;
  /** A fresh reading has been asked for and is not back yet: the screen asks again in a few seconds. */
  reading?: boolean;
};

export const FIGURES_FRESH_MS = 3 * 60_000;

/** Label a reading by its age. A reading older than the window is never called live, whatever it says. */
export function figuresState(at: string | null, nowMs: number, hasNumber: boolean): AccountFigures["state"] {
  if (!hasNumber) return "unavailable";
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "last_known";
  return nowMs - t <= FIGURES_FRESH_MS ? "live" : "last_known";
}

/** "just now", "4 min ago", "3 h ago", "2 days ago" — for a time the member needs to judge at a glance. */
export function ageText(at: string | null, nowMs: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "not yet read";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/* ── formatting ────────────────────────────────────────────────────────────────────────────────── */

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", AUD: "A$", CAD: "C$", CHF: "CHF " };

/** 10000 → "$10,000.00". An unknown currency keeps its code in front; a missing number is an em dash. */
export function money(v: number | null | undefined, currency: string | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const cur = String(currency ?? "").toUpperCase();
  const sym = SYMBOL[cur] ?? (cur ? `${cur} ` : "");
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}${sym}${abs}`;
}

/** 120 → "+120 pips"; −36.5 → "−36.5 pips"; 0 → "0 pips". */
export function pipsText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v), body = Number.isInteger(abs) ? abs.toLocaleString("en-US") : abs.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${v < 0 ? "−" : v > 0 ? "+" : ""}${body} pip${abs === 1 ? "" : "s"}`;
}

export const toneOf = (v: number | null | undefined): "up" | "down" | "flat" => (v == null || !Number.isFinite(v) || v === 0 ? "flat" : v > 0 ? "up" : "down");

/* ── Atlas on The Floor ────────────────────────────────────────────────────────────────────────── */

export const ATLAS_READ_FRESH_MS = 20 * 60_000;

/**
 * ATLAS's newest read, when it is recent enough to stand for the market now. An older read is not put
 * in front of a member as what ATLAS thinks: the panel then says nothing about the market at all.
 */
export function atlasReadFor(row: { at?: unknown; summary?: unknown } | null | undefined, nowMs: number): { at: string; summary: string } | null {
  const at = Date.parse(String(row?.at ?? ""));
  const summary = String(row?.summary ?? "").trim();
  if (!Number.isFinite(at) || !summary) return null;
  if (nowMs - at > ATLAS_READ_FRESH_MS || at - nowMs > 60_000) return null;
  return { at: new Date(at).toISOString(), summary };
}

/* ── the setup, as the chart card says it ──────────────────────────────────────────────────────── */

/** How far along a setup is (setupLock.SetupStage), in the three words the platform uses everywhere. */
export type FloorStage = "watching" | "forming" | "live";
export const STAGE_LABEL: Record<FloorStage, string> = { watching: "Watching", forming: "Waiting for confirmation", live: "Ready" };

/** One sentence for the foot of the chart. It names no direction: it is true whether or not the play is open to this member. */
export function stageSentence(stage: FloorStage, engine: string, name: string): string {
  if (stage === "live") return `${engine} has a confirmed entry on ${name}.`;
  if (stage === "forming") return `${engine} has a ${name} setup forming. It is waiting for confirmation.`;
  return `${engine} is watching ${name}. No confirmed entry.`;
}

export type SetupView = {
  stage: FloorStage | null;
  /** The play was sent (this member's window is open), so levels may be drawn. */
  open: boolean;
  side: "buy" | "sell" | null;
  levels: { kind: "support" | "resistance" | "entry" | "stop" | "target"; price: number; label: string }[];
  zone: { low: number; high: number } | null;
  /** The engine's own words for what it is waiting for, and what would change its mind. */
  waitingFor: string | null;
  changesIf: string | null;
};

const stageFrom = (action: unknown): FloorStage => {
  const a = String(action ?? "");
  return /_NOW$/.test(a) ? "live" : /_LIMIT$/.test(a) ? "forming" : "watching";
};
const words = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };

/**
 * What the chart card may show from /api/floor/setup's answer. A locked answer carries only how far
 * along the setup is, so that is all this returns for it — no side, no level. With the read present:
 * support and resistance always; the entry, stop and first target only once the engine has a setup of
 * its own (forming or live) — while it is only watching, its range plan sits ON those two levels, and
 * drawing it again would put two labels on one line.
 */
export function setupView(answer: { g?: unknown; locked?: { stage?: unknown } | null } | null | undefined): SetupView {
  const none: SetupView = { stage: null, open: false, side: null, levels: [], zone: null, waitingFor: null, changesIf: null };
  if (!answer) return none;
  const g = answer.g as Record<string, unknown> | null | undefined;
  if (!g || typeof g !== "object") {
    const s = String(answer.locked?.stage ?? "");
    return s === "live" || s === "forming" || s === "watching" ? { ...none, stage: s } : none;
  }
  const stage = stageFrom(g.action);
  const side = /SELL/.test(String(g.action ?? "")) ? "sell" : /BUY/.test(String(g.action ?? "")) ? "buy" : null;
  const levels: SetupView["levels"] = [];
  const sup = num(g.closest_support), res = num(g.closest_resistance);
  if (res != null) levels.push({ kind: "resistance", price: res, label: "Resistance" });
  if (sup != null) levels.push({ kind: "support", price: sup, label: "Support" });
  let zone: SetupView["zone"] = null;
  if (stage !== "watching") {
    const taken = (p: number) => levels.some((l) => Math.abs(l.price - p) < 1e-9);
    const entry = num(g.entry), stop = num(g.stop_loss), tp = num(g.tp1);
    if (entry != null && !taken(entry)) levels.push({ kind: "entry", price: entry, label: "Entry" });
    if (stop != null && !taken(stop)) levels.push({ kind: "stop", price: stop, label: "Stop" });
    if (tp != null && !taken(tp)) levels.push({ kind: "target", price: tp, label: "Target" });
    const zl = num(g.entry_low), zh = num(g.entry_high);
    if (zl != null && zh != null && zh > zl) zone = { low: zl, high: zh };
  }
  return { stage, open: true, side, levels, zone, waitingFor: words(g.trigger_condition), changesIf: words(g.invalidation_reason) };
}

/* ── the whole answer ──────────────────────────────────────────────────────────────────────────── */

/** /api/floor/overview. Every part can be null on its own: "could not be read" is never shown as zero. */
export type FloorOverview = {
  asOf: string;
  /** false: the member's accounts could not be read just now — which is not the same as having none. */
  accountsKnown: boolean;
  accounts: FloorAccount[];
  account: FloorAccount | null;
  figures: AccountFigures | null;
  genx: { period: FloorPeriod; since: string; results: GenxResults } | null;
  flow: { period: FloorPeriod; since: string; results: FlowResults } | null;
  atlas: { open: boolean; preview: boolean; cost: number; minutes: number; read: { at: string; summary: string } | null } | null;
};
