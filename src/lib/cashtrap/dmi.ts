import type { Series } from "./indicators";
import type { CashtrapSymbol } from "./symbols";

/**
 * DMI-STOCHASTIC — implemented from the owner's own indicator source (pasted 10-21):
 *
 *   study(title="DMI Stochastic Extreme", shorttitle="DMI-Stochastic", overlay=false)   // Pine v3
 *   wwma(l,p) => wwma = (nz(wwma[1]) * (l - 1) + p) / l          // Wells Wilder's MA, seeded at 0
 *   DMIlength = input(10)      Stolength = input(3)
 *   hiDiff = high - high[1]    loDiff = low[1] - low
 *   plusDM  = (hiDiff > loDiff) and (hiDiff > 0) ? hiDiff : 0
 *   minusDM = (loDiff > hiDiff) and (loDiff > 0) ? loDiff : 0
 *   ATR = wwma(DMIlength, tr)
 *   PlusDI  = 100 * wwma(DMIlength, plusDM)  / ATR
 *   MinusDI = 100 * wwma(DMIlength, minusDM) / ATR
 *   osc = PlusDI - MinusDI
 *   hi = highest(osc, Stolength)    lo = lowest(osc, Stolength)
 *   Stoch = sum((osc-lo), Stolength) / sum((hi-lo), Stolength) * 100
 *   crossUp   = Stoch[1] < 10 and Stoch > 10 ? 1 : 0
 *   crossDown = Stoch[1] > 90 and Stoch < 90 ? 1 : 0
 *
 * Reproduced exactly, including the parts that differ from the textbook DMI:
 *   • wwma starts from ZERO (nz of the previous value), not from a simple-average seed — it is not
 *     ta.rma. Its starting value fades as 0.9ⁿ, so over the 500-candle calculation window the
 *     result agrees with a chart that started years earlier to about 1e-12.
 *   • `tr` is Pine v3's variable, true range without na handling: na on the first bar, which makes
 *     ATR na there and restarts it from zero on the next bar, as Pine does.
 *   • A comparison with na is false, so plusDM/minusDM are 0 on the first bar.
 *   • Division by zero (ATR 0, or a flat oscillator over five bars) is na: no value, no event.
 *   • highest/lowest/sum over a window that holds an na are na (only the first bars are affected).
 *
 * THE B/S EVENTS. The pasted version draws no markers — its signal plots are commented out. The only
 * events it computes are crossUp and crossDown, and its commented-out plots label crossUp "Long"
 * (green) and crossDown short (fuchsia). So:  B = crossUp (DMI-Stoch rises through 10),
 * S = crossDown (DMI-Stoch falls through 90), on the candle where the cross is computed, at that
 * candle's close. If the B/S on the owner's chart is drawn by other lines, that version is needed.
 */
export const DMI_SOURCE = Object.freeze({
  name: "DMI Stochastic Extreme (DMI-Stochastic)",
  language: "Pine Script v3",
  receivedAt: "2026-10-21",
  version: "owner-paste-2026-10-21",
  bRule: "crossUp: DMI-Stoch[1] < 10 and DMI-Stoch > 10",
  sRule: "crossDown: DMI-Stoch[1] > 90 and DMI-Stoch < 90",
  markerNote: "The pasted version computes crossUp/crossDown but draws no B/S markers (its signal plots are commented out); B = crossUp and S = crossDown.",
});
export const DMI_LOWER = 10;
export const DMI_UPPER = 90;

export type DmiResult = { osc: Series; stoch: Series; buy: boolean[]; sell: boolean[] };

/** Wells Wilder's MA exactly as the script defines it: (nz(prev) · (l − 1) + p) / l. */
function wwma(l: number, p: Series): Series {
  const out: Series = new Array(p.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < p.length; i++) {
    const x = p[i];
    const v: number | null = x == null || !Number.isFinite(x) ? null : ((prev ?? 0) * (l - 1) + x) / l;
    out[i] = v;
    prev = v;
  }
  return out;
}

function windowOp(src: Series, len: number, i: number, op: "max" | "min" | "sum"): number | null {
  if (i - len + 1 < 0) return null;
  let acc: number | null = null;
  for (let j = i - len + 1; j <= i; j++) {
    const v = src[j];
    if (v == null || !Number.isFinite(v)) return null;
    acc = acc == null ? v : op === "max" ? Math.max(acc, v) : op === "min" ? Math.min(acc, v) : acc + v;
  }
  return acc;
}

