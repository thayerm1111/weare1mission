"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Gauge, ShieldAlert, Target, Check, X, Clock, Copy } from "lucide-react";
import { Ring } from "./quantUi";

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/CAD", "GBP/JPY", "XAU/USD"];
const PIP: Record<string, number> = { "EUR/USD": 0.0001, "GBP/USD": 0.0001, "USD/JPY": 0.01, "AUD/CAD": 0.0001, "GBP/JPY": 0.01, "XAU/USD": 0.1 };

type TP = { label: string; price: number | null; rMultiple: number | null };
type Sig = {
  decision: "TRADE" | "WATCHLIST" | "NO_TRADE"; symbol: string; direction: "BUY" | "SELL" | "NONE";
  dataTimestampUtc: string | null; setupFamily: string; regime: string; score: number; confidenceLabel: string;
  entryType: string; entryZone: { low: number | null; high: number | null }; currentPrice: number | null;
  stopLoss: number | null; takeProfits: TP[]; invalidation: string; expiresAtUtc: string | null; maximumChasePrice: number | null;
  spreadStatus: string; sessionStatus: string; newsStatus: string; mtf: { tf: string; trend: string }[];
  passedConditions: string[]; failedConditions: string[]; vetoes: string[];
  scoreBreakdown: { category: string; points: number; max: number; note: string }[];
  riskWarnings: string[]; explanation: string; strategyVersion: string; configVersion: string; dataSource: string;
  error?: string; reason?: string;
};

const fmt = (n: number | null | undefined) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 100) return n.toFixed(2);
  if (a >= 10) return n.toFixed(3);
  return n.toFixed(5);
};
const minsUntil = (iso: string | null) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 60000) : null);

