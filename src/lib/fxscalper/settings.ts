import { PAIR_KEYS, type PairKey } from "./pairs";

/**
 * FX SCALPER SETTINGS — every number the bot trades by, with the owner's defaults (10-23, take-profit
 * raised to 10 executable pips the same day). All of them are shown on the dashboard before START LIVE
 * and are editable there. Values are validated on the way in: an out-of-range number is REFUSED with a
 * reason, never quietly clamped, because a silently changed risk limit is worse than an error.
 *
 * Two values are deliberately unset by default, and their absence blocks entries:
 *   • the account's commission — the broker's API does not report it, and assuming zero is the classic
 *     way a scalper looks profitable on paper and loses money live;
 *   • the cost confirmation — the owner ticks that these are the account's real costs.
 */

export type TpMode = "executable" | "after_fees";

export type PairSettings = {
  enabled: boolean;
  /** Spread + round-trip commission + other charges + slippage allowance, in pips. A screening rule. */
  maxCostPips: number;
  /** The widest stop this pair may use. Never raised automatically. */
  maxStopPips: number;
};

export type Settings = {
  strategy: {
    tpPips: number;
    tpMode: TpMode;
    stopMinPips: number;
    stopAtrMult: number;
    stopSpreadMult: number;
    maxHoldSec: number;
    signalExpirySec: number;
    maxSignalDriftPips: number;
    m1EmaFast: number;
    m1EmaSlow: number;
    m5EmaFast: number;
    m5EmaSlow: number;
    m5SlopeBars: number;
    stochK: number;
    stochSmooth: number;
    stochD: number;
    stochLow: number;
    stochHigh: number;
    atrPeriod: number;
    bandLookback: number;
  };
  costs: {
    /** Account currency per 1.0 lot per side. null = not entered yet (entries blocked). */
    commissionPerLotPerSide: number | null;
    /** Account currency per 1.0 lot, round trip. Anything the broker charges besides commission. */
    otherChargesPerLotRoundTrip: number;
    /** The owner has confirmed these are this account's actual costs. */
    confirmed: boolean;
    /** Initial slippage allowance in pips. Raised automatically when measured fills are worse. */
    slippageAllowancePips: number;
  };
  risk: {
    riskPerTradePct: number;
    maxOpenRiskPct: number;
    maxConcurrent: number;
    maxLotsPerTrade: number;
    maxGrossNotionalX: number;
    dailyLossLimitPct: number;
    lossStreakCount: number;
    lossStreakPauseMin: number;
    maxSameCurrencyDirection: number;
    /** After a new trade's margin, free margin must still be at least this % of equity. */
    marginReservePct: number;
    /** Account currency excluded from risk capital (promotional credit, payouts left in the account). */
    excludedCapital: number;
  };
  /** New York clock. No new entries inside these windows (open positions are still managed). */
  session: {
    rolloverStart: string;
    rolloverEnd: string;
    fridayCutoff: string;
    sundayOpenDelayMin: number;
  };
  pairs: Record<PairKey, PairSettings>;
  /** The owner's choice of broker symbol where the account lists more than one candidate. */
  symbolOverrides: Partial<Record<PairKey, string>>;
  /** The Genesis partner agreement, as the owner enters it. Unknown terms count as zero. */
  payout: {
    termsEntered: boolean;
    ratePerLot: number | null;
    basis: "per_side" | "round_turn";
    minHoldSec: number | null;
    currency: string;
    notes: string;
  };
  data: {
    /** Wait this long after a minute closes before asking for its candle. */
    barSettleMs: number;
    /** How often each pair's quote is refreshed for the dashboard (entries always fetch a fresh one). */
    quoteIntervalMs: number;
  };
};

export const DEFAULT_PAIR: PairSettings = { enabled: true, maxCostPips: 1.5, maxStopPips: 5 };

