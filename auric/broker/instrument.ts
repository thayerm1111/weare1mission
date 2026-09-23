import type { InstrumentSpec } from "../core/types";
import { getInstrumentDetails, listInstruments, type TLAuth, type TLInstrumentRow } from "./tradelocker";

/** Deep numeric pick with alias list; searches nested objects (details, tradingRules, ...). */
function deepPickNum(o: unknown, keys: string[], depth = 0): number | null {
  if (!o || typeof o !== "object" || depth > 3) return null;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k]; if (v != null && v !== "" && Number.isFinite(Number(v))) return Number(v);
    // TradeLocker publishes price-range tables: tickSize: [{ tickSize, leftRangeLimit }], tickCost: [{ tickCost, leftRangeLimit }].
    // Use the base range (leftRangeLimit null/0 → first entry); a positive value only.
    if (Array.isArray(v) && v.length) {
      const base = v.find((e) => e && typeof e === "object" && ((e as Record<string, unknown>).leftRangeLimit == null || Number((e as Record<string, unknown>).leftRangeLimit) === 0)) ?? v[0];
      const inner = base && typeof base === "object" ? (base as Record<string, unknown>)[k] : base;
      if (inner != null && inner !== "" && Number.isFinite(Number(inner))) return Number(inner);
    }
  }
  for (const v of Object.values(rec)) { if (v && typeof v === "object" && !Array.isArray(v)) { const r = deepPickNum(v, keys, depth + 1); if (r != null) return r; } }
  return null;
}
function deepPickStr(o: unknown, keys: string[], depth = 0): string | null {
  if (!o || typeof o !== "object" || depth > 3) return null;
  const rec = o as Record<string, unknown>;
  for (const k of keys) { const v = rec[k]; if (typeof v === "string" && v) return v; }
  for (const v of Object.values(rec)) { if (v && typeof v === "object" && !Array.isArray(v)) { const r = deepPickStr(v, keys, depth + 1); if (r != null) return r; } }
  return null;
}

/** Gold instrument by narrow name match. Refuses ambiguity. */
export function findGold(rows: TLInstrumentRow[]): { row: TLInstrumentRow; tradeRouteId: string; infoRouteId: string } | { error: string } {
  const isGold = (n: string) => /^(XAU\/?USD|GOLD)(\.[a-z0-9]+|[_-]?(cfd|spot|std|raw|pro|ecn|\.?[a-z]{1,3}))?$/i.test(n.trim());
  const c = rows.filter((r) => isGold(r.name));
  if (!c.length) return { error: `no XAUUSD instrument on this account (${rows.length} instruments listed)` };
  if (c.length > 1) return { error: `ambiguous gold instruments: ${c.map((r) => r.name).join(", ")}` };
  const row = c[0];
  const trade = row.routes.find((r) => r.type.toUpperCase() === "TRADE"), info = row.routes.find((r) => r.type.toUpperCase() === "INFO");
  if (!trade) return { error: `instrument ${row.name} has no TRADE route` };
  return { row, tradeRouteId: trade.id, infoRouteId: (info ?? trade).id };
}

/**
 * Parse the broker's instrument detail payload. `lotSize` is ambiguous across brokers (units per lot vs
 * quantity step); it is promoted to contract size ONLY when an explicit different step is also present.
 * Missing specs stay null and sizing refuses — a wrong contract size costs an account.
 */
export function parseSpec(payload: unknown, base: { tradableInstrumentId: string; tradeRouteId: string; infoRouteId: string; name: string }): InstrumentSpec {
  const d = (payload as { d?: unknown })?.d ?? payload;
  const row = Array.isArray(d) ? d[0] : d;
  const g = (keys: string[]) => deepPickNum(row, keys);
  const explicitStep = g(["lotStep", "quantityStep", "volumeStep", "lotSizeStep", "stepQuantity", "qtyStep"]);
  const lotSizeField = g(["lotSize", "lot_size"]);
  const statedContract = g(["contractSize", "contract_size", "unitsPerLot", "contractMultiplier"]);
  const contractSize = statedContract ?? (explicitStep != null && lotSizeField != null && lotSizeField !== explicitStep ? lotSizeField : null);
  const tickSize = g(["tickSize", "tick_size", "minPriceIncrement", "priceIncrement", "priceStep"]);
  const tv = g(["tickValue", "tick_value", "valuePerTick", "tickCost"]);
  return {
    tradableInstrumentId: base.tradableInstrumentId, tradeRouteId: base.tradeRouteId, infoRouteId: base.infoRouteId, name: base.name,
    contractSize, lotStep: explicitStep ?? lotSizeField,
    minLot: g(["minLot", "minQty", "minVolume", "minLotSize", "minQuantity", "minOrderQuantity"]),
    maxLot: g(["maxLot", "maxQty", "maxVolume", "maxLotSize", "maxQuantity", "maxOrderQuantity"]),
    tickSize, tickValue: tv != null && tv > 0 ? tv : null,
    priceDecimals: g(["pricePrecision", "priceDecimals", "decimals", "digits"]),
    currency: deepPickStr(row, ["quotingCurrency", "profitCurrency", "marginCurrency", "currency", "quoteCurrency"]),
    minStopDistance: g(["stopLevel", "minStopDistance", "stopsLevel", "minStopLevel", "freezeLevel"]),
    raw: row,
  };
}

export async function discoverGold(a: TLAuth): Promise<{ ok: true; spec: InstrumentSpec; missing: string[] } | { ok: false; error: string }> {
  const li = await listInstruments(a);
  if (!li.ok) return { ok: false, error: `instruments: ${li.error}` };
  const f = findGold(li.data);
  if ("error" in f) return { ok: false, error: f.error };
  const det = await getInstrumentDetails(a, f.row.tradableInstrumentId, f.infoRouteId);
  const spec = parseSpec(det.ok ? det.data : f.row.raw, { tradableInstrumentId: f.row.tradableInstrumentId, tradeRouteId: f.tradeRouteId, infoRouteId: f.infoRouteId, name: f.row.name });
  const missing = missingFields(spec);
  // A failed/rate-limited details call with a thin list row is a transient failure, not a specification:
  // report it as such so the caller keeps whatever complete spec it already has and retries later.
  if (!det.ok && missing.length) return { ok: false, error: `details: ${det.error}` };
  if (spec.priceDecimals == null && spec.tickSize != null) spec.priceDecimals = Math.max(0, Math.round(-Math.log10(spec.tickSize)));
  return { ok: true, spec, missing };
}

/** Which sizing-critical fields a spec lacks. Empty means the spec is complete enough to size with. */
export function missingFields(spec: InstrumentSpec): string[] {
  const missing: string[] = [];
  if (spec.tickSize == null) missing.push("tickSize");
  if (spec.lotStep == null) missing.push("lotStep");
  if (spec.minLot == null) missing.push("minLot");
  if (spec.contractSize == null && spec.tickValue == null) missing.push("contractSize/tickValue");
  return missing;
}
