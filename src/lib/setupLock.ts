/**
 * LIVE SETUPS TAKE CREDITS TO VIEW (owner 10-05: "Make them use credits to view"; again 10-06, after
 * the Telegram channel was emptied and its posts switched back to the full play: "Yes, lock the site").
 *
 * The site was handing the engine's play to any signed-in member for nothing, in three places:
 *
 *   - The Floor's setup card      /api/floor/setup   gold, EUR/USD and GBP/JPY on all three horizons,
 *                                                     and every earlier map of each
 *   - the GEN FX page's lists     /api/genfx/desk    what the scanner is watching and has called
 *   - the FLOW desk's read        /api/flow/read     "Find my trade", five markets
 *
 * THE RULE, the same in all three. A member sees the play — which way, the entry, the stop, the
 * targets — while their WINDOW is open. The window opens for 30 minutes from any credit spent on
 * these setups: tapping "See the play" on a locked card, a GENX, GEN FX or MFX Ghost read they were
 * charged for, or a setup or trade fee FLOW charged them. A FLOW Pass keeps it open, and so does
 * being an admin. It is the Command Center's rule (5 credits for 30 minutes, the spend itself is the
 * pass — ccPass.ts), applied to the setups. Who has a window is decided in setupAccess.ts; this file
 * is what a member WITHOUT one is sent.
 *
 * WITHHELD BY THE SERVER, NOT HIDDEN BY THE PAGE. Each answer is rebuilt from a short list of fields
 * that say nothing about the trade — the market, the horizon, the price, the candles, how far along
 * the setup is. Nothing is copied across by default, so a field added to a read later is withheld
 * until someone lists it here. A locked card can say THAT there is a setup and how far along it is;
 * it cannot say which way or where.
 *
 * Pure: no server imports, safe in a client bundle.
 */
export const SETUP_WINDOW_MS = 30 * 60_000;
export const SETUP_MINUTES = SETUP_WINDOW_MS / 60_000;

/** How a member's window stands. `via` is why it is open; `until` is when a paid window ends. */
export type SetupGate = {
  open: boolean;
  /** Why it is open. "free" is GEN FX with the owner's billing switch off: nothing there costs anything. */
  via: "admin" | "pass" | "credits" | "free" | null;
  until: string | null;
  /** What "See the play" costs, and how long it lasts — printed on the button. */
  cost: number;
  minutes: number;
};

/** Minutes left on a PAID window, rounded up. Null when there is no clock to show: closed, a Pass, an admin. */
export function minutesLeft(gate: SetupGate | null, nowMs: number): number | null {
  if (!gate || !gate.open || gate.via !== "credits" || !gate.until) return null;
  const ms = Date.parse(gate.until) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : null;
}

/** What the button's request came back with. */
export type TapReply = Partial<SetupGate> & { error?: string; charged?: boolean | null; balance?: number | null };

/**
 * What a tap on "See the play" came to, in the words the card prints. "This tap took no credits" is
 * said only where that is known — and of this tap alone, not of one before it. Everywhere else the
 * member is told what is true whatever happened: a window that is open is never charged again, so
 * tapping again cannot cost them twice.
 */
export function tapOutcome(status: number, d: TapReply | null): { opened: boolean; charged: boolean; flyer: boolean; message: string } {
  const no = (message: string, flyer = false) => ({ opened: false, charged: false, flyer, message });
  if (d?.open) return { opened: true, charged: d.charged === true, flyer: false, message: "" };
  if (d?.error === "insufficient" || status === 402) return no(`Not enough credits${typeof d?.balance === "number" ? ` — you have ${d.balance}` : ""}.`, true);
  if (d?.error === "unauthorized" || status === 401) return no("Sign in again to continue.");
  if (d?.error === "unavailable") return no("Couldn't check your access just now, so this tap took no credits. Try again in a moment.");
  if (d?.error === "busy") return no("Already opening — one moment.");
  if (d?.error === "charge_failed" && d.charged === false) return no("That didn't go through, and this tap took no credits. Try again.");
  return no("That didn't go through. Tap again — you won't be charged twice.");
}

/** How far along a setup is. All a locked card says about it. */
export type SetupStage = "live" | "forming" | "watching";
export type LockedSetup = { stage: SetupStage };

