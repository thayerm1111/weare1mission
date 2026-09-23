/**
 * `npm run auric-research` — runs the walk-forward replay on archived XAU/USD M1 candles (read-only) and
 * writes the report to auric_settings.research_report. Runs on Railway as a one-off; never trades.
 */
import { admin } from "../db";
import { backtest, type BtAssumptions } from "./backtest";
import type { Bar } from "../core/types";
import { DEFAULT_CONFIG } from "../config/defaults";

async function loadBars(fromIso: string): Promise<Bar[]> {
  const db = admin(); const out: Bar[] = []; let cursor = fromIso;
  for (;;) {
    const { data, error } = await db.from("genx_candle_archive").select("t,o,h,l,c").eq("symbol", "XAU/USD").eq("interval", "1min").gt("t", cursor).order("t").limit(20000);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const r of data) out.push({ t: Date.parse(r.t), o: +r.o, h: +r.h, l: +r.l, c: +r.c });
    cursor = data[data.length - 1].t; console.log(`[research] loaded ${out.length} bars to ${cursor}`);
    if (data.length < 20000) break;
  }
  return out;
}

async function main() {
  const months = Number(process.env.AURIC_RESEARCH_MONTHS ?? 12);
  const from = new Date(Date.now() - months * 30.4 * 86_400_000).toISOString();
  const bars = await loadBars(from);
  console.log(`[research] ${bars.length} bars from ${from}`);
  const base: BtAssumptions = { spread: 0.30, slippageTicks: 15, commissionPerLot: 0, equity: 1000, riskFraction: 0.005, label: "base: spread 0.30, slip 15 ticks, $1000, 0.5%" };
  const variants: BtAssumptions[] = [
    base,
    { ...base, spread: 0.20, label: "tight: spread 0.20" },
    { ...base, spread: 0.50, slippageTicks: 30, label: "adverse: spread 0.50, slip 30 ticks" },
    { ...base, equity: 500, label: "small: $500 equity (min-lot skips expected)" },
  ];
  const reports = [];
  for (const v of variants) { console.log(`[research] running ${v.label}`); const r = backtest(bars, v, DEFAULT_CONFIG, { log: (s) => console.log("[research]", s) }); reports.push(r); console.log(`[research] ${v.label}: trades ${r.trades} net ${r.net} PF ${r.profitFactor} DD ${r.maxDrawdownPct}%`); }
  // Stricter no-retest breakout variant, separately versioned, base assumptions.
  const nr = backtest(bars, { ...base, label: "variant: no-retest breakout ON" }, { ...DEFAULT_CONFIG, version: DEFAULT_CONFIG.version + "+no-retest", setups: { ...DEFAULT_CONFIG.setups, breakout: { ...DEFAULT_CONFIG.setups.breakout, noRetestVariant: true } } });
  reports.push(nr);
  await admin().from("auric_settings").upsert({ key: "research_report", value: { at: new Date().toISOString(), months, bars: bars.length, reports }, updated_at: new Date().toISOString() });
  console.log("[research] report stored in auric_settings.research_report");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
