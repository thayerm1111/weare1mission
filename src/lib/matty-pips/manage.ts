import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { getQuote, listPositions, listInstruments, modifyPosition, closePosition, type TLEnv } from "@/lib/flow/tradelocker";
import { getInstrument, pipsToPrice, priceToPips } from "@/lib/matty-pips/pips";
import { normalizeQuantity } from "@/lib/flow/instruments";
import { liveTickExtremes } from "@/lib/flow/liveTicks";
import { matchInstrument } from "@/lib/flow/executor";
import { pickOrphanMatch, positionCols, normalizePos, type OrphanWant } from "@/lib/flow/recover";

/**
 * MATTY PIPS AUTO — position manager (shared by the minutely cron AND the always-on
 * worker; owner 09-11: "Matty pips AI is not getting managed. It didn't move to
 * breakeven").
 *
 * WHAT WAS WRONG: the old manager point-sampled the live price once a minute and
 * compared THAT instant against the break-even trigger. A trade that spiked +100 pips
 * between samples and pulled back read as "+27, not yet" forever — the exact wick-miss
 * FLOW's manager fixed long ago. This version fixes it the same two ways:
 *
 *   • FAVORABLE-EXCURSION MEMORY — per position, the best exit-side price seen is
 *     tracked (live quote each pass + tick-level highs/lows from the WebSocket stream
 *     since entry). Triggers fire on the best the trade REACHED, not where one sample
 *     happens to land. Safety: the stop only moves when the LIVE price still sits
 *     safely beyond the new stop (+2 pips), so a dead pullback is never scratched out.
 *   • WORKER CADENCE — the worker calls this every few seconds; the minutely Vercel
 *     cron stands down while the worker's heartbeat is fresh and takes over only if
 *     the worker dies (same failover pattern as FLOW).
 *
 * Manages ONLY matty_pips_positions rows; FLOW's manager never sees these and vice versa.
 */

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

type Row = {
  id: string; connection_id: string; account_id: string; acc_num: string; environment: string;
  position_id: string; symbol: string; side: "buy" | "sell";
  entry: number; init_stop: number; cur_stop: number | null; tp1: number | null; tp1_pips: number | null;
  qty: number | null; tid: string | null; route_id: string | null;
  be_enabled: boolean | null; partials_enabled: boolean | null;
  be_trigger: number | null; partial_trigger: number | null; lock_pips: number | null;
  be_done: boolean; partial_done: boolean;
  created_at?: string | null;
  best_price?: number | null;
};