const fin = (v: unknown): boolean =>
  (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

/** The fields of a read that are the trade itself. A read carrying any one of them is a play. */
export const PLAY_LEVELS = ["entry", "entry_low", "entry_high", "stop_loss", "tp1", "tp2", "tp3", "invalidation_price"] as const;

/**
 * Is there a play in this read? The engine draws a plan — an entry, a stop, targets — on nearly every
 * read, including the range plans it draws when it has no setup of its own, and the desk trades
 * those too (zoneSetups.ts). A read with none of those levels has nothing to withhold.
 */
export function hasPlay(g: unknown): boolean {
  if (!g || typeof g !== "object") return false;
  const r = g as Record<string, unknown>;
  return PLAY_LEVELS.some((k) => fin(r[k]));
}

/** How far along: entering now, waiting for price to reach its entry, or waiting for a trigger. */
export function stageOf(g: unknown): SetupStage {
  const action = String((g as { action?: unknown } | null)?.action ?? "");
  if (/_NOW$/.test(action)) return "live";
  if (/_LIMIT$/.test(action)) return "forming";
  return "watching";
}

/** How a card says it. No direction in any of them. */
export const STAGE_TEXT: Record<SetupStage, string> = {
  live: "entry is live now",
  forming: "setup forming",
  watching: "watching for the trigger",
};

/* ── The Floor's setup card ───────────────────────────────────────────────────────────────────── */

export type SetupBody = { g: unknown; candles: unknown; price: unknown; session: unknown; mode: unknown; asOf: unknown; symbol: unknown; cached?: boolean };

/** The card's answer without the play: the chart and the price are the market's; the read is not sent. */
export function lockSetup(body: SetupBody): { g: null; locked: LockedSetup; candles: unknown; price: unknown; session: unknown; mode: unknown; asOf: unknown; symbol: unknown; cached?: boolean } {
  return {
    g: null, locked: { stage: stageOf(body.g) },
    candles: body.candles, price: body.price, session: body.session, mode: body.mode, asOf: body.asOf, symbol: body.symbol,
    ...(body.cached ? { cached: true } : {}),
  };
}

/* ── The GEN FX page's lists ──────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

/**
 * A time to the five minutes. To the second, "entered at 09:00:07" is the entry price, read off any
 * chart; to the minute it is still one small candle. Five minutes says when without saying where.
 */
const STEP_MS = 5 * 60_000;
const toStep = (v: unknown): string | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(Math.floor(ms / STEP_MS) * STEP_MS).toISOString() : null;
};

/** A call that reached its target or its stop is over: a result. Nothing else is. */
const isResult = (outcome: unknown): boolean => outcome === "win" || outcome === "loss";

/**
 * What the scanner is watching and has called. A call that hit its target or its stop is a result
 * and is sent whole. Every other call keeps which pair, which horizon, how far along and when (to the
 * five minutes) — and loses its side, its levels, its confidence and its key (the key spells the side and
 * the zone). That includes a call that EXPIRED: it ran out of time with its stop and its target both
 * unbroken, so its levels are still a trade, and the scanner is free to record the same setup again.
 */
export function lockAlerts<T extends Row>(alerts: T[]): Row[] {
  return alerts.map((a) => {
    if (isResult(a.outcome)) return a;
    return {
      id: a.id, pair: a.pair, mode: a.mode, state: a.state, kind: a.kind, created_at: toStep(a.created_at), enter_sent_at: toStep(a.enter_sent_at),
      side: null, entry: null, entry_low: null, entry_high: null, stop: null, tp1: null, enter_price: null, confidence: null,
      outcome: a.outcome === "expired" ? "expired" : null, result_pips: null, locked: true,
    };
  });
}

/** Statuses that mean an order went to this member's own account: it is theirs, side and all. */
const OWN_ORDER = new Set(["placed", "uncertain", "cancelled"]);
/**
 * An alarm about the member's own account: an order or a position that is, or may be, on it and is not
 * being looked after ("… CHECK THIS ACCOUNT", "… CHECK SL/TP ON THE POSITION"), or GEN FX having taken
 * itself off the account ("SWITCHED OFF on this account — …"). These are never cut down: a line that
 * says "check this account" must not come out reading "nothing was placed".
 * TOLD BY HOW IT OPENS as well as by how it closes: a line is cut to 200 characters when it is written
 * (genfx/settle.ts, genfx/place.ts), and on a long one the closing words are what the cut takes.
 */
const ACCOUNT_ALARM = /^\s*genfx:?\s*(SWITCHED OFF|AN ORDER WHOSE OUTCOME IS UNKNOWN|ORDER \S+ WAS ACCEPTED|not adopted|not booked|the stop could not be confirmed)\b|CHECK (THIS ACCOUNT|SL\/TP)|NOT being followed/;
/** A direction, a word that places one price against another, or a number written like a price. Read strictly. */
const TELLS = /\b(buy\w*|sell\w*|long|short|bull\w*|bear\w*|above|below|higher|lower|rising|falling|up|down)\b|\d\.\d/i;
/** Codes about the member's ACCOUNT — credits, the broker, its settings — whose own detail may be shown if it is clean. */
const ACCOUNT_REASONS = new Set([
  "credits", "permission", "switched_off", "conservative_cooldown", "no_broker_account", "no_broker_token", "broker_unreadable",
  "ledger_unreadable", "instrument_not_found", "contract_size", "no_order_labels", "no_equity", "non_usd_account",
]);
/** Codes about the account whose detail carries a figure of the trade (what the smallest order would lose at this stop): said in fixed words instead. */
const ACCOUNT_SAID: Record<string, string> = {
  min_lot_over_risk: "the smallest order would risk too much of this account",
  min_lot_over_leverage: "the smallest order is too large for this account",
  no_risk_pct: "no risk % is set on this account",
};
/** The order path's own refusals before anything is sent (flow/executor.ts): safe to name. */
const REFUSAL_CODES = new Set(["entry_quote_unavailable", "entry_bracket_already_crossed", "invalid_broker_quantity", "entry_deadline_passed"]);
/** All a locked line says of a call the account sat out for a reason of the trade's. */
const NOT_TAKEN = "genfx: not taken";
/** All it says of an order the broker would not take. */
const REFUSED = "genfx: order not placed (the broker refused it)";

