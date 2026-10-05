import { type Mode } from "@/lib/genxCompute";
import { esc } from "@/lib/telegram";
import { type FxPair, fmtPx } from "@/lib/genfx/pairs";
import { ARM_MAX_MS } from "@/lib/genfx/decide";

/**
 * GEN FX — WHAT IT SAYS IN THE CHANNEL. The same three messages GENX sends (a setup is forming, enter
 * now, the setup is off) plus the win recap, worded the same way, with two differences a reader needs:
 * every line says GEN FX and names the pair, and prices print at the pair's own precision. Nothing is
 * sent unless the owner has switched GEN FX's Telegram on (control.ts).
 */
export const TYPE_LABEL: Record<Mode, string> = { quick: "QUICK", intraday: "INTRADAY", swing: "SWING" };
export const MODE_LABEL: Record<Mode, string> = { quick: "Quick", intraday: "Intraday", swing: "Swing" };
const TRIGGER: Record<Mode, string> = { quick: "5-minute", intraday: "15-minute", swing: "1-hour" };
export const genfxTyped = (mode: Mode): string => `GEN FX ${TYPE_LABEL[mode] ?? ""}`.trim();

type Lv = { entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2?: number | null; tp3?: number | null; confidence?: number | null; invalidation?: number | null };
const zoneOf = (p: FxPair, a: Lv) => (a.entry_low != null && a.entry_high != null ? `${fmtPx(p, a.entry_low)}–${fmtPx(p, a.entry_high)}` : "—");

export function headsUpMsg(p: FxPair, side: "buy" | "sell", mode: Mode, a: Lv): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const tps = [a.tp1 != null ? `TP1 ${fmtPx(p, a.tp1)}` : null, a.tp2 != null ? `TP2 ${fmtPx(p, a.tp2)}` : null].filter(Boolean).join(" · ");
  return [
    `⏳ <b>${genfxTyped(mode)} — ${p.name} ${dir} setup forming</b>`,
    `Zone: <b>${esc(zoneOf(p, a))}</b>`,
    `Stop: ${fmtPx(p, a.stop)}${tps ? " · " + esc(tps) : ""}`,
    a.confidence != null ? `Confidence ${a.confidence}/100` : "",
    `Waiting for price to reach the zone and confirm. You'll get an <b>ENTER NOW</b> the moment it triggers.`,
    `<i>Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n");
}

export function enterMsg(p: FxPair, side: "buy" | "sell", mode: Mode, a: Lv, atPrice: number | null, immediate: boolean): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const tps = [a.tp1 != null ? `TP1 ${fmtPx(p, a.tp1)}` : null, a.tp2 != null ? `TP2 ${fmtPx(p, a.tp2)}` : null, a.tp3 != null ? `TP3 ${fmtPx(p, a.tp3)}` : null].filter(Boolean).join(" · ");
  const confirmLine = immediate
    ? `Live setup — ${p.name} is at the zone now.`
    : `${side === "sell" ? "Sellers" : "Buyers"} confirmed on the ${TRIGGER[mode] ?? "trigger"} close.`;
  return [
    `✅ <b>${genfxTyped(mode)} — ENTER NOW · ${p.name} ${dir}</b>`,
    `${p.name} @ ~${fmtPx(p, atPrice)}`,
    `Entry ${esc(zoneOf(p, a))} · Stop ${fmtPx(p, a.stop)}`,
    tps ? esc(tps) : "",
    confirmLine,
    `<i>Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n");
}

/**
 * A setup called off. Two different things end one, and the channel is told which.
 *   • A candle closed beyond its invalidation — the default, and what the second line has always said.
 *   • `timedOut`: it was announced on a confirmation with price already past the entry, given five
 *     minutes for the pullback (decide.ARM_MAX_MS), and the pullback did not come. Nothing closed
 *     beyond anything. Until 10-04 this case was sent the first sentence too — as GENX's line is — and
 *     the first one that went out live told the channel GBP/JPY had "closed beyond 208.785" when the
 *     setup had been let go by the clock.
 */
export function invalidMsg(p: FxPair, side: "buy" | "sell", mode: Mode, a: Lv, timedOut = false): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  if (timedOut) {
    const mins = Math.round(ARM_MAX_MS / 60_000);
    return [
      `❌ <b>${genfxTyped(mode)} — ${p.name} setup expired · ${dir}</b>`,
      `The ${esc(a.entry_low != null && a.entry_high != null ? zoneOf(p, a) : "the zone")} ${dir.toLowerCase()} is off — price did not come back to the entry within ${mins} minutes. Don't chase it.`,
    ].join("\n");
  }
  return [
    `❌ <b>${genfxTyped(mode)} — ${p.name} setup invalidated · ${dir}</b>`,
    `The ${esc(a.entry_low != null && a.entry_high != null ? zoneOf(p, a) : "the zone")} ${dir.toLowerCase()} is off — price closed beyond ${fmtPx(p, a.invalidation ?? a.stop)}. Don't take it.`,
  ].join("\n");
}

export function winMsg(p: FxPair, side: "buy" | "sell", mode: Mode, a: Lv, pips: number): string {
  return [
    `🏆 <b>GEN FX WIN · ${p.name} ${side === "sell" ? "SELL" : "BUY"} · ${MODE_LABEL[mode] ?? mode}</b>`,
    `${p.name} hit its target for <b>+${pips} pips</b>.`,
    `Called ${esc(zoneOf(p, a))} → TP1 ${fmtPx(p, a.tp1)}.`,
    `<i>Educational, not financial advice.</i>`,
  ].join("\n");
}
