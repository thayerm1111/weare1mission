import { ACCOUNT_FRESH_MS, finiteNumber, freshAt, SNAPSHOT_FRESH_MS } from "@/lib/nitrous/policy";
import type { NitrousAnalyze, NitrousCandle, NitrousScenario } from "@/lib/nitrous/types";
import { json, requireUser, requireNitrousAddon, unavailable } from "../_shared";

export const dynamic = "force-dynamic";

function candle(v: unknown): NitrousCandle | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const t = finiteNumber(r.t), o = finiteNumber(r.o), h = finiteNumber(r.h), l = finiteNumber(r.l), c = finiteNumber(r.c);
  if ([t,o,h,l,c].some((n) => n === null) || t! < 1_000_000_000_000 || h! < l! || h! < Math.max(o!,c!) || l! > Math.min(o!,c!)) return null;
  return { t: t!, o: o!, h: h!, l: l!, c: c! };
}

export async function GET() {
  try {
    const auth = await requireUser();
    if ("error" in auth) return auth.error;
    if (!auth.active) return json({ error: "access_inactive" }, 403);
    const access = await requireNitrousAddon(auth.admin, auth.user.id);
    if ("error" in access) return access.error;
    const result = await auth.admin.from("nitrous_snapshots").select("snapshot_id,strategy_version,generated_at,market_event_time,feed_source,health,regimes,payload")
      .order("generated_at", { ascending: false }).limit(1).maybeSingle();
    if (result.error) return unavailable();
    const row = result.data as Record<string, unknown> | null;
    if (!row) return json({ available: false, reason: "Waiting for the first market read.", asOf: null, generatedAt: null,
      ageMs: null, stale: true, price: null, symbol: "XAUUSD", source: null, bars: [], scenarios: [], flow: [],
      explanation: "Setups will appear when current market data is available.", health: { state: "blocked", reasons: ["No market snapshot yet."] }, strategyVersion: null } satisfies NitrousAnalyze);
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const generatedAt = typeof row.generated_at === "string" ? row.generated_at : null;
    const ageMs = generatedAt ? now - Date.parse(generatedAt) : Infinity;
    const suppliedHealth = (row.health ?? {}) as Record<string, unknown>;
    const health: NitrousAnalyze["health"] = { state: typeof suppliedHealth.state === "string" ? suppliedHealth.state : "blocked",
      reasons: Array.isArray(suppliedHealth.reasons) ? suppliedHealth.reasons.filter((v): v is string => typeof v === "string") : ["Market data health is unknown."] };
    const asOf = typeof row.market_event_time === "string" ? row.market_event_time : null;
    const bars = (Array.isArray(payload.bars) ? payload.bars : []).map(candle).filter((b): b is NitrousCandle => b !== null && b.t + 300_000 <= now).slice(-180);
    if (!freshAt(asOf, now, ACCOUNT_FRESH_MS)) health.reasons.push("The latest market event is stale or unavailable.");
    if (!bars.length || now - bars[bars.length - 1].t - 300_000 > 420_000) health.reasons.push("The completed chart candles need to refresh.");
    const stale = !Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > SNAPSHOT_FRESH_MS || health.state !== "ok" || health.reasons.length > 0;
    if (stale) health.state = "blocked";
    const scenarios = (Array.isArray(payload.scenarios) ? payload.scenarios : []) as NitrousScenario[];
    const safeScenarios = scenarios.filter((s) => s && (s.side === "buy" || s.side === "sell") && [s.refEntry,s.stop,s.target,s.entryBandLow,s.entryBandHigh,s.expiresAt].every((n) => typeof n === "number" && Number.isFinite(n)))
      .map((s) => ({ ...s, state: s.expiresAt <= now ? "expired" : stale ? "stale" : s.state,
        conditionsMet: Array.isArray(s.conditionsMet) ? s.conditionsMet : [], conditionsPending: Array.isArray(s.conditionsPending) ? s.conditionsPending : [] }));
    const regimes = (row.regimes ?? {}) as Record<string, string>;
    const labels: Record<string,string> = { D1: "D", H4: "4H", H1: "1H", M30: "30M", M15: "15M", M5: "5M" };
    const flow: NitrousAnalyze["flow"] = Object.entries(labels).map(([key,timeframe]) => {
      const value = regimes[key]; const direction = value === "up" || value === "down" ? value : value === "sideways" ? "range" : "unknown";
      return { timeframe, direction, label: direction === "up" ? "Uptrend" : direction === "down" ? "Downtrend" : direction === "range" ? "Range" : "Unavailable" };
    });
    return json({ available: true, generatedAt, asOf,
      ageMs: Number.isFinite(ageMs) ? Math.max(0,ageMs) : null, stale, price: finiteNumber(payload.price) ?? bars.at(-1)?.c ?? null,
      symbol: "XAUUSD", source: typeof row.feed_source === "string" ? row.feed_source : null, bars, scenarios: safeScenarios, flow,
      explanation: typeof payload.explanation === "string" ? payload.explanation : "", health,
      strategyVersion: typeof row.strategy_version === "string" ? row.strategy_version : null } satisfies NitrousAnalyze);
  } catch { return unavailable(); }
}