export const DEFAULT_SETTINGS: Settings = {
  strategy: {
    tpPips: 10,
    tpMode: "executable",
    stopMinPips: 3,
    stopAtrMult: 0.5,
    stopSpreadMult: 2,
    maxHoldSec: 120,
    signalExpirySec: 10,
    maxSignalDriftPips: 1,
    m1EmaFast: 50,
    m1EmaSlow: 100,
    m5EmaFast: 20,
    m5EmaSlow: 50,
    m5SlopeBars: 3,
    stochK: 5,
    stochSmooth: 3,
    stochD: 3,
    stochLow: 20,
    stochHigh: 80,
    atrPeriod: 14,
    bandLookback: 3,
  },
  costs: {
    commissionPerLotPerSide: null,
    otherChargesPerLotRoundTrip: 0,
    confirmed: false,
    slippageAllowancePips: 0.3,
  },
  risk: {
    riskPerTradePct: 0.1,
    maxOpenRiskPct: 0.3,
    maxConcurrent: 3,
    maxLotsPerTrade: 0.1,
    maxGrossNotionalX: 5,
    dailyLossLimitPct: 1,
    lossStreakCount: 3,
    lossStreakPauseMin: 15,
    maxSameCurrencyDirection: 2,
    marginReservePct: 50,
    excludedCapital: 0,
  },
  session: { rolloverStart: "16:55", rolloverEnd: "17:10", fridayCutoff: "16:45", sundayOpenDelayMin: 10 },
  pairs: Object.fromEntries(PAIR_KEYS.map((k) => [k, { ...DEFAULT_PAIR }])) as Record<PairKey, PairSettings>,
  symbolOverrides: {},
  payout: { termsEntered: false, ratePerLot: null, basis: "round_turn", minHoldSec: null, currency: "USD", notes: "" },
  data: { barSettleMs: 700, quoteIntervalMs: 5000 },
};

type Rule = { min: number; max: number; int?: boolean };

/** The accepted range of every number. Out of range is refused. */
const RULES: Record<string, Rule> = {
  "strategy.tpPips": { min: 1, max: 100 },
  "strategy.stopMinPips": { min: 0.5, max: 50 },
  "strategy.stopAtrMult": { min: 0, max: 10 },
  "strategy.stopSpreadMult": { min: 0, max: 10 },
  "strategy.maxHoldSec": { min: 10, max: 3600, int: true },
  "strategy.signalExpirySec": { min: 2, max: 60, int: true },
  "strategy.maxSignalDriftPips": { min: 0.1, max: 10 },
  "strategy.m1EmaFast": { min: 2, max: 500, int: true },
  "strategy.m1EmaSlow": { min: 2, max: 1000, int: true },
  "strategy.m5EmaFast": { min: 2, max: 500, int: true },
  "strategy.m5EmaSlow": { min: 2, max: 500, int: true },
  "strategy.m5SlopeBars": { min: 1, max: 50, int: true },
  "strategy.stochK": { min: 2, max: 100, int: true },
  "strategy.stochSmooth": { min: 1, max: 20, int: true },
  "strategy.stochD": { min: 1, max: 20, int: true },
  "strategy.stochLow": { min: 1, max: 49 },
  "strategy.stochHigh": { min: 51, max: 99 },
  "strategy.atrPeriod": { min: 2, max: 200, int: true },
  "strategy.bandLookback": { min: 1, max: 20, int: true },
  "costs.commissionPerLotPerSide": { min: 0, max: 100 },
  "costs.otherChargesPerLotRoundTrip": { min: 0, max: 100 },
  "costs.slippageAllowancePips": { min: 0, max: 5 },
  "risk.riskPerTradePct": { min: 0.01, max: 2 },
  "risk.maxOpenRiskPct": { min: 0.01, max: 6 },
  "risk.maxConcurrent": { min: 1, max: 7, int: true },
  "risk.maxLotsPerTrade": { min: 0.01, max: 50 },
  "risk.maxGrossNotionalX": { min: 0.1, max: 50 },
  "risk.dailyLossLimitPct": { min: 0.05, max: 20 },
  "risk.lossStreakCount": { min: 1, max: 50, int: true },
  "risk.lossStreakPauseMin": { min: 1, max: 1440, int: true },
  "risk.maxSameCurrencyDirection": { min: 1, max: 7, int: true },
  "risk.marginReservePct": { min: 0, max: 95 },
  "risk.excludedCapital": { min: 0, max: 1e12 },
  "session.sundayOpenDelayMin": { min: 0, max: 240, int: true },
  "payout.ratePerLot": { min: 0, max: 1000 },
  "payout.minHoldSec": { min: 0, max: 86400, int: true },
  "data.barSettleMs": { min: 0, max: 5000, int: true },
  "data.quoteIntervalMs": { min: 1000, max: 60000, int: true },
  "pair.maxCostPips": { min: 0.1, max: 20 },
  "pair.maxStopPips": { min: 0.5, max: 50 },
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function checkNumber(path: string, v: unknown, ruleKey = path, nullable = false): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v === null && nullable) return { ok: true, value: null };
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, error: `${path}: a number is required` };
  const r = RULES[ruleKey];
  if (r) {
    if (n < r.min || n > r.max) return { ok: false, error: `${path}: ${n} is outside ${r.min}–${r.max}` };
    if (r.int && !Number.isInteger(n)) return { ok: false, error: `${path}: a whole number is required` };
  }
  return { ok: true, value: n };
}

