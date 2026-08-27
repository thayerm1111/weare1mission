import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTelegram, esc } from "@/lib/telegram";

/**
 * SERVER-SIDE MONITOR (key-gated cron).
 *
 * Replaces the old external Cowork "health self-check" + "big-accounts monitor"
 * scheduled tasks, which could not work: a scheduled cloud run has no bridge to the
 * browser's Supabase tab and no DB connector permission, so they failed every cycle.
 * This runs INSIDE the app with full admin DB access + Telegram, so it can never hit
 * that wall. Two jobs, each self-throttled via flow_incidents so nothing spams:
 *
 *   1. SCANNER-STALL ALERT (throttled ~15m). If the GENX scan heartbeat has gone
 *      stale (no scan in > STALL_MIN minutes) it pings Telegram — this is the case
 *      the DOWN watchdog misses when the desk is FLAT (a stalled scanner with no open
 *      trade is only "degraded", never "down"). The self-healing watchdog still
 *      restarts it every minute; this just makes a persistent stall visible.
 *
 *   2. BIG-ACCOUNT DIGEST (throttled ~4h). Per big account: 4h realised P&L (pips,
 *      W/L), a SIZING sanity sweep on every open position (flags risk that is far too
 *      small OR too large), a break-even-at-a-loss check, and the forex loss streak.
 *      Anomalies lead with ⚠️; otherwise a short "all clear" so the owner knows it is
 *      watching. Sent to TELEGRAM_ADMIN_CHAT_ID when set (private), else the channel.
 *
 * Auth: Vercel Cron injects `Authorization: Bearer <CRON_SECRET>` automatically; the
 * GitHub backup passes ?key=. Same gate as the other crons.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function keyAuthorized(req: NextRequest): boolean {
  const url = new URL(req.url);
  const qp = url.searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  for (const k of [process.env.FLOW_CRON_KEY, process.env.GENX_CRON_KEY, process.env.CRON_SECRET]) {
    if (k && (qp === k || hdr === `Bearer ${k}`)) return true;
  }
  return false;
}

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

const STALL_MIN = 6;                 // GENX scan considered stalled past this
const STALL_ALERT_COOLDOWN_MIN = 15; // ping a persistent stall at most this often
const DIGEST_EVERY_MIN = 240;        // big-account digest cadence (~4h)

// The two large LIVE accounts to watch (owner-provided).
const BIG_ACCOUNTS: Record<string, string> = { "763013": "CRUC", "803349": "GENFX" };

// USD value per 1.0 lot per 1.0 price move, per instrument (JPY/CAD are quote-scaled).
function valuePerPrice(symbol: string, entry: number): { pip: number; vpp: number } {
  const s = symbol.toUpperCase();
  if (s === "XAUUSD" || s === "GOLD") return { pip: 0.1, vpp: 100 };
  if (s === "USDJPY") return { pip: 0.01, vpp: entry > 0 ? 100000 / entry : 100000 };
  if (s === "USDCAD") return { pip: 0.0001, vpp: entry > 0 ? 100000 / entry : 100000 };
  if (s === "NAS100" || s === "US30") return { pip: 1, vpp: 10 };
  // EURUSD / GBPUSD / AUDUSD and other majors
  return { pip: 0.0001, vpp: 100000 };
}

/** Fire an alert at most once per cooldown, tracked in flow_incidents. Returns whether it sent. */
async function throttledSend(admin: Admin, kind: string, cooldownMin: number, text: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - cooldownMin * 60_000).toISOString();
    const { data: recent } = await admin.from("flow_incidents").select("id").eq("kind", kind).gte("created_at", since).limit(1);
    if (recent && recent.length) return false; // still in cooldown
  } catch { return false; } // read error → fail closed (never spam)
  const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  try {
    await sendTelegram(text, adminChat ? { chatId: adminChat } : undefined);
    await admin.from("flow_incidents").insert({ component: "monitor", kind, detail: {} });
    return true;
  } catch { return false; }
}

async function scannerStallCheck(admin: Admin): Promise<{ stalled: boolean; ageMin: number | null; alerted: boolean }> {
  let ageMin: number | null = null;
  try {
    const { data } = await admin.from("genx_alerts").select("last_checked_at").eq("dedupe_key", "__scan_heartbeat__").maybeSingle();
    const last = (data as { last_checked_at?: string | null } | null)?.last_checked_at;
    if (last) ageMin = Math.round(((Date.now() - Date.parse(last)) / 60000) * 10) / 10;
  } catch { /* fall through */ }
  const stalled = ageMin == null || ageMin >= STALL_MIN;
  if (!stalled) return { stalled: false, ageMin, alerted: false };
  const alerted = await throttledSend(admin, "genx_stall_alert", STALL_ALERT_COOLDOWN_MIN, [
    "⚠️ <b>GENX scanner stalled</b>",
    ageMin == null ? "No scan heartbeat found." : `No new scan for <b>${ageMin} min</b> (expected every minute).`,
    "The self-healing watchdog restarts it each minute — re-check shortly; only worry if this persists past ~15 min.",
  ].join("\n"));
  return { stalled: true, ageMin, alerted };
}

type PosRow = { account_id: string | null; symbol: string; side: string; qty: number | null; entry: number | null; init_stop: number | null; be_done: boolean | null; cur_stop: number | null };
type ClosedRow = { account_id: string | null; result_pips: number | null; outcome: string | null };

