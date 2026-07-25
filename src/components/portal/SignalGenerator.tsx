"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bitcoin, Gem, TrendingUp, Globe, BarChart3, Zap, X, ChevronLeft, Loader2, Check,
  ArrowUp, ArrowDown, Target, ShieldAlert, Sparkles, Clock, Minus,
} from "lucide-react";
import { MARKETS, type Market, type Asset } from "@/data/signalAssets";

const MARKET_ICON: Record<Market["id"], typeof Bitcoin> = {
  crypto: Bitcoin, metal: Gem, stock: TrendingUp, forex: Globe, index: BarChart3,
};
const MARKET_TINT: Record<Market["id"], string> = {
  crypto: "text-orange-400", metal: "text-amber-300", stock: "text-emerald-400", forex: "text-sky-400", index: "text-violet-400",
};

type Signal = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  entry: number; stopLoss: number; takeProfits: number[];
  confidence: string; riskReward: string; timeframe: string; rationale: string; invalidation: string;
};
type Result = {
  symbol: string; name: string; market: string; orderType: string;
  price: number; asOf: string; signal: Signal;
};

const GEN_STEPS = [
  "Connecting to market data…",
  "Fetching live candles…",
  "Calculating RSI & moving averages…",
  "Analyzing market structure…",
  "Generating trade signal…",
];

