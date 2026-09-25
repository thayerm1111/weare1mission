import type { InstrumentSpec, Quote, Setup, Side } from "../core/types";
import { dirOf, spreadOf } from "../core/types";
import type { RapidConfig } from "../config/defaults";
import { buildCostModel, costRatio, netRewardRisk } from "../engine/targets";
import { requiredStopBuffer } from "../engine/tolerances";

/**
 * The last gate before an order is sent.
 *
 * Everything here is re-checked on the LIVE quote, not on the snapshot the setup was planned
 * against, because the gap between "this looked good" and "this is being sent" is where a spread
 * blows out, a session closes, or the member turns automation off. The browser having said yes is
 * not broker acceptance, and a snapshot having said yes is not a current fact.
 */

export type GateInput = {
  now: number;
  setup: Setup;
  quote: Quote;
  quoteAgeMs: number;
  spec: InstrumentSpec;
  /** Executable price for this side: ask for a long, bid for a short. */
  executable: number;
  /** The setup's configured expiry and the current zone version. */
  currentZoneVersion: number;
  /** The account toggle version read at decision time, and the one in the database now. */
  automationVersionAtDecision: number;
  automationVersionNow: number;
  automationEnabled: boolean;
  sessionOpen: boolean;
  /** Set when a verified economic-calendar source says we are inside a pause window. */
  newsBlocked: boolean;
  /** Measured basis stability; null when a reference feed is not being used at all. */
  basisUnstable: boolean;
  /** Milliseconds since the intent was approved. */
  signalAgeMs: number;
  cfg: RapidConfig;
};

export type GateResult = { ok: true; notes: string[] } | { ok: false; code: string; reason: string };

export function preSubmissionGate(g: GateInput): GateResult {
  const cfg = g.cfg;
  const notes: string[] = [];
  const s = g.setup;
  const d = dirOf(s.side);

  if (!g.automationEnabled) return { ok: false, code: "automation_off", reason: "automation is off for this account" };
  if (g.automationVersionNow !== g.automationVersionAtDecision) {
    return { ok: false, code: "automation_changed", reason: "the automation setting changed after this decision was made" };
  }
  if (!g.sessionOpen) return { ok: false, code: "session_closed", reason: "the broker session is closed" };
  if (g.now >= s.expiresAt) return { ok: false, code: "expired", reason: "the setup expired before it could be submitted" };
  if (g.currentZoneVersion !== s.zoneVersion) {
    return { ok: false, code: "zone_moved", reason: `the level moved to version ${g.currentZoneVersion} after this setup was frozen` };
  }
  if (g.quoteAgeMs > cfg.feed.maxQuoteAgeMs) {
    return { ok: false, code: "stale_quote", reason: `the account feed is ${g.quoteAgeMs}ms old, over the ${cfg.feed.maxQuoteAgeMs}ms ceiling` };
  }
  if (g.signalAgeMs > cfg.feed.maxSignalToSubmitMs) {
    return { ok: false, code: "signal_stale", reason: `${g.signalAgeMs}ms elapsed since approval, over the ${cfg.feed.maxSignalToSubmitMs}ms ceiling` };
  }
  if (g.basisUnstable) return { ok: false, code: "basis_unstable", reason: "the price basis between the reference and broker feeds is not stable enough to translate levels" };
  if (g.newsBlocked) return { ok: false, code: "news_window", reason: "inside a configured high-impact event pause" };

  const spread = spreadOf(g.quote);
  if (spread > cfg.risk.maxSpreadUsd) {
    return { ok: false, code: "spread_too_wide", reason: `spread ${spread.toFixed(2)} over the ${cfg.risk.maxSpreadUsd} ceiling` };
  }
  if (spread > cfg.risk.maxSpreadToTargetRatio * s.targetUsd) {
    return { ok: false, code: "spread_too_wide", reason: `spread ${spread.toFixed(2)} is over ${(cfg.risk.maxSpreadToTargetRatio * 100).toFixed(0)}% of the ${s.targetUsd.toFixed(2)} target` };
  }

  // Price must still be inside the frozen approach band. Outside it, this is chasing.
  if (g.executable < s.entryBandLow - 1e-9 || g.executable > s.entryBandHigh + 1e-9) {
    return { ok: false, code: "outside_band", reason: `executable ${g.executable.toFixed(2)} is outside the frozen band ${s.entryBandLow.toFixed(2)}-${s.entryBandHigh.toFixed(2)}` };
  }

  // The bracket has to still make sense against the price we can actually get.
  if (d * (g.executable - s.stop) <= 0) return { ok: false, code: "bracket_invalid", reason: "price has already reached or passed the stop" };
  if (d * (s.target - g.executable) <= 0) return { ok: false, code: "bracket_invalid", reason: "price has already reached the target" };

  // A widened spread demands a WIDER protective buffer. The stop moves out and the size comes down;
  // the quantity is never preserved by pulling the stop in.
  const needed = requiredStopBuffer(s.tolerances.atrEntry, spread, g.spec.tickSize ?? 0.01, cfg);
  if (needed > s.tolerances.stopBuffer + 1e-9) {
    notes.push(`spread widened: protective buffer ${s.tolerances.stopBuffer.toFixed(2)} -> ${needed.toFixed(2)}; stop moves out and size is recomputed`);
  }

  const liveStopDistance = Math.abs(g.executable - s.stop);
  if (liveStopDistance > Math.min(cfg.protection.stopCapUsd, cfg.protection.stopCeilingUsd) + 1e-9) {
    return { ok: false, code: "stop_too_wide", reason: `against the live price the stop is ${liveStopDistance.toFixed(2)}, over the cap` };
  }
  if (g.spec.minStopDistance != null && liveStopDistance < g.spec.minStopDistance) {
    return { ok: false, code: "stop_too_close", reason: `stop ${liveStopDistance.toFixed(2)} is inside the broker's ${g.spec.minStopDistance} minimum` };
  }

  const costs = buildCostModel(spread, g.spec.tickSize ?? 0.01, g.spec.contractSize, cfg);
  const liveTarget = Math.abs(s.target - g.executable);
  const cr = costRatio(liveTarget, costs);
  if (cr > cfg.risk.maxCostToTargetRatio) {
    return { ok: false, code: "cost_too_high", reason: `modelled costs are ${(cr * 100).toFixed(1)}% of the live ${liveTarget.toFixed(2)} target` };
  }
  const rr = netRewardRisk(s.side, g.executable, s.stop, s.target, costs);
  if (rr < cfg.target.minNetRewardRisk) {
    return { ok: false, code: "reward_risk_short", reason: `net reward/risk against the live price is ${rr.toFixed(2)}` };
  }

  notes.push(`live check: spread ${spread.toFixed(2)}, stop ${liveStopDistance.toFixed(2)}, target ${liveTarget.toFixed(2)}, net R:R ${rr.toFixed(2)}`);
  return { ok: true, notes };
}

/** Executable price for a side and phase. A crossed book is not a price. */
export function executablePrice(q: Quote, side: Side, phase: "entry" | "exit"): number | null {
  if (!(q.bid > 0) || !(q.ask > 0) || q.ask < q.bid) return null;
  const wantAsk = (side === "buy" && phase === "entry") || (side === "sell" && phase === "exit");
  return wantAsk ? q.ask : q.bid;
}
