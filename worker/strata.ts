import { createAdminClient } from "@/lib/supabase/admin";
import { getStrataState } from "@/lib/strata/feed";
import { isOpen } from "@/lib/cashtrap/marketHours";

/**
 * STRATA PAPER AUTOMATION ONLY.
 *
 * Explicit opt-in rows describe the member's own account for context, but this
 * worker NEVER imports any broker order placement function. It can only write
 * simulated positions to strata_paper_positions. Live and demo TradeLocker
 * accounts are never traded by this service. A separate broker-execution
 * release will require testing, an independent risk gate, and a new opt-in.
 */
type Setting = { user_id: string; connection_id: string; account_id: string;
  environment: "demo" | "live"; risk_pct: number; max_entries_per_day: number };
type Paper = { id: string; user_id: string; connection_id: string; account_id: string;
  side: "buy" | "sell"; stop: number; target: number; status: "open"; opened_at: string };
const MS = 20_000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (r: { user_id: string; connection_id: string; account_id: string }) =>
  r.user_id + ":" + r.connection_id + ":" + r.account_id;

export async function strataPaperTick(): Promise<{ checked: number; created: number; closed: number; reason?: string }> {
  const db = createAdminClient();
  if (!db) return { checked: 0, created: 0, closed: 0, reason: "no_database" };
  const now = Date.now();
  if (!isOpen("metal", now)) return { checked: 0, created: 0, closed: 0, reason: "market_closed" };
  // No tick = no simulated fill, ever. Do not substitute candle close for a fill price.
  const { data: tick, error: tickError } = await db.from("market_live_ticks")
    .select("price,received_at").eq("symbol", "XAU/USD").maybeSingle();
  const received = tick?.received_at ? Date.parse(tick.received_at) : NaN;
  const price = Number(tick?.price);
  if (tickError || !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(received) || now - received < -3000 || now - received > 6_000)
    return { checked: 0, created: 0, closed: 0, reason: "tick_stale" };
  // Resolve existing simulated trades from genuine observed prices. No imaginary intrabar TP/SL.
  const { data: opened, error: openError } = await db.from("strata_paper_positions")
    .select("id,user_id,connection_id,account_id,side,stop,target,status,opened_at")
    .eq("status", "open").order("opened_at", { ascending: true }).limit(400);
  if (openError) return { checked: 0, created: 0, closed: 0, reason: "paper_read_error" };
  let closed = 0;
  const pending = (opened ?? []) as Paper[];
  for (const position of pending) {
    // Price is evaluated against the protective stop FIRST. Paper results are only
    // illustrative and exclude latency, spread, commission and gaps.
    const stop = Number(position.stop), target = Number(position.target);
    const lost = position.side === "buy" ? price <= stop : price >= stop;
    const won = position.side === "buy" ? price >= target : price <= target;
    if (!lost && !won) continue;
    const { data, error } = await db.from("strata_paper_positions")
      .update({ status: lost ? "stopped" : "target", exit_price: price, closed_at: new Date(now).toISOString() })
      .eq("id", position.id).eq("status", "open").select("id").maybeSingle();
    if (!error && data) closed++;
  }
  const { data: optIns, error: settingsError } = await db.from("strata_automation_settings")
    .select("user_id,connection_id,account_id,environment,risk_pct,max_entries_per_day")
    .eq("mode", "paper").limit(400);
  if (settingsError || !optIns?.length) return { checked: 0, created: 0, closed, reason: settingsError ? "settings_error" : "no_opt_ins" };
  const settings = optIns as Setting[];
  const state = await getStrataState();
  const analysis = state?.analysis;
  const plan = analysis?.primary;
  if (!state || state.dataStale || state.marketClosed || analysis?.status !== "READY" ||
      !plan || plan.stage !== "ready" || plan.entry === null || plan.stop === null || !plan.targets.length ||
      !Number.isFinite(analysis.asOf) || now - (analysis.asOf + 900_000) > 120_000)
    return { checked: settings.length, created: 0, closed, reason: "no_fresh_qualified_setup" };
  // A simulated fill must still be near the actual confirmed entry, and the
  // stop/target geometry must remain valid at the current fresh tick.
  if (Math.abs(price - plan.entry) > Math.max(0.6, analysis.atr * .35))
    return { checked: settings.length, created: 0, closed, reason: "entry_moved" };
  const stopRisk = Math.abs(price - plan.stop), profit = Math.abs(plan.targets[0] - price);
  const correct = plan.side === "buy" ? plan.stop < price && plan.targets[0] > price
    : plan.stop > price && plan.targets[0] < price;
  if (!correct || !(stopRisk >= .3) || profit / stopRisk < 1.45)
    return { checked: settings.length, created: 0, closed, reason: "risk_geometry_changed" };
  const day = new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
  const { data: today, error: todayError } = await db.from("strata_paper_positions")
    .select("user_id,connection_id,account_id").gte("opened_at", day).limit(4000);
  if (todayError) return { checked: settings.length, created: 0, closed, reason: "journal_unavailable" };
  const counts = new Map<string, number>();
  for (const row of today ?? []) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  const openIds = new Set(pending.map(keyOf));
  let created = 0;
  for (const setting of settings) {
    const k = keyOf(setting);
    if (openIds.has(k) || (counts.get(k) ?? 0) >= setting.max_entries_per_day) continue;
    // A selected account must remain attached to the user and a connected
    // broker login; paper mode is never a reason to reconnect or arm FLOW.
    const { data: account } = await db.from("flow_broker_accounts")
      .select("account_id").eq("user_id", setting.user_id)
      .eq("connection_id", setting.connection_id).eq("account_id", setting.account_id).maybeSingle();
    if (!account) continue;
    const { data: conn } = await db.from("flow_broker_connections")
      .select("status").eq("user_id", setting.user_id).eq("id", setting.connection_id).maybeSingle();
    if (!conn || conn.status !== "connected") continue;
    const { error: insertError } = await db.from("strata_paper_positions").insert({
      user_id: setting.user_id, connection_id: setting.connection_id,
      account_id: setting.account_id, environment: setting.environment,
      signal_key: plan.id, side: plan.side, setup_type: plan.type,
      entry: price, stop: plan.stop, target: plan.targets[0],
      risk_pct: setting.risk_pct, status: "open", opened_at: new Date(now).toISOString(),
    });
    if (!insertError) { created++; openIds.add(k); counts.set(k, (counts.get(k) ?? 0) + 1); }
  }
  return { checked: settings.length, created, closed };
}

export async function strataPaperLoop(stopping: () => boolean): Promise<void> {
  while (!stopping()) {
    try {
      const report = await strataPaperTick();
      if (report.created || report.closed)
        console.log("[STRATA paper]", { created: report.created, closed: report.closed, checked: report.checked });
    } catch (err) {
      console.log("[STRATA paper] scan failed; other workers unaffected", err instanceof Error ? err.message : String(err));
    }
    await delay(MS);
  }
}
