/**
 * THE MARKET SNAPSHOT BUILDER.
 *
 * This assembles the ONE object The BRAIN and the strategy engine are allowed to read. Two consequences,
 * both deliberate:
 *   • A model can never see data the snapshot did not carry, so replay and live are identical by construction.
 *   • Everything that should make a decision suspicious travels WITH the data, in `warnings`, instead of being
 *     checked separately and forgotten.
 *
 * Pure: bars and feed readings in, a snapshot out. No network calls live here.
 */
import type { Bar, BlockerCode, FeedHealth, MarketSnapshot, Timeframe } from "../core/types";
import { TF_MINUTES } from "../core/types";
import { hasGaps, lastClosed } from "../core/bars";
import { analyseTf, regimeOf } from "../core/regime";
import { minutesIntoSession, sessionAt, sessionLevels, withDistance } from "../core/sessions";

export const SNAPSHOT_VERSION = "cc-1.0.0";

/** How far apart two feeds may be before a price is not trustworthy enough to trade on. */
export const MAX_FEED_DIVERGENCE = 1.5;        // dollars on gold
/** How old the freshest tick may be before the market read is treated as stale, per timeframe context. */
export const MAX_TICK_AGE_MS = 90_000;

export type SnapshotInput = {
  now: number;
  bars: Partial<Record<Timeframe, Bar[]>>;
  price: number;
  bid?: number | null;
  ask?: number | null;
  feeds: FeedHealth[];
  /** Same instrument, other feed — used only to detect divergence, never to price a trade. */
  comparePrice?: { source: string; price: number } | null;
  news?: MarketSnapshot["news"];
  prevPressureNet?: number | null;
};

/** The timeframes a live decision is actually taken on. Only these can block trading when they go stale —
 *  a 4-hour candle being "3 hours old" is normal, and a daily one is stale all weekend by definition. */
export const EXECUTION_TFS: Timeframe[] = ["1m", "5m", "15m"];

