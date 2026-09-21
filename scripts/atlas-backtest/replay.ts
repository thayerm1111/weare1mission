/**
 * ATLAS SETUP REPLAY — the live Command Center pipeline (buildSnapshot → perceive → findSetup, owner
 * profile: Quick + Normal, min confidence 55) stepped over every closed 5-minute bar of archived gold.
 * Writes every trade-ready setup to JSONL with whether it needed the 09-21 "0.8:1 from here" relaxation.
 *
 * npx tsx scripts/atlas-backtest/replay.ts <bars5.json> <from> <to> <out.jsonl>
 */
import fs from "fs";
import { buildSnapshot } from "../../command-center/engines/snapshot";
import { findSetup } from "../../command-center/engines/setup";
import { perceive } from "../../command-center/brain/index";
import { emptyRolling } from "../../command-center/brain/memory";
import { asSetupProfile, DEFAULT_PROFILE } from "../../command-center/engines/profile";
import type { Bar, Timeframe } from "../../command-center/core/types";

type B = [number, number, number, number, number];
const [, , file, fromS, toS, outFile] = process.argv;
const raw = JSON.parse(fs.readFileSync(file, "utf8")) as B[];
const from = Number(fromS), to = Number(toS);
const m5: Bar[] = raw.map((r) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4] }));

function agg(src: Bar[], ms: number): Bar[] {
  const out: Bar[] = [];
  for (const b of src) {
    const k = Math.floor(b.t / ms) * ms, l = out[out.length - 1];
    if (l && l.t === k) { l.h = Math.max(l.h, b.h); l.l = Math.min(l.l, b.l); l.c = b.c; }
    else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}
const series: Record<string, Bar[]> = { "15m": agg(m5, 900_000), "1h": agg(m5, 3_600_000), "4h": agg(m5, 14_400_000), "1d": agg(m5, 86_400_000) };
const ptr: Record<string, number> = { "15m": 0, "1h": 0, "4h": 0, "1d": 0 };
const MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const SIZE: Record<string, number> = { "5m": 200, "15m": 150, "1h": 150, "4h": 120, "1d": 60 };

function upTo(tf: string, now: number, cur: Bar, i: number): Bar[] {
  const s = series[tf];
  while (ptr[tf] < s.length && s[ptr[tf]].t + MS[tf] <= now) ptr[tf]++;
  const closed = s.slice(Math.max(0, ptr[tf] - SIZE[tf] + 1), ptr[tf]);
  // the bucket in progress, built from the 5m bars so far (the live feed includes it)
  const k = Math.floor((now - 1) / MS[tf]) * MS[tf];
  const inb: Bar[] = [];
  for (let j = i; j >= 0 && m5[j].t >= k; j--) inb.unshift(m5[j]);
  if (inb.length) closed.push({ t: k, o: inb[0].o, h: Math.max(...inb.map((b) => b.h)), l: Math.min(...inb.map((b) => b.l)), c: cur.c });
  return closed;
}
const open = (t: number) => { const d = new Date(t); const wd = d.getUTCDay(), h = d.getUTCHours(); return !(wd === 6 || (wd === 5 && h >= 21) || (wd === 0 && h < 22)); };

let rolling = emptyRolling();
const profile = asSetupProfile(DEFAULT_PROFILE);
fs.writeFileSync(outFile, "");
const buf: string[] = [];
let n = 0, ready = 0;
for (let i = 250; i < m5.length; i++) {
  const b = m5[i];
  const now = b.t + 300_000;
  if (now < from * 1000 || now > to * 1000 || !open(now)) continue;
  const bars: Partial<Record<Timeframe, Bar[]>> = { "5m": m5.slice(i - SIZE["5m"] + 1, i + 1) };
  for (const tf of ["15m", "1h", "4h", "1d"]) bars[tf as Timeframe] = upTo(tf, now, b, i);
  let snap;
  try {
    snap = buildSnapshot({ now, bars, price: b.c, bid: b.c - 0.15, ask: b.c + 0.15, feeds: [{ feed: "twelvedata", state: "live", ageMs: 1000, lastTickMs: now - 1000 }] as never });
  } catch { continue; }
  const pc = perceive({ rolling, snapshot: snap } as never);
  rolling = pc.rolling;
  // the worker's rolling memory is bounded by the brain's own retention; keep it bounded here too
  if (rolling.snapshots.length > 60) rolling.snapshots = rolling.snapshots.slice(-60);
  if (rolling.events.length > 300) rolling.events = rolling.events.slice(-300);
  if (rolling.statements.length > 100) rolling.statements = rolling.statements.slice(-100);
  if (rolling.theses.length > 50) rolling.theses = rolling.theses.slice(-50);
  if (rolling.lessons.length > 100) rolling.lessons = rolling.lessons.slice(-100);
  if (n % 500 === 0) console.log(`progress ${new Date(now).toISOString()} steps ${n} ready ${ready} rss ${Math.round(process.memoryUsage().rss / 1e6)}MB`);
  n++;
  const setup = findSetup({ snapshot: snap, profile, marketOpen: true, now, thesisBias: pc.thesis.bias ?? null, thesisConfidence: pc.thesis.confidence ?? null });
  if (setup.state !== "trade_ready" || !setup.side || setup.stop == null || setup.initialObjective == null) continue;
  ready++;
  const relaxed = setup.conditions.some((c) => c.id === "trigger" && c.text.startsWith("Reward:risk from here"));
  buf.push(JSON.stringify({ t: now, i, price: b.c, side: setup.side, style: setup.style, strategy: setup.strategy, stop: setup.stop, tp1: setup.initialObjective, tp2: setup.extendedObjective, conf: setup.confidence, relaxed, session: snap.session, regime: snap.regime }) + "\n");
  if (buf.length >= 200) { fs.appendFileSync(outFile, buf.join("")); buf.length = 0; }
}
fs.appendFileSync(outFile, buf.join(""));
console.log(`steps ${n}, trade-ready ${ready}`);
