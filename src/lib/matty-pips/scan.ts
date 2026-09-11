import { createAdminClient } from "@/lib/supabase/admin";
import { runEngine } from "@/lib/matty-pips/engine";
import { enabledAccounts, placeForAccount } from "@/lib/matty-pips/broker";
import { logDecision } from "@/lib/matty-pips/audit";
import { inWeekendCloseWindow, inDailyReopenWindow, rewardRisk } from "@/lib/flow/autoExec";
import { livePrice } from "@/lib/marketData";
import type { Mode } from "@/lib/matty-pips/types";

/**
 * MATTY PIPS AUTO — scan core, shared by the minutely Vercel cron AND the always-on
 * worker (owner 09-11 audit: "When GenX or matty pips sees the entry the trades needs
 * to be executed immediately without a second delay" — the cron alone meant a TAKE_NOW
 * could sit unexecuted for up to a minute; the worker now runs this every ~20s).
 *
 * Overlap-safe by construction: each (signal, account) is claimed via the unique index
 * in matty_pips_trades before any broker call, so the cron and the worker can never
 * double-fill the same signal.
 *
 * DESK GUARDS (added in the 09-11 audit — parity with FLOW/GENX):
 *   • WEEKEND-CLOSE BLACKOUT — no fresh entries in the last 30 min before Friday close.
 *   • DAILY-REOPEN BLACKOUT — no fresh entries 4:45–7:00pm New York (spread/rollover).
 *   • CHASE GUARD — if price has already run so far toward TP1 that the LIVE reward:risk
 *     is under 0.75 (the owner's floor), the entry is skipped for everyone instead of
 *     filling a tiny-TP / huge-SL market order. Fails OPEN when the feed is down —
 *     a feed blip never halts Matty; the structural stop still protects the trade.
 * (News is already handled inside the engine itself: a TAKE_NOW never forms during a
 * high-impact event window — newsOk gating in engine.ts.)
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const MATTY_MIN_LIVE_RR = 0.75; // owner floor — same as GENX gold

export type MattyScanResult = Record<string, unknown>;

export async function runMattyScan(): Promise<{ ok: boolean; result?: MattyScanResult; error?: string; skipped?: string }> {
  const admin = createAdminClient();
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!admin || !mdKey) return { ok: false, error: "not_configured" };

  // ENTRY BLACKOUTS (desk-wide, same rules as FLOW/GENX). Open positions are still
  // managed normally by manageMattyPips — these gates block fresh ENTRIES only.
  if (inWeekendCloseWindow()) return { ok: true, skipped: "weekend_close_blackout" };
  if (inDailyReopenWindow()) return { ok: true, skipped: "reopen_blackout" };

  const accts = await enabledAccounts(admin);
  if (!accts.length) return { ok: true, skipped: "no_enabled_accounts" };

  const modes = [...new Set(accts.map((a) => (a.mode === "aggressive" ? "aggressive" : "conservative")))] as Mode[];
  const out: MattyScanResult = { accounts: accts.length, modes };
  const placed: string[] = [];

  for (const mode of modes) {
    const d = await runEngine({ symbol: "XAUUSD", mode, mdKey, fresh: false });
    if (!d.ok) { out[`engine_${mode}`] = d.error; continue; }
    out[`status_${mode}`] = d.status;
    if (d.status !== "TAKE_NOW" || !d.trade) continue;

    // CHASE GUARD (falling-knife / spent-move): the engine graded this entry at ITS read
    // price, but the fill goes out at MARKET — if price has since run toward TP1, the
    // real reward:risk collapses. Skip the wave desk-wide below the 0.75 floor, or when
    // price is already at/through the target. Feed down → fail open (never halt on a blip).
    try {
      const lp = await livePrice("XAU/USD", mdKey, true);
      if (typeof lp === "number" && Number.isFinite(lp) && lp > 0) {
        const t = d.trade;
        const through = t.direction === "buy" ? lp >= t.tp1 : lp <= t.tp1;
        const rr = rewardRisk(lp, t.stopLoss, t.tp1);
        if (through || (rr != null && rr < MATTY_MIN_LIVE_RR)) {
          out[`chase_skip_${mode}`] = rr != null ? `live R:R ${rr.toFixed(2)} < ${MATTY_MIN_LIVE_RR}` : "price at/through TP1";
          void logDecision({ userId: null, symbol: "XAUUSD", kind: "auto_skip", detail: { mode, reason: `chase_guard: ${out[`chase_skip_${mode}`]}`, entry: t.entry, stop: t.stopLoss, tp1: t.tp1, live: lp } });
          continue;
        }
      }
    } catch { /* feed blip → proceed on the engine's read */ }

    const z = d.trade.entryZone;
    const signalKey = `XAUUSD:${d.trade.direction}:${r1(z.low)}-${r1(z.high)}:${d.trade.setupType}`;
    for (const a of accts.filter((x) => (x.mode === "aggressive" ? "aggressive" : "conservative") === mode)) {
      try {
        const res = await placeForAccount(admin, a, d, signalKey);
        void logDecision({
          userId: a.user_id, symbol: "XAUUSD", kind: res.placed ? "auto_take" : "auto_skip",
          detail: { account: a.acc_num, mode, signalKey, reason: res.reason, score: d.score.total, setup: d.trade.setupType, entry: d.trade.entry, stop: d.trade.stopLoss, tp1: d.trade.tp1, riskPct: a.risk_pct },
        });
        if (res.placed) placed.push(a.acc_num);
      } catch (e) {
        void logDecision({ userId: a.user_id, symbol: "XAUUSD", kind: "auto_error", detail: { account: a.acc_num, error: e instanceof Error ? e.message.slice(0, 160) : "unknown" } });
      }
    }
  }
  out.placed = placed;
  return { ok: true, result: out };
}
