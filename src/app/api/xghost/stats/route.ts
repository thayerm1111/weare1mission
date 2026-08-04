import { type NextRequest } from "next/server";
import { authedContext } from "@/lib/supabase/bearer";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveXghostOpen } from "@/lib/xghostResolve";
import { XGHOST_VERSION } from "@/lib/xghost/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * xGhost performance dashboard data (ADMIN ONLY).
 *
 * On load it first grades any still-open xGhost signals on demand (so the numbers
 * are current the moment the admin opens the screen — no scheduled job required),
 * then aggregates the paper-logged ledger: win rate, expectancy in R, and the same
 * broken down by pair, by setup family, and by DXY confirmation.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Meta = { family?: string; grade?: string; exec_state?: string; dxy_confirm?: string; dxy_state?: string; dxy_source?: string; rr_main?: number } | null;
type Sig = {
  symbol: string | null; instrument: string | null; direction: string | null; method: string | null;
  status: string | null; score: number | null; realized_r: number | null; mae_r: number | null; mfe_r: number | null;
  entry: number | null; stop: number | null; tp1: number | null; created_at: string | null; resolved_at: string | null;
  session: string | null; regime: string | null; meta: Meta;
};

type Bucket = { key: string; n: number; wins: number; losses: number; other: number; sumR: number; gradedN: number };
function emptyBucket(key: string): Bucket { return { key, n: 0, wins: 0, losses: 0, other: 0, sumR: 0, gradedN: 0 }; }
function addToBucket(b: Bucket, s: Sig) {
  b.n++;
  if (s.status === "win") b.wins++;
  else if (s.status === "loss") b.losses++;
  else if (s.status === "expired" || s.status === "unfilled") b.other++;
  if (typeof s.realized_r === "number" && Number.isFinite(s.realized_r)) { b.sumR += s.realized_r; b.gradedN++; }
}
function finishBucket(b: Bucket) {
  const decided = b.wins + b.losses;
  return {
    key: b.key, n: b.n, wins: b.wins, losses: b.losses, other: b.other,
    winRate: decided ? Math.round((b.wins / decided) * 100) : null,
    expectancyR: b.gradedN ? +(b.sumR / b.gradedN).toFixed(2) : null,
    totalR: +b.sumR.toFixed(2),
  };
}

export async function GET(req: NextRequest) {
  const { user, configured } = await authedContext(req);
  if (configured && !user) return json({ error: "unauthorized" }, 401);

  // Admin gate — must be an admin profile.
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured", reason: "Performance tracking needs the service role key." }, 200);
  if (user) {
    const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (!prof || prof.role !== "admin") return json({ error: "forbidden" }, 403);
  } else if (configured) {
    return json({ error: "unauthorized" }, 401);
  }

  // Grade open signals on demand (unless explicitly skipped).
  const url = new URL(req.url);
  let resolvedNow = { checked: 0, resolved: 0, breakdown: {} as Record<string, number> };
  if (url.searchParams.get("resolve") !== "0") {
    const mdKey = process.env.TWELVEDATA_API_KEY;
    if (mdKey) { try { resolvedNow = await resolveXghostOpen(mdKey); } catch { /* show stale rather than fail */ } }
  }

  const { data: rowsRaw, error } = await admin
    .from("signal_log")
    .select("symbol,instrument,direction,method,status,score,realized_r,mae_r,mfe_r,entry,stop,tp1,created_at,resolved_at,session,regime,meta")
    .eq("engine", "xghost")
    .order("created_at", { ascending: false })
    .limit(600);
  if (error) return json({ error: "db_error", detail: error.message }, 500);
  const rows = (rowsRaw || []) as Sig[];

  // Totals
  const t = { signals: rows.length, open: 0, wins: 0, losses: 0, expired: 0, unfilled: 0, sumR: 0, gradedN: 0, sumWinR: 0, winN: 0, sumLossR: 0, lossN: 0 };
  let bestR = -Infinity, worstR = Infinity;
  const pairs = new Map<string, Bucket>(), fams = new Map<string, Bucket>(), dxy = new Map<string, Bucket>();
  const pick = (m: Map<string, Bucket>, key: string) => (m.get(key) || m.set(key, emptyBucket(key)).get(key)!);

  for (const s of rows) {
    if (s.status === "open") t.open++;
    else if (s.status === "win") t.wins++;
    else if (s.status === "loss") t.losses++;
    else if (s.status === "expired") t.expired++;
    else if (s.status === "unfilled") t.unfilled++;
    if (typeof s.realized_r === "number" && Number.isFinite(s.realized_r)) {
      t.sumR += s.realized_r; t.gradedN++;
      if (s.realized_r > bestR) bestR = s.realized_r;
      if (s.realized_r < worstR) worstR = s.realized_r;
      if (s.status === "win") { t.sumWinR += s.realized_r; t.winN++; }
      else if (s.status === "loss") { t.sumLossR += s.realized_r; t.lossN++; }
    }
    const sym = s.symbol || s.instrument || "?";
    addToBucket(pick(pairs, sym), s);
    addToBucket(pick(fams, s.method || (s.meta?.family ?? "—")), s);
    addToBucket(pick(dxy, s.meta?.dxy_confirm ? String(s.meta.dxy_confirm) : "n/a"), s);
  }
  const decided = t.wins + t.losses;

  const recent = rows
    .filter((s) => s.status && s.status !== "open")
    .slice(0, 20)
    .map((s) => ({
      symbol: s.symbol || s.instrument, direction: s.direction, family: s.method || s.meta?.family || "—",
      status: s.status, realized_r: s.realized_r, grade: s.meta?.grade ?? null, score: s.score,
      dxyConfirm: s.meta?.dxy_confirm ?? null, resolved_at: s.resolved_at, created_at: s.created_at,
    }));
  const openList = rows
    .filter((s) => s.status === "open")
    .slice(0, 20)
    .map((s) => ({
      symbol: s.symbol || s.instrument, direction: s.direction, family: s.method || s.meta?.family || "—",
      entry: s.entry, stop: s.stop, tp1: s.tp1, score: s.score, grade: s.meta?.grade ?? null,
      execState: s.meta?.exec_state ?? null, created_at: s.created_at,
    }));

  const byN = (a: ReturnType<typeof finishBucket>, b: ReturnType<typeof finishBucket>) => b.n - a.n;

  return json({
    ok: true,
    version: XGHOST_VERSION,
    resolvedNow,
    totals: {
      signals: t.signals, open: t.open, resolved: t.wins + t.losses + t.expired + t.unfilled,
      wins: t.wins, losses: t.losses, expired: t.expired, unfilled: t.unfilled,
      decided, winRate: decided ? Math.round((t.wins / decided) * 100) : null,
      expectancyR: t.gradedN ? +(t.sumR / t.gradedN).toFixed(2) : null,
      totalR: +t.sumR.toFixed(2),
      avgWinR: t.winN ? +(t.sumWinR / t.winN).toFixed(2) : null,
      avgLossR: t.lossN ? +(t.sumLossR / t.lossN).toFixed(2) : null,
      bestR: Number.isFinite(bestR) ? +bestR.toFixed(2) : null,
      worstR: Number.isFinite(worstR) ? +worstR.toFixed(2) : null,
    },
    byPair: Array.from(pairs.values()).map(finishBucket).sort(byN),
    byFamily: Array.from(fams.values()).map(finishBucket).sort(byN),
    byDxy: Array.from(dxy.values()).map(finishBucket).sort(byN),
    recent, open: openList,
  });
}
