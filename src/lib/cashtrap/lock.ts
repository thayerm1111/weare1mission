import type { Decision } from "./engine";
import type { SignalRecord } from "./signals";
import type { Snapshot } from "./snapshot";

/**
 * CASHTRAP'S LIVE PLAY TAKES CREDITS TO VIEW (owner 10-23: Cashtrap on The Floor for members, "locked"
 * like the other live setups). The rule is the site's: one window — a 5-credit spend, a FLOW Pass, or
 * being an admin — opens every live setup for 30 minutes (src/lib/setupLock.ts, setupAccess.ts). This
 * file is what a member WITHOUT a window is sent.
 *
 * WHAT IS THE PLAY: a signal still in play (published or active — its entry window or its expiry is
 * still ahead), a setup that is armed or forming, and anything that names their direction: the
 * card's status and checklist, the latest decision when it armed or confirmed, the setups and signals
 * behind a live play, and fresh alerts about them. WHAT STAYS OPEN: prices, the chart and its
 * indicators, zones, a market that is simply waiting, settled and missed signals (results), and the
 * replay. Withheld by the server — the page is never sent what it must not show.
 *
 * Pure: no server imports.
 */
export const isLiveSignal = (s: { status: string } | null | undefined): boolean => !!s && (s.status === "published" || s.status === "active");

/** A decision that names the direction of a setup that may still be in play. */
const revealsPlay = (d: Pick<Decision, "status"> | null | undefined): boolean => !!d && (d.status === "ARMED" || d.status === "CONFIRMED");

const PLAY_STATUSES = new Set(["CALL", "PUT", "ACTIVE", "ARMED", "DEVELOPING"]);
export const LOCKED_REASON = "A Cashtrap signal is live on this market. Which way and the reference entry open with credits.";
export const FORMING_REASON = "A Cashtrap setup is forming on this market. Which way opens with credits.";

/** A market card for a member without a window. */
export function lockSnapshot(s: Snapshot | null): Snapshot | null {
  if (!s) return s;
  const out: Snapshot = {
    ...s,
    armed: null,
    developing: null,
    signal: isLiveSignal(s.signal) ? null : s.signal,
    lastDecision: revealsPlay(s.lastDecision) ? null : s.lastDecision,
  };
  if (!PLAY_STATUSES.has(s.status)) return out;
  const forming = s.status === "ARMED" || s.status === "DEVELOPING";
  return { ...out, status: "LOCKED", direction: null, checklist: null, met: 0, reason: forming ? FORMING_REASON : LOCKED_REASON };
}

type SetupRowLike = { id: string; status: string; exhaustion_t?: string | null };
type PointLike = { t: number; bbBasis: number | null; bbUpper: number | null; bbLower: number | null; rsi: number | null; rsiMa: number | null; stochK: number | null; dmiStoch: number | null; dmiEvent: "B" | "S" | null };

/**
 * The selected market's detail for a member without a window. Besides the play itself, the indicator
 * values and DMI events of the candles since the live setup began are blanked: on those candles they
 * would say which way it goes (the exhaustion's band/RSI/Stochastic side, the confirming B or S).
 * The candles themselves stay, as on the other locked cards.
 */
export function lockMarket<T extends { setups: SetupRowLike[]; signals: SignalRecord[]; decision: Decision | null; snapshot: Snapshot | null; points?: PointLike[] }>(p: T): T {
  const live = p.signals.filter(isLiveSignal);
  const liveSetups = new Set(live.map((x) => x.setupId));
  const starts: number[] = live.map((x) => x.setupCandleT);
  if (p.snapshot?.signal && isLiveSignal(p.snapshot.signal)) { liveSetups.add(p.snapshot.signal.setupId); starts.push(p.snapshot.signal.setupCandleT); }
  if (p.snapshot?.armed) starts.push(p.snapshot.armed.exhaustionT);
  for (const s of p.setups) if (s.status === "armed" && s.exhaustion_t) starts.push(Date.parse(s.exhaustion_t));
  if (p.snapshot?.developing) starts.push(p.snapshot.developing.candleT);
  const since = starts.filter(Number.isFinite).length ? Math.min(...starts.filter(Number.isFinite)) : Infinity;
  const points = p.points?.map((k) => (k.t >= since ? { ...k, bbBasis: null, bbUpper: null, bbLower: null, rsi: null, rsiMa: null, stochK: null, dmiStoch: null, dmiEvent: null } : k));
  return {
    ...p,
    ...(points ? { points } : {}),
    setups: p.setups.filter((x) => x.status !== "armed" && !liveSetups.has(x.id)),
    signals: p.signals.filter((x) => !isLiveSignal(x)),
    decision: revealsPlay(p.decision) ? null : p.decision,
    snapshot: lockSnapshot(p.snapshot),
  };
}

/** Signal history for a member without a window: results stay, live plays go. */
export function lockHistory<T extends { referenceFeed: SignalRecord[]; brokerVerified: SignalRecord[]; setups: SetupRowLike[] }>(p: T): T {
  const liveSetups = new Set([...p.referenceFeed, ...p.brokerVerified].filter(isLiveSignal).map((x) => x.setupId));
  return {
    ...p,
    referenceFeed: p.referenceFeed.filter((x) => !isLiveSignal(x)),
    brokerVerified: p.brokerVerified.filter((x) => !isLiveSignal(x)),
    setups: p.setups.filter((x) => x.status !== "armed" && !liveSetups.has(x.id)),
  };
}

/** Alerts about a play still running say THAT there is one, not which way. A signal's whole life is under ten minutes. */
export const ALERT_LOCK_MS = 15 * 60_000;
const PLAY_ALERTS = new Set(["armed", "signal", "entry"]);
export function lockAlerts<T extends { kind: string; symbol: string | null; title: string; body: string; created_at: string }>(alerts: T[], nowMs: number, label: (symbol: string | null) => string): T[] {
  return alerts.map((a) => {
    const age = nowMs - Date.parse(a.created_at);
    if (!PLAY_ALERTS.has(a.kind) || !(age < ALERT_LOCK_MS)) return a;
    return { ...a, title: `${label(a.symbol)}: ${a.kind === "armed" ? "Cashtrap setup forming" : "live Cashtrap signal"}`, body: "Which way and the reference entry open with credits." };
  });
}
