/** Usage: tsx scripts/genx3-replay.ts bars.json [fromISO] [toISO]  — bars: [[tMs,o,h,l,c],...] */
import { readFileSync } from "node:fs";
import { replay, summarize } from "../src/lib/genx3/replay";
const [, , file, from, to] = process.argv;
const bars = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const f = from ? Date.parse(from) : bars[0].t + 6 * 86_400_000;
const tt = to ? Date.parse(to) : bars.at(-1)!.t;
const t0 = Date.now();
const r = replay(bars, { from: f, to: tt });
const by = (k: "setup" | "regime" | "side") => Object.fromEntries([...new Set(r.trades.map((t) => t[k]))].map((v) => [v, summarize(r.trades.filter((t) => t[k] === v))]));
console.log(JSON.stringify({ ms: Date.now() - t0, range: [new Date(f).toISOString(), new Date(tt).toISOString()], decisions: r.decisions, signals: r.signals, missedFills: r.missedFills, noTrade: r.noTrade, all: summarize(r.trades), bySetup: by("setup"), byRegime: by("regime"), bySide: by("side"), trades: r.trades.slice(-12) }, null, 1));
