/**
 * COMMUNITY RESULTS — how the OM AI Plays members ran have done, platform-wide, as aggregates only.
 *
 * This was the database function community_signal_stats(), which counted from a date written into it
 * (2026-09-05) and so could not follow the record reset. It is worked out here instead, from the
 * signal_log rows at or after the reset (owner 10-11: "please reset all the stats on the platform"),
 * by /api/community-stats for the site and the phone app. The shape is the function's, so both screens
 * read it unchanged — with one fix: the function sent the same resolved plays twice, once under `live`
 * and again under `launch`, and both screens add the two together, so every W/L count (and the "enough
 * plays to headline a win rate" bar) was doubled. `launch` is now always zero.
 *
 * Pure, so the arithmetic is tested (tests/stats-reset.test.ts).
 */

export type PlayRow = {
  engine: string | null;
  user_id: string | null;
  instrument: string | null;
  direction: string | null;
  status: string | null;
  confidence: string | null;
  rr_planned: number | string | null;
  realized_r: number | string | null;
  hit_tp: number | null;
  created_at: string;
  resolved_at: string | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
// Two places, halves away from zero — as Postgres' round() did (−0.125 → −0.13, not −0.12).
const round2 = (x: number) => (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100 + 0;
const avg2 = (xs: number[]): number | null => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const DONE = new Set(["win", "loss", "expired", "unfilled"]);

export function communityStats(rows: ReadonlyArray<PlayRow>, nowMs: number = Date.now()) {
  const resolved = rows.filter((r) => r.status === "win" || r.status === "loss");
  const wins = resolved.filter((r) => r.status === "win").length;
  const losses = resolved.length - wins;

  const byEngine = new Map<string, { engine: string; generated: number; resolved: number; wins: number; losses: number }>();
  for (const r of rows) {
    const k = String(r.engine ?? "");
    const e = byEngine.get(k) ?? { engine: k, generated: 0, resolved: 0, wins: 0, losses: 0 };
    e.generated += 1;
    if (r.status === "win") { e.resolved += 1; e.wins += 1; }
    else if (r.status === "loss") { e.resolved += 1; e.losses += 1; }
    byEngine.set(k, e);
  }

  const inst = new Map<string, number>();
  for (const r of rows) inst.set(String(r.instrument ?? ""), (inst.get(String(r.instrument ?? "")) ?? 0) + 1);
  const topInstruments = [...inst.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([instrument, n]) => ({ instrument, n }));

  const at = (r: PlayRow) => r.resolved_at ?? r.created_at;
  const recent = rows
    .filter((r) => r.status === "win" || r.status === "loss" || r.status === "expired")
    .sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)))
    .slice(0, 12)
    .map((r) => ({ engine: r.engine, instrument: r.instrument, direction: r.direction, status: r.status, hit_tp: r.hit_tp, realized_r: num(r.realized_r), at: at(r) }));

  return {
    generated_at: new Date(nowMs).toISOString(),
    members_using: new Set(rows.map((r) => r.user_id).filter((u): u is string => !!u)).size,
    live: {
      generated: rows.length,
      generated_7d: rows.filter((r) => Date.parse(r.created_at) >= nowMs - 7 * 86_400_000).length,
      open: rows.filter((r) => r.status != null && !DONE.has(r.status)).length,
      resolved: resolved.length,
      wins,
      losses,
      expired: rows.filter((r) => r.status === "expired").length,
      avg_planned_rr: avg2(rows.map((r) => num(r.rr_planned)).filter((x): x is number => x != null)),
      avg_realized_r: avg2(resolved.map((r) => num(r.realized_r)).filter((x): x is number => x != null)),
      by_engine: [...byEngine.values()],
      top_instruments: topInstruments,
      direction: {
        long: rows.filter((r) => r.direction === "long").length,
        short: rows.filter((r) => r.direction === "short").length,
      },
      confidence: {
        High: rows.filter((r) => r.confidence === "High").length,
        Medium: rows.filter((r) => r.confidence === "Medium").length,
        Low: rows.filter((r) => /low/i.test(String(r.confidence ?? ""))).length,
      },
      recent,
    },
    launch: { resolved: 0, wins: 0, losses: 0 },
  };
}
