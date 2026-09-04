import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runEngine } from "@/lib/matty-pips/engine";
import { enabledAccounts, placeForAccount } from "@/lib/matty-pips/broker";
import { logDecision } from "@/lib/matty-pips/audit";
import type { Mode } from "@/lib/matty-pips/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MATTY PIPS AUTO — scan tick (key-gated cron, every minute).
 * Runs the SAME deterministic engine as FIND ME A TRADE for gold, and when a
 * TAKE_NOW read exists, copies the trade to every account whose owner opted
 * in (their own toggle, their own risk %). Per-signal claims (unique index)
 * make double-fills impossible across overlapping runs. Completely inert when
 * nobody has auto ON. FLOW/GENX are never consulted or modified.
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

const r1 = (n: number) => Math.round(n * 10) / 10;

async function run(): Promise<Response> {
  const admin = createAdminClient();
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!admin || !mdKey) return json({ ok: false, error: "not_configured" }, 500);

  const accts = await enabledAccounts(admin);
  if (!accts.length) return json({ ok: true, skipped: "no_enabled_accounts" });

  const modes = [...new Set(accts.map((a) => (a.mode === "aggressive" ? "aggressive" : "conservative")))] as Mode[];
  const out: Record<string, unknown> = { accounts: accts.length, modes };
  const placed: string[] = [];

  for (const mode of modes) {
    const d = await runEngine({ symbol: "XAUUSD", mode, mdKey, fresh: false });
    if (!d.ok) { out[`engine_${mode}`] = d.error; continue; }
    out[`status_${mode}`] = d.status;
    if (d.status !== "TAKE_NOW" || !d.trade) {
      // Record the tick decision sparsely (only state changes matter for audit volume).
      continue;
    }
    const z = d.trade.entryZone;
    const signalKey = `XAUUSD:${d.trade.direction}:${r1(z.low)}-${r1(z.high)}:${d.trade.setupType}`;
    for (const a of accts.filter((x) => (x.mode === "aggressive" ? "aggressive" : "conservative") === mode)) {
      try {
        const res = await placeForAccount(admin, a, d, signalKey);
        void logDecision({
          userId: a.user_id, symbol: "XAUUSD", kind: res.placed ? "auto_take" : "auto_skip",
          detail: { account: a.acc_num, mode, signalKey, reason: res.reason, score: d.score.total, setup: d.trade.setupType, entry: d.trade.entry, stop: d.trade.stopLoss, tp1: d.trade.tp1, riskPct: a.risk_pct },
        });
        if (res.placed) placed.push(a.acc_num);
      } catch (e) {
        void logDecision({ userId: a.user_id, symbol: "XAUUSD", kind: "auto_error", detail: { account: a.acc_num, error: e instanceof Error ? e.message.slice(0, 160) : "unknown" } });
      }
    }
  }
  out.placed = placed;
  return json({ ok: true, ...out });
}

export async function GET(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
export async function POST(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