export function buildSnapshot(i: SnapshotInput): MarketSnapshot {
  const warnings: string[] = [];
  const blockers: { code: BlockerCode; detail: string }[] = [];
  const block = (code: BlockerCode, detail: string) => { blockers.push({ code, detail }); warnings.push(detail); };
  const timeframes: MarketSnapshot["timeframes"] = {};

  const execTf: Timeframe = "5m";
  const contextTf: Timeframe = "1h";

  for (const tf of ["1m", "5m", "15m", "1h", "4h", "1d"] as Timeframe[]) {
    const bars = i.bars[tf];
    if (!bars || bars.length < 60) continue;
    const a = analyseTf(bars, i.prevPressureNet != null ? { bullish: 0, bearish: 0, net: i.prevPressureNet, acceleration: 0 } : null);
    if (!a) continue;
    timeframes[tf] = { state: a.state, features: a.f, structure: a.s };

    // A timeframe whose last bar closed long ago is not telling us about *now*. Only the execution
    // timeframes block on it: a 4h or 1d series is legitimately "old" most of the time.
    const closed = lastClosed(bars, tf, i.now);
    const behind = closed ? i.now - closed.t : null;
    if (behind != null && behind > TF_MINUTES[tf] * 60_000 * 3) {
      const msg = `${tf} data is behind (last close ${Math.round(behind / 60_000)}m ago)`;
      if (EXECUTION_TFS.includes(tf)) block("exec_data_behind", msg); else warnings.push(msg);
    }
    if (hasGaps(bars, tf)) {
      const msg = `${tf} series has gaps — a feed interruption, not a quiet market`;
      if (EXECUTION_TFS.includes(tf)) block("exec_data_gaps", msg); else warnings.push(msg);
    }
  }

  const exec = timeframes[execTf];
  const context = timeframes[contextTf] ?? null;

  const pressure = exec
    ? analyseTf(i.bars[execTf] ?? [], i.prevPressureNet != null ? { bullish: 0, bearish: 0, net: i.prevPressureNet, acceleration: 0 } : null)?.pressure
      ?? { bullish: 50, bearish: 50, net: 0, acceleration: 0 }
    : { bullish: 50, bearish: 50, net: 0, acceleration: 0 };

  const regime = exec
    ? regimeOf({
        exec: { f: exec.features, s: exec.structure },
        context: context ? { f: context.features, s: context.structure } : null,
        newsShock: i.news?.inLockout && (i.news?.minutesToNext ?? 99) <= 2,
      })
    : "chaotic";

  if (!exec) block("no_exec_read", "No usable 5-minute read — not enough closed bars");
  if (regime === "chaotic") block("chaotic", "Market is chaotic — no strategy is eligible");

  // Feed health and divergence. A price we cannot trust must never become a trade.
  for (const f of i.feeds) {
    if (f.state === "stale" || f.state === "disconnected") block("feed_stale", `${f.feed} feed is ${f.state}`);
    else if (f.ageMs != null && f.ageMs > MAX_TICK_AGE_MS) block("feed_stale", `${f.feed} last update ${Math.round(f.ageMs / 1000)}s ago`);
  }
  if (i.comparePrice && Math.abs(i.comparePrice.price - i.price) > MAX_FEED_DIVERGENCE) {
    block("feed_divergence", `Price feeds disagree by $${Math.abs(i.comparePrice.price - i.price).toFixed(2)} (${i.comparePrice.source} ${i.comparePrice.price.toFixed(2)} vs ${i.price.toFixed(2)})`);
  }

  const session = sessionAt(i.now);
  if (session === "closed") block("market_closed", "Market is closed");

  const atr = exec?.features.atr ?? 0;
  const levels = withDistance(sessionLevels(i.bars["5m"] ?? i.bars["15m"] ?? [], i.now), i.price, atr);

  /*
   * CAUSES BEFORE CONSEQUENCES.
   *
   * `tradeable()` reports blockers[0], and the log line and the screen both show that one. Blockers
   * were being pushed in the order the checks happen, which put "chaotic" first — so an entire closed
   * weekend was reported as "blocked: chaotic" when the snapshot also plainly carried "market_closed".
   * Two people then spent a while wondering why the market was chaotic.
   *
   * A shut market and a feed we cannot see are REASONS. Chaos is a description of what the numbers look
   * like when one of those is true. Ordering them this way means the first blocker is the one worth
   * acting on, and nothing is hidden — the full list is still carried on the snapshot.
   */
  const BLOCKER_PRIORITY: BlockerCode[] = [
    "market_closed", "feed_stale", "feed_divergence", "no_exec_read",
    "exec_data_behind", "exec_data_gaps", "chaotic",
  ];
  blockers.sort((a, b) => BLOCKER_PRIORITY.indexOf(a.code) - BLOCKER_PRIORITY.indexOf(b.code));

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    at: i.now,
    price: i.price,
    bid: i.bid ?? null,
    ask: i.ask ?? null,
    spread: i.bid != null && i.ask != null ? +(i.ask - i.bid).toFixed(3) : null,
    feeds: i.feeds,
    session,
    minutesIntoSession: minutesIntoSession(i.now),
    timeframes,
    regime,
    pressure,
    levels: levels.slice(0, 12),
    news: i.news ?? { nextEvent: null, minutesToNext: null, inLockout: false },
    warnings,
    blockers,
  };
}

/**
 * The single question the execution path asks of a snapshot: may this be traded on at all?
 * Data quality is a HARD gate — the desk fails closed on what it cannot see clearly.
 */
export function tradeable(s: MarketSnapshot): { ok: boolean; reason: string; code: BlockerCode | null } {
  const first = s.blockers[0];
  return first ? { ok: false, reason: first.detail, code: first.code } : { ok: true, reason: "", code: null };
}
