import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { isCashtrapSymbol, roundPrice } from "@/lib/cashtrap/symbols";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual support/resistance zones (admin). A zone is used from the moment it is marked — never on
 * earlier candles — and "removing" one ends it (active_until) rather than deleting it, so the history
 * of what was in force stays intact.
 */
export async function GET(req: NextRequest) {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const symbol = new URL(req.url).searchParams.get("symbol");
  let q = a.db.from("cashtrap_zones").select("*").eq("origin", "manual").order("created_at", { ascending: false }).limit(200);
  if (symbol && isCashtrapSymbol(symbol)) q = q.eq("symbol", symbol);
  const r = await q;
  return json({ zones: r.data ?? [] });
}

export async function POST(req: NextRequest) {
  const a = await cashtrapAccess({ admin: true });
  if (!a.ok) return json({ error: a.error }, a.status);
  const b = (await req.json().catch(() => ({}))) as { symbol?: string; kind?: string; lower?: number; upper?: number; note?: string };
  if (!isCashtrapSymbol(b.symbol)) return json({ error: "symbol: USDJPY, EURUSD, XAUUSD or GBPJPY" }, 400);
  if (b.kind !== "support" && b.kind !== "resistance") return json({ error: "kind: support or resistance" }, 400);
  const lo = Number(b.lower), hi = Number(b.upper);
  if (!(lo > 0 && hi > 0 && hi > lo)) return json({ error: "lower and upper: positive prices, upper above lower" }, 400);
  const now = new Date().toISOString();
  const row = {
    id: `manual:${b.symbol}:${randomUUID()}`, symbol: b.symbol, kind: b.kind, origin: "manual",
    lower: roundPrice(b.symbol, lo), upper: roundPrice(b.symbol, hi), center: roundPrice(b.symbol, (lo + hi) / 2),
    created_at: now, confirmed_at: now, active_from: now, note: (b.note ?? "").slice(0, 200) || null, created_by: a.userId,
  };
  const r = await a.db.from("cashtrap_zones").insert(row).select("*");
  if (r.error) return json({ error: r.error.message }, 500);
  return json({ zone: (r.data ?? [])[0] });
}

export async function DELETE(req: NextRequest) {
  const a = await cashtrapAccess({ admin: true });
  if (!a.ok) return json({ error: a.error }, a.status);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id.startsWith("manual:")) return json({ error: "only manual zones can be removed" }, 400);
  const r = await a.db.from("cashtrap_zones").update({ active_until: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).is("active_until", null).select("id");
  return json({ ended: (r.data ?? []).length });
}
