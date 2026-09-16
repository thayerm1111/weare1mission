import { readFileSync, writeFileSync } from "node:fs";
import { tradableOnly } from "../src/lib/genx3/v31/series";
const [, , inp, out] = process.argv;
const raw = (JSON.parse(readFileSync(inp, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const tr = tradableOnly(raw);
const byMonth: Record<string, number> = {};
for (const b of tr) { const k = new Date(b.t).toISOString().slice(0, 7); byMonth[k] = (byMonth[k] ?? 0) + 1; }
writeFileSync(out, JSON.stringify(tr.map((b) => [b.t, b.o, b.h, b.l, b.c])));
console.log(raw.length, tr.length, JSON.stringify(byMonth));
