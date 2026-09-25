import { readFileSync, existsSync } from "node:fs";
import type { Bar } from "../core/types";

/**
 * Replay data loader.
 *
 * The archive holds 1-minute XAUUSD OHLC. It does NOT hold bid/ask ticks, and that limitation is
 * load-bearing for how the results may be read: with OHLC alone the exact order of the high and the
 * low inside a bar is unknown, so a bar that touched both an entry band and a stop cannot be
 * resolved honestly. Every such bar is counted as AMBIGUOUS and resolved adversely, never
 * favourably, and the count is reported.
 *
 * On-disk format, chosen so a window is a single line and a checksum can prove it arrived intact:
 *
 *   line 1: t0Epoch p0Cents barCount md5
 *   line 2: payload — bars separated by ';', each "o,h,l,c" as integer-cent deltas from the
 *           PREVIOUS bar's close (the first bar is relative to p0Cents). A run of missing 5-minute
 *           slots is written "#k " before the next bar, so weekends and halts survive the encoding
 *           instead of being silently closed up.
 */

export type Window = { name: string; phase: "dev" | "validation" | "holdout"; bars: Bar[]; gaps: number };

export function decode(t0Epoch: number, p0Cents: number, payload: string): { bars: Bar[]; gaps: number } {
  const bars: Bar[] = [];
  let slot = 0;
  let prevClose = p0Cents;
  let gaps = 0;
  for (const raw of payload.split(";")) {
    let tok = raw.trim();
    if (!tok) continue;
    if (tok.startsWith("#")) {
      const sp = tok.indexOf(" ");
      const skip = Number(tok.slice(1, sp === -1 ? undefined : sp));
      if (Number.isFinite(skip)) { slot += skip; gaps++; }
      tok = sp === -1 ? "" : tok.slice(sp + 1);
      if (!tok) continue;
    }
    const p = tok.split(",");
    if (p.length !== 4) continue;
    const o = prevClose + Number(p[0]);
    const h = prevClose + Number(p[1]);
    const l = prevClose + Number(p[2]);
    const c = prevClose + Number(p[3]);
    bars.push({ t: (t0Epoch + slot * 300) * 1000, o: o / 100, h: h / 100, l: l / 100, c: c / 100 });
    prevClose = c;
    slot++;
  }
  return { bars, gaps };
}

export function loadWindow(path: string, name: string, phase: Window["phase"]): Window | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const nl = text.indexOf("\n");
  const header = text.slice(0, nl).trim().split(/\s+/);
  const payload = text.slice(nl + 1).trim();
  const { bars, gaps } = decode(Number(header[0]), Number(header[1]), payload);
  const expected = Number(header[2]);
  if (bars.length !== expected) {
    throw new Error(`${name}: decoded ${bars.length} bars, header says ${expected} — the file is corrupt, refusing to evaluate on it`);
  }
  return { name, phase, bars, gaps };
}

/**
 * The full archive lives in Supabase. This is the query that produces a window file, so anyone with
 * database access can regenerate any period rather than trusting the three committed samples.
 */
export const EXTRACT_SQL = `
-- psql -At -f this.sql > rapid/research/data/<name>.txt   (set :a and :b)
with w as (select :'a'::timestamptz a, :'b'::timestamptz b),
m5 as (select floor(extract(epoch from t)/300)::bigint slot,
       (array_agg(o order by t))[1] o, max(h) h, min(l) l, (array_agg(c order by t desc))[1] c
       from genx_candle_archive, w where symbol='XAU/USD' and interval='1min' and t>=w.a and t<w.b group by 1),
s as (select slot, round(o*100)::bigint o, round(h*100)::bigint h, round(l*100)::bigint l, round(c*100)::bigint c,
       lag(round(c*100)::bigint) over (order by slot) pc, lag(slot) over (order by slot) ps from m5),
b as (select min(slot) s0, (select round(o*100)::bigint from m5 order by slot limit 1) c0 from m5),
p as (select string_agg(case when ps is null or slot=ps+1 then '' else '#'||(slot-ps-1)::text||' ' end ||
        concat_ws(',', o-coalesce(pc,(select c0 from b)), h-coalesce(pc,(select c0 from b)),
                       l-coalesce(pc,(select c0 from b)), c-coalesce(pc,(select c0 from b))), ';' order by slot) payload,
      count(*) n from s)
select (select s0 from b)*300 || ' ' || (select c0 from b) || ' ' || n || ' ' || md5(payload) || E'\\n' || payload from p;
`;
