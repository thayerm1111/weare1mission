"use client";

import { useEffect, useState } from "react";
import { Gem, RefreshCw, Loader2, Play, Database, Target } from "lucide-react";

/**
 * GENX Lab (admin) — the recorded-signal ledger and outcome analytics for the
 * flagship Gold engine (spec §33–§35). Every number comes from genx_signals: the
 * immutable decision fields plus the outcome_* columns the resolver fills. Nothing
 * here is fabricated — an empty ledger reads as empty.
 */
type Row = { key: string; n: number; resolved: number; wins: number; losses: number; win_rate: number };
type Recent = {
  id: string; created_at: string; mode: string | null; action: string | null; direction: string | null;
  confidence: number | null; entry: number | null; outcome: string | null; filled: boolean | null;
  mfe_pips: number | null; mae_pips: number | null; minutes_to_tp: number | null; regime: string | null;
};
type Data = {
  ok: boolean; needs_migration?: boolean; empty?: boolean; error?: string | null;
  overview: null | {
    total: number; resolved: number; open: number; wins: number; losses: number; win_rate: number;
    net_pips: number; avg_mfe: number; avg_mae: number; directional_accuracy: number; filled_rate: number;
  };
  by_mode: Row[]; by_action: Row[]; by_confidence: Row[]; recent: Recent[];
};

type AlertRow = {
  mode: string | null; side: string | null; action: string | null;
  entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2: number | null;
  confidence: number | null; state: string | null; created_at: string | null; enter_sent_at: string | null; updated_at: string | null;
};
type AlertsData = { configured: boolean; telegram: boolean; lastScanAt: string | null; tracking: AlertRow[]; recent: AlertRow[] };

const outColor = (o: string | null) =>
  o === "WIN" ? "text-emerald-400" : o === "LOSS" ? "text-red-400" : o === "EXPIRED" ? "text-white/50" : "text-amber-300/80";
