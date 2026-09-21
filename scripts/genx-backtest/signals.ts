/**
 * GENX 1.0 SIGNAL REPLAY — runs the live engine (runEngine + buildGenx, quick mode, GENX2 flags off)
 * on every closed 5-minute bar of the archived XAU/USD history, exactly as the scanner would have seen
 * it, and writes every actionable read (TRADE_READY / DEVELOPING_SETUP) to a JSONL file.
 *
 * Usage: npx tsx scripts/genx-backtest/signals.ts <bars5.json> <fromEpoch> <toEpoch> <out.jsonl>
 */
import fs from "fs";
import { runEngine, type EngineCfg } from "../../src/lib/omEngine";
import { buildGenx, GOLD, MODES, sessionNow, type Row } from "../../src/lib/genxCompute";

type B = [number, number, number, number, number];
const [, , file, fromS, toS, outFile, modeArg] = process.argv;
const MODE = (modeArg === "intraday" || modeArg === "swing" ? modeArg : "quick") as "quick" | "intraday" | "swing";
const bars5 = JSON.parse(fs.readFileSync(file, "utf8")) as B[];
const from = Number(fromS), to = Number(toS);

function agg(src: B[], sec: number): B[] {
  const out: B[] = [];
  for (const b of src) {
    const k = Math.floor(b[0] / sec) * sec, l = out[out.length - 1];
    if (l && l[0] === k) { l[2] = Math.max(l[2], b[2]); l[3] = Math.min(l[3], b[3]); l[4] = b[4]; }
    else out.push([k, b[1], b[2], b[3], b[4]]);
  }
  return out;
}
const s15 = agg(bars5, 900), s30 = agg(bars5, 1800), s60 = agg(bars5, 3600), s240 = agg(bars5, 14400), s1d = agg(bars5, 86400);
const dt = (e: number) => new Date(e * 1000).toISOString().slice(0, 19).replace("T", " ");
const toRow = (b: B): Row => ({ datetime: dt(b[0]), open: String(b[1]), high: String(b[2]), low: String(b[3]), close: String(b[4]) });

/** Bars of `s` (period `sec`) closed by `t`, plus the forming bar built from 5m bars up to t. */
function window(s: B[], sec: number, t: number, n: number, pos: { i: number }): Row[] {
  while (pos.i < s.length && s[pos.i][0] + sec <= t) pos.i++;
  const closed = s.slice(Math.max(0, pos.i - n), pos.i).map(toRow);
  // forming bar: the current bucket so far (last 5m close as its price)
  const last5 = cur5;
  closed.push({ datetime: dt(Math.floor(t / sec) * sec), open: String(last5[4]), high: String(last5[4]), low: String(last5[4]), close: String(last5[4]) });
  return closed;
}
let cur5: B = bars5[0];
const p15 = { i: 0 }, p30 = { i: 0 }, p60 = { i: 0 }, p15b = { i: 0 }, p60b = { i: 0 }, p240 = { i: 0 }, p1d = { i: 0 };
const m = MODES[MODE];
const cfg: EngineCfg = { ...GOLD, ...m.eng } as EngineCfg;
fs.writeFileSync(outFile, "");
const buf: string[] = [];
const out = {
  write: (x: string) => { buf.push(x); if (buf.length >= 200) { fs.appendFileSync(outFile, buf.join("")); buf.length = 0; } },
  end: () => { fs.appendFileSync(outFile, buf.join("")); buf.length = 0; },
};
let n = 0, hits = 0;
for (let i = 200; i < bars5.length; i++) {
  if (MODE === "intraday" && i % 3 !== 0) continue; // intraday reads every 15 minutes
  const b = bars5[i];
  const t = b[0] + 300; // this 5m bar has just closed
  if (t < from || t > to) continue;
  cur5 = b;
  const m5 = bars5.slice(i - 149, i + 1).map(toRow);
  m5.push({ datetime: dt(t), open: String(b[4]), high: String(b[4]), low: String(b[4]), close: String(b[4]) });
  let h1: Row[], h4: Row[], d1: Row[], m30: Row[], m15: Row[];
  if (MODE === "intraday") {
    // intraday: d1=1day, h4=4h, h1=1h, m30=30min, m15=15min, m5=5min
    m15 = window(s15, 900, t, 150, p15); m30 = window(s30, 1800, t, 120, p30);
    h1 = window(s60, 3600, t, 120, p60); h4 = window(s240, 14400, t, 90, p240); d1 = window(s1d, 86400, t, 90, p1d);
  } else {
    h1 = window(s15, 900, t, 120, p15); m30 = h1;
    h4 = window(s30, 1800, t, 90, p30); d1 = window(s60, 3600, t, 90, p60); m15 = m5;
  }
  const price = b[4];
  const nowMs = t * 1000;
  const session = sessionNow(new Date(nowMs));
  n++;
  let read: Record<string, unknown>;
  try { read = runEngine(cfg, { d1, h4, h1, m30, m15, m5, price, nowMs, session } as never) as Record<string, unknown>; } catch { continue; }
  // volatility bucket exactly as computeGenxRead does it (on the "m15" = 5min series)
  const tr: number[] = [];
  for (let k = 1; k < m15.length; k++) { const h = +m15[k].high, l = +m15[k].low, pc = +m15[k - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  const atr = tr.slice(-14).reduce((a, x) => a + x, 0) / 14;
  const pct = atr / price;
  const volatility = pct >= 0.0018 ? "High" : pct <= 0.0007 ? "Low" : "Normal";
  const g = buildGenx(read, { mode: MODE, price, session, dataStatus: "live", hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, pip: GOLD.pip, dec: GOLD.dec, marketStory: [], volatility, atr, m15 }) as Record<string, unknown>;
  const st = String(g.engine_state || "");
  if ((st === "TRADE_READY" || st === "DEVELOPING_SETUP") && g.entry_low != null && g.entry_high != null && g.stop_loss != null) {
    hits++;
    out.write(JSON.stringify({ t, i, price, st, action: g.action, side: String(g.action).includes("SELL") ? "sell" : "buy", lo: g.entry_low, hi: g.entry_high, stop: g.stop_loss, tp1: g.tp1, tp2: g.tp2, inv: g.invalidation_price ?? g.stop_loss, watch: String(g.action).includes("SELL") ? (g.closest_resistance ?? g.entry) : (g.closest_support ?? g.entry), conf: g.confidence_score, profile: g.entry_profile, setup: g.setup_type, session, regime: g.market_regime, ms: g.market_structure, mom: g.momentum }) + "\n");
  }
}
out.end();
console.error(`reads ${n}, actionable ${hits}`);
