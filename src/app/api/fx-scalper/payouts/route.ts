import { body, json, requireOwner } from "../_shared";
import { addEvent } from "@/lib/fxscalper/store";

export const dynamic = "force-dynamic";

/**
 * Record compensation the broker actually reported or paid under the owner's Genesis agreement — from a
 * statement import or a manual entry. There is no compensation API; nothing here is fetched or invented.
 *
 * CSV import: one line per entry, header optional:
 *   date,kind,amount,currency,lots,reference,paid_into_account
 *   2026-10-31,paid,125.40,USD,62.7,Statement Oct 2026,false
 * kind is confirmed | paid | reversal.
 */
type Entry = { period_start: string | null; period_end: string | null; kind: string; amount: number; currency: string; lots: number | null; paid_into_account: boolean; reference: string | null; note: string | null; source: "statement_import" | "manual"; raw: unknown };

const KINDS = new Set(["confirmed", "paid", "reversal"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseCsv(text: string): { entries: Entry[]; errors: string[] } {
  const entries: Entry[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    if (i === 0 && /date/i.test(cells[0] ?? "") && /kind/i.test(cells[1] ?? "")) return;
    const [date, kind, amount, currency, lots, reference, paid] = cells;
    const amt = Number(amount);
    if (!DATE.test(date ?? "")) { errors.push(`line ${i + 1}: date must be YYYY-MM-DD`); return; }
    if (!KINDS.has((kind ?? "").toLowerCase())) { errors.push(`line ${i + 1}: kind must be confirmed, paid or reversal`); return; }
    if (!Number.isFinite(amt) || amt < 0) { errors.push(`line ${i + 1}: amount must be a positive number`); return; }
    entries.push({
      period_start: date, period_end: date, kind: kind.toLowerCase(), amount: amt, currency: (currency || "USD").toUpperCase().slice(0, 3),
      lots: lots ? Number(lots) : null, paid_into_account: /^(true|yes|1)$/i.test(paid ?? ""), reference: reference || null, note: null, source: "statement_import", raw: line,
    });
  });
  return { entries, errors };
}

export async function POST(req: Request) {
  const a = await requireOwner();
  if ("error" in a) return a.error;
  const b = await body(req);
  let entries: Entry[] = [];
  if (typeof b.csv === "string") {
    const p = parseCsv(b.csv);
    if (p.errors.length) return json({ error: "Some lines were not accepted.", errors: p.errors }, 400);
    entries = p.entries;
  } else {
    const kind = String(b.kind ?? "").toLowerCase();
    const amount = Number(b.amount);
    if (!KINDS.has(kind)) return json({ error: "kind must be confirmed, paid or reversal" }, 400);
    if (!Number.isFinite(amount) || amount < 0) return json({ error: "amount must be a positive number" }, 400);
    const ps = b.periodStart ? String(b.periodStart) : null;
    const pe = b.periodEnd ? String(b.periodEnd) : ps;
    if ((ps && !DATE.test(ps)) || (pe && !DATE.test(pe))) return json({ error: "dates must be YYYY-MM-DD" }, 400);
    entries = [{
      period_start: ps, period_end: pe, kind, amount, currency: String(b.currency ?? "USD").toUpperCase().slice(0, 3), lots: b.lots == null || b.lots === "" ? null : Number(b.lots),
      paid_into_account: b.paidIntoAccount === true, reference: b.reference ? String(b.reference).slice(0, 200) : null, note: b.note ? String(b.note).slice(0, 1000) : null,
      source: "manual", raw: null,
    }];
  }
  if (!entries.length) return json({ error: "Nothing to record." }, 400);
  const { error } = await a.db.from("fx_scalper_compensation").insert(entries.map((e) => ({ ...e, created_by: a.user.id })));
  if (error) return json({ error: error.message }, 500);
  await addEvent(a.db, { kind: "compensation_recorded", message: `Owner recorded ${entries.length} compensation entr${entries.length === 1 ? "y" : "ies"} (${entries.map((e) => `${e.kind} ${e.amount} ${e.currency}`).join(", ")}).` });
  return json({ ok: true, count: entries.length });
}
