/**
 * TRAIN THE DIRECTION MODEL on the desk's own gold archive (genx_candle_archive, 1-minute bars).
 *
 * Walk-forward and honest: the model is fitted on the OLDER part of the history and scored on the newer part
 * it has never seen. What it prints is what the geometry would actually have paid, including a cost
 * assumption — not an in-sample fantasy. Run: npx tsx research/trainQuant.ts [tpPips] [slPips] [tfMinutes]
 */
import { createClient } from "@supabase/supabase-js";
import { features, toVector, type Bar } from "../src/lib/genx/quant/features";
import { labelPath, breakEvenRate, expectancy, type Geometry } from "../src/lib/genx/quant/label";
import { fitLogistic, standardise, sigmoid, auc } from "../src/lib/genx/quant/model";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const tp = Number(process.argv[2] ?? 45), sl = Number(process.argv[3] ?? 35), tf = Number(process.argv[4] ?? 5);

async function loadBars(): Promise<Bar[]> {
  const db = createClient(URL, KEY, { auth: { persistSession: false } });
  const out: Bar[] = [];
  let from = "2024-09-01T00:00:00Z";
  for (let page = 0; page < 200; page++) {
    const { data, error } = await db.from("genx_candle_archive")
      .select("t,o,h,l,c").eq("interval", "1min").gt("t", from).order("t", { ascending: true }).limit(5000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { t: string; o: number; h: number; l: number; c: number }[];
    if (!rows.length) break;
    for (const r of rows) out.push({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c });
    from = rows[rows.length - 1].t;
    if (rows.length < 5000) break;
  }
  return out;
}

/** 1-minute bars → tf-minute bars. */
function resample(bars: Bar[], minutes: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += minutes) {
    const w = bars.slice(i, i + minutes);
    if (w.length < minutes) break;
    out.push({ t: w[0].t, o: w[0].o, h: Math.max(...w.map((b) => b.h)), l: Math.min(...w.map((b) => b.l)), c: w[w.length - 1].c });
  }
  return out;
}

async function main() {
  const raw = await loadBars();
  const bars = resample(raw, tf);
  const g: Geometry = { tpPips: tp, slPips: sl, horizonBars: Math.round(240 / tf), pip: 0.1 };
  console.log(`loaded ${raw.length} 1m bars → ${bars.length} ${tf}m bars · geometry ${tp}/${sl} · horizon ${g.horizonBars} bars`);

  for (const side of ["buy", "sell"] as const) {
    const X: number[][] = [], Y: number[] = [];
    for (let i = 120; i < bars.length - g.horizonBars - 1; i++) {
      const f = features(bars.slice(0, i + 1));
      if (!f) continue;
      const y = labelPath(bars, i, side, g);
      if (y == null) continue;
      X.push(toVector(f)); Y.push(y);
    }
    if (X.length < 500) { console.log(`${side}: not enough labelled rows (${X.length})`); continue; }
    const cut = Math.floor(X.length * 0.7);
    const { mean, sd } = standardise(X.slice(0, cut));
    const z = X.map((r) => r.map((v, i) => (v - mean[i]) / (sd[i] || 1)));
    const { weights, bias } = fitLogistic(z.slice(0, cut), Y.slice(0, cut), { epochs: 500, lr: 0.25, l2: 1e-3 });

    const testZ = z.slice(cut), testY = Y.slice(cut);
    const scores = testZ.map((r) => sigmoid(bias + r.reduce((s, v, i) => s + weights[i] * v, 0)));
    const base = testY.reduce((a, b) => a + b, 0) / testY.length;
    const be = breakEvenRate(g);
    const a = auc(scores, testY);

    // What the gate would actually have done out of sample, at a few thresholds.
    console.log(`\n=== ${side.toUpperCase()} · rows ${X.length} (test ${testY.length}) · base hit ${(base * 100).toFixed(1)}% · break-even ${(be * 100).toFixed(1)}% · AUC ${a.toFixed(3)}`);
    for (const thr of [be, be + 0.02, be + 0.04, be + 0.06, be + 0.08]) {
      const taken = scores.map((s, i) => ({ s, y: testY[i] })).filter((r) => r.s >= thr);
      if (taken.length < 20) { console.log(`  thr ${(thr * 100).toFixed(1)}% → too few trades (${taken.length})`); continue; }
      const hit = taken.reduce((acc, r) => acc + r.y, 0) / taken.length;
      const perTrade = expectancy(hit, g, 3);
      const perDay = taken.length / ((testY.length * tf) / (60 * 24));
      console.log(`  thr ${(thr * 100).toFixed(1)}% → ${taken.length} trades (${perDay.toFixed(1)}/day) · hit ${(hit * 100).toFixed(1)}% · ${perTrade >= 0 ? "+" : ""}${perTrade.toFixed(1)} pips/trade · ${(perTrade * taken.length).toFixed(0)} pips total`);
    }
    console.log("  weights:", weights.map((w) => w.toFixed(2)).join(", "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
