/**
 * MATTY PIPS — deterministic narration + real-time coaching. Templates over
 * the DecisionObject's NUMBERS: nothing here decides anything, and the goal
 * is that using Matty Pips makes the user a better trader.
 */
import type { DecisionObject, ReactionRead, SetupStatus } from "./types";
import { formatPrice } from "./pips";

const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

export function watchLine(o: {
  symbol: string;
  node: { low: number; high: number; kind: "support" | "resistance"; isComplex: boolean } | null;
  distancePips: number | null;
  status: SetupStatus;
  reaction: ReactionRead;
}): string {
  if (!o.node) return "No meaningful level in play — standing down until price reaches one.";
  const z = `${formatPrice(o.symbol, o.node.low)}–${formatPrice(o.symbol, o.node.high)}`;
  const what = o.node.isComplex ? `${o.node.kind} complex` : `${o.node.kind} zone`;
  const dist = o.distancePips != null && o.distancePips > 0 ? ` (${o.distancePips} pips away)` : " (price is there now)";
  return `Watching the ${z} ${what}${dist} — reaction: ${pretty(o.reaction.state)} · status: ${o.status.replace("_", " ")}.`;
}

/** The example-output style checklist (✓ lines) — or "why we wait". */
export function whyThisTrade(d: DecisionObject): string[] {
  const s = d.symbol;
  const lines: string[] = [];
  if (d.trade) {
    if (d.activeNode) lines.push(`${d.activeNode.isComplex ? "Major " + d.activeNode.kind + " complex" : "Meaningful " + d.activeNode.kind} ${formatPrice(s, d.activeNode.low)}–${formatPrice(s, d.activeNode.high)} (rank ${d.activeNode.rank}: ${d.activeNode.sources.map(pretty).join(", ")}).`);
    if (d.liquidity.sweep) lines.push(`${pretty(d.liquidity.sweep.side)} liquidity swept at ${formatPrice(s, d.liquidity.sweep.extreme)}.`);
    lines.push(`Reaction: ${pretty(d.reaction.state)} — ${d.reaction.detail}`);
    for (const c of d.confirmations.slice(0, 2)) lines.push(`15M: ${c.label} — ${c.detail}`);
    if (d.structureContext.lastStructureBreak) lines.push(`Structure: ${d.structureContext.lastStructureBreak} break ${d.structureContext.structureBreakDirection}${d.structureContext.changeOfCharacter ? " (change of character)" : ""}.`);
    if (d.breakoutQuality) lines.push(`Breakout grade: ${d.breakoutQuality.replace("BREAKOUT_", "")}.`);
    if (d.symbol === "XAUUSD" && d.dxy.verdict !== "DXY_NEUTRAL" && d.dxy.verdict !== "DXY_UNAVAILABLE") lines.push(`DXY: ${d.dxy.verdict === "DXY_SUPPORTS" ? "supports" : "leans against"} the trade.`);
    lines.push(`Stop ${formatPrice(s, d.trade.stopLoss)} (${d.trade.stopPips}p, structural — where the idea is wrong); TP1 ${formatPrice(s, d.trade.tp1)} (~1R), ${d.trade.tp2 != null ? `TP2 ${formatPrice(s, d.trade.tp2)}` : "no clean TP2"}, runner ${d.trade.runnerTarget != null ? formatPrice(s, d.trade.runnerTarget) : "—"}.`);
    lines.push(`Manage: +${d.trade.management.breakevenAtPips}p → breakeven · partial ${d.trade.management.partialAtHalfwayToTarget ? "at halfway" : `+${d.trade.management.partialAtPips}p`} · then stop LOCKS +${d.trade.management.lockProfitPips}p — never backward.`);
    lines.push(`Trade quality ${d.tradeQuality.replace(/_/g, " ")} · entry ${d.entryQuality ?? "—"} · score ${d.score.total}/100 (level ${d.score.levelLocation}/20 · reaction ${d.score.reaction}/20 · structure ${d.score.structure}/15 · liquidity ${d.score.liquidity}/10 · confirm ${d.score.confirmation}/15 · risk ${d.score.riskTarget}/10 · mom ${d.score.momentum}/5 · dxy ${d.score.dxy}/3 · news ${d.score.news}/2).`);
  } else {
    if (d.activeNode) lines.push(`At the ${formatPrice(s, d.activeNode.low)}–${formatPrice(s, d.activeNode.high)} ${d.activeNode.isComplex ? d.activeNode.kind + " complex" : d.activeNode.kind} (rank ${d.activeNode.rank}) · range position ${d.rangePosition}%.`);
    lines.push(`Reaction: ${pretty(d.reaction.state)} — ${d.reaction.detail}`);
    if (d.noTradeReason) lines.push(d.noTradeReason);
    lines.push(d.monitoring.watching);
  }
  return lines;
}

/** Real-time teaching — advanced concepts explained as they happen. */
export function coachLines(d: DecisionObject): string[] {
  const out: string[] = [];
  const s = d.symbol;
  if (d.approach.kind === "GRIND_COMPRESSION" && d.activeNode?.kind === "resistance") {
    out.push("Buyers are compressing into this resistance (shallow pullbacks, repeated pressure). That raises breakout odds — blindly selling the first touch here is lower quality than usual.");
  }
  if (d.approach.kind === "FAST_EXPANSION") {
    out.push("Price went vertical into this level. Fast expansion into a level often meets profit-taking — a temporary rejection is more likely, but wait for the closed candle to say so.");
  }
  if (d.liquidity.sweep && d.liquidity.fakeoutProbability === "FAKEOUT_HIGH") {
    out.push(`This is behaving more like a liquidity grab than a real breakout — price swept ${formatPrice(s, d.liquidity.sweep.extreme)} and closed back inside. Sweeps of obvious highs/lows that immediately fail are some of the best reversal fuel.`);
  }
  if (d.acceptance === "ACCEPTANCE") {
    out.push("Price is ACCEPTING beyond the level (multiple bodies closing there). Don't fight acceptance — the fade trade dies when the market is comfortable at the new price.");
  }
  if (d.entryQuality === "LATE" || d.entryQuality === "CHASE") {
    out.push("The setup is real but the entry is late — the best price is gone. Waiting for new structure beats chasing; a missed trade costs nothing.");
  }
  if (d.badLocation) {
    out.push("Good idea, bad location: the next opposing level is too close for the structural stop. Asymmetry is the edge — no room, no trade.");
  }
  if (d.momentumVerdict === "TOO_EXTENDED_DO_NOT_CHASE") {
    out.push("The break is real but extended with no sane continuation stop. MOVE CONFIRMED · ENTRY MISSED · WAITING FOR NEW STRUCTURE.");
  }
  if (d.structureContext.changeOfCharacter) {
    out.push("Change of character: internal structure just turned against the prevailing move — the first warning that the current leg is losing control.");
  }
  if (d.news.action === "WAIT_FOR_EVENT") {
    out.push("Major news minutes away with price parked at a big level — the release itself will pick the direction. Let it show its hand; the post-news sweep or break IS the setup.");
  }
  return out.slice(0, 3);
}
