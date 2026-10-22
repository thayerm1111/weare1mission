import { M5 } from "./candles";
import type { DmiStatus } from "./dmi";
import { callPut, metCount, type ArmedSetup, type Checklist, type Decision, type Direction, type Values } from "./engine";
import type { SignalRecord } from "./signals";
import type { CashtrapSymbol } from "./symbols";

/**
 * WHAT A MARKET CARD SHOWS — written by the live runner after every pass, read by the dashboard.
 *
 * Status, in order of precedence:
 *   CALL / PUT        a signal was just published and its entry window is open
 *   ACTIVE            a signal's reference entry was accepted and it has not expired
 *   EXPIRED           a signal finished (settled, unresolved or missed) within the last five minutes
 *   DATA UNAVAILABLE  the market is closed, the feed is behind or broken, or history is too short
 *   ARMED             an exhaustion candle armed a setup; waiting for the DMI event
 *   DEVELOPING        the candle still FORMING meets the exhaustion conditions — provisional; it is never
 *                     a signal and never counted
 *   WAIT              nothing qualifies
 * "x/5 conditions met" is confluence of related indicators, not a probability of winning.
 */
export type CardStatus = "WAIT" | "DEVELOPING" | "ARMED" | "CALL" | "PUT" | "ACTIVE" | "EXPIRED" | "DATA_UNAVAILABLE";

export type Snapshot = {
  symbol: CashtrapSymbol;
  updatedAt: number;
  price: { px: number; at: number; source: string } | null;
  feed: { open: boolean; ok: boolean; reason: string | null; lagMs: number | null; latestCandleT: number | null };
  status: CardStatus;
  reason: string;
  direction: Direction | null;
  checklist: Checklist | null;
  met: number;
  nextCloseAt: number;
  lastDecision: Decision | null;
  armed: (ArmedSetup & { windowEndsAt: number }) | null;
  developing: { direction: Direction; checklist: Checklist; values: Values; candleT: number } | null;
  signal: SignalRecord | null;
  dmi: DmiStatus;
  strategyVersion: string;
  configVersion: string;
};

const hms = (t: number) => `${new Date(t).toISOString().slice(11, 19)} UTC`;
export const EXPIRED_SHOWN_MS = 5 * 60_000;

export function cardStatus(o: {
  now: number;
  feed: Snapshot["feed"];
  lastDecision: Decision | null;
  armed: Snapshot["armed"];
  developing: Snapshot["developing"];
  signal: SignalRecord | null;
  dmiAvailable: boolean;
}): Pick<Snapshot, "status" | "reason" | "direction" | "checklist" | "met"> {
  const s = o.signal;
  if (s) {
    const dir: Direction = s.direction === "CALL" ? "BUY" : "SELL";
    const cl: Checklist = { band: true, rsi: true, stoch: true, zone: s.zone != null, dmi: true };
    if (s.status === "published" && o.now <= s.entryDeadline) {
      return { status: s.direction, direction: dir, checklist: cl, met: metCount(cl), reason: `${s.direction} published at ${hms(s.publishedAt)}; reference entry by ${hms(s.entryDeadline)}.` };
    }
    if (s.status === "active" && s.expiryAt != null && o.now < s.expiryAt) {
      return { status: "ACTIVE", direction: dir, checklist: cl, met: metCount(cl), reason: `${s.direction} active from ${s.referencePrice} (${s.referenceSource}); expires ${hms(s.expiryAt)}.` };
    }
    const endedAt = s.settlementAt ?? s.expiryAt ?? s.entryDeadline;
    if ((s.status === "settled" || s.status === "missed" || s.status === "active") && o.now - endedAt < EXPIRED_SHOWN_MS) {
      const what = s.status === "missed" ? "missed — no reference entry inside the entry window" : s.status === "active" ? "expired — settling" : `${s.result}${s.settlementPrice != null ? ` (settled ${s.settlementPrice} vs entry ${s.referencePrice})` : ""}`;
      return { status: "EXPIRED", direction: dir, checklist: cl, met: metCount(cl), reason: `${s.direction} from ${hms(s.publishedAt)} ${what}. Reference-feed result, not a broker settlement.` };
    }
  }
  if (!o.feed.ok) return { status: "DATA_UNAVAILABLE", direction: null, checklist: null, met: 0, reason: o.feed.open ? `Data unavailable — ${o.feed.reason ?? "feed problem"}. No signals until the data is reliable.` : "Market closed." };
  if (o.lastDecision?.status === "DATA_UNAVAILABLE") return { status: "DATA_UNAVAILABLE", direction: null, checklist: null, met: 0, reason: o.lastDecision.reason };
  if (o.armed) {
    const cl: Checklist = { ...o.armed.checklist, dmi: o.dmiAvailable ? false : null };
    return { status: "ARMED", direction: o.armed.direction, checklist: cl, met: metCount(cl), reason: o.lastDecision?.status === "ARMED" ? o.lastDecision.reason : `${o.armed.direction} armed; waiting for DMI until ${hms(o.armed.windowEndsAt)}.` };
  }
  if (o.developing) {
    return { status: "DEVELOPING", direction: o.developing.direction, checklist: o.developing.checklist, met: metCount(o.developing.checklist), reason: `Developing ${o.developing.direction}: the forming ${hms(o.developing.candleT).slice(0, 5)} candle meets the exhaustion conditions so far. Provisional — only a completed candle counts.` };
  }
  const d = o.lastDecision;
  const lead = d?.leading ?? null;
  const cl = lead && d?.checklist ? d.checklist[lead] : null;
  return { status: "WAIT", direction: lead, checklist: cl, met: cl ? metCount(cl) : 0, reason: d?.reason ?? "Waiting for the first completed candle." };
}

export const armedWindowEnd = (a: ArmedSetup, windowCandles: number): number => a.exhaustionT + (windowCandles + 1) * M5;
export const signalLabel = (d: Direction) => callPut(d);