const fmtDate = (s: string) => { try { return new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return s; } };
const agoShort = (s: string | null): string => {
  if (!s) return "—";
  const ms = Date.now() - new Date(s).getTime();
  if (!Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const zoneStr = (a: AlertRow) => (a.entry_low != null && a.entry_high != null ? `${a.entry_low}–${a.entry_high}` : "—");
const sideColor = (s: string | null) => (s === "sell" ? "text-red-300" : "text-emerald-300");

export function GenxLab() {
  const [data, setData] = useState<Data | null>(null);
  const [alerts, setAlerts] = useState<AlertsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [grading, setGrading] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  async function loadAlerts() {
    try {
      const res = await fetch("/api/genx/alerts-status", { cache: "no-store" });
      const d = await res.json();
      if (res.ok && d && d.configured !== false) setAlerts(d as AlertsData);
    } catch { /* leave alerts as-is */ }
  }
  async function load() {
    setLoading(true); setErr("");
    void loadAlerts();
    try {
      const res = await fetch("/api/admin/genx", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok || !d.ok) { setErr(d.error || "Couldn't load GENX data."); setData(null); }
      else setData(d);
    } catch { setErr("Couldn't reach the server."); }
    finally { setLoading(false); }
  }
  async function gradeNow() {
    setGrading(true); setNote("");
    try {
      const res = await fetch("/api/admin/genx", { method: "POST" });
      const d = await res.json();
      if (!res.ok || !d.ok) setNote(d.error || "Grading failed.");
      else { setNote(`Checked ${d.checked ?? 0} · resolved ${d.resolved ?? 0}.`); await load(); }
    } catch { setNote("Couldn't reach the server."); }
    finally { setGrading(false); }
  }
  useEffect(() => { load(); }, []);

  const ov = data?.overview;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0b0d14] p-5 text-white sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">
            <Gem className="h-3.5 w-3.5" /> GENX Lab
          </p>
          <h2 className="mt-1 font-serif text-2xl font-bold">Recorded Gold signals & tracked outcomes</h2>
          <p className="mt-1 text-sm text-white/50">Every GENX read is logged immutably, then graded against the candles that print after it. Win-rate, net pips and calibration below are the real ledger — nothing is fabricated.</p>
        </div>
        <div className="flex flex-shrink-0 flex-col gap-2">
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/70 hover:border-white/30 disabled:opacity-40">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </button>
          <button onClick={gradeNow} disabled={grading || !!data?.needs_migration} className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-3 py-1.5 text-xs font-semibold text-amber-200 hover:border-amber-300/50 disabled:opacity-40">
            {grading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Grade open now
          </button>
        </div>
      </div>

      {note && <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/60">{note}</div>}
      {err && <div className="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300">{err}</div>}
      {loading && !data && <div className="mt-6 flex items-center gap-2 text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Loading the ledger…</div>}

      {alerts && (
        <section className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-amber-200/90">
              <span className={`h-2 w-2 rounded-full ${alerts.telegram ? "bg-emerald-400" : "bg-white/30"} ${alerts.telegram ? "animate-pulse" : ""}`} />
              Live Alerts {alerts.telegram ? "· Telegram connected" : "· Telegram not configured"}
            </p>
            <span className="text-[11px] text-white/45">Last scan {agoShort(alerts.lastScanAt)}</span>
          </div>
          <p className="mt-1 text-[12px] text-white/50">Scanning Quick (scalp) mode every ~5 min · a heads-up posts when a setup forms, then an ENTER NOW when it triggers.</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">Tracking now ({alerts.tracking.length})</p>
              {alerts.tracking.length === 0 ? (
                <p className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[12px] text-white/45">Nothing forming right now — you&apos;ll be alerted here and in Telegram the moment GENX calls one.</p>
              ) : (
                <div className="space-y-1.5">
                  {alerts.tracking.map((a, i) => (
                    <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                      <p className="text-[13px] font-bold">
                        <span className={sideColor(a.side)}>{(a.side || "").toUpperCase()}</span>
                        <span className="text-white/80"> {zoneStr(a)}</span>
                        <span className="ml-1 text-[10px] font-normal text-amber-300/80">⏳ waiting</span>
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-white/40">stop {a.stop ?? "—"} · TP1 {a.tp1 ?? "—"}{a.tp2 != null ? ` · TP2 ${a.tp2}` : ""}{a.confidence != null ? ` · conf ${a.confidence}` : ""} · {agoShort(a.created_at)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">Recently called ({alerts.recent.length})</p>
              {alerts.recent.length === 0 ? (
                <p className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[12px] text-white/45">No entries or invalidations yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {alerts.recent.map((a, i) => (
                    <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                      <p className="text-[13px] font-bold">
                        <span className={sideColor(a.side)}>{(a.side || "").toUpperCase()}</span>
                        <span className="text-white/80"> {zoneStr(a)}</span>
                        <span className={`ml-1 text-[10px] font-normal ${a.state === "entered" ? "text-emerald-300" : "text-red-300"}`}>{a.state === "entered" ? "✅ entered" : "❌ invalid"}</span>
                      </p>
                      <p className="mt-0.5 text-[10.5px] text-white/40">stop {a.stop ?? "—"} · TP1 {a.tp1 ?? "—"} · {agoShort(a.state === "entered" ? a.enter_sent_at : a.updated_at)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {data?.needs_migration && (
        <div className="mt-5 rounded-xl border border-sky-400/25 bg-sky-400/[0.06] px-4 py-4 text-sm text-sky-100">
          <p className="flex items-center gap-1.5 font-semibold"><Database className="h-4 w-4" /> One step to switch this on</p>
          <p className="mt-1 text-sky-100/70">The <code className="rounded bg-white/10 px-1">genx_signals</code> table isn’t in the database yet, so no signals are being recorded. Run <code className="rounded bg-white/10 px-1">genx_signals.sql</code> once in the Supabase SQL editor — after that, every GENX read is logged and graded automatically, and this Lab fills in.</p>
        </div>
      )}

      {data && !data.needs_migration && ov && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Signals recorded" value={String(ov.total)} sub={`${ov.open} still open`} />
            <Tile label="Win rate" value={ov.resolved ? `${ov.win_rate}%` : "—"} sub={`${ov.wins}W · ${ov.losses}L of ${ov.resolved}`} />
            <Tile label="Net pips" value={ov.resolved ? `${ov.net_pips > 0 ? "+" : ""}${ov.net_pips}` : "—"} tint={ov.net_pips > 0 ? "text-emerald-400" : ov.net_pips < 0 ? "text-red-400" : undefined} />
            <Tile label="Directional accuracy" value={ov.resolved ? `${ov.directional_accuracy}%` : "—"} sub="price moved GENX’s way" />
          </div>

          {ov.resolved > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Avg MFE" value={`${ov.avg_mfe}p`} sub="best move reached" />
              <Tile label="Avg MAE" value={`${ov.avg_mae}p`} sub="worst adverse move" />
              <Tile label="Fill rate" value={`${ov.filled_rate}%`} sub="triggers that armed" />
              <Tile label="Resolved" value={`${ov.resolved}/${ov.total}`} sub="graded so far" />
            </div>
          )}

          {ov.total === 0 && (
            <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/60">
              No GENX signals recorded yet. Each Gold read from The Floor is logged here; outcomes fill in as the resolver grades them (automatically every 15 minutes, or press “Grade open now”).
            </p>
          )}

          {ov.total > 0 && (
            <>
              {/* Confidence calibration */}
              <section className="mt-6">
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45"><Target className="h-3.5 w-3.5" /> Confidence calibration — does a higher score really win more?</h3>
                <div className="mt-3 space-y-2">
                  {data.by_confidence.map((b) => (
                    <div key={b.key} className="flex items-center gap-3">
                      <span className="w-14 flex-shrink-0 text-[13px] text-white/75">{b.key}</span>
                      <div className="h-5 flex-1 overflow-hidden rounded bg-white/[0.05]">
                        <div className="h-full rounded bg-gradient-to-r from-amber-500/70 to-amber-300/70" style={{ width: `${b.resolved ? Math.round(b.win_rate) : 0}%` }} />
                      </div>
                      <span className="w-28 flex-shrink-0 text-right text-[12px] text-white/60">{b.resolved ? `${b.win_rate}% · ${b.resolved} graded` : `${b.n} open`}</span>
                    </div>
                  ))}
                </div>
              </section>

              <div className="mt-6 grid gap-5 lg:grid-cols-2">
                <BucketTable title="By mode" rows={data.by_mode} />
                <BucketTable title="By action" rows={data.by_action} />
              </div>

              {/* Recent signals ledger */}
              <section className="mt-6">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">Recent signals</h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-[13px]">
                    <thead className="text-[11px] uppercase tracking-wide text-white/40">
                      <tr>
                        <th className="pb-2 pr-3 font-semibold">When</th>
                        <th className="pb-2 pr-3 font-semibold">Mode</th>
                        <th className="pb-2 pr-3 font-semibold">Action</th>
                        <th className="pb-2 pr-3 font-semibold">Conf</th>
                        <th className="pb-2 pr-3 font-semibold">Outcome</th>
                        <th className="pb-2 pr-3 font-semibold text-right">MFE/MAE</th>
                      </tr>
                    </thead>
                    <tbody className="text-white/75">
                      {data.recent.map((r) => (
                        <tr key={r.id} className="border-t border-white/[0.06]">
                          <td className="py-2 pr-3 whitespace-nowrap text-white/55">{fmtDate(r.created_at)}</td>
                          <td className="py-2 pr-3 capitalize">{r.mode || "—"}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">{(r.action || "—").replace(/_/g, " ")}</td>
                          <td className="py-2 pr-3">{r.confidence ?? "—"}</td>
                          <td className={`py-2 pr-3 font-semibold ${outColor(r.outcome)}`}>{r.outcome || "open"}</td>
                          <td className="py-2 pr-3 text-right text-white/60">{r.mfe_pips != null ? `+${r.mfe_pips}` : "—"} / {r.mae_pips != null ? `-${r.mae_pips}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <p className="text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tint || "text-white"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-white/45">{sub}</p>}
    </div>
  );
}

function BucketTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-white/45">No signals yet.</p>
      ) : (
        <table className="mt-2 w-full text-left text-[13px]">
          <thead className="text-[11px] uppercase tracking-wide text-white/40">
            <tr><th className="pb-1.5 pr-3 font-semibold">Bucket</th><th className="pb-1.5 pr-3 font-semibold text-right">N</th><th className="pb-1.5 pr-3 font-semibold text-right">Graded</th><th className="pb-1.5 font-semibold text-right">Win%</th></tr>
          </thead>
          <tbody className="text-white/75">
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/[0.06]">
                <td className="py-1.5 pr-3 capitalize">{r.key.replace(/_/g, " ")}</td>
                <td className="py-1.5 pr-3 text-right">{r.n}</td>
                <td className="py-1.5 pr-3 text-right text-white/55">{r.resolved}</td>
                <td className="py-1.5 text-right font-semibold">{r.resolved ? `${r.win_rate}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
