import { ctx, json, ownedAccount, readSettings, type Ctx } from "../_lib";
import { fallbackSession } from "../../../../../auric/market/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/auric/activate?accountId= — the quote: exact scope, price, expiry, readiness. Never charges.
 * POST /api/auric/activate { accountId, key, confirm:true, autoRenew?:boolean } — atomic debit + entitlement.
 *   `key` is a client-generated idempotency key: a double click, retry or second tab returns the same session.
 */
async function readiness(c: Ctx, acct: Record<string, unknown>) {
  const s = await readSettings(c);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const price = s.daily_price_credits;
  checks.push({ name: "price", ok: price != null, detail: price != null ? `${price} credits for one ${s.session_hours ?? 24}-hour session on this account` : "Administrator has not configured the daily price yet." });
  checks.push({ name: "engine", ok: s.engine_enabled === true, detail: s.engine_enabled === true ? "AURIC engine is enabled" : "AURIC engine is switched off by the administrator." });
  const { data: hb } = await c.admin.from("auric_worker_heartbeat").select("at").order("at", { ascending: false }).limit(1).maybeSingle();
  const alive = hb ? Date.now() - Date.parse(hb.at) < 45_000 : false;
  checks.push({ name: "worker", ok: alive, detail: alive ? "auric-engine worker is running" : "auric-engine worker heartbeat is missing — activation would not be monitored." });
  checks.push({ name: "consent", ok: !!acct.consent_at, detail: acct.consent_at ? `consent ${acct.consent_version}` : "Consent for this account is required first." });
  checks.push({ name: "account", ok: acct.status === "linked", detail: acct.status === "linked" ? "account linked" : String(acct.block_reason ?? acct.status) });
  const { data: conn } = await c.admin.from("auric_broker_connections").select("env, status, last_error").eq("id", String(acct.connection_id)).maybeSingle();
  checks.push({ name: "broker", ok: conn?.status === "ok", detail: conn?.status === "ok" ? `broker session ok (${conn.env})` : `broker connection ${conn?.status ?? "missing"}: ${conn?.last_error ?? ""}` });
  const live = conn?.env === "live";
  if (live) checks.push({ name: "live", ok: !!acct.live_authorized_at && s.live_orders_enabled === true, detail: acct.live_authorized_at && s.live_orders_enabled === true ? "live orders authorized for this account" : "This is a LIVE account: it needs explicit live authorization (per account) and the global live flag. Monitoring will run, orders will not be sent." });
  const spec = acct.instrument_spec as Record<string, unknown> | null; const missing = (acct.spec_missing as string[]) ?? [];
  checks.push({ name: "instrument", ok: !!spec && missing.length === 0, detail: spec ? (missing.length ? `broker spec missing ${missing.join(", ")}` : `XAUUSD spec verified: tick ${spec.tickSize}, step ${spec.lotStep}, min ${spec.minLot}, contract ${spec.contractSize ?? "via tick value"}`) : "Instrument spec not yet discovered (discovered on first engine tick; sizing refuses until then)." });
  const mkt = fallbackSession(Date.now());
  checks.push({ name: "market", ok: true, detail: mkt.open ? `market open (${mkt.label})` : `market currently closed (${mkt.label}) — the session clock still runs; monitoring resumes at open` });
  const { data: active } = await c.admin.from("auric_sessions").select("id, expires_at").eq("account_id", String(acct.id)).eq("status", "active").gt("expires_at", new Date().toISOString()).maybeSingle();
  checks.push({ name: "no_active_session", ok: !active, detail: active ? `a session is already active until ${active.expires_at}` : "no overlapping session" });
  const blocking = checks.filter((x) => !x.ok && x.name !== "live" && x.name !== "instrument");
  return { checks, blocking, price, hours: s.session_hours ?? 24, live };
}

export async function GET(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  const acct = await ownedAccount(c, new URL(req.url).searchParams.get("accountId") ?? ""); if (!acct) return json({ error: "account_not_found" }, 404);
  const rd = await readiness(c, acct);
  return json({ ok: true, ...rd, scope: `One ${rd.hours}-hour AURIC session for broker account ${acct.name ?? acct.broker_account_id} (${acct.acc_num}) only. Credits buy monitoring and automation access, not trades or profit; a session may produce no qualifying trades. Open AURIC positions keep being managed after expiry at no extra charge.` });
}

export async function POST(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  let b: { accountId?: string; key?: string; confirm?: boolean; autoRenew?: boolean };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (b.confirm !== true) return json({ error: "confirmation_required" }, 400);
  const key = String(b.key ?? ""); if (!/^[0-9a-f-]{20,64}$/i.test(key)) return json({ error: "idempotency_key_required" }, 400);
  const acct = await ownedAccount(c, String(b.accountId ?? "")); if (!acct) return json({ error: "account_not_found" }, 404);
  const rd = await readiness(c, acct);
  if (rd.blocking.length) return json({ error: "not_ready", checks: rd.checks }, 409);
  const { data, error } = await c.admin.rpc("auric_activate_session", { p_user: c.user.id, p_account: acct.id, p_key: `${c.user.id}:${key}`, p_allowance: Number(process.env.NEXT_PUBLIC_DAILY_FREE_CREDITS ?? 5), p_checks: rd.checks });
  if (error) return json({ error: "activation_failed", detail: error.message }, 500);
  if (!data?.ok) return json({ error: data?.error ?? "activation_failed", detail: data }, 402);
  if (b.autoRenew === true && !data.idempotent) await c.admin.from("auric_sessions").update({ auto_renew: true, auto_renew_price: rd.price }).eq("id", data.session_id);
  if (!data.idempotent) await c.admin.from("auric_events").insert({ account_id: acct.id, session_id: data.session_id, kind: "session", message: `Session activated: ${data.charged} credits for ${rd.hours} hours (until ${data.expires_at})${b.autoRenew ? `; auto-renew ON at ${rd.price} credits/session` : ""}. ${rd.live ? "Live orders " + (rd.checks.find((x) => x.name === "live")?.ok ? "authorized." : "NOT authorized — monitoring only.") : "Demo account."}`, state: "OBSERVING" });
  return json({ ok: true, sessionId: data.session_id, expiresAt: data.expires_at, charged: data.charged, idempotent: !!data.idempotent, balance: data.balance ?? null });
}