/** Rules that tie two settings together. */
function crossCheck(s: Settings): string[] {
  const errs: string[] = [];
  if (s.strategy.m1EmaFast >= s.strategy.m1EmaSlow) errs.push("strategy: the M1 fast EMA must be shorter than the slow EMA");
  if (s.strategy.m5EmaFast >= s.strategy.m5EmaSlow) errs.push("strategy: the M5 fast EMA must be shorter than the slow EMA");
  if (s.strategy.stochLow >= s.strategy.stochHigh) errs.push("strategy: the Stochastic low level must be below the high level");
  if (s.risk.maxOpenRiskPct < s.risk.riskPerTradePct) errs.push("risk: the open-risk cap must be at least the risk per trade");
  for (const k of PAIR_KEYS) {
    if (s.pairs[k].maxStopPips < s.strategy.stopMinPips) errs.push(`pairs.${k}: the maximum stop (${s.pairs[k].maxStopPips}) is below the minimum stop (${s.strategy.stopMinPips})`);
  }
  for (const key of ["rolloverStart", "rolloverEnd", "fridayCutoff"] as const) {
    if (!HHMM.test(s.session[key])) errs.push(`session.${key}: use HH:MM (New York time)`);
  }
  if (!/^[A-Z]{3}$/.test(s.payout.currency)) errs.push("payout.currency: a 3-letter currency code is required");
  return errs;
}

/**
 * Apply an owner's edit. Only known fields are taken; anything else in the patch is reported back as
 * unknown rather than ignored silently.
 */
