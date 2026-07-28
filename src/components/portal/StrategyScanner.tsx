"use client";

/**
 * OM STRATEGY SCANNER — front end for the confirmations-as-strategies engine.
 *
 * Each strategy the trader toggles is a "scout" that scans the pair and returns
 * its own read (direction + what it saw). The card shows every scout's read on
 * its own line, then the combined verdict: a qualified trade, or an honest WAIT
 * when the strategies don't agree. Every number is computed server-side in code;
 * this component only displays and journals the result.
 */
import { useEffect, useState } from "react";
import {
  Radar, Loader2, ShieldAlert, ArrowUp, ArrowDown, Target, Gauge, Check, X, Sparkles,
  Ban, Layers, TrendingUp, Trash2,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";

const INSTRUMENTS: { td: string; label: string; cat: string }[] = [
  { td: "XAU/USD", label: "Gold", cat: "Metal" },
  { td: "XAG/USD", label: "Silver", cat: "Metal" },
  { td: "WTI/USD", label: "Crude Oil", cat: "Energy" },
  { td: "EUR/USD", label: "Euro", cat: "Forex" },
  { td: "GBP/USD", label: "Pound", cat: "Forex" },
  { td: "USD/JPY", label: "Yen", cat: "Forex" },
  { td: "AUD/USD", label: "Aussie", cat: "Forex" },
  { td: "SPY", label: "S&P 500", cat: "Index" },
  { td: "QQQ", label: "Nasdaq", cat: "Index" },
  { td: "BTC/USD", label: "Bitcoin", cat: "Crypto" },
  { td: "ETH/USD", label: "Ethereum", cat: "Crypto" },
];
const STYLES: { key: string; label: string; note: string }[] = [
  { key: "scalp", label: "Scalp", note: "next ~30–90 min · 30–100 pips" },
  { key: "intraday", label: "Intraday", note: "the bigger intraday move" },
  { key: "swing", label: "Swing", note: "the overall direction" },
];
const SCOUTS: { key: string; label: string }[] = [
  { key: "structure", label: "Market Structure" },
  { key: "liquidity", label: "Liquidity Sweeps" },
  { key: "fvg", label: "Fair Value Gaps" },
  { key: "fib", label: "Fib / OTE" },
  { key: "breakRetest", label: "Break & Retest" },
  { key: "sr", label: "Support / Resistance" },
  { key: "trend", label: "Trend (MAs)" },
  { key: "rsi", label: "RSI Momentum" },
];

type ScoutRead = { key: string; label: string; fired: boolean; dir: "LONG" | "SHORT" | null; strength: number; read: string; level?: number };
type Result = Record<string, unknown> & {
  status: string; symbol?: string; style?: string; price?: number; htf_trend?: string; confluence?: number; agreement?: number;
  headline?: string; reason?: string; direction?: string; order_type?: string; confidence?: string;
  entry?: number; stop_loss?: number; take_profits?: number[]; risk_reward?: string; stop_pips?: number; reversal?: boolean;
  scouts?: ScoutRead[]; reasoning?: string[]; educational?: string; error?: string;
};
type Journal = Result & { id: number };

const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toFixed(6)) : "—");

