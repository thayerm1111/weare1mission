import { hasPlay } from "@/lib/setupLock";

/**
 * IS THIS READ ONE THE MEMBER PAYS FOR? (A GENX or GEN FX read: 5 credits, free on the FLOW Pass.)
 *
 * A read has always been charged when the engine found something to act on or to watch. It was free
 * when the engine's verdict was NO TRADE — but the engine still draws a plan on those reads whenever
 * it has a support and a resistance to work from: a range plan with an entry, a stop and targets,
 * and the desk trades it (zoneSetups.ts). That same plan takes credits to view everywhere else on
 * the site (setupLock.ts). A free read that hands it over was the one way left to see a play for
 * nothing: about a third of the week's GENX reads (owner 10-06).
 *
 * So a read is charged when the engine found a setup OR the read carries a plan at all. A read with
 * no plan in it — not enough data, no levels to trade from — is still free: there is nothing in it
 * to pay for.
 */
const FOUND = new Set(["TRADE_READY", "DEVELOPING_SETUP", "WATCHLIST"]);

export function chargedRead(state: unknown, read: unknown): boolean {
  return FOUND.has(String(state)) || hasPlay(read);
}

/* ── MFX Ghost: the same engine, returned raw ─────────────────────────────────────────────────── */

const num = (v: unknown): boolean =>
  (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
/** An entry, a stop, a target or a zone as the raw read writes it: an object with a price or a zone in it. */
const priced = (o: unknown): boolean => {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return num(r.price) || num(r.zone_low) || num(r.zone_high);
};
const anyPriced = (list: unknown): boolean => Array.isArray(list) && list.some(priced);

/**
 * The same question of a RAW engine read (omEngine.runEngine, as MFX Ghost returns it), before it is
 * laid out for a page. Its plan sits in objects rather than flat fields — entry {price, zone_low,
 * zone_high}, stop_loss {price}, take_profits [{price}], the same again under provisional_trade, and
 * a setup zone. And when the engine has no setup of its own it still returns the support and the
 * resistance that the range plan is drawn from: on The Floor's card those two numbers ARE the entry
 * and the far target, so a read that hands them over has handed over the plan.
 */
export function engineReadHasPlan(read: unknown): boolean {
  if (!read || typeof read !== "object") return false;
  const r = read as Record<string, unknown>;
  if (priced(r.entry) || priced(r.stop_loss) || anyPriced(r.take_profits) || priced(r.setup_zone)) return true;
  const pt = r.provisional_trade;
  if (pt && typeof pt === "object") {
    const t = pt as Record<string, unknown>;
    if (priced(t.entry) || priced(t.stop_loss) || anyPriced(t.take_profits)) return true;
  }
  const lv = r.levels;
  return !!lv && typeof lv === "object" && num((lv as Record<string, unknown>).support) && num((lv as Record<string, unknown>).resistance);
}

/**
 * IS THIS MFX GHOST READ ONE THE MEMBER PAYS FOR? (5 credits, the "ghost" feature.) Ghost runs the
 * engine GENX runs, on gold and on the pairs, and returns everything it found. It used to be charged
 * only on a trade or a developing setup; a watchlist or no-trade read was free and still carried the
 * provisional trade, the setup zone, or the two levels of the range plan — the play The Floor's card
 * keeps back, for nothing (owner 10-06). Now: charged on a trade or a developing setup, as before, OR
 * whenever the read carries a plan. A read with nothing in it to trade from is still free.
 */
export function chargedGhostRead(state: unknown, read: unknown): boolean {
  return state === "TRADE_READY" || state === "DEVELOPING_SETUP" || engineReadHasPlan(read);
}