/**
 * Why a call was not taken, safe to show. A reason is written `genfx: <code> (<detail>)` or
 * `genfx: <code> — <detail>`. Details name the side ("already in a EUR/USD sell on this account",
 * "not taking a SELL against it", "not rising enough") or a number of the trade — and some CODES
 * give the side away by themselves: "one_open" is only ever written when the new call points the
 * same way as a trade the member already has on. So nothing is passed on by default. A reason about
 * the member's account ("not enough credits for this trade", "reconnect your broker") keeps its code,
 * and its detail if that names no direction and no price; an account reason whose detail is a figure
 * of the trade is said in fixed words. Every other reason — whatever the trade itself had to do with
 * it — is the same two words, so that one cannot be told from another.
 */
export function safeReason(reason: unknown): string | null {
  if (typeof reason !== "string" || !reason.trim()) return null;
  const m = /^\s*genfx:?\s*([a-z0-9_]+)\s*(?:\((.*)\))?/i.exec(reason);
  const code = m ? m[1].toLowerCase() : "";
  if (ACCOUNT_SAID[code]) return `genfx: ${code} (${ACCOUNT_SAID[code]})`;
  if (!ACCOUNT_REASONS.has(code)) return NOT_TAKEN;
  const detail = m?.[2]?.trim();
  return detail && !TELLS.test(detail) ? `genfx: ${code} (${detail})` : `genfx: ${code}`;
}

/**
 * What an ERROR line may say when it is not an alarm and no order of the member's came of it: the
 * broker refused the order, or the order path gave up before sending it. The order path's own
 * refusals are named. The broker's words are not passed on at all ("Not enough margin to create
 * Order … Buy 0.02 Price 208.9", "Stop loss must be lower than the limit price"): they are the
 * broker's to choose, so no list of words to look for would be the right one. They are said in ours.
 */
export function safeErrorNote(reason: unknown): string | null {
  if (typeof reason !== "string" || !reason.trim()) return null;
  const m = /^\s*genfx:?\s*([a-z0-9_]+)\s*$/i.exec(reason);
  return m && REFUSAL_CODES.has(m[1].toLowerCase()) ? `genfx: ${m[1].toLowerCase()}` : REFUSED;
}

/**
 * A member's own GEN FX activity. A line is theirs, and is sent whole — side and all — when an order
 * went to their account (placed, being checked, withdrawn), when it names an order of theirs
 * (`order_id`), or when it is an alarm about their account. Every other line loses its side and
 * anything in its reason that would give the side back: a call the account sat out, or one the broker
 * refused before an order existed. Those lines land the moment the call fires, so with a side on them
 * they were the call, for nothing — which is also why their time is kept to the five minutes. Only the
 * listed fields are sent.
 */
export function lockActivity<T extends Row>(rows: T[]): Row[] {
  return rows.map((e) => {
    const status = String(e.status);
    const mine = OWN_ORDER.has(status) || (e.order_id != null && String(e.order_id).trim() !== "") || (typeof e.reason === "string" && ACCOUNT_ALARM.test(e.reason));
    if (mine) return e;
    return {
      symbol: e.symbol, side: null, status: e.status, created_at: toStep(e.created_at), account_id: e.account_id,
      reason: status === "error" ? safeErrorNote(e.reason) : safeReason(e.reason),
    };
  });
}

/* ── The FLOW desk's read ─────────────────────────────────────────────────────────────────────── */

/**
 * "Find my trade" without the trade: the market, its price and how far along the setup is. The entry
 * engine's own verdict is not sent, not even its state: "stand aside" is said of a trade against the
 * trend and "enter on the pullback" of one with it, which is half of which way.
 */
export function lockFlowRead(p: Row): Row {
  return {
    ok: true, symbol: p.symbol, instrument: p.instrument, mode: p.mode, price: p.price, data_status: p.data_status, session: p.session,
    entry_engine: null, g: null, locked: { stage: stageOf(p.g) },
  };
}

/**
 * Is this read for the market and horizon on the screen? A read is drawn — and can be traded — only
 * under the ones it was made for: switching market while a read is out must not leave one market's
 * levels under another's name. Spelling is not compared (the route upper-cases the symbol it echoes),
 * and a read that does not say what it is for — an older server's — is taken as fitting.
 */
export function readFits(read: { symbol?: unknown; mode?: unknown } | null | undefined, symbol: string, mode: string): boolean {
  if (!read) return false;
  const same = (said: unknown, shown: string) => said == null || said === "" || String(said).toUpperCase() === String(shown).toUpperCase();
  return same(read.symbol, symbol) && same(read.mode, mode);
}