async function bigAccountDigest(admin: Admin): Promise<{ sent: boolean; note: string }> {
  // Throttle to the digest cadence.
  try {
    const since = new Date(Date.now() - DIGEST_EVERY_MIN * 60_000).toISOString();
    const { data: recent } = await admin.from("flow_incidents").select("id").eq("kind", "account_digest").gte("created_at", since).limit(1);
    if (recent && recent.length) return { sent: false, note: "cooldown" };
  } catch { return { sent: false, note: "throttle_read_failed" }; }

  const ids = Object.keys(BIG_ACCOUNTS);
  // Balances (equity estimate).
  const balById = new Map<string, number>();
  try {
    const { data } = await admin.from("flow_broker_accounts").select("account_id, balance").in("account_id", ids);
    for (const r of ((data ?? []) as { account_id: string | null; balance: number | null }[])) {
      if (r.account_id && typeof r.balance === "number") balById.set(String(r.account_id), r.balance);
    }
  } catch { /* balances optional */ }

  // Open positions across the desk (sizing sanity + BE-at-loss) — small set.
  const openByAcct = new Map<string, PosRow[]>();
  const anomalies: string[] = [];
  try {
    const { data } = await admin.from("flow_managed_positions")
      .select("account_id, symbol, side, qty, entry, init_stop, be_done, cur_stop").eq("status", "open");
    for (const p of ((data ?? []) as PosRow[])) {
      const aid = String(p.account_id ?? "");
      if (!openByAcct.has(aid)) openByAcct.set(aid, []);
      openByAcct.get(aid)!.push(p);
      // BE-at-loss check (all accounts).
      if (p.be_done && p.entry != null && p.cur_stop != null) {
        const atLoss = (p.side === "buy" && p.cur_stop < p.entry) || (p.side === "sell" && p.cur_stop > p.entry);
        if (atLoss) anomalies.push(`BE stop parked at a LOSS: ${esc(p.symbol)} ${esc(p.side)} on ${esc(BIG_ACCOUNTS[aid] || aid)}`);
      }
      // Sizing sanity for the big accounts only (where we have a balance).
      const bal = balById.get(aid);
      if (bal && bal > 0 && p.qty != null && p.entry != null && p.init_stop != null) {
        const { vpp } = valuePerPrice(p.symbol, p.entry);
        const riskUsd = p.qty * Math.abs(p.entry - p.init_stop) * vpp;
        const riskPct = (riskUsd / bal) * 100;
        if (riskPct < 0.25) anomalies.push(`UNDER-sized: ${esc(p.symbol)} on ${esc(BIG_ACCOUNTS[aid] || aid)} risking only ${riskPct.toFixed(2)}% ($${Math.round(riskUsd)})`);
        else if (riskPct > 8) anomalies.push(`OVER-sized: ${esc(p.symbol)} on ${esc(BIG_ACCOUNTS[aid] || aid)} risking ${riskPct.toFixed(1)}% ($${Math.round(riskUsd)})`);
      }
    }
  } catch { /* positions optional */ }

  // 4h realised P&L per big account.
  const pnl = new Map<string, { pips: number; w: number; l: number }>();
  try {
    const since = new Date(Date.now() - 4 * 3600e3).toISOString();
    const { data } = await admin.from("flow_managed_positions")
      .select("account_id, result_pips, outcome").in("account_id", ids).eq("status", "closed").gte("resolved_at", since);
    for (const r of ((data ?? []) as ClosedRow[])) {
      const aid = String(r.account_id ?? "");
      const cur = pnl.get(aid) ?? { pips: 0, w: 0, l: 0 };
      const p = Number(r.result_pips) || 0;
      cur.pips += p;
      if (r.outcome === "stop" || p < 0) cur.l += 1; else cur.w += 1;
      pnl.set(aid, cur);
    }
  } catch { /* pnl optional */ }

  const lines: string[] = [];
  lines.push(anomalies.length ? "⚠️ <b>Trading monitor — attention</b>" : "✅ <b>Trading monitor — all clear</b>");
  for (const [id, name] of Object.entries(BIG_ACCOUNTS)) {
    const p = pnl.get(id);
    const open = openByAcct.get(id)?.length ?? 0;
    const pnlTxt = p ? `${p.pips >= 0 ? "+" : ""}${Math.round(p.pips)} pips (${p.w}W/${p.l}L)` : "no closed trades";
    lines.push(`<b>${esc(name)}</b>: 4h ${esc(pnlTxt)} · ${open} open`);
  }
  if (anomalies.length) { lines.push(""); for (const a of anomalies.slice(0, 8)) lines.push("• " + a); }
  else lines.push("Sizing sane, no break-even-at-loss, scanner + manager alive.");

  const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  try {
    await sendTelegram(lines.join("\n"), adminChat ? { chatId: adminChat } : undefined);
    await admin.from("flow_incidents").insert({ component: "monitor", kind: "account_digest", detail: { anomalies: anomalies.length } });
    return { sent: true, note: anomalies.length ? `${anomalies.length} anomalies` : "all_clear" };
  } catch { return { sent: false, note: "send_failed" }; }
}

async function run(req: NextRequest): Promise<Response> {
  if (!keyAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const stall = await scannerStallCheck(admin);
  const digest = await bigAccountDigest(admin);

  return json({ ok: true, stall, digest, asOf: new Date().toISOString() }, 200);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
