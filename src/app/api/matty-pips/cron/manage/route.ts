import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { getQuote, listPositions, modifyPosition, closePosition, type TLEnv } from "@/lib/flow/tradelocker";
import { getInstrument, pipsToPrice, priceToPips } from "@/lib/matty-pips/pips";
import { normalizeQuantity } from "@/lib/flow/instruments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MATTY PIPS AUTO — position manager (key-gated cron, every minute).
 * Manages ONLY positions in matty_pips_positions (the ones Matty Pips opened):
 *   • breakeven at +be_trigger pips → stop to entry +5 pips in profit
 *   • partial at +partial_trigger pips → close half, LOCK stop +lock_pips
 *   • stops never move backward; every action is recorded.
 * FLOW's manager never sees these rows; this manager never touches FLOW's.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY, secret = process.env.CRON_SECRET;
  const qp = new URL(req.url).searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

type Row = {
  id: string; connection_id: string; account_id: string; acc_num: string; environment: string;
  position_id: string; symbol: string; side: "buy" | "sell";
  entry: number; init_stop: number; cur_stop: number | null; tp1: number | null; tp1_pips: number | null;
  qty: number | null; tid: string | null; route_id: string | null;
  be_enabled: boolean | null; partials_enabled: boolean | null;
  be_trigger: number | null; partial_trigger: number | null; lock_pips: number | null;
  be_done: boolean; partial_done: boolean;
};

function posId(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}

async function run(): Promise<Response> {
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  const nowIso = () => new Date().toISOString();
  const { data } = await admin.from("matty_pips_positions").select("*").eq("status", "open").limit(60);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return json({ ok: true, open: 0 });

  const tokens = new Map<string, { token: string; env: TLEnv } | null>();
  const openSets = new Map<string, Set<string>>();
  const acted: string[] = [];

  for (const r of rows) {
    try {
      let tok = tokens.get(r.connection_id);
      if (tok === undefined) {
        const t = await connectionToken(r.connection_id);
        tok = t.ok ? { token: t.token, env: t.env } : null;
        tokens.set(r.connection_id, tok);
      }
      if (!tok) { await admin.from("matty_pips_positions").update({ last_error: "auth_failed", updated_at: nowIso() }).eq("id", r.id); continue; }

      // Is the position still open? (one broker call per account per pass)
      const setKey = `${r.connection_id}:${r.account_id}`;
      let openIds = openSets.get(setKey);
      if (!openIds) {
        const pp = await listPositions(tok.env, tok.token, r.acc_num, r.account_id);
        if (!pp.ok) continue; // can't read the broker → never guess "closed"
        openIds = new Set(pp.data.map(posId).filter(Boolean));
        openSets.set(setKey, openIds);
      }
      if (!openIds.has(String(r.position_id))) {
        // Closed at the broker (stop, TP, or manual). Resolve the outcome by where it stood.
        await admin.from("matty_pips_positions").update({ status: "closed", outcome: r.be_done ? "closed_after_be" : "closed", resolved_at: nowIso(), updated_at: nowIso() }).eq("id", r.id);
        continue;
      }

      if (!r.tid || !r.route_id) continue;
      const q = await getQuote(tok.env, tok.token, r.acc_num, r.tid, r.route_id);
      if (!q.ok) continue;
      const price = r.side === "buy" ? q.data.bid : q.data.ask; // exit-side price
      if (price == null || !Number.isFinite(price)) continue;

      const meta = getInstrument(r.symbol);
      const profitPips = r.side === "buy" ? priceToPips(r.symbol, Math.max(0, price - r.entry)) : priceToPips(r.symbol, Math.max(0, r.entry - price));
      const inProfit = r.side === "buy" ? price > r.entry : price < r.entry;
      const pip = pipsToPrice(r.symbol, 1);
      const roundPx = (n: number) => +n.toFixed(meta.pricePrecision);
      const stopAheadOf = (a: number, b: number) => (r.side === "buy" ? a > b : a < b); // never move backward
      const cur = r.cur_stop ?? r.init_stop;

      // STEP 1 — breakeven (+5 pips in profit so fees never turn it into a loss).
      const beTrig = r.be_trigger ?? 30;
      if (r.be_enabled !== false && !r.be_done && inProfit && profitPips >= beTrig) {
        const bePx = roundPx(r.side === "buy" ? r.entry + 5 * pip : r.entry - 5 * pip);
        if (stopAheadOf(bePx, cur)) {
          const m = await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: bePx });
          if (m.ok) {
            await admin.from("matty_pips_positions").update({ be_done: true, cur_stop: bePx, updated_at: nowIso() }).eq("id", r.id);
            await admin.from("matty_pips_management_events").insert({ position_id: r.position_id, account_id: r.account_id, kind: "breakeven", detail: { at: price, stop: bePx, profitPips } }).then(() => null, () => null);
            acted.push(`${r.acc_num}:BE`);
            continue;
          }
          await admin.from("matty_pips_positions").update({ last_error: `be: ${m.error}`.slice(0, 180), updated_at: nowIso() }).eq("id", r.id);
        }
      }

      // STEP 2 — partial + LOCK. Half off, stop locks +lock_pips in profit.
      const partTrig = r.partial_trigger ?? (r.tp1_pips ? Math.max(40, Math.round(r.tp1_pips / 2)) : 60);
      if (r.partials_enabled !== false && !r.partial_done && inProfit && profitPips >= partTrig && r.qty && r.qty > 0) {
        const half = normalizeQuantity(r.symbol, r.qty / 2, undefined);
        if (half.ok && half.qty > 0 && half.qty < r.qty) {
          const c = await closePosition(tok.env, tok.token, r.acc_num, r.position_id, half.qty);
          if (c.ok) {
            const lock = r.lock_pips ?? 30;
            const lockPx = roundPx(r.side === "buy" ? r.entry + lock * pip : r.entry - lock * pip);
            const newStop = stopAheadOf(lockPx, cur) ? lockPx : cur;
            if (stopAheadOf(newStop, cur) || newStop !== cur) await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: newStop });
            await admin.from("matty_pips_positions").update({ partial_done: true, qty: +(r.qty - half.qty).toFixed(2), cur_stop: newStop, updated_at: nowIso() }).eq("id", r.id);
            await admin.from("matty_pips_management_events").insert({ position_id: r.position_id, account_id: r.account_id, kind: "partial_lock", detail: { at: price, closed: half.qty, stop: newStop, profitPips } }).then(() => null, () => null);
            acted.push(`${r.acc_num}:PARTIAL`);
            continue;
          }
          await admin.from("matty_pips_positions").update({ last_error: `partial: ${c.error}`.slice(0, 180), updated_at: nowIso() }).eq("id", r.id);
        } else if (!r.partial_done) {
          // Position too small to split — lock profit instead of partialing.
          const lock = r.lock_pips ?? 30;
          const lockPx = roundPx(r.side === "buy" ? r.entry + lock * pip : r.entry - lock * pip);
          if (stopAheadOf(lockPx, cur)) {
            const m = await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: lockPx });
            if (m.ok) {
              await admin.from("matty_pips_positions").update({ partial_done: true, cur_stop: lockPx, updated_at: nowIso() }).eq("id", r.id);
              acted.push(`${r.acc_num}:LOCK`);
            }
          }
        }
      }

      await admin.from("matty_pips_positions").update({ updated_at: nowIso() }).eq("id", r.id);
    } catch { /* per-position best-effort */ }
  }
  return json({ ok: true, open: rows.length, acted });
}

export async function GET(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
export async function POST(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
