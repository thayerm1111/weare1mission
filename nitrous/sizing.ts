import { roundUpToStep } from "../rapid/core/decimal";
import type { Setup } from "../rapid/core/types";
import { sizePosition, type SizingInput, type SizingResult } from "../rapid/risk/sizing";

/** Reserve enough risk for a market fill anywhere in the confirmed entry band. */
export function sizeNitrousPosition(input: SizingInput, band: Pick<Setup, "entryBandLow" | "entryBandHigh">): SizingResult {
  const { executable, cfg } = input;
  const { entryBandLow, entryBandHigh } = band;
  const tick = input.spec.tickSize;
  if (tick == null || !Number.isFinite(tick) || tick <= 0) {
    return { ok: false, reason: "instrument tick size unavailable", blockers: ["Cannot price the entry band without a valid broker tick size."] };
  }
  if (![executable, entryBandLow, entryBandHigh].every(price => Number.isFinite(price) && price > 0)
    || executable < entryBandLow || executable > entryBandHigh) {
    return { ok: false, reason: "quote outside a valid entry band", blockers: ["Sizing requires the broker quote inside the confirmed entry band."] };
  }

  const adverseDistance = input.side === "buy" ? entryBandHigh - executable : executable - entryBandLow;
  const bandTicks = roundUpToStep(adverseDistance / tick, 1);
  // Both allowances start at the observed quote. Reserve the larger move only once.
  const entrySlippageTicks = Math.max(cfg.risk.entrySlippageTicks, bandTicks);
  return sizePosition({ ...input, cfg: { ...cfg, risk: { ...cfg.risk, entrySlippageTicks } } });
}