const fmt = (n: number) => {
  if (!isFinite(n)) return "—";
  const d = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SignalGenerator() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"market" | "asset" | "config" | "loading" | "result" | "error">("market");
  const [market, setMarket] = useState<Market | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [genStep, setGenStep] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [recent, setRecent] = useState<Result[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("om_signals");
      if (raw) setRecent(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  function reset() {
    setStep("market"); setMarket(null); setAsset(null); setOrderType("limit");
    setResult(null); setErrorMsg(""); setGenStep(0);
  }
  function close() { if (timer.current) clearInterval(timer.current); setOpen(false); }

  async function generate() {
    if (!asset) return;
    setStep("loading"); setGenStep(0); setErrorMsg("");
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setGenStep((s) => Math.min(s + 1, GEN_STEPS.length - 1)), 650);

    try {
      const [res] = await Promise.all([
        fetch("/api/om-signal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ td: asset.td, orderType }),
        }),
        delay(2600),
      ]);
      if (timer.current) clearInterval(timer.current);
      const data = await res.json().catch(() => ({}));
      if (data.notConfigured === "marketdata") {
        setErrorMsg("Live market data isn't connected yet — add a TWELVEDATA_API_KEY in Vercel and I'll pull real prices.");
        setStep("error"); return;
      }
      if (data.notConfigured === "ai") {
        setErrorMsg("OM AI isn't switched on yet — the Anthropic key is missing.");
        setStep("error"); return;
      }
      if (data.error || !data.signal) {
        setErrorMsg(data.detail ? `Couldn't build a signal: ${data.detail}` : "Couldn't build a signal right now. Try another asset or try again shortly.");
        setStep("error"); return;
      }
      const r = data as Result;
      setResult(r);
      setStep("result");
      const next = [r, ...recent].slice(0, 12);
      setRecent(next);
      try { localStorage.setItem("om_signals", JSON.stringify(next)); } catch { /* ignore */ }
    } catch {
      if (timer.current) clearInterval(timer.current);
      setErrorMsg("Something interrupted the connection. Try again.");
      setStep("error");
    }
  }

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.18),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      {/* header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-gold-light to-[#8a6d35]">
            <Zap className="h-4 w-4 text-[#0a0b10]" aria-hidden="true" />
          </span>
          <div>
            <p className="font-serif text-base font-semibold uppercase tracking-[0.14em]">Signal Hub</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">AI signals · real market data</p>
          </div>
        </div>
        <button
          onClick={() => { reset(); setOpen(true); }}
          className="inline-flex items-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] transition-opacity hover:opacity-90"
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" /> Generate Signal
        </button>
      </div>

      {/* hub / recent */}
      <div className="relative z-10 px-6 py-6 sm:px-8">
        {recent.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] ring-1 ring-white/10">
              <Sparkles className="h-6 w-6 text-white/30" aria-hidden="true" />
            </span>
            <p className="mt-4 font-serif text-lg font-semibold">No active signals</p>
            <p className="mt-1 max-w-xs text-sm text-white/40">Generate your first signal to start tracking opportunities across every market.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {recent.map((r, i) => <SignalCard key={i} r={r} compact onClick={() => { setResult(r); setStep("result"); setOpen(true); }} />)}
          </div>
        )}
      </div>

      {/* modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={close}>
          <div
            className="relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-[#0d0e15] text-white ring-1 ring-white/12"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pointer-events-none absolute inset-x-0 -top-16 h-48 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.22),transparent)]" />
            <div className="relative z-10 flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-2">
                {(step === "asset" || step === "config") && (
                  <button onClick={() => setStep(step === "config" ? "asset" : "market")} className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10" aria-label="Back">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                )}
                <span className="text-[11px] uppercase tracking-[0.16em] text-white/45">
                  {step === "market" && "Step 1 of 4 · Market Type"}
                  {step === "asset" && "Step 2 of 4 · Select Asset"}
                  {step === "config" && "Step 3 of 4 · Configure"}
                  {step === "loading" && "Generating…"}
                  {step === "result" && "Your Signal"}
                  {step === "error" && "Heads up"}
                </span>
              </div>
              <button onClick={close} className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>

            {/* progress bar */}
            {["market", "asset", "config", "loading"].includes(step) && (
              <div className="relative z-10 mb-2 flex gap-1.5 px-6">
                {[0, 1, 2, 3].map((i) => {
                  const active = ["market", "asset", "config", "loading"].indexOf(step);
                  return <span key={i} className={`h-1 flex-1 rounded-full ${i <= active ? "bg-gold-light" : "bg-white/10"}`} />;
                })}
              </div>
            )}

            <div className="relative z-10 px-6 pb-7 pt-3">
              {step === "market" && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Select Market Type</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Choose the market you want to trade in</p>
                  <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {MARKETS.map((m) => {
                      const Icon = MARKET_ICON[m.id];
                      return (
                        <button key={m.id} onClick={() => { setMarket(m); setStep("asset"); }}
                          className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-center transition-colors hover:border-gold-light/40 hover:bg-white/[0.06]">
                          <Icon className={`h-7 w-7 ${MARKET_TINT[m.id]}`} aria-hidden="true" />
                          <span className="mt-2.5 text-sm font-semibold">{m.name}</span>
                          <span className="mt-0.5 text-[11px] leading-tight text-white/40">{m.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {step === "asset" && market && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Select Asset</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Pick a {market.name.toLowerCase()} asset to analyze</p>
                  <div className="mt-5 space-y-2">
                    {market.assets.map((a) => (
                      <button key={a.td} onClick={() => { setAsset(a); setStep("config"); }}
                        className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-gold-light/40 hover:bg-white/[0.06]">
                        <div>
                          <p className="font-semibold">{a.symbol}</p>
                          <p className="text-xs text-white/40">{a.name}</p>
                        </div>
                        <span className="text-white/30">›</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {step === "config" && asset && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Configure</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Analysis parameters for <span className="text-gold-light">{asset.symbol}</span></p>
                  <p className="mt-6 text-[11px] uppercase tracking-[0.12em] text-white/45">Order Type</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {(["market", "limit"] as const).map((o) => (
                      <button key={o} onClick={() => setOrderType(o)}
                        className={`rounded-xl border px-4 py-3 text-left transition-colors ${orderType === o ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="text-sm font-semibold capitalize">{o}</span>
                        <span className="mt-0.5 block text-[11px] text-white/40">{o === "market" ? "Signal around current price" : "Wait for an exact entry level"}</span>
                      </button>
                    ))}
                  </div>
                  <button onClick={generate}
                    className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-3.5 text-[13px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] transition-opacity hover:opacity-90">
                    <Sparkles className="h-4 w-4" /> Generate Signal
                  </button>
                </>
              )}

              {step === "loading" && (
                <div className="py-4">
                  <div className="flex flex-col items-center">
                    <span className="grid h-16 w-16 animate-pulse place-items-center rounded-full bg-gradient-to-br from-gold-light to-[#8a6d35]">
                      <Sparkles className="h-7 w-7 text-[#0a0b10]" />
                    </span>
                    <p className="mt-4 text-sm text-white/50">Analyzing</p>
                    <p className="font-serif text-2xl font-bold">{asset?.symbol}</p>
                  </div>
                  <div className="mt-6 space-y-3">
                    {GEN_STEPS.map((s, i) => (
                      <div key={i} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${i === genStep ? "bg-white/[0.06] ring-1 ring-gold-light/30" : ""}`}>
                        <span className={`grid h-5 w-5 place-items-center rounded-full ${i < genStep ? "bg-emerald-500/20 text-emerald-400" : i === genStep ? "text-gold-light" : "text-white/20"}`}>
                          {i < genStep ? <Check className="h-3.5 w-3.5" /> : i === genStep ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                        </span>
                        <span className={`text-sm ${i <= genStep ? "text-white/80" : "text-white/30"}`}>{s}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {step === "result" && result && (
                <>
                  <SignalCard r={result} />
                  <button onClick={() => { reset(); }}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-none border border-white/20 px-6 py-3 text-[12px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-white/10">
                    <Sparkles className="h-4 w-4" /> New Signal
                  </button>
                </>
              )}

              {step === "error" && (
                <div className="py-6 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-500/15 text-amber-400"><ShieldAlert className="h-6 w-6" /></span>
                  <p className="mt-4 text-sm text-white/70">{errorMsg}</p>
                  <button onClick={() => reset()} className="mt-5 rounded-none border border-white/20 px-6 py-2.5 text-[12px] font-medium uppercase tracking-[0.14em] text-white hover:bg-white/10">Back to start</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SignalCard({ r, compact, onClick }: { r: Result; compact?: boolean; onClick?: () => void }) {
  const s = r.signal;
  const dir = s.direction;
  const dirColor = dir === "LONG" ? "text-emerald-400 bg-emerald-500/15" : dir === "SHORT" ? "text-red-400 bg-red-500/15" : "text-white/60 bg-white/10";
  const DirIcon = dir === "LONG" ? ArrowUp : dir === "SHORT" ? ArrowDown : Minus;

  if (compact) {
    return (
      <button onClick={onClick} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-gold-light/30 hover:bg-white/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{r.symbol}</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${dirColor}`}><DirIcon className="h-3 w-3" />{dir}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-white/40">Entry {fmt(s.entry)} · {s.timeframe}</p>
        </div>
        <span className="text-white/30">›</span>
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-serif text-xl font-bold">{r.symbol}</p>
          <p className="text-xs text-white/40">{r.name} · {r.market} · {r.orderType}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${dirColor}`}><DirIcon className="h-4 w-4" />{dir}</span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Cell label="Entry" value={fmt(s.entry)} tint="text-white" />
        <Cell label="Stop Loss" value={fmt(s.stopLoss)} tint="text-red-400" icon={<ShieldAlert className="h-3 w-3" />} />
        <Cell label="Risk : Reward" value={s.riskReward} tint="text-gold-light" />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        {(s.takeProfits || []).slice(0, 3).map((tp, i) => (
          <Cell key={i} label={`TP${i + 1}`} value={fmt(tp)} tint="text-emerald-400" icon={<Target className="h-3 w-3" />} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
        <span>Confidence: <span className="font-semibold text-white/80">{s.confidence}</span></span>
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {s.timeframe}</span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-white/80">{s.rationale}</p>
      {s.invalidation && <p className="mt-2 text-xs text-white/45"><span className="text-white/60">Invalidation:</span> {s.invalidation}</p>}

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] text-white/35">
        Price {fmt(r.price)} · as of {r.asOf} · live data via Twelve Data. Educational analysis, not financial advice — verify before trading.
      </p>
    </div>
  );
}

function Cell({ label, value, tint, icon }: { label: string; value: string; tint: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5">
      <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.1em] text-white/40">{icon}{label}</p>
      <p className={`mt-0.5 font-serif text-base font-bold tabular-nums ${tint}`}>{value}</p>
    </div>
  );
}