export function applySettingsPatch(base: Settings, patch: unknown): { ok: true; settings: Settings } | { ok: false; errors: string[] } {
  const s = clone(base);
  const errs: string[] = [];
  if (!patch || typeof patch !== "object") return { ok: false, errors: ["settings: an object is required"] };
  const p = patch as Record<string, unknown>;

  const section = <K extends "strategy" | "costs" | "risk" | "session" | "data">(name: K) => {
    const src = p[name];
    if (src === undefined) return;
    if (!src || typeof src !== "object") { errs.push(`${name}: an object is required`); return; }
    const target = s[name] as Record<string, unknown>;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (!(k in target)) { errs.push(`${name}.${k}: unknown setting`); continue; }
      const path = `${name}.${k}`;
      if (path === "strategy.tpMode") {
        if (v !== "executable" && v !== "after_fees") errs.push(`${path}: "executable" or "after_fees"`);
        else target[k] = v;
        continue;
      }
      if (path === "costs.confirmed") {
        if (typeof v !== "boolean") errs.push(`${path}: true or false`);
        else target[k] = v;
        continue;
      }
      if (name === "session" && k !== "sundayOpenDelayMin") {
        if (typeof v !== "string" || !HHMM.test(v)) errs.push(`${path}: use HH:MM (New York time)`);
        else target[k] = v;
        continue;
      }
      const r = checkNumber(path, v, path, path === "costs.commissionPerLotPerSide");
      if (!r.ok) errs.push(r.error);
      else target[k] = r.value;
    }
  };
  section("strategy");
  section("costs");
  section("risk");
  section("session");
  section("data");

  if (p.pairs !== undefined) {
    if (!p.pairs || typeof p.pairs !== "object") errs.push("pairs: an object is required");
    else {
      for (const [k, v] of Object.entries(p.pairs as Record<string, unknown>)) {
        if (!(PAIR_KEYS as string[]).includes(k)) { errs.push(`pairs.${k}: not one of the seven pairs`); continue; }
        if (!v || typeof v !== "object") { errs.push(`pairs.${k}: an object is required`); continue; }
        const tgt = s.pairs[k as PairKey];
        for (const [f, val] of Object.entries(v as Record<string, unknown>)) {
          if (f === "enabled") {
            if (typeof val !== "boolean") errs.push(`pairs.${k}.enabled: true or false`);
            else tgt.enabled = val;
          } else if (f === "maxCostPips" || f === "maxStopPips") {
            const r = checkNumber(`pairs.${k}.${f}`, val, `pair.${f}`);
            if (!r.ok) errs.push(r.error);
            else tgt[f] = r.value as number;
          } else errs.push(`pairs.${k}.${f}: unknown setting`);
        }
      }
    }
  }

  if (p.symbolOverrides !== undefined) {
    if (!p.symbolOverrides || typeof p.symbolOverrides !== "object") errs.push("symbolOverrides: an object is required");
    else {
      for (const [k, v] of Object.entries(p.symbolOverrides as Record<string, unknown>)) {
        if (!(PAIR_KEYS as string[]).includes(k)) { errs.push(`symbolOverrides.${k}: not one of the seven pairs`); continue; }
        if (v === null || v === "") delete s.symbolOverrides[k as PairKey];
        else if (typeof v !== "string" || v.length > 40) errs.push(`symbolOverrides.${k}: a broker symbol name is required`);
        else s.symbolOverrides[k as PairKey] = v.trim();
      }
    }
  }

  if (p.payout !== undefined) {
    if (!p.payout || typeof p.payout !== "object") errs.push("payout: an object is required");
    else {
      for (const [k, v] of Object.entries(p.payout as Record<string, unknown>)) {
        if (k === "termsEntered") { if (typeof v !== "boolean") errs.push("payout.termsEntered: true or false"); else s.payout.termsEntered = v; }
        else if (k === "basis") { if (v !== "per_side" && v !== "round_turn") errs.push('payout.basis: "per_side" or "round_turn"'); else s.payout.basis = v; }
        else if (k === "currency") { if (typeof v !== "string") errs.push("payout.currency: text"); else s.payout.currency = v.trim().toUpperCase(); }
        else if (k === "notes") { if (typeof v !== "string" || v.length > 2000) errs.push("payout.notes: text up to 2000 characters"); else s.payout.notes = v; }
        else if (k === "ratePerLot" || k === "minHoldSec") {
          const r = checkNumber(`payout.${k}`, v, `payout.${k}`, true);
          if (!r.ok) errs.push(r.error);
          else (s.payout as Record<string, unknown>)[k] = r.value;
        } else errs.push(`payout.${k}: unknown setting`);
      }
    }
  }

  for (const k of Object.keys(p)) {
    if (!["strategy", "costs", "risk", "session", "data", "pairs", "symbolOverrides", "payout"].includes(k)) errs.push(`${k}: unknown setting`);
  }
  errs.push(...crossCheck(s));
  return errs.length ? { ok: false, errors: errs } : { ok: true, settings: s };
}

/**
 * Read stored settings. Defaults fill anything missing; a stored value that no longer validates is
 * replaced by its default AND reported, so the dashboard can say so instead of trading on it silently.
 */
export function settingsFrom(stored: unknown): { settings: Settings; warnings: string[] } {
  const warnings: string[] = [];
  if (!stored || typeof stored !== "object" || !Object.keys(stored as object).length) return { settings: clone(DEFAULT_SETTINGS), warnings };
  let s = clone(DEFAULT_SETTINGS);
  const src = stored as Record<string, unknown>;
  // Apply section by section so one bad value does not discard the rest.
  for (const key of ["strategy", "costs", "risk", "session", "data", "pairs", "symbolOverrides", "payout"]) {
    if (src[key] === undefined) continue;
    const r = applySettingsPatch(s, { [key]: src[key] });
    if (r.ok) { s = r.settings; continue; }
    // Field by field, keeping what validates.
    const part = src[key];
    if (part && typeof part === "object") {
      for (const [f, v] of Object.entries(part as Record<string, unknown>)) {
        const one = applySettingsPatch(s, { [key]: { [f]: v } });
        if (one.ok) s = one.settings;
        else warnings.push(...one.errors.map((e) => `stored setting ignored — ${e}`));
      }
    } else warnings.push(...r.errors.map((e) => `stored setting ignored — ${e}`));
  }
  return { settings: s, warnings };
}

/** What blocks entries in the settings themselves (shown on the dashboard and checked by the worker). */
export function settingsBlockers(s: Settings): string[] {
  const out: string[] = [];
  if (s.costs.commissionPerLotPerSide == null) out.push("Enter the account's commission per lot (the broker's API does not report it).");
  if (!s.costs.confirmed) out.push("Confirm the account's costs (commission and any other charges).");
  if (!PAIR_KEYS.some((k) => s.pairs[k].enabled)) out.push("Every pair is switched off.");
  return out;
}
