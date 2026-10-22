"use client";
import { useState } from "react";
import { CASHTRAP_SYMBOLS, SYMBOL_SPECS } from "@/lib/cashtrap/symbols";
import { postJson, usePoll } from "./useCashtrap";
import { C, localDateTime } from "./theme";

type SettingsPayload = { settings: { assumptions: Record<string, unknown>; visibility: string; dmiMode: string; dmiFeedVerified: boolean; liveEnabled: boolean }; configVersion: string; channels: Array<{ name: string; configured: boolean; kinds?: string[] }>; env: { dmiFeedSecret: boolean } };
type ZonesPayload = { zones: Array<{ id: string; symbol: string; kind: string; lower: number; upper: number; note: string | null; created_at: string; active_until: string | null; invalidated_at: string | null }> };
type RunsPayload = { runs: Array<{ id: string; status: string; params: { symbols: string[]; weeks: number; payouts: number[] }; report: Record<string, unknown> | null; error: string | null; created_at: string; finished_at: string | null }> };

/** Admin: the switches and assumptions, manual zones, and replay/backtest runs. */
export function AdminPanel() {
  return (
    <section className="space-y-4">
      <SettingsCard />
      <ZonesCard />
      <ReplayCard />
    </section>
  );
}

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: C.line, background: C.card }}>
      <h3 className="text-base font-semibold" style={{ color: C.ink }}>{title}</h3>
      {note && <p className="mt-0.5 text-[12px]" style={{ color: C.muted }}>{note}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function SettingsCard() {
  const { data, reload } = usePoll<SettingsPayload>("/api/cashtrap/settings", 120_000);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Card title="Settings">Loading…</Card>;
  const a = data.settings.assumptions as { bandExcursion: string; dmiWindowCandles: number; requireZone: boolean; maxEntryDelaySec: number; expiry: { mode: string; durationSec?: number; boundaryMinutes?: number; minSecondsToExpiry?: number }; tieRule: string; payoutRate: number | null };
  const save = async (body: Record<string, unknown>) => {
    const r = await postJson("/api/cashtrap/settings", body);
    setMsg(r.ok ? "Saved." : `Not saved: ${String(r.data.error ?? "")}${Array.isArray(r.data.details) ? ` — ${(r.data.details as string[]).join("; ")}` : ""}`);
    reload();
  };
  const sel = "rounded-lg border px-2 py-1 text-[12px]";
  return (
    <Card title="Settings" note={`Configuration ${data.configVersion}. Screenshot settings are fixed in code; these are the V1 assumptions and switches. Every change is logged.`}>
      <div className="grid gap-3 text-[13px] sm:grid-cols-2" style={{ color: C.ink }}>
        <label className="flex items-center justify-between gap-2">Live runner
          <select className={sel} style={{ borderColor: C.line }} value={data.settings.liveEnabled ? "on" : "off"} onChange={(e) => void save({ liveEnabled: e.target.value === "on" })}><option value="on">on</option><option value="off">off</option></select></label>
        <label className="flex items-center justify-between gap-2">Who can see Cashtrap
          <select className={sel} style={{ borderColor: C.line }} value={data.settings.visibility} onChange={(e) => void save({ visibility: e.target.value })}><option value="admin">admins only</option><option value="members">active members</option></select></label>
        <label className="flex items-center justify-between gap-2">DMI source
          <select className={sel} style={{ borderColor: C.line }} value={data.settings.dmiMode} onChange={(e) => void save({ dmiMode: e.target.value })}><option value="calculation">calculated (your source)</option><option value="event-feed">external event feed</option><option value="off">off (source required)</option></select></label>
        <label className="flex items-center justify-between gap-2">Event feed verified
          <select className={sel} style={{ borderColor: C.line }} value={data.settings.dmiFeedVerified ? "yes" : "no"} onChange={(e) => void save({ dmiFeedVerified: e.target.value === "yes" })} disabled={!data.env.dmiFeedSecret}><option value="no">no</option><option value="yes">yes</option></select></label>
        <label className="flex items-center justify-between gap-2">Band excursion
          <select className={sel} style={{ borderColor: C.line }} value={a.bandExcursion} onChange={(e) => void save({ assumptions: { bandExcursion: e.target.value } })}><option value="wick">wick outside band</option><option value="close">close outside band</option></select></label>
        <label className="flex items-center justify-between gap-2">DMI window (candles after)
          <select className={sel} style={{ borderColor: C.line }} value={a.dmiWindowCandles} onChange={(e) => void save({ assumptions: { dmiWindowCandles: Number(e.target.value) } })}>{[0, 1, 2, 3, 4, 5].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        <label className="flex items-center justify-between gap-2">Zone required
          <select className={sel} style={{ borderColor: C.line }} value={a.requireZone ? "yes" : "no"} onChange={(e) => void save({ assumptions: { requireZone: e.target.value === "yes" } })}><option value="yes">yes</option><option value="no">no</option></select></label>
        <label className="flex items-center justify-between gap-2">Max entry delay (s)
          <select className={sel} style={{ borderColor: C.line }} value={a.maxEntryDelaySec} onChange={(e) => void save({ assumptions: { maxEntryDelaySec: Number(e.target.value) } })}>{[5, 10, 15, 20, 30].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        <label className="flex items-center justify-between gap-2">Expiry
          <select className={sel} style={{ borderColor: C.line }} value={a.expiry.mode === "duration" ? `d${a.expiry.durationSec}` : `f${a.expiry.boundaryMinutes}`} onChange={(e) => { const v = e.target.value; void save({ assumptions: { expiry: v.startsWith("d") ? { mode: "duration", durationSec: Number(v.slice(1)) } : { mode: "fixed", boundaryMinutes: Number(v.slice(1)), minSecondsToExpiry: 60 } } }); }}>
            {[60, 120, 180, 300, 600, 900].map((s) => <option key={`d${s}`} value={`d${s}`}>{s / 60} min from entry</option>)}
            {[5, 15].map((m) => <option key={`f${m}`} value={`f${m}`}>fixed: next {m}-min boundary (≥ 60 s)</option>)}
          </select></label>
        <label className="flex items-center justify-between gap-2">Tie rule (broker)
          <select className={sel} style={{ borderColor: C.line }} value={a.tieRule} onChange={(e) => void save({ assumptions: { tieRule: e.target.value } })}><option value="refund">refund</option><option value="loss">loss</option></select></label>
        <label className="flex items-center justify-between gap-2">Net payout per win (broker)
          <select className={sel} style={{ borderColor: C.line }} value={a.payoutRate == null ? "" : String(a.payoutRate)} onChange={(e) => void save({ assumptions: { payoutRate: e.target.value === "" ? null : Number(e.target.value) } })}>
            <option value="">not set</option>{[0.7, 0.75, 0.8, 0.82, 0.85, 0.87, 0.9, 0.92, 0.95].map((p) => <option key={p} value={p}>{Math.round(p * 100)}%</option>)}
          </select></label>
      </div>
      <p className="mt-3 text-[12px]" style={{ color: C.muted }}>DMI event feed secret on the server: {data.env.dmiFeedSecret ? "set" : "not set"}. Alert channels: {data.channels.map((c) => `${c.name} ${c.configured ? `on (${(c.kinds ?? []).join(", ")})` : "not set up"}`).join(", ")}.</p>
      {msg && <p className="mt-2 text-[12px]" style={{ color: msg.startsWith("Saved") ? C.green : C.red }}>{msg}</p>}
    </Card>
  );
}

function ZonesCard() {
  const { data, reload } = usePoll<ZonesPayload>("/api/cashtrap/zones", 120_000);
  const [f, setF] = useState({ symbol: "EURUSD", kind: "support", lower: "", upper: "", note: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    const r = await postJson("/api/cashtrap/zones", { ...f, lower: Number(f.lower), upper: Number(f.upper) });
    setMsg(r.ok ? "Zone added — it applies from now on (never to earlier candles)." : `Not added: ${String(r.data.error ?? "")}`);
    if (r.ok) setF({ ...f, lower: "", upper: "", note: "" });
    reload();
  };
  const end = async (id: string) => { await postJson(`/api/cashtrap/zones?id=${encodeURIComponent(id)}`, {}, "DELETE"); reload(); };
  const inp = "w-full rounded-lg border px-2 py-1 text-[12px]";
  return (
    <Card title="Manual support/resistance zones" note="Marked zones are used from the moment they are added. Removing one ends it; the record of when it applied is kept.">
      <div className="grid gap-2 sm:grid-cols-6">
        <select className={inp} style={{ borderColor: C.line }} value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })}>{CASHTRAP_SYMBOLS.map((s) => <option key={s} value={s}>{SYMBOL_SPECS[s].label}</option>)}</select>
        <select className={inp} style={{ borderColor: C.line }} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="support">support</option><option value="resistance">resistance</option></select>
        <input className={inp} style={{ borderColor: C.line }} inputMode="decimal" placeholder="lower" value={f.lower} onChange={(e) => setF({ ...f, lower: e.target.value })} />
        <input className={inp} style={{ borderColor: C.line }} inputMode="decimal" placeholder="upper" value={f.upper} onChange={(e) => setF({ ...f, upper: e.target.value })} />
        <input className={inp} style={{ borderColor: C.line }} placeholder="note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button type="button" onClick={() => void add()} className="rounded-lg px-3 py-1 text-[12px] font-semibold text-white" style={{ background: C.blue }}>Add zone</button>
      </div>
      {msg && <p className="mt-2 text-[12px]" style={{ color: msg.startsWith("Zone added") ? C.green : C.red }}>{msg}</p>}
      <ul className="mt-3 space-y-1 text-[12px]" style={{ color: C.ink }}>
        {data?.zones.map((z) => (
          <li key={z.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1" style={{ borderColor: C.line }}>
            <span>{z.symbol} {z.kind} {z.lower}–{z.upper}{z.note ? ` · ${z.note}` : ""} <span style={{ color: C.faint }}>· added {localDateTime(Date.parse(z.created_at))}{z.active_until ? ` · ended ${localDateTime(Date.parse(z.active_until))}` : ""}{z.invalidated_at ? " · broken" : ""}</span></span>
            {!z.active_until && <button type="button" onClick={() => void end(z.id)} className="text-[11px] underline" style={{ color: C.red }}>End</button>}
          </li>
        ))}
        {!data?.zones.length && <li style={{ color: C.faint }}>No manual zones.</li>}
      </ul>
    </Card>
  );
}

type SymStats = { candles?: number; error?: string; cutoff?: string | null; development?: Stats; outOfSample?: Stats; all?: Stats };
type Stats = { from: string | null; to: string | null; candlesDecided: number; dataUnavailable: number; setups: { armed: number; confirmed: number; cancelled: number; expired: number; confirmedNotPublished: number }; signals: number; signalsPerTradingDay: number | null; missed: number; wins: number; losses: number; ties: number; unresolved: number; winRateExTies: number | null; longestLosingStreak: number; netAt: Array<{ payout: number; breakEvenWinRate: number; netUnits: number; perSignal: number | null }> };

function ReplayCard() {
  const { data, reload } = usePoll<RunsPayload>("/api/cashtrap/replay", 30_000);
  const [weeks, setWeeks] = useState(8);
  const [msg, setMsg] = useState<string | null>(null);
  const queue = async () => {
    const r = await postJson("/api/cashtrap/replay", { symbol: "all", weeks, payouts: [0.8] });
    setMsg(r.ok ? "Queued — the runner starts it within five minutes." : `Not queued: ${String(r.data.error ?? "")}`);
    reload();
  };
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  return (
    <Card title="Replay / backtest" note="Each market separately, on real 5-minute history, with the live engine's own step; chronological development period and a later out-of-sample period. Outcomes use the bar-open proxy (optimistic, general feed) — simulated, not broker-verified.">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <label className="inline-flex items-center gap-1">Weeks
          <select className="rounded-lg border px-2 py-1" style={{ borderColor: C.line }} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[2, 4, 8, 12].map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
        <button type="button" onClick={() => void queue()} className="rounded-lg px-3 py-1 font-semibold text-white" style={{ background: C.purple }}>Run replay (all four markets)</button>
        {msg && <span style={{ color: msg.startsWith("Queued") ? C.green : C.red }}>{msg}</span>}
      </div>
      <div className="mt-3 space-y-3">
        {data?.runs.map((r) => {
          const by = ((r.report as { bySymbol?: Record<string, SymStats> } | null)?.bySymbol ?? {}) as Record<string, SymStats>;
          return (
            <div key={r.id} className="rounded-xl border p-3" style={{ borderColor: C.line }}>
              <p className="text-[12px]" style={{ color: C.muted }}>{localDateTime(Date.parse(r.created_at))} · {r.params.weeks} weeks · {r.status}{r.error ? ` — ${r.error}` : ""}</p>
              {r.status === "done" && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-[12px]" style={{ color: C.ink }}>
                    <thead style={{ color: C.faint }}><tr>{["Market", "Period", "Candles", "Setups armed", "Signals", "Per day", "W / L / T", "Win rate (ex ties)", "Longest losing streak", "Net @ 80% (units)", "Break-even"].map((h) => <th key={h} className="pb-1 pr-3 font-medium">{h}</th>)}</tr></thead>
                    <tbody>
                      {Object.entries(by).flatMap(([sym, s]) => s.error ? [<tr key={sym}><td className="pr-3">{sym}</td><td colSpan={10} style={{ color: C.red }}>{s.error}</td></tr>] : ([["development", s.development], ["out-of-sample", s.outOfSample]] as Array<[string, Stats | undefined]>).map(([label, st]) => st && (
                        <tr key={`${sym}-${label}`} className="border-t" style={{ borderColor: C.line }}>
                          <td className="py-1 pr-3">{sym}</td>
                          <td className="whitespace-nowrap pr-3">{label}<br /><span style={{ color: C.faint }}>{st.from?.slice(0, 10)} → {st.to?.slice(0, 10)}</span></td>
                          <td className="pr-3">{st.candlesDecided}</td>
                          <td className="pr-3">{st.setups.armed}</td>
                          <td className="pr-3">{st.signals}</td>
                          <td className="pr-3">{st.signalsPerTradingDay ?? "—"}</td>
                          <td className="pr-3">{st.wins} / {st.losses} / {st.ties}{st.unresolved ? ` (+${st.unresolved} unresolved)` : ""}</td>
                          <td className="pr-3">{pct(st.winRateExTies)}</td>
                          <td className="pr-3">{st.longestLosingStreak}</td>
                          <td className="pr-3 font-mono">{st.netAt[0]?.netUnits ?? "—"}</td>
                          <td className="pr-3">{pct(st.netAt[0]?.breakEvenWinRate)}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
        {!data?.runs.length && <p className="text-[12px]" style={{ color: C.faint }}>No runs yet.</p>}
      </div>
    </Card>
  );
}
