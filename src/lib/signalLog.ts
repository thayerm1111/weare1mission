import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Universal signal logger. EVERY generation engine (Plays, Scanner, Command,
 * MFXGHOST) records a row here the moment it produces a trade idea, so the
 * platform can later measure its own edge. This is fire-and-safe: it NEVER
 * throws and NEVER blocks signal generation — a logging failure must never cost
 * the user their signal. Rows are graded later by the scheduled resolver.
 */
export type SignalLogInput = {
  engine: "plays" | "scanner" | "command" | "ghost";
  userId?: string | null;
  instrument: string;              // canonical td, e.g. "XAU/USD", "NAS100"
  symbol?: string;
  style?: string;                  // scalp | intraday | swing
  method?: string;                 // best/smc/structure OR chosen-strategy label
  direction: string;               // LONG/SHORT or buy/sell (normalised below)
  orderType?: string;              // market | limit | stop
  entry: number;
  stop: number;
  tps?: number[];
  confidence?: string;             // High | Medium | Low
  score?: number;                  // 0-100 where available
  regime?: string;
  session?: string;
  atr?: number;
  priceAtIssue?: number;
  interval?: string;               // execution timeframe used
  meta?: Record<string, unknown>;
};

const normDir = (d: string): string =>
  /long|buy/i.test(d) ? "long" : /short|sell/i.test(d) ? "short" : String(d || "").toLowerCase();

// How long an idea stays live before the resolver marks it "expired" if it never
// hits a stop or target. Scaled by trading style.
function expiryForStyle(style?: string): string {
  const s = (style || "").toLowerCase();
  const hours = s.includes("scalp") ? 24 : s.includes("swing") ? 14 * 24 : 96; // scalp 1d, swing 14d, else 4d
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

export async function logSignal(s: SignalLogInput): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    const entry = Number(s.entry);
    const stop = Number(s.stop);
    if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry === stop) return;
    const tps = (s.tps || []).map(Number).filter((n) => Number.isFinite(n));
    const risk = Math.abs(entry - stop);
    const rrPlanned = risk > 0 && tps[0] != null ? +(Math.abs(tps[0] - entry) / risk).toFixed(2) : null;
    await admin.from("signal_log").insert({
      engine: s.engine,
      user_id: s.userId ?? null,
      instrument: s.instrument,
      symbol: s.symbol ?? s.instrument,
      style: s.style ?? null,
      method: s.method ?? null,
      direction: normDir(s.direction),
      order_type: s.orderType ?? null,
      entry,
      stop,
      tp1: tps[0] ?? null,
      tp2: tps[1] ?? null,
      tp3: tps[2] ?? null,
      confidence: s.confidence ?? null,
      score: Number.isFinite(Number(s.score)) ? Math.round(Number(s.score)) : null,
      regime: s.regime ?? null,
      session: s.session ?? null,
      atr_at_issue: Number.isFinite(Number(s.atr)) ? Number(s.atr) : null,
      price_at_issue: Number.isFinite(Number(s.priceAtIssue)) ? Number(s.priceAtIssue) : null,
      interval: s.interval ?? null,
      rr_planned: rrPlanned,
      expires_at: expiryForStyle(s.style),
      meta: s.meta ?? {},
    });
  } catch {
    // Swallow everything — logging must never break signal generation.
  }
}