// DEEP CANDLE BACKFILL (owner 09-11, the 02:25 wave: 26 positions spiked +120 pips
// BEFORE the excursion manager deployed, so its from-scratch memory never saw the move
// and BE stayed unfired). For a position with no persisted best_price yet, fetch up to
// ~5h of 1-min candles ONCE and fold the true high/low since entry. After that the
// persisted best_price + live ticks carry the history across any restart — full parity
// with FLOW's manager. Cached per symbol (60s) so 26 gold rows cost ~1 call a minute.
const candleCache = new Map<string, { at: number; bars: Array<{ t: number; high: number; low: number }> }>();
async function candleExtremesSince(td: string, sinceMs: number): Promise<{ high: number; low: number } | null> {
  try {
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    let entry = candleCache.get(td);
    if (!entry || Date.now() - entry.at > 60_000) {
      const bars: Array<{ t: number; high: number; low: number }> = [];
      const need = Math.min(330, Math.max(20, Math.ceil((Date.now() - sinceMs) / 60_000) + 3));
      const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=1min&outputsize=${need}&apikey=${key}`, { cache: "no-store" });
      const j = (await r.json()) as { values?: Array<{ datetime?: unknown; high?: unknown; low?: unknown }> };
      for (const v of (Array.isArray(j?.values) ? j.values : [])) {
        const h = Number(v.high), l = Number(v.low);
        const t = Date.parse(String(v.datetime ?? "").replace(" ", "T") + "Z");
        if (Number.isFinite(h) && h > 0 && Number.isFinite(l) && l > 0 && Number.isFinite(t)) bars.push({ t, high: h, low: l });
      }
      entry = { at: Date.now(), bars };
      candleCache.set(td, entry);
    }
    let hi = 0, lo = Infinity;
    for (const b of entry.bars) { if (b.t >= sinceMs) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); } }
    return hi > 0 && Number.isFinite(lo) ? { high: hi, low: lo } : null;
  } catch { return null; }
}

function posId(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}

// Favorable-excursion memory: position_id → best exit-side price seen. Long-lived in the
// worker (where it matters); a fresh cron invocation simply starts from the current
// quote + the stream's recent tick window — never worse than the old behavior.
const bestSeen = new Map<string, number>();

// ── MATTY ORPHAN RECOVERY (owner 09-11: "trades are still not going to break even") ──
// ROOT CAUSE FOUND: placeForAccount waited only ~2.4s to learn the new position's id
// from the broker; on a slow fill it gave up ("placed_no_position_id") and NEVER
// created the matty_pips_positions row — a live broker position with NO manager row,
// invisible forever. This sweep adopts them: for recent 'placed' trades with no
// position id, it asks the broker what's open on that account and matches on
// instrument + side + quantity (stop disambiguates; ambiguity → skip, never guess) —
// the same battle-tested matcher FLOW's orphan recovery uses.
const ORPHAN_EVERY_MS = 20_000;
let lastOrphanScanMs = 0;
async function recoverMattyOrphans(admin: Admin): Promise<number> {
  const sinceIso = new Date(Date.now() - 12 * 3600e3).toISOString();
  const { data } = await admin.from("matty_pips_trades")
    .select("id, user_id, account_id, acc_num, connection_id, symbol, direction, entry, stop, tp1, qty, created_at")
    .eq("status", "placed").is("position_id", null).gte("created_at", sinceIso).limit(20);
  const trades = (data ?? []) as Array<{ id: string; user_id: string | null; account_id: string; acc_num: string; connection_id: string; symbol: string; direction: "buy" | "sell"; entry: number | null; stop: number | null; tp1: number | null; qty: number | null; created_at: string }>;
  if (!trades.length) return 0;
  let adopted = 0;
  for (const tr of trades) {
    try {
      const tok = await connectionToken(tr.connection_id);
      if (!tok.ok) continue;
      const pp = await listPositions(tok.env, tok.token, tr.acc_num, tr.account_id);
      if (!pp.ok) continue;
      const li = await listInstruments(tok.env, tok.token, tr.acc_num, tr.account_id);
      if (!li.ok) continue;
      const inst = matchInstrument(tr.symbol, li.data);
      if (!inst) continue;
      const cols = await positionCols(tok.env, tok.token, tr.acc_num);
      const bposs = pp.data.map((p) => normalizePos(p, cols)).filter((p) => p.positionId);
      const { data: trackedRows } = await admin.from("matty_pips_positions").select("position_id").eq("account_id", tr.account_id);
      const tracked = new Set(((trackedRows ?? []) as { position_id: string | null }[]).map((r) => String(r.position_id ?? "")));
      const want: OrphanWant = { instrId: String(inst.tradableInstrumentId), side: tr.direction, qty: Number(tr.qty) || 0, stop: tr.stop != null ? Number(tr.stop) : null };
      const match = pickOrphanMatch(bposs, want, tracked);
      if (!match) continue;
      const entry = match.avg != null && match.avg > 0 ? match.avg : (tr.entry != null ? Number(tr.entry) : null);
      const sl = match.sl != null ? match.sl : (tr.stop != null ? Number(tr.stop) : null);
      if (entry == null || sl == null) continue; // cannot manage without a real entry + stop
      const tp = match.tp != null ? match.tp : (tr.tp1 != null ? Number(tr.tp1) : null);
      // Account prefs (best-effort — defaults keep management ON).
      let beOn: boolean | null = null, partOn: boolean | null = null;
      try {
        const { data: acct } = await admin.from("matty_pips_accounts").select("be_enabled, partials_enabled").eq("account_id", tr.account_id).maybeSingle();
        const a = (acct ?? null) as { be_enabled?: boolean | null; partials_enabled?: boolean | null } | null;
        beOn = a?.be_enabled ?? null; partOn = a?.partials_enabled ?? null;
      } catch { /* prefs optional */ }
      const ins = await admin.from("matty_pips_positions").insert({
        user_id: tr.user_id, connection_id: tr.connection_id, account_id: tr.account_id, acc_num: tr.acc_num,
        environment: tok.env, position_id: match.positionId, symbol: tr.symbol, side: tr.direction,
        entry, init_stop: sl, cur_stop: sl, tp1: tp,
        tp1_pips: tp != null ? Math.round(priceToPips(tr.symbol, Math.abs(tp - entry))) : null,
        qty: match.qty, tid: String(inst.tradableInstrumentId), route_id: String(inst.routeId),
        be_enabled: beOn, partials_enabled: partOn,
        status: "open",
      });
      if (!ins.error) {
        adopted += 1;
        await admin.from("matty_pips_trades").update({ position_id: match.positionId, updated_at: new Date().toISOString() }).eq("id", tr.id);
        await admin.from("matty_pips_management_events").insert({ position_id: match.positionId, account_id: tr.account_id, kind: "orphan_adopted", detail: { entry, stop: sl, tp, qty: match.qty } }).then(() => null, () => null);
      }
    } catch { /* per-trade best-effort */ }
  }
  return adopted;
}

export async function manageMattyPips(): Promise<{ ok: boolean; open?: number; acted?: string[]; error?: string }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, error: "not_configured" };
  const nowIso = () => new Date().toISOString();
  if (Date.now() - lastOrphanScanMs > ORPHAN_EVERY_MS) {
    lastOrphanScanMs = Date.now();
    try { await recoverMattyOrphans(admin); } catch { /* recovery is best-effort */ }
  }
  const { data } = await admin.from("matty_pips_positions").select("*").eq("status", "open").order("updated_at", { ascending: true }).limit(60);
  const rows = (data ?? []) as Row[];
  if (!rows.length) { bestSeen.clear(); return { ok: true, open: 0 }; }

  const tokens = new Map<string, { token: string; env: TLEnv } | null>();
  const openSets = new Map<string, Set<string>>();
  // ONE quote per (env, instrument) per pass — 25+ gold rows used to each fetch their own
  // quote every 15s, which is pure duplicate load on the broker edge (the 09-11 1015-storm
  // lesson: every saved call is headroom). Bid/ask both kept so each side reads its own.
  const quoteCache = new Map<string, { bid: number | null; ask: number | null } | null>();
  const acted: string[] = [];
  const liveIds = new Set(rows.map((r) => String(r.position_id)));
  for (const k of bestSeen.keys()) if (!liveIds.has(k)) bestSeen.delete(k); // closed → forget

  // FAVOR GENX ALWAYS (owner 09-11): if GENX/FLOW opened an OPPOSITE-side gold position on
  // an account where Matty already holds gold, that is the buy+sell hedge the owner hit —
  // Matty flattens its own leg so GENX's trade runs alone. Same-direction coexistence is
  // left alone (both engines agree — not a hedge). One read for the whole book this pass.
  const flowGoldByAcct = new Map<string, Set<string>>(); // account_id -> open FLOW/GENX gold sides
  try {
    const acctIds = [...new Set(rows.map((r) => String(r.account_id)))];
    if (acctIds.length) {
      const { data: fg } = await admin.from("flow_managed_positions")
        .select("account_id, side").eq("status", "open").in("symbol", ["XAUUSD", "GOLD"]).in("account_id", acctIds);
      for (const fr of (fg ?? []) as { account_id: string | null; side: string | null }[]) {
        const aid = String(fr.account_id ?? ""); const sd = String(fr.side ?? "");
        if (!aid || !sd) continue;
        if (!flowGoldByAcct.has(aid)) flowGoldByAcct.set(aid, new Set());
        flowGoldByAcct.get(aid)!.add(sd);
      }
    }
  } catch { /* read blip → no forced yields this pass (safe: just skips the flatten) */ }

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
        bestSeen.delete(String(r.position_id));
        continue;
      }

      if (!r.tid || !r.route_id) {
        // Never skip silently — a row with no quote route can't be managed and must say so.
        await admin.from("matty_pips_positions").update({ last_error: "no_route_meta (tid/route_id missing)", updated_at: nowIso() }).eq("id", r.id);
        continue;
      }
      const qKey = `${tok.env}|${r.tid}`;
      let quote = quoteCache.get(qKey);
      if (quote === undefined) {
        const q = await getQuote(tok.env, tok.token, r.acc_num, r.tid, r.route_id);
        quote = q.ok ? { bid: q.data.bid ?? null, ask: q.data.ask ?? null } : null;
        quoteCache.set(qKey, quote);
      }
      if (!quote) continue;
      const price = r.side === "buy" ? quote.bid : quote.ask; // exit-side price
      if (price == null || !Number.isFinite(price)) continue;
      // Live spread for the profit-lock cushion below (junk/one-sided quote → 0 → floors win).
      const liveSpread = quote.bid != null && quote.ask != null && quote.ask > quote.bid ? quote.ask - quote.bid : 0;

      // FAVOR GENX ALWAYS: an OPPOSITE-side GENX/FLOW gold position now exists on this
      // account → close Matty's leg so it isn't hedging against GENX's trade. Realizes
      // Matty's P&L at market; that is the owner's explicit call (GENX wins conflicts).
      {
        const flowSides = flowGoldByAcct.get(String(r.account_id));
        const opposite = r.side === "buy" ? "sell" : "buy";
        if (flowSides && flowSides.has(opposite) && r.qty && r.qty > 0) {
          const c = await closePosition(tok.env, tok.token, r.acc_num, r.position_id, r.qty);
          if (c.ok) {
            await admin.from("matty_pips_positions").update({ status: "closed", outcome: "yield_to_genx", resolved_at: nowIso(), updated_at: nowIso() }).eq("id", r.id);
            await admin.from("matty_pips_management_events").insert({ position_id: r.position_id, account_id: r.account_id, kind: "yield_to_genx", detail: { at: price, matty_side: r.side, flow_side: opposite } }).then(() => null, () => null);
            bestSeen.delete(String(r.position_id));
            acted.push(`${r.acc_num}:YIELD`);
            continue;
          }
          // couldn't close (broker blip) → leave it; the next pass retries the yield.
        }
      }

      const meta = getInstrument(r.symbol);
      const pip = pipsToPrice(r.symbol, 1);
      const roundPx = (n: number) => +n.toFixed(meta.pricePrecision);
      const stopAheadOf = (a: number, b: number) => (r.side === "buy" ? a > b : a < b); // never move backward
      const cur = r.cur_stop ?? r.init_stop;
      const inProfit = r.side === "buy" ? price > r.entry : price < r.entry;

      // FAVORABLE EXCURSION — the best the trade actually reached: the PERSISTED best
      // (survives restarts), the current sample, tick-level stream extremes, and — for
      // rows that predate the excursion manager — a one-time deep candle backfill since
      // entry. A junk value more than 2% from the live price is data, not market.
      const pid = String(r.position_id);
      const sane = (x: number) => Number.isFinite(x) && x > 0 && Math.abs(x - price) / price <= 0.02;
      const persisted = r.best_price != null && sane(r.best_price) ? r.best_price : null;
      let best = persisted ?? bestSeen.get(pid) ?? price;
      best = r.side === "buy" ? Math.max(best, price) : Math.min(best, price);
      const td = meta.twelveDataSymbol;
      const sinceMs = r.created_at && Number.isFinite(Date.parse(r.created_at)) ? Date.parse(r.created_at) : Date.now() - 8 * 60_000;
      if (persisted == null && td) {
        // No recorded excursion yet (row predates the upgrade, or fresh adoption) —
        // recover the true high/low since entry from 1-min candles, once.
        const ce = await candleExtremesSince(td, sinceMs);
        if (ce) {
          if (r.side === "buy" && sane(ce.high)) best = Math.max(best, ce.high);
          if (r.side === "sell" && sane(ce.low)) best = Math.min(best, ce.low);
        }
      }
      const ext = td ? liveTickExtremes(td, sinceMs) : null;
      if (ext) {
        if (r.side === "buy" && sane(ext.high)) best = Math.max(best, ext.high);
        if (r.side === "sell" && sane(ext.low)) best = Math.min(best, ext.low);
      }
      bestSeen.set(pid, best);
      // Persist the excursion so a restart can never forget it (column added 09-11;
      // written only when it actually advanced, so quiet passes stay write-free).
      const bestAdvanced = persisted == null || (r.side === "buy" ? best > persisted + 0.01 : best < persisted - 0.01);
      const favPips = r.side === "buy" ? priceToPips(r.symbol, Math.max(0, best - r.entry)) : priceToPips(r.symbol, Math.max(0, r.entry - best));

      // STEP 1 — breakeven, pushed INTO PROFIT (owner: "It has to move it into profit not
      // a loss"). +5 pips alone is NOT enough — a stop becomes a market order when touched,
      // and FLOW's live history (09-06/09-07/09-08) proved fills land a full spread + spike
      // slippage through the lock. Same cushion FLOW's manager earned the hard way: the live
      // spread, floored at 12 pips in liquid hours / 20 in the thin window (21:00–07:00 UTC
      // rollover + Asia), capped at 40 so a junk quote can't distort it. BE trigger is 30
      // pips, so even the deep thin-hours lock (25p) stays inside the trigger.
      // Trigger judges the EXCURSION (a wick that touched the level counts); the live
      // price must still sit safely beyond the new stop so a faded move isn't scratched.
      const utcH = new Date().getUTCHours();
      const thinHours = utcH >= 21 || utcH < 7;
      const lockPad = Math.min(Math.max(liveSpread, (thinHours ? 20 : 12) * pip), 40 * pip);
      const beTrig = r.be_trigger ?? 30;
      if (r.be_enabled !== false && !r.be_done && inProfit && favPips >= beTrig) {
        const bePx = roundPx(r.side === "buy" ? r.entry + 5 * pip + lockPad : r.entry - 5 * pip - lockPad);
        const beSafe = r.side === "buy" ? price >= bePx + 2 * pip : price <= bePx - 2 * pip;
        if (beSafe && stopAheadOf(bePx, cur)) {
          const m = await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: bePx });
          if (m.ok) {
            await admin.from("matty_pips_positions").update({ be_done: true, cur_stop: bePx, updated_at: nowIso() }).eq("id", r.id);
            await admin.from("matty_pips_management_events").insert({ position_id: r.position_id, account_id: r.account_id, kind: "breakeven", detail: { at: price, stop: bePx, favPips } }).then(() => null, () => null);
            acted.push(`${r.acc_num}:BE`);
            continue;
          }
          await admin.from("matty_pips_positions").update({ last_error: `be: ${m.error}`.slice(0, 180), updated_at: nowIso() }).eq("id", r.id);
        }
      }

      // STEP 2 — partial + LOCK. Half off, stop locks +lock_pips in profit.
      const partTrig = r.partial_trigger ?? (r.tp1_pips ? Math.max(40, Math.round(r.tp1_pips / 2)) : 60);
      if (r.partials_enabled !== false && !r.partial_done && inProfit && favPips >= partTrig && r.qty && r.qty > 0) {
        const half = normalizeQuantity(r.symbol, r.qty / 2, undefined);
        if (half.ok && half.qty > 0 && half.qty < r.qty) {
          const c = await closePosition(tok.env, tok.token, r.acc_num, r.position_id, half.qty);
          if (c.ok) {
            // The partial IS banked (the close filled) — record that unconditionally. The
            // profit LOCK is separate: only move the stop when the live price still sits
            // safely beyond it (a faded move can't have its stop parked through the market,
            // which the broker would reject or instantly fill), and only RECORD cur_stop
            // when the broker actually ACCEPTED the modify — the old path wrote the lock to
            // the ledger even when the modify was rejected, so the DB claimed a stop the
            // broker never held.
            const lock = r.lock_pips ?? 30;
            const lockPx = roundPx(r.side === "buy" ? r.entry + lock * pip : r.entry - lock * pip);
            const lockSafe = r.side === "buy" ? price >= lockPx + 2 * pip : price <= lockPx - 2 * pip;
            let newStop = cur;
            if (lockSafe && stopAheadOf(lockPx, cur)) {
              const m = await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: lockPx });
              if (m.ok) newStop = lockPx;
            }
            await admin.from("matty_pips_positions").update({ partial_done: true, qty: +(r.qty - half.qty).toFixed(2), cur_stop: newStop, updated_at: nowIso() }).eq("id", r.id);
            await admin.from("matty_pips_management_events").insert({ position_id: r.position_id, account_id: r.account_id, kind: "partial_lock", detail: { at: price, closed: half.qty, stop: newStop, lockApplied: newStop !== cur, favPips } }).then(() => null, () => null);
            acted.push(`${r.acc_num}:PARTIAL`);
            continue;
          }
          await admin.from("matty_pips_positions").update({ last_error: `partial: ${c.error}`.slice(0, 180), updated_at: nowIso() }).eq("id", r.id);
        } else if (!r.partial_done) {
          // Position too small to split — lock profit instead of partialing.
          const lock = r.lock_pips ?? 30;
          const lockPx = roundPx(r.side === "buy" ? r.entry + lock * pip : r.entry - lock * pip);
          const lockSafe = r.side === "buy" ? price >= lockPx + 2 * pip : price <= lockPx - 2 * pip;
          if (lockSafe && stopAheadOf(lockPx, cur)) {
            const m = await modifyPosition(tok.env, tok.token, r.acc_num, r.position_id, { stopLoss: lockPx });
            if (m.ok) {
              await admin.from("matty_pips_positions").update({ partial_done: true, cur_stop: lockPx, updated_at: nowIso() }).eq("id", r.id);
              acted.push(`${r.acc_num}:LOCK`);
            }
          }
        }
      }

      // WRITE THINNING: persist the excursion only when it actually advanced; the bare
      // liveness stamp only when the row hasn't been touched for 60s (was: every pass —
      // hundreds of no-op UPDATEs a minute at worker cadence, for nothing).
      if (bestAdvanced) await admin.from("matty_pips_positions").update({ best_price: best, updated_at: nowIso() }).eq("id", r.id);
      else {
        const touched = (r as { updated_at?: string | null }).updated_at;
        const ageMs = touched ? Date.now() - Date.parse(touched) : Infinity;
        if (!Number.isFinite(ageMs) || ageMs > 60_000) await admin.from("matty_pips_positions").update({ updated_at: nowIso() }).eq("id", r.id);
      }
    } catch { /* per-position best-effort */ }
  }
  return { ok: true, open: rows.length, acted };
}

/** Is the always-on worker actively managing? (fresh manager heartbeat with worker:true)
 *  The minutely cron stands down while true — same failover pattern as FLOW's crons. */
export async function workerIsManaging(admin: Admin): Promise<boolean> {
  try {
    const { data } = await admin.from("flow_heartbeat").select("last_run, detail").eq("component", "manager").maybeSingle();
    const d = (data ?? null) as { last_run?: string | null; detail?: { worker?: boolean } | null } | null;
    if (!d?.last_run || d.detail?.worker !== true) return false;
    return Date.now() - Date.parse(d.last_run) < 30_000;
  } catch { return false; }
}