export function dmiStochastic(high: Series, low: Series, close: Series, dmiLength = 10, stoLength = 3): DmiResult {
  const n = close.length;
  const tr: Series = new Array(n).fill(null);
  const plusDM: Series = new Array(n).fill(0);
  const minusDM: Series = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const h = high[i], l = low[i];
    if (i === 0) continue;                                  // tr na; hiDiff/loDiff na → DM 0
    const h1 = high[i - 1], l1 = low[i - 1], c1 = close[i - 1];
    if (h == null || l == null || h1 == null || l1 == null) continue;
    tr[i] = c1 == null ? null : Math.max(h - l, Math.abs(h - c1), Math.abs(l - c1));
    const hiDiff = h - h1;
    const loDiff = l1 - l;
    plusDM[i] = hiDiff > loDiff && hiDiff > 0 ? hiDiff : 0;
    minusDM[i] = loDiff > hiDiff && loDiff > 0 ? loDiff : 0;
  }
  const atr = wwma(dmiLength, tr);
  const pSm = wwma(dmiLength, plusDM);
  const mSm = wwma(dmiLength, minusDM);
  const osc: Series = atr.map((a, i) => {
    const p = pSm[i], m = mSm[i];
    if (a == null || a === 0 || p == null || m == null) return null;
    return (100 * p) / a - (100 * m) / a;
  });
  const hi: Series = osc.map((_, i) => windowOp(osc, stoLength, i, "max"));
  const lo: Series = osc.map((_, i) => windowOp(osc, stoLength, i, "min"));
  const num: Series = osc.map((o, i) => (o == null || lo[i] == null ? null : o - (lo[i] as number)));
  const den: Series = osc.map((_, i) => (hi[i] == null || lo[i] == null ? null : (hi[i] as number) - (lo[i] as number)));
  const stoch: Series = osc.map((_, i) => {
    const a = windowOp(num, stoLength, i, "sum");
    const b = windowOp(den, stoLength, i, "sum");
    if (a == null || b == null || b === 0) return null;
    return (a / b) * 100;
  });
  return { osc, stoch, ...dmiCrosses(stoch) };
}

/** The script's events: crossUp = Stoch[1] < 10 and Stoch > 10 (B); crossDown = Stoch[1] > 90 and Stoch < 90 (S). Strict, as written. */
export function dmiCrosses(stoch: Series): { buy: boolean[]; sell: boolean[] } {
  const buy = stoch.map((s, i) => i > 0 && s != null && stoch[i - 1] != null && (stoch[i - 1] as number) < DMI_LOWER && s > DMI_LOWER);
  const sell = stoch.map((s, i) => i > 0 && s != null && stoch[i - 1] != null && (stoch[i - 1] as number) > DMI_UPPER && s < DMI_UPPER);
  return { buy, sell };
}

/* ── the adapter: where B/S events come from ──────────────────────────────────────────────────── */
/**
 * A timestamped DMI-Stochastic event. `candleT` is the OPEN time (ms, UTC) of the 5-minute candle on
 * which the marker prints; `knownAt` is when the event became known (a calculated event is known at
 * that candle's close; a fed event when it was received).
 */
export type DmiEvent = { symbol: CashtrapSymbol; candleT: number; type: "B" | "S"; source: string; knownAt: number };

/**
 * How the engine gets DMI events:
 *   "calculation" — computed from the candles with the owner's source above (default).
 *   "event-feed"  — timestamped events posted to /api/cashtrap/dmi (e.g. TradingView alerts on the
 *                   owner's own indicator). Used only after the feed has been marked verified.
 *   "off"         — no DMI: setups can arm, but no CALL/PUT is ever confirmed.
 */
export type DmiMode = "calculation" | "event-feed" | "off";

export type DmiStatus = {
  mode: DmiMode;
  /** True only when confirmations can happen. */
  available: boolean;
  label: string;
  notes: string[];
};

export function dmiStatus(mode: DmiMode, feedVerified = false): DmiStatus {
  if (mode === "calculation") {
    return {
      mode, available: true,
      label: "Calculated from your DMI Stochastic Extreme source",
      notes: [
        `B = ${DMI_SOURCE.bRule}; S = ${DMI_SOURCE.sRule}.`,
        DMI_SOURCE.markerNote,
        "Parity with your TradingView chart is not yet verified: it needs a chart-data export (see the setup notes).",
      ],
    };
  }
  if (mode === "event-feed") {
    return feedVerified
      ? { mode, available: true, label: "Verified DMI event feed", notes: ["Events come from the connected feed; a candle's event is waited for up to the grace period after its close."] }
      : { mode, available: false, label: "DMI event feed not verified", notes: ["Events can be received, but confirmations stay off until the feed is marked verified."] };
  }
  return { mode, available: false, label: "DMI source required", notes: ["No DMI-Stochastic events: setups can arm but CALL/PUT cannot be confirmed."] };
}