export function StrategyScanner() {
  const [td, setTd] = useState("XAU/USD");
  const [style, setStyle] = useState("scalp");
  const [scouts, setScouts] = useState<string[]>(SCOUTS.map((s) => s.key));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [journal, setJournal] = useState<Journal[]>([]);

  useEffect(() => { try { const raw = localStorage.getItem("om_scanner"); if (raw) setJournal(JSON.parse(raw)); } catch { /* ignore */ } }, []);
  function persist(next: Journal[]) { setJournal(next); try { localStorage.setItem("om_scanner", JSON.stringify(next.slice(0, 15))); } catch { /* ignore */ } }

  const toggle = (k: string) => setScouts((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  async function scan() {
    if (loading) return;
    setLoading(true); setError(""); setNeedCredits(false); setResult(null);
    try {
      const res = await fetch("/api/strategy-scanner", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td, style, scouts }),
      });
      const d: Result = await res.json().catch(() => ({ status: "error" }));
      if (res.status === 402 || d.error === "insufficient_credits") { setNeedCredits(true); setError("You're out of credits — they reset tomorrow, or grab more."); return; }
      if (d.error === "ratelimit" || d.error === "system_busy" || d.error === "notConfigured") { setError((d.reason as string) || "Market data is busy — try again shortly."); return; }
      if (d.error) { setError((d.reason as string) || "Couldn't run the scan right now. Try again shortly."); return; }
      setResult(d);
      const item: Journal = { ...d, id: Date.now() };
      persist([item, ...journal].slice(0, 15));
      try { window.dispatchEvent(new Event("credits-updated")); } catch { /* ignore */ }
    } catch { setError("Something interrupted the connection. Try again."); }
    finally { setLoading(false); }
  }

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(129,140,248,0.16),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-300 to-indigo-600"><Radar className="h-4 w-4 text-[#0a0b10]" /></span>
          <div>
            <p className="font-serif text-base font-semibold uppercase tracking-[0.14em]">OM Strategy Scanner</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Each confirmation is a strategy · combined into one read</p>
          </div>
        </div>
        <span className="rounded-full border border-white/15 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-white/50">WAIT is a valid result</span>
      </div>

      <div className="relative z-10 px-6 py-6 sm:px-8">
        {/* Instrument */}
        <p className="text-[11px] uppercase tracking-[0.12em] text-white/45">Instrument</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {INSTRUMENTS.map((i) => (
            <button key={i.td} onClick={() => setTd(i.td)} title={`${i.label} · ${i.cat}`}
              className={`rounded-xl border px-3 py-1.5 text-xs transition-colors ${td === i.td ? "border-indigo-400/60 bg-indigo-400/10 text-white" : "border-white/12 bg-white/[0.03] text-white/60 hover:text-white/90"}`}>
              {i.td}
            </button>
          ))}
        </div>

        {/* Timeframe intent */}
        <p className="mt-4 text-[11px] uppercase tracking-[0.12em] text-white/45">Timeframe intent</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {STYLES.map((s) => (
            <button key={s.key} onClick={() => setStyle(s.key)}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${style === s.key ? "border-indigo-400/60 bg-indigo-400/10" : "border-white/12 bg-white/[0.03] hover:border-white/25"}`}>
              <p className="text-sm font-semibold text-white">{s.label}</p>
              <p className="text-[10px] text-white/45">{s.note}</p>
            </button>
          ))}
        </div>

        {/* Strategy scouts */}
        <p className="mt-4 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
          <span>Strategies to scan with</span>
          <span className="text-white/35">{scouts.length}/{SCOUTS.length} on · tap to toggle</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SCOUTS.map((s) => {
            const on = scouts.includes(s.key);
            return (
              <button key={s.key} onClick={() => toggle(s.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${on ? "border-indigo-400/50 bg-indigo-400/10 text-white" : "border-white/12 bg-white/[0.02] text-white/40 hover:text-white/70"}`}>
                {on ? <Check className="h-3 w-3 text-indigo-300" /> : <X className="h-3 w-3" />} {s.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-end">
          <button onClick={scan} disabled={loading || scouts.length === 0}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-300 to-indigo-600 px-6 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#0a0b10] transition-opacity hover:opacity-90 disabled:opacity-40">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {loading ? "Scanning…" : "Scan strategies"}
            <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.signal}</span>
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
            <p className="inline-flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> {error}</p>
            {needCredits && <a href="/portal/credits" className="mt-2 inline-flex rounded-lg bg-indigo-400/90 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#0a0b10]">Get credits</a>}
          </div>
        )}

        {result && <ResultView r={result} />}

        {/* Recent */}
        {journal.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
              <span>Recent scans</span>
              <button onClick={() => persist([])} className="inline-flex items-center gap-1 text-white/40 hover:text-white/70"><Trash2 className="h-3 w-3" /> clear</button>
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {journal.map((j) => (
                <button key={j.id} onClick={() => setResult(j)} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:border-white/25">
                  <span className="flex items-center gap-2 text-sm font-semibold">{j.symbol}
                    {j.status === "setup"
                      ? <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${j.direction === "LONG" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{j.direction}</span>
                      : <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/50"><Ban className="h-3 w-3" /> wait</span>}
                  </span>
                  <span className="text-[10px] text-white/35">{j.confluence != null ? `${j.confluence}/100` : ""}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-5 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-white/35">
          Educational market analysis &amp; paper-trading decision support — not financial advice, and not a prediction. The scanner returns WAIT whenever the strategies don&apos;t agree. Trading involves substantial risk; manage your own exposure.
        </p>
      </div>
    </div>
  );
}

function ResultView({ r }: { r: Result }) {
  const scouts = Array.isArray(r.scouts) ? r.scouts : [];
  const isSetup = r.status === "setup";
  const buy = r.direction === "LONG";
  return (
    <div className="mt-5 rounded-2xl border border-white/12 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-serif text-xl font-bold">{r.symbol}</p>
          <p className="text-xs text-white/40">{r.style} · HTF trend {r.htf_trend}</p>
        </div>
        {isSetup ? (
          <div className="flex flex-col items-end gap-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${buy ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{buy ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}{r.direction} · {r.order_type}</span>
            {r.reversal && <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">Confirmed reversal</span>}
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white/60"><Ban className="h-4 w-4" /> WAIT</span>
        )}
      </div>

      {/* Confluence meter */}
      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
          <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" /> Confluence · {Math.round((r.agreement ?? 0) * 100)}% agree</span>
          <span className="font-serif text-lg font-bold text-white">{r.confluence ?? 0}/100</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className={`h-full rounded-full ${(r.confluence ?? 0) >= 78 ? "bg-emerald-400" : (r.confluence ?? 0) >= 60 ? "bg-indigo-400" : "bg-amber-400"}`} style={{ width: `${Math.min(100, r.confluence ?? 0)}%` }} />
        </div>
      </div>

      {/* Per-strategy reads */}
      <p className="mt-4 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-white/45"><Layers className="h-3.5 w-3.5" /> What each strategy sees</p>
      <div className="mt-2 space-y-1.5">
        {scouts.map((s) => (
          <div key={s.key} className="flex items-start gap-2.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
            <span className={`mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full ${s.fired ? (s.dir === "LONG" ? "bg-emerald-500/15 text-emerald-400" : s.dir === "SHORT" ? "bg-red-500/15 text-red-400" : "bg-white/10 text-white/40") : "bg-white/[0.04] text-white/25"}`}>
              {s.fired ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-white/85">{s.label}
                {s.fired && s.dir && <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.dir === "LONG" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{s.dir}</span>}
              </p>
              <p className={`text-[12px] leading-relaxed ${s.fired ? "text-white/70" : "text-white/40"}`}>{s.read}</p>
            </div>
          </div>
        ))}
      </div>

      {isSetup ? (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Cell label="Entry" v={fmt(r.entry)} tint="text-white" />
            <Cell label="Stop" v={fmt(r.stop_loss)} tint="text-red-400" icon={<ShieldAlert className="h-3 w-3" />} />
            <Cell label="Risk : Reward" v={r.risk_reward || "—"} tint="text-indigo-300" small />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {(r.take_profits || []).map((t, i) => <Cell key={i} label={`TP${i + 1}`} v={fmt(t)} tint="text-emerald-400" icon={<Target className="h-3 w-3" />} />)}
          </div>
          {Array.isArray(r.reasoning) && r.reasoning.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {r.reasoning.map((x, i) => <li key={i} className="flex items-start gap-2 text-sm text-white/80"><Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-indigo-300" /> {x}</li>)}
            </ul>
          )}
          <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-white/45"><TrendingUp className="h-3 w-3" /> Confidence: <span className="font-semibold text-white/75">{r.confidence}</span> · ~{r.stop_pips} pip stop</p>
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm leading-relaxed text-white/80">{r.reason}</p>
      )}

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/35">{r.educational}</p>
    </div>
  );
}

function Cell({ label, v, tint, icon, small }: { label: string; v: string; tint: string; icon?: React.ReactNode; small?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5">
      <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.08em] text-white/40">{icon}{label}</p>
      <p className={`mt-0.5 font-serif ${small ? "text-sm" : "text-base"} font-bold tabular-nums ${tint}`}>{v}</p>
    </div>
  );
}
