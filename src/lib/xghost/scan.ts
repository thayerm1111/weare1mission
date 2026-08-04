/**
 * xGhost — shared scan core.
 *
 * The single source of truth for "run the five-pair scan": fetch candles, build
 * the DXY read (native → free ICE → proxy), analyse each pair, rank and apply the
 * correlation guard. Used by BOTH the member-facing route (/api/xghost) and the
 * automatic cron (/api/cron/xghost-scan) so a manual scan and an automatic one are
 * byte-for-byte the same analysis — no drift.
 *
 * This module owns NO auth, credits, AI prose, or HTTP shaping — callers add those.
 */
import { series } from "@/lib/marketData";
import { closedBars } from "@/lib/mtf";
import { XPAIRS, XSYMS, analyzePair, sessionOf, XGHOST_VERSION, type PairInput, type XSym, type XCandidate, type SessionKey, type DxyRead } from "@/lib/xghost/engine";
import { classifyDxy, buildProxyCloses, fetchFreeDxy } from "@/lib/xghost/dxy";
import { rankAndGuard } from "@/lib/xghost/correlation";
import { logSignal } from "@/lib/signalLog";
import type { Row } from "@/lib/marketData";

const arr = (r: Row[] | "ratelimit" | null): Row[] | null => (Array.isArray(r) ? r : null);

export type XScanResult =
  | {
      status: "ok";
      asOf: string; nowMs: number; session: SessionKey;
      dxy: DxyRead; ranked: XCandidate[]; best: XCandidate | null; second: XCandidate | null;
      suppressed: { symbol: string; reason: string }[]; anyTradeable: boolean;
    }
  | { status: "ratelimit" };

export async function scanXghost(mdKey: string, fresh: boolean): Promise<XScanResult> {
  const now = new Date();
  const nowMs = now.getTime();
  const session = sessionOf(now);

  // 5 pairs × (1H, 15m, 5m) + a fresh 1m tick for price.
  const pairFetch = XSYMS.map(async (sym) => {
    const cfg = XPAIRS[sym];
    const [h1, m15, m5, priceRow] = await Promise.all([
      series(cfg.td, "1h", 120, mdKey, fresh),
      series(cfg.td, "15min", 120, mdKey, fresh),
      series(cfg.td, "5min", 150, mdKey, fresh),
      series(cfg.td, "1min", 2, mdKey, fresh),
    ]);
    const m5arr = arr(m5);
    const price = m5arr && m5arr.length ? +m5arr[m5arr.length - 1].close : null;
    return { sym, h1: arr(h1), m15: arr(m15), m5: m5arr, priceRow: arr(priceRow), price };
  });

  // DXY across 1m/5m/15m/30m: native (opt-in) → free ICE feed → proxy from pairs.
  const DXY_TFS = ["1min", "5min", "15min", "30min"] as const;
  const tryNative = process.env.XGHOST_NATIVE_DXY === "1";
  const dxyFetch = (async () => {
    if (tryNative) {
      const nat = await Promise.all(DXY_TFS.map((tf) => series("DXY", tf, 150, mdKey, fresh)));
      const n = nat.map(arr);
      if (n.every((x) => x && x!.length > 25)) return { src: "native" as const, rows: n as Row[][] };
    }
    const free = await Promise.all(DXY_TFS.map((tf) => fetchFreeDxy(tf, 200)));
    if (free.every((x) => x && x.length > 25)) return { src: "free" as const, rows: free as Row[][] };
    return { src: "proxy" as const, rows: null };
  })();

  const [pairData, dxySrc] = await Promise.all([Promise.all(pairFetch), dxyFetch]);

  const anyData = pairData.some((p) => p.h1 && p.m15 && p.m5);
  if (!anyData) return { status: "ratelimit" };

  let dxy: DxyRead;
  if (dxySrc.rows) {
    const R = dxySrc.rows;
    const cb = (r: Row[]) => (r.length > 26 ? r.slice(0, -1) : r);
    dxy = classifyDxy(cb(R[0]), cb(R[1]), cb(R[2]), cb(R[3]), dxySrc.src);
  } else {
    const byTf = (tf: "h1" | "m15" | "m5") => {
      const m: Record<string, Row[] | null> = {};
      for (const p of pairData) m[p.sym] = closedBars(p[tf], 120);
      return m;
    };
    dxy = classifyDxy(null, buildProxyCloses(byTf("m5")), buildProxyCloses(byTf("m15")), buildProxyCloses(byTf("h1")), "proxy");
  }

  const cands = pairData.map((p) => {
    const cfg = XPAIRS[p.sym as XSym];
    const inp: PairInput = {
      h1: closedBars(p.h1, 25), m15: closedBars(p.m15, 25), m5: closedBars(p.m5, 25),
      price: p.price, nowMs, session, dxy,
    };
    return analyzePair(cfg, inp);
  });

  const { ranked, best, second, suppressed, anyTradeable } = rankAndGuard(cands);
  return { status: "ok", asOf: now.toISOString(), nowMs, session, dxy, ranked, best, second, suppressed, anyTradeable };
}

/**
 * Paper-log the tradeable results (Enter-now / Limit) into the universal
 * signal_log so the scanner's edge can be measured. Deduped by fingerprint, so the
 * same live setup — whether re-scanned by a member or re-scanned by the cron — is
 * only recorded once while it stays open. Fire-and-safe (never throws).
 */
export async function logXghostSignals(best: XCandidate | null, second: XCandidate | null, dxy: DxyRead, userId: string | null): Promise<number> {
  const toLog = [best, second].filter((c): c is XCandidate => !!c && (c.execState === "ENTER_NOW" || c.execState === "LIMIT_ENTRY"));
  let logged = 0;
  for (const c of toLog) {
    const isMarket = c.entryType === "MARKET";
    const entryRef = isMarket
      ? (c.price ?? c.entryLow ?? c.entryHigh)
      : (c.entryLow != null && c.entryHigh != null ? (c.entryLow + c.entryHigh) / 2 : (c.entryLow ?? c.entryHigh ?? c.price));
    const tpPrices = c.tps.map((t) => t.price).filter((n) => Number.isFinite(n));
    if (entryRef == null || c.stop == null || !tpPrices.length || !c.direction) continue;
    await logSignal({
      engine: "xghost", userId,
      instrument: c.symbol, symbol: c.symbol, style: "scalp",
      method: c.family, direction: c.direction, orderType: isMarket ? "market" : "limit",
      entry: entryRef, stop: c.stop, tps: tpPrices,
      confidence: c.grade && c.grade !== "NONE" ? c.grade : undefined, score: c.score,
      regime: c.regime, session: c.session, priceAtIssue: c.price ?? undefined,
      interval: "5min", fingerprint: c.fingerprint || undefined,
      expiresAt: c.expiresAtUtc || undefined,
      meta: {
        variant: "xghost", family: c.family, grade: c.grade, exec_state: c.execState,
        rr_main: c.rrMain, rr1: c.rr1, usd_leg: c.usdLeg,
        dxy_state: dxy.state, dxy_score: dxy.score, dxy_source: dxy.source, dxy_confirm: c.dxyConfirm,
        strategy_version: XGHOST_VERSION,
      },
    });
    logged++;
  }
  return logged;
}
