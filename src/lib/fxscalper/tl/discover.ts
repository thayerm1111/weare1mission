import { PAIRS, type PairKey } from "../pairs";
import type { InstrumentSpec } from "../plan";
import type { InstrumentRow } from "./api";

/**
 * FIND THE SEVEN PAIRS ON THE CONNECTED ACCOUNT, by the account's own instrument list — never a
 * hard-coded symbol or id.
 *
 * A name matches a pair when, letters and digits only, it starts with the pair (EURUSD, EURUSD.r,
 * EURUSDm, #EURUSD …). One match → that one. Several → the plain name if exactly one is plain;
 * otherwise the pair is BLOCKED with the candidates listed, because "EURUSD" and "EURUSD.raw" are
 * usually different contracts with different spreads and commissions, and choosing between them is
 * a decision about money that a regex should not make. The owner picks one in the settings.
 *
 * The contract details then have to make sense for a currency pair before the pair can trade: a lot
 * size, a lot step and minimum, a tick no coarser than a pip, a bar source, the quoting currency the
 * pair implies, routes for quotes and for orders, and a leverage to estimate margin from.
 */

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function resolveSymbol(rows: InstrumentRow[], pair: PairKey, override?: string | null):
  { ok: true; row: InstrumentRow; candidates: string[] } | { ok: false; reason: string; candidates: string[] } {
  const candidates = rows.filter((r) => {
    const n = norm(r.name);
    return n.startsWith(pair) && n.length - pair.length <= 8;
  });
  const names = candidates.map((r) => r.name);
  if (override) {
    const hit = rows.filter((r) => r.name.toUpperCase() === override.toUpperCase());
    if (hit.length === 1) return { ok: true, row: hit[0], candidates: names };
    return { ok: false, reason: `The chosen symbol "${override}" is not on this account.`, candidates: names };
  }
  if (candidates.length === 1) return { ok: true, row: candidates[0], candidates: names };
  if (!candidates.length) return { ok: false, reason: `No ${pair} instrument on this account.`, candidates: [] };
  const plain = candidates.filter((r) => norm(r.name) === pair);
  if (plain.length === 1) return { ok: true, row: plain[0], candidates: names };
  return { ok: false, reason: `${candidates.length} instruments could be ${pair} (${names.join(", ")}); choose one in the settings.`, candidates: names };
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** TradeLocker publishes tick size/cost as price-banded tiers: [{ leftRangeLimit, value }]. The base band applies. */
export function tiered(v: unknown): number | null {
  if (Array.isArray(v)) {
    const rows = v as Array<Record<string, unknown>>;
    const base = rows.find((r) => r && (r.leftRangeLimit == null || Number(r.leftRangeLimit) === 0)) ?? rows[0];
    if (!base) return null;
    const n = num(base.value ?? base.tickSize ?? base.tickCost);
    return n != null && n > 0 ? n : null;
  }
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

const decimalsOf = (step: number): number => {
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return (s.split(".")[1] ?? "").length;
};

export function specFrom(pair: PairKey, row: InstrumentRow, details: Record<string, unknown>, infoRouteId: string | null):
  { ok: true; spec: InstrumentSpec; notes: string[] } | { ok: false; problems: string[]; partial: Partial<InstrumentSpec> } {
  const p = PAIRS[pair];
  const problems: string[] = [];
  const notes: string[] = [];
  const lotSize = num(details.lotSize ?? row.raw.lotSize);
  const lotStep = num(details.lotStep ?? row.raw.lotStep);
  const minLot = num(details.minLot ?? row.raw.minLot);
  const maxLot = num(details.maxLot ?? row.raw.maxLot);
  const tickSize = tiered(details.tickSize ?? row.raw.tickSize);
  const barSource = String(details.barSource ?? row.barSource ?? "").toUpperCase();
  const quoting = String(details.quotingCurrency ?? row.raw.quotingCurrency ?? "").toUpperCase() || null;
  const baseCcy = String(details.baseCurrency ?? row.raw.baseCurrency ?? "").toUpperCase() || null;
  const leverage = num(details.leverage ?? row.raw.leverage);

  if (lotSize == null || !(lotSize > 0)) problems.push("no lot size (units per lot)");
  else if (lotSize < 1000 || lotSize > 10_000_000) problems.push(`unusual lot size for a currency pair: ${lotSize} units`);
  if (lotStep == null || !(lotStep > 0)) problems.push("no lot step");
  if (minLot == null || !(minLot > 0)) problems.push("no minimum lot");
  if (maxLot == null || !(maxLot > 0)) problems.push("no maximum lot");
  else if (minLot != null && maxLot < minLot) problems.push("the maximum lot is below the minimum");
  if (tickSize == null) problems.push("no tick size");
  else if (tickSize > p.pip + 1e-12) problems.push(`the tick (${tickSize}) is coarser than a pip (${p.pip})`);
  else if (Math.abs(p.pip / tickSize - Math.round(p.pip / tickSize)) > 1e-6) problems.push(`the tick (${tickSize}) does not divide a pip (${p.pip})`);
  if (!["BID", "ASK", "TRADE"].includes(barSource)) problems.push(`unknown candle source "${barSource || "none"}"`);
  if (quoting && quoting !== p.quote) problems.push(`the instrument is quoted in ${quoting}, not ${p.quote}`);
  if (!quoting) notes.push(`The broker did not state the quoting currency; ${p.quote} is implied by the pair.`);
  if (baseCcy && baseCcy !== p.base) problems.push(`the instrument's base currency is ${baseCcy}, not ${p.base}`);
  if (!row.tradeRouteId) problems.push("no TRADE route for orders");
  if (!infoRouteId) problems.push("no working INFO route for quotes");
  if (leverage == null || !(leverage > 0)) problems.push("no leverage in the contract details (margin cannot be estimated)");
  const status = String(details.symbolStatus ?? "").toUpperCase();
  if (barSource === "TRADE") notes.push("Candles are built from trades; the quote's mid price is used to check how far price has moved since the signal.");

  const partial: Partial<InstrumentSpec> = {
    pair, brokerSymbol: row.name, tradableInstrumentId: row.tradableInstrumentId, tradeRouteId: row.tradeRouteId ?? undefined,
    infoRouteId: infoRouteId ?? undefined, lotSize: lotSize ?? undefined, lotStep: lotStep ?? undefined, minLot: minLot ?? undefined,
    maxLot: maxLot ?? undefined, tickSize: tickSize ?? undefined, pipSize: p.pip, quote: quoting ?? p.quote, base: baseCcy ?? p.base,
    leverage, barSource: (["BID", "ASK", "TRADE"].includes(barSource) ? barSource : undefined) as InstrumentSpec["barSource"] | undefined,
  };
  if (problems.length) return { ok: false, problems, partial };
  if (status && status !== "FULLY_OPEN") notes.push(`The broker reports the symbol as ${status}.`);
  return {
    ok: true,
    notes,
    spec: {
      pair, brokerSymbol: row.name, tradableInstrumentId: row.tradableInstrumentId, tradeRouteId: row.tradeRouteId!,
      infoRouteId: infoRouteId!, lotSize: lotSize!, lotStep: lotStep!, minLot: minLot!, maxLot: maxLot!, tickSize: tickSize!,
      pipSize: p.pip, decimals: decimalsOf(tickSize!), barSource: barSource as InstrumentSpec["barSource"],
      quote: quoting ?? p.quote, base: baseCcy ?? p.base, leverage,
    },
  };
}