export function ScalpTool() {
  const [sym, setSym] = useState("EUR/USD");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Sig | null>(null);
  const [msg, setMsg] = useState("");
  const [balance, setBalance] = useState("10000");
  const [riskPct, setRiskPct] = useState("0.25");
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => { const iv = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(iv); }, []);

  async function run() {
    if (busy) return;
    setBusy(true); setMsg(""); setR(null);
    try {
      const res = await fetch("/api/scalp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: sym }) });
      if (res.status === 402) { setMsg("You're out of credits — top up on the Credits page."); return; }
      const d = await res.json().catch(() => ({}));
      if (d.error === "notConfigured") { setMsg("Live market data isn't connected yet."); return; }
      if (d.error === "ratelimit") { setMsg("Data busy for a moment — try again shortly."); return; }
      if (d.error) { setMsg(d.reason || "Couldn't analyze — try again."); return; }
      setR(d as Sig);
      // A credit is only spent on an actual TRADE — refresh the balance only then.
      if ((d as Sig).decision === "TRADE" && typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
    } catch { setMsg("Something interrupted the connection. Try again."); }
    finally { setBusy(false); }
  }

  const isTrade = r?.decision === "TRADE", isWatch = r?.decision === "WATCHLIST", isNo = r?.decision === "NO_TRADE";
  const long = r?.direction === "BUY";
  const decTone = isTrade ? "emerald" : isWatch ? "amber" : "slate";
  const decLabel = isTrade ? "TRADE" : isWatch ? "WATCHLIST" : "NO TRADE";
  const border = isTrade ? "border-emerald-400/30" : isWatch ? "border-amber-400/30" : "border-white/10";

  const bal = Number(balance) || 0, rp = Number(riskPct) || 0;
  const riskAmt = bal * (rp / 100);
  const entryMid = r && r.entryZone.low != null && r.entryZone.high != null ? (r.entryZone.low + r.entryZone.high) / 2 : r?.currentPrice ?? null;
  const stopDist = entryMid != null && r?.stopLoss != null ? Math.abs(entryMid - r.stopLoss) : null;
  const pip = PIP[sym] ?? 0.0001;
  const stopPips = stopDist != null ? stopDist / pip : null;
  const estUnits = stopDist && stopDist > 0 ? riskAmt / stopDist : null;

  const copyTrade = () => {
    if (!r || r.stopLoss == null) return;
    const lines = [`${r.symbol} ${r.direction}`, `Entry: ${r.entryZone.low != null ? `${fmt(r.entryZone.low)}-${fmt(r.entryZone.high)}` : fmt(r.currentPrice)}`, `Stop: ${fmt(r.stopLoss)}`, ...r.takeProfits.map((t) => `${t.label}: ${fmt(t.price)}`)];
    try { void navigator.clipboard?.writeText(lines.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* Config card */}
      <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-sky-500/15 text-sky-300"><Gauge className="h-5 w-5" /></span>
            <div>
              <h1 className="font-serif text-lg font-bold text-white">OM Scalp</h1>
              <p className="text-xs text-white/45">Selective, deterministic scalp signals — NO&nbsp;TRADE is a valid result</p>
            </div>
          </div>
          <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-300">Beta</span>
        </div>
        <p className="mt-4 text-[10px] uppercase tracking-[0.14em] text-white/40">Instrument</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PAIRS.map((p) => (
            <button key={p} onClick={() => setSym(p)} className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition ${p === sym ? "border-sky-400/50 bg-sky-500/15 text-white" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>{p}</button>
          ))}
        </div>
        <button onClick={run} disabled={busy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 to-sky-400 px-4 py-3 font-bold text-[#04121d] transition hover:brightness-110 disabled:opacity-60">
          {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-[#04121d]/40 border-t-[#04121d]" /> Analyzing…</> : <>Analyze market <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">1</span></>}
        </button>
        {msg && <p className="mt-3 text-center text-sm text-amber-300">{msg} {msg.includes("credits") && <Link href="/portal/credits" className="underline">Credits →</Link>}</p>}
      </div>

      {/* Result */}
      {r && (
        <div className={`mt-4 rounded-3xl border bg-white/[0.02] p-5 ${border}`}>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-serif text-xl font-bold text-white">{r.symbol}</span>
                {!isNo && r.direction !== "NONE" && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${long ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{long ? "Buy" : "Sell"}</span>}
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${isTrade ? "bg-emerald-500/15 text-emerald-300" : isWatch ? "bg-amber-500/15 text-amber-300" : "bg-white/10 text-white/60"}`}>{decLabel}</span>
              </div>
              <p className="mt-1 text-xs text-white/50">{r.regime}{r.setupFamily !== "None" ? ` · ${r.setupFamily}` : ""}</p>
            </div>
            <Ring value={r.score} size={78} tone={decTone as "emerald" | "amber" | "slate"} sub="score" />
          </div>

          {/* status strip */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[["Session", r.sessionStatus], ["Spread", r.spreadStatus], ["Data", r.dataTimestampUtc ? freshLabel(r.dataTimestampUtc) : "—"]].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 text-center">
                <p className="text-[9px] uppercase tracking-wide text-white/40">{k}</p><p className="mt-0.5 text-xs font-semibold text-white/85">{v}</p>
              </div>
            ))}
          </div>
          {r.mtf.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.mtf.map((m) => <span key={m.tf} className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold capitalize ${m.trend === "bullish" ? "bg-emerald-500/15 text-emerald-300" : m.trend === "bearish" ? "bg-red-500/15 text-red-300" : "bg-white/[0.06] text-white/55"}`}>{m.tf} {m.trend}</span>)}
            </div>
          )}
          <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-1.5 text-[11px] text-amber-300">⚑ {r.newsStatus}</p>

          {r.explanation && <p className="mt-3 text-sm leading-relaxed text-white/85">{r.explanation}</p>}

          {/* levels */}
          {!isNo && r.stopLoss != null && (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Box label={`Entry ${r.entryType.toLowerCase()}`} value={r.entryZone.low != null ? `${fmt(r.entryZone.low)}–${fmt(r.entryZone.high)}` : fmt(r.currentPrice)} tint="text-white" />
                <Box label="Stop" value={fmt(r.stopLoss)} tint="text-red-400" icon={<ShieldAlert className="h-3 w-3" />} />
                <Box label="Now" value={fmt(r.currentPrice)} tint="text-sky-300" />
                {r.takeProfits.map((tp) => <Box key={tp.label} label={`${tp.label}${tp.rMultiple != null ? ` · ${tp.rMultiple}R` : ""}`} value={fmt(tp.price)} tint="text-emerald-400" icon={<Target className="h-3 w-3" />} />)}
              </div>
              <button onClick={copyTrade} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-xs font-bold text-white/80 hover:bg-white/[0.06]">
                <Copy className="h-3.5 w-3.5" />{copied ? "Copied ✓" : "Copy trade"}
              </button>
              <div className="mt-3 space-y-1.5 text-[12px]">
                {r.invalidation && <Row k="Invalidation" v={r.invalidation} />}
                {r.maximumChasePrice != null && <Row k="Max chase" v={fmt(r.maximumChasePrice)} />}
                {r.expiresAtUtc && <Row k="Expires" v={<span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{expiryLabel(r.expiresAtUtc)}</span>} />}
              </div>

              {/* position size */}
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
                <p className="text-[10px] uppercase tracking-[0.14em] text-white/40">Position size (estimate)</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block text-[11px] text-white/50">Account (USD)<input value={balance} onChange={(e) => setBalance(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-sky-400/50" /></label>
                  <label className="block text-[11px] text-white/50">Risk %<input value={riskPct} onChange={(e) => setRiskPct(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-sky-400/50" /></label>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div><p className="text-[9px] uppercase text-white/40">Risk</p><p className="font-serif text-sm font-bold text-white">${riskAmt.toFixed(2)}</p></div>
                  <div><p className="text-[9px] uppercase text-white/40">Stop</p><p className="font-serif text-sm font-bold text-white">{stopPips != null ? `${stopPips.toFixed(1)} pips` : "—"}</p></div>
                  <div><p className="text-[9px] uppercase text-white/40">Est. units</p><p className="font-serif text-sm font-bold text-white">{estUnits != null ? Math.round(estUnits).toLocaleString() : "—"}</p></div>
                </div>
                <p className="mt-1.5 text-[10px] text-white/35">Estimate only — assumes 1 unit = a 1.00 quote-currency move (accurate for USD-quoted pairs; verify pip value with your broker).</p>
              </div>
            </>
          )}

          {/* conditions */}
          {r.vetoes.length > 0 && <CondGroup title="Vetoes" items={r.vetoes} icon={<X className="h-3.5 w-3.5 text-red-400" />} box />}
          {r.passedConditions.length > 0 && <CondGroup title="Passed" items={r.passedConditions} icon={<Check className="h-3.5 w-3.5 text-emerald-400" />} />}
          {r.failedConditions.length > 0 && <CondGroup title="Not met" items={r.failedConditions} icon={<span className="text-white/40">–</span>} />}

          {/* score breakdown */}
          {r.scoreBreakdown.length > 0 && (
            <div className="mt-4">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/40">Score {r.score}/100</p>
              <div className="mt-2 space-y-1.5">
                {r.scoreBreakdown.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-[42%] shrink-0 text-[11px] text-white/60">{s.category}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400" style={{ width: `${(s.points / s.max) * 100}%` }} /></span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-white/50">{s.points}/{s.max}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 space-y-1">{r.riskWarnings.map((w, i) => <p key={i} className="text-[11px] leading-snug text-white/50">⚠ {w}</p>)}</div>
          <p className="mt-3 border-t border-white/10 pt-3 text-[10px] text-white/35">Deterministic engine {r.strategyVersion} · {r.configVersion} · data {r.dataSource}. Educational analysis, not financial advice — you decide whether to trade.</p>
        </div>
      )}
    </div>
  );
}

function Box({ label, value, tint, icon }: { label: string; value: string; tint: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5 text-center">
      <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.06em] text-white/40">{icon}{label}</p>
      <p className={`mt-0.5 font-serif text-sm font-bold tabular-nums ${tint}`}>{value}</p>
    </div>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-3"><span className="text-white/45">{k}</span><span className="max-w-[62%] text-right font-medium text-white/85">{v}</span></div>;
}
function CondGroup({ title, items, icon, box }: { title: string; items: string[]; icon: React.ReactNode; box?: boolean }) {
  return (
    <div className={`mt-3 ${box ? "rounded-xl border border-red-400/25 bg-red-500/[0.05] p-3" : ""}`}>
      <p className="text-[10px] uppercase tracking-[0.14em] text-white/40">{title}</p>
      <div className="mt-1.5 space-y-1">{items.map((v, i) => <div key={i} className="flex items-start gap-2 text-[12.5px] leading-snug text-white/80"><span className="mt-0.5">{icon}</span>{v}</div>)}</div>
    </div>
  );
}

function freshLabel(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "live" : `${m}m old`;
}
function expiryLabel(iso: string): string {
  const m = minsUntil(iso);
  if (m == null) return "—";
  return m <= 0 ? "expired" : `in ${m}m`;
}
