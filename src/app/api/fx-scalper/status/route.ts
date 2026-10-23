import { json, requireOwner } from "../_shared";
import { readControl, readSettings, LIVE_STATES, tradeFrom } from "@/lib/fxscalper/store";
import { settingsBlockers } from "@/lib/fxscalper/settings";
import { estimatedCompensation } from "@/lib/fxscalper/risk";
import { fxDayStart } from "@/lib/fxscalper/clock";

export const dynamic = "force-dynamic";

/** Everything the dashboard shows, from the database only (the worker is the one that talks to the broker). */
export async function GET() {
  const a = await requireOwner();
  if ("error" in a) return a.error;
  const db = a.db;
  try {
    const [control, settings] = await Promise.all([readControl(db), readSettings(db)]);
    const since = new Date(fxDayStart(Date.now())).toISOString();
    const [status, conns, instruments, live, recent, closed, comp, events, cmds] = await Promise.all([
      db.from("fx_scalper_status").select("at, worker, snapshot").eq("id", 1).maybeSingle(),
      db.from("fx_scalper_connections").select("id, server, email_masked, status, last_error, last_auth_at, created_at, accounts, enc_password").neq("status", "revoked").order("created_at", { ascending: false }).limit(10),
      db.from("fx_scalper_instruments").select("pair, status, problem, broker_symbol, candidates, lot_size, lot_step, min_lot, max_lot, tick_size, pip_size, bar_source, quoting_currency, leverage, symbol_status, resolved_at"),
      db.from("fx_scalper_trades").select("*").in("state", LIVE_STATES as unknown as string[]).order("created_at", { ascending: false }),
      db.from("fx_scalper_trades").select("*").not("state", "in", `(${LIVE_STATES.join(",")})`).order("created_at", { ascending: false }).limit(60),
      db.from("fx_scalper_trades").select("net_pnl, gross_pnl, commission, other_charges, closed_lots, eligible_lots, closed_at, pnl_final").eq("state", "closed").limit(20000),
      db.from("fx_scalper_compensation").select("*").order("created_at", { ascending: false }).limit(100),
      db.from("fx_scalper_events").select("id, at, level, kind, pair, trade_id, message").order("at", { ascending: false }).limit(120),
      db.from("fx_scalper_commands").select("id, kind, created_at, status, result, finished_at").order("created_at", { ascending: false }).limit(10),
    ]);

    const rows = (closed.data ?? []) as Array<{ net_pnl: number | null; gross_pnl: number | null; commission: number | null; other_charges: number | null; closed_lots: number | null; eligible_lots: number | null; closed_at: string | null; pnl_final: boolean }>;
    const sum = (list: typeof rows) => {
      const n = (v: unknown) => (v == null ? 0 : Number(v));
      const priced = list.filter((r) => r.pnl_final);
      return {
        trades: list.length,
        unpriced: list.length - priced.length,
        wins: priced.filter((r) => n(r.net_pnl) > 0).length,
        losses: priced.filter((r) => n(r.net_pnl) < 0).length,
        gross: priced.reduce((x, r) => x + n(r.gross_pnl), 0),
        charges: priced.reduce((x, r) => x + n(r.commission) + n(r.other_charges), 0),
        net: priced.reduce((x, r) => x + n(r.net_pnl), 0),
        closedLots: list.reduce((x, r) => x + n(r.closed_lots), 0),
        eligibleLots: list.reduce((x, r) => x + n(r.eligible_lots), 0),
      };
    };
    const today = sum(rows.filter((r) => r.closed_at && r.closed_at >= since));
    const all = sum(rows);

    const ledger = (comp.data ?? []) as Array<{ kind: string; amount: number }>;
    const byKind = (k: string) => ledger.filter((r) => r.kind === k).reduce((x, r) => x + Number(r.amount), 0);
    const compensation = {
      estimated: estimatedCompensation(all.eligibleLots, settings.settings.payout),
      confirmed: byKind("confirmed"),
      paid: byKind("paid"),
      reversed: byKind("reversal"),
      termsEntered: settings.settings.payout.termsEntered,
      rows: comp.data ?? [],
    };

    const connections = ((conns.data ?? []) as Array<Record<string, unknown>>).map((c) => ({
      id: c.id, server: c.server, emailMasked: c.email_masked, status: c.status, lastError: c.last_error, lastAuthAt: c.last_auth_at, createdAt: c.created_at,
      staysConnected: Boolean(c.enc_password), accounts: Array.isArray(c.accounts) ? c.accounts : [],
    }));
    const st = status.data as { at: string | null; worker: string | null; snapshot: Record<string, unknown> } | null;

    return json({
      now: Date.now(),
      control,
      settings: { values: settings.settings, version: settings.version, warnings: settings.warnings, blockers: settingsBlockers(settings.settings), updatedAt: settings.updatedAt },
      worker: st ? { at: st.at, ageMs: st.at ? Date.now() - Date.parse(st.at) : null, worker: st.worker, snapshot: st.snapshot } : null,
      connections,
      instruments: instruments.data ?? [],
      trades: { live: ((live.data ?? []) as Record<string, unknown>[]).map(tradeFrom), recent: ((recent.data ?? []) as Record<string, unknown>[]).map(tradeFrom) },
      results: { today, all, dayStartsAt: since },
      compensation,
      events: events.data ?? [],
      commands: cmds.data ?? [],
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
