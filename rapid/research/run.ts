import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, withOverrides } from "../config/defaults";
import { loadWindow, type Window } from "./loader";
import { runWindow, summarise, type BacktestResult, type Trade } from "./backtest";

/**
 * Market evaluation.
 *
 * Reports what happened, including the parts that are unflattering. A result here is evidence about
 * the RULES over the sampled period, on 5-minute OHLC, with an assumed spread. It is not evidence
 * that the strategy makes money, and this script will not print a sentence saying that it does.
 */

const DATA = join(import.meta.dirname ?? "rapid/research", "data");

/**
 * Chronological split, not a random one. Intraday trades within a window overlap each other, so
 * shuffling them would leak the same market conditions into both sides of the split. Parameters were
 * frozen in config/defaults.ts before any of this ran and were not touched afterwards.
 */
const PHASES: Record<string, Window["phase"]> = {
  "w1-2024-10": "dev",
  "w2-2025-01": "dev",
  "w3-2025-05": "validation",
  "w4-2026-04": "holdout",
  "w5-2026-08": "holdout",
};

function load(): Window[] {
  const out: Window[] = [];
  for (const f of readdirSync(DATA).filter((f) => f.endsWith(".txt")).sort()) {
    const name = f.replace(/\.txt$/, "");
    const w = loadWindow(join(DATA, f), name, PHASES[name] ?? "dev");
    if (w) out.push(w);
  }
  return out;
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function reportOne(r: BacktestResult, label: string) {
  const s = summarise(r.trades);
  console.log(`\n── ${r.window} [${r.phase}] ${label} ─────────────────────────────`);
  console.log(`   ${r.from.slice(0, 10)} to ${r.to.slice(0, 10)} · ${r.bars} closed M5 bars · ${r.coverageNote}`);
  console.log(`   evaluations ${r.evaluations} · candidates surfaced ${r.candidates} · trades taken ${s.trades}`);
  if (!s.trades) {
    console.log("   NO TRADES. The rejection funnel below is the whole result.");
  } else {
    console.log(`   net ${s.netR.toFixed(2)}R · expectancy ${s.expectancyR}R/trade` +
      (s.expectancyCi ? ` (95% CI ${s.expectancyCi[0]} to ${s.expectancyCi[1]})` : ""));
    console.log(`   win ${pct(s.winRate)} (${s.wins}W ${s.losses}L ${s.breakevens}BE) · profit factor ${s.profitFactor ?? "—"} · max drawdown ${s.maxDrawdownR}R`);
    console.log(`   median favourable excursion ${s.medianMfe} · median adverse ${s.medianMae} · median hold ${s.medianBarsHeld} bars`);
    console.log(`   exits ${JSON.stringify(s.byExit)}`);
    console.log(`   by family ${JSON.stringify(Object.fromEntries(Object.entries(s.byFamily).map(([k, v]) => [k, `${v.n} trades, ${v.netR.toFixed(2)}R`])))}`);
    if (s.ambiguous) console.log(`   ${s.ambiguous} trade(s) resolved ADVERSELY because the bar touched both the entry and the stop and OHLC cannot say which came first`);
  }
  const top = Object.entries(r.funnel).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`   rejection funnel: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

function main() {
  const windows = load();
  if (!windows.length) {
    console.log("No replay windows on disk. Use loader.EXTRACT_SQL to produce one from genx_candle_archive.");
    return;
  }

  console.log("RAPID replay — strategy", DEFAULT_CONFIG.version, "config", DEFAULT_CONFIG.configVersion);
  console.log("Parameters were frozen before this ran. Nothing below was tuned to these periods.");

  const all: Trade[] = [];
  for (const w of windows) {
    const on = runWindow(w, { management: true });
    process.stderr.write(`[done ${w.name} ON]\n`);
    reportOne(on, "management ON");
    all.push(...on.trades);

    const off = runWindow(w, { management: false });
    reportOne(off, "management OFF");
  }

  // Per phase, so the held-out periods can be read on their own.
  console.log("\n── by phase, management ON ─────────────────────────────");
  for (const phase of ["dev", "validation", "holdout"] as const) {
    const t = all.filter((x) => x.phase === phase);
    const s = summarise(t);
    console.log(`   ${phase.padEnd(11)} ${String(s.trades).padStart(4)} trades  net ${String(s.netR).padStart(8)}R  expectancy ${String(s.expectancyR ?? "—").padStart(8)}R` +
      (s.expectancyCi ? `  95% CI ${s.expectancyCi[0]} to ${s.expectancyCi[1]}` : ""));
  }

  // Sensitivity: does the answer survive a worse spread and a tighter target?
  console.log("\n── sensitivity ─────────────────────────────");
  for (const [label, opts] of [
    ["spread 0.35 (base)", { spread: 0.35 }],
    ["spread 0.80 (the ceiling)", { spread: 0.8 }],
    ["breakeven off", { cfg: withOverrides(DEFAULT_CONFIG, "no-be", { management: { beMinUsd: 9999 } }) }],
    ["stop cap 6 instead of 10", { cfg: withOverrides(DEFAULT_CONFIG, "cap6", { protection: { stopCapUsd: 6 } }) }],
  ] as const) {
    const t: Trade[] = [];
    for (const w of windows) t.push(...runWindow(w, { management: true, everyBars: 4, ...opts }).trades);
    const s = summarise(t);
    console.log(`   ${label.padEnd(28)} trades ${String(s.trades).padStart(4)}  net ${String(s.netR).padStart(8)}R  expectancy ${s.expectancyR ?? "—"}R`);
  }

  const s = summarise(all);
  console.log("\n── overall, management ON ─────────────────────────────");
  console.log(`   ${s.trades} trades across ${windows.length} window(s), ${windows.reduce((a, w) => a + w.bars.length, 0)} closed M5 bars`);
  console.log(`   net ${s.netR}R, expectancy ${s.expectancyR}R/trade` + (s.expectancyCi ? `, 95% CI ${s.expectancyCi[0]} to ${s.expectancyCi[1]}` : ""));

  console.log("\n── verdict ─────────────────────────────");
  const conclusive = s.trades >= 100 && s.expectancyCi != null && s.expectancyCi[0] > 0;
  if (conclusive) {
    console.log("   Positive expectancy with the lower confidence bound above zero on this sample.");
    console.log("   That is still ONE instrument over a limited period on OHLC data with an assumed spread.");
  } else {
    console.log("   INCONCLUSIVE. Not a profitability claim, in either direction.");
    const reasons: string[] = [];
    if (s.trades < 100) reasons.push(`only ${s.trades} trades — too few for the uncertainty to mean anything`);
    if (s.expectancyCi && s.expectancyCi[0] <= 0 && s.expectancyCi[1] >= 0) reasons.push("the confidence interval spans zero");
    if (s.expectancyR != null && s.expectancyR < 0) reasons.push("the point estimate is negative");
    reasons.push("5-minute OHLC cannot verify intrabar touch order or same-bar management");
    reasons.push("the spread is assumed, not measured from the account that would trade it");
    for (const r of reasons) console.log(`   · ${r}`);
  }
}

main();
