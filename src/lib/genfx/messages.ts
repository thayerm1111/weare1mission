import { type Mode } from "@/lib/genxCompute";
import { esc } from "@/lib/telegram";
import { type FxPair, fmtPx } from "@/lib/genfx/pairs";
import { formingPost, enterPost, cancelledPost, GENFX_TOOL } from "@/lib/publicSignal";

/**
 * GEN FX — WHAT IT SAYS IN THE CHANNEL. The same three messages GENX sends (a setup is forming, enter
 * now, the setup is off) plus the win recap. Every line says GEN FX and names the pair. Nothing is
 * sent unless the owner has switched GEN FX's Telegram on (control.ts).
 *
 * THE THREE LIVE MESSAGES CARRY NO PLAY (owner 10-05: free subscribers were getting the whole trade).
 * They take the pair and the horizon and nothing else — no side, no zone, no stop, no target, no
 * price — so a call cannot be traded from the channel; the play is read on the GEN FX page, for
 * credits. The wording and the reasons are in publicSignal.ts. The win recap is posted after the
 * trade is over, when its levels are a result and not a signal, and still says what was called.
 */
export const TYPE_LABEL: Record<Mode, string> = { quick: "QUICK", intraday: "INTRADAY", swing: "SWING" };
export const MODE_LABEL: Record<Mode, string> = { quick: "Quick", intraday: "Intraday", swing: "Swing" };
export const genfxTyped = (mode: Mode): string => `GEN FX ${TYPE_LABEL[mode] ?? ""}`.trim();

export const headsUpMsg = (p: FxPair, mode: Mode): string => formingPost(genfxTyped(mode), p.name, GENFX_TOOL);
export const enterMsg = (p: FxPair, mode: Mode): string => enterPost(genfxTyped(mode), p.name, GENFX_TOOL);
export const invalidMsg = (p: FxPair, mode: Mode): string => cancelledPost(genfxTyped(mode), p.name);

type Called = { entry_low: number | null; entry_high: number | null; tp1: number | null };
const zoneOf = (p: FxPair, a: Called) => (a.entry_low != null && a.entry_high != null ? `${fmtPx(p, a.entry_low)}–${fmtPx(p, a.entry_high)}` : "—");

export function winMsg(p: FxPair, side: "buy" | "sell", mode: Mode, a: Called, pips: number): string {
  return [
    `🏆 <b>GEN FX WIN · ${p.name} ${side === "sell" ? "SELL" : "BUY"} · ${MODE_LABEL[mode] ?? mode}</b>`,
    `${p.name} hit its target for <b>+${pips} pips</b>.`,
    `Called ${esc(zoneOf(p, a))} → TP1 ${fmtPx(p, a.tp1)}.`,
    `<i>Educational, not financial advice.</i>`,
  ].join("\n");
}
