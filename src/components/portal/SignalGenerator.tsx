"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bitcoin, Gem, TrendingUp, Globe, BarChart3, Zap, X, ChevronLeft, Loader2, Check,
  ArrowUp, ArrowDown, Target, ShieldAlert, Sparkles, Clock, Minus, RefreshCw, Trash2,
} from "lucide-react";
import { MARKETS, findAsset, type Market, type Asset } from "@/data/signalAssets";
import { earnMission } from "@/lib/earnMission";
import { CREDIT_COST } from "@/lib/creditConfig";
import { DeepDiveModal } from "./floor/DeepDive";

const MARKET_ICON: Record<Market["id"], typeof Bitcoin> = { crypto: Bitcoin, metal: Gem, stock: TrendingUp, forex: Globe, index: BarChart3 };
const MARKET_TINT: Record<Market["id"], string> = { crypto: "text-orange-400", metal: "text-amber-300", stock: "text-emerald-400", forex: "text-sky-400", index: "text-violet-400" };

type Method = "best" | "smc" | "structure";
const METHODS: { k: Method; label: string; sub: string }[] = [
  { k: "best", label: "Best", sub: "OM AI's optimal mix" },
  { k: "smc", label: "Smart Money", sub: "ICT / SMC" },
  { k: "structure", label: "Structure", sub: "Market structure" },
];
const CONFS: { k: string; label: string }[] = [
  { k: "structure", label: "Market Structure" },
  { k: "ob", label: "Order Blocks" },
  { k: "fvg", label: "Fair Value Gaps" },
  { k: "liquidity", label: "Liquidity Sweeps" },
  { k: "sr", label: "Support / Resistance" },
  { k: "trend", label: "Trend (MAs)" },
  { k: "rsi", label: "RSI Momentum" },
  { k: "fib", label: "Fib / OTE" },
  { k: "breakRetest", label: "Break & Retest" },
  { k: "volume", label: "Volume" },
];
const METHOD_DEFAULTS: Record<Method, string[]> = {
  best: ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"],
  smc: ["structure", "ob", "fvg", "liquidity", "breakRetest"],
  structure: ["structure", "sr", "trend", "breakRetest"],
};

type Candle = { t: string; o: number; h: number; l: number; c: number };
type Signal = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  entry: number; stopLoss: number; takeProfits: number[];
  confidence: string; riskReward: string; timeframe: string; rationale: string; invalidation: string;
  setup?: string; bias?: string; poi?: string; liquidityTarget?: string;
  checklist?: { label: string; ok: boolean }[]; confirmed?: number; total?: number;
};
type Status = "open" | "win" | "loss";
type Result = {
  id: number; symbol: string; name: string; market: string; td: string; interval: string;
  orderType: string; style?: string; method?: string; price: number; asOf: string; marketClosed?: boolean;
  signal: Signal; candles?: Candle[]; status: Status;
};

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const d = Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 1 ? 4 : 6;
  return x.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GEN_STEPS = ["Connecting to market data…", "Fetching live candles…", "Mapping structure & liquidity…", "Checking confirmations…", "Generating trade signal…"];

export function SignalGenerator() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"market" | "asset" | "config" | "loading" | "result" | "error">("market");
  const [market, setMarket] = useState<Market | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [style, setStyle] = useState<"scalp" | "intraday" | "swing">("intraday");
  const [method, setMethod] = useState<Method>("best");
  const [confs, setConfs] = useState<string[]>(METHOD_DEFAULTS.best);
  const [genStep, setGenStep] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [recent, setRecent] = useState<Result[]>([]);
  const [checking, setChecking] = useState<number | null>(null);
  const [dive, setDive] = useState<Result | null>(null);
  const [needCredits, setNeedCredits] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try { const raw = localStorage.getItem("om_signals"); if (raw) setRecent(JSON.parse(raw)); } catch { /* ignore */ }
  }, []);

  // Auto-generate the full play when opened from a deep link, e.g. the Market
  // Pulse scanner's "Generate the full play": /portal/signals?td=BTC/USD&style=intraday
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const td = q.get("td");
    if (!td) return;
    const found = findAsset(td);
    if (!found) return;
    const st = q.get("style");
    if (st === "scalp" || st === "intraday" || st === "swing") setStyle(st);
    setMarket(found.market); setAsset(found.asset); setOpen(true);
    try { window.history.replaceState({}, "", "/portal/signals"); } catch { /* ignore */ }
    void generate(found.asset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function persist(next: Result[]) { setRecent(next); try { localStorage.setItem("om_signals", JSON.stringify(next.slice(0, 20))); } catch { /* ignore */ } }

  function pickMethod(m: Method) { setMethod(m); setConfs(METHOD_DEFAULTS[m]); }
  function toggleConf(k: string) { setConfs((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k])); }
  function reset() {
    setStep("market"); setMarket(null); setAsset(null); setOrderType("limit"); setStyle("intraday");
    setMethod("best"); setConfs(METHOD_DEFAULTS.best); setResult(null); setErrorMsg(""); setGenStep(0);
  }
  function close() { if (timer.current) clearInterval(timer.current); setOpen(false); }

  async function generate(a: Asset | null = asset) {
    if (!a) return;
    setStep("loading"); setGenStep(0); setErrorMsg(""); setNeedCredits(false);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setGenStep((s) => Math.min(s + 1, GEN_STEPS.length - 1)), 700);
    try {
      const [res] = await Promise.all([
        fetch("/api/om-signal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ td: a.td, orderType, style, method, confirmations: confs }) }),
        delay(3000),
      ]);
      if (timer.current) clearInterval(timer.current);
      const data = await res.json().catch(() => ({}));
      if (data.notConfigured === "marketdata") { setErrorMsg("Live market data isn't connected yet — add a TWELVEDATA_API_KEY in Vercel and I'll pull real prices."); setStep("error"); return; }
      if (data.notConfigured === "ai") { setErrorMsg("OM AI isn't switched on yet — the Anthropic key is missing."); setStep("error"); return; }
      if (data.error === "ratelimit") { setErrorMsg(data.detail || "You've hit the free market-data limit (8 requests a minute). Give it about a minute, then generate again."); setStep("error"); return; }
      if (data.error === "system_busy") { setErrorMsg(data.detail || "The data desk is at capacity for a moment — try again in a few seconds."); setStep("error"); return; }
      if (res.status === 402 || data.error === "insufficient_credits") { setNeedCredits(true); setErrorMsg("You're out of credits. Your free credits reset tomorrow — or grab more to keep generating plays now."); setStep("error"); return; }
      if (data.error || !data.signal) { setErrorMsg(data.detail ? `Couldn't build a signal: ${data.detail}` : "Couldn't build a signal right now. Try another asset or try again shortly."); setStep("error"); return; }
      const r: Result = { ...data, id: Date.now(), status: "open" };
      setResult(r); setStep("result");
      persist([r, ...recent].slice(0, 20));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
      void earnMission("signal"); // auto-earn the daily "generate a play" mission
    } catch { if (timer.current) clearInterval(timer.current); setErrorMsg("Something interrupted the connection. Try again."); setStep("error"); }
  }

  async function checkResult(r: Result) {
    if (checking) return;
    setChecking(r.id);
    try {
      const res = await fetch("/api/om-signal-check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td: r.td, interval: r.interval, since: r.asOf, direction: r.signal.direction, entry: r.signal.entry, sl: r.signal.stopLoss, tp1: (r.signal.takeProfits || [])[0] }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.status === "win" || d.status === "loss") {
        const next = recent.map((x) => (x.id === r.id ? { ...x, status: d.status } : x));
        persist(next);
        if (result?.id === r.id) setResult({ ...result, status: d.status });
      }
    } catch { /* ignore */ } finally { setChecking(null); }
  }

  function deleteResult(id: number) {
    persist(recent.filter((x) => x.id !== id));
    if (result?.id === id) { setResult(null); }
  }

  const wins = recent.filter((r) => r.status === "win").length;
  const losses = recent.filter((r) => r.status === "loss").length;
  const rate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.18),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-gold-light to-[#8a6d35]"><Zap className="h-4 w-4 text-[#0a0b10]" /></span>
          <div>
            <p className="font-serif text-base font-semibold uppercase tracking-[0.14em]">OM AI Plays</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">AI trade signals · real market data</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {rate !== null && (
            <div className="text-right">
              <p className="font-serif text-lg font-bold text-emerald-400">{rate}%<span className="ml-1 text-xs font-normal text-white/40">win</span></p>
              <p className="text-[10px] uppercase tracking-[0.1em] text-white/40">{wins}W · {losses}L</p>
            </div>
          )}
          <button onClick={() => { reset(); setOpen(true); }} className="inline-flex items-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] transition-opacity hover:opacity-90">
            <Sparkles className="h-4 w-4" /> Generate Signal <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.signal} credit</span>
          </button>
        </div>
      </div>

      <div className="relative z-10 px-6 py-6 sm:px-8">
        {recent.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] ring-1 ring-white/10"><Sparkles className="h-6 w-6 text-white/30" /></span>
            <p className="mt-4 font-serif text-lg font-semibold">No active signals</p>
            <p className="mt-1 max-w-xs text-sm text-white/40">Generate your first signal to start tracking opportunities across every market.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {recent.map((r) => (
              <CompactCard key={r.id} r={r} checking={checking === r.id}
                onOpen={() => { setResult(r); setStep("result"); setOpen(true); }}
                onCheck={() => checkResult(r)}
                onDelete={() => deleteResult(r.id)} />
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={close}>
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-[#0d0e15] text-white ring-1 ring-white/12" onClick={(e) => e.stopPropagation()}>
            <div className="pointer-events-none absolute inset-x-0 -top-16 h-48 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.22),transparent)]" />
            <div className="relative z-10 flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-2">
                {(step === "asset" || step === "config") && (
                  <button onClick={() => setStep(step === "config" ? "asset" : "market")} className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10"><ChevronLeft className="h-4 w-4" /></button>
                )}
                <span className="text-[11px] uppercase tracking-[0.16em] text-white/45">
                  {step === "market" && "Step 1 · Market Type"}
                  {step === "asset" && "Step 2 · Select Asset"}
                  {step === "config" && "Step 3 · Configure"}
                  {step === "loading" && "Generating…"}
                  {step === "result" && "Your Signal"}
                  {step === "error" && "Heads up"}
                </span>
              </div>
              <button onClick={close} className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10"><X className="h-4 w-4" /></button>
            </div>

            <div className="relative z-10 px-6 pb-7 pt-1">
              {step === "market" && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Select Market Type</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Choose the market you want to trade in</p>
                  <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {MARKETS.map((m) => {
                      const Icon = MARKET_ICON[m.id];
                      return (
                        <button key={m.id} onClick={() => { setMarket(m); setStep("asset"); }} className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-center transition-colors hover:border-gold-light/40 hover:bg-white/[0.06]">
                          <Icon className={`h-7 w-7 ${MARKET_TINT[m.id]}`} />
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
                      <button key={a.td} onClick={() => { setAsset(a); setStep("config"); }} className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-gold-light/40 hover:bg-white/[0.06]">
                        <div><p className="font-semibold">{a.symbol}</p><p className="text-xs text-white/40">{a.name}</p></div>
                        <span className="text-white/30">›</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {step === "config" && asset && (
                <>
                  <h2 className="text-center font-serif text-2xl font-bold">Configure</h2>
                  <p className="mt-1 text-center text-sm text-white/45">Setup for <span className="text-gold-light">{asset.symbol}</span></p>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Trade Style</p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {([["scalp", "Scalp", "Minutes"], ["intraday", "Intraday", "1H"], ["swing", "Swing", "Daily"]] as const).map(([v, label, sub]) => (
                      <button key={v} onClick={() => setStyle(v)} className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${style === v ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="block text-sm font-semibold">{label}</span><span className="mt-0.5 block text-[10px] text-white/40">{sub}</span>
                      </button>
                    ))}
                  </div>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Analysis Method</p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {METHODS.map((m) => (
                      <button key={m.k} onClick={() => pickMethod(m.k)} className={`rounded-xl border px-2 py-2.5 text-center transition-colors ${method === m.k ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="block text-[13px] font-semibold">{m.label}</span><span className="mt-0.5 block text-[10px] leading-tight text-white/40">{m.sub}</span>
                      </button>
                    ))}
                  </div>

                  <div className="mt-5 flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-[0.12em] text-white/45">Confirmations</p>
                    <span className="text-[10px] text-white/35">tap to toggle</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {CONFS.map((c) => {
                      const on = confs.includes(c.k);
                      return (
                        <button key={c.k} onClick={() => toggleConf(c.k)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${on ? "border-gold-light/50 bg-gold-light/10 text-white" : "border-white/12 bg-white/[0.02] text-white/50 hover:text-white/80"}`}>
                          {on && <Check className="h-3 w-3 text-gold-light" />} {c.label}
                        </button>
                      );
                    })}
                  </div>

                  <p className="mt-5 text-[11px] uppercase tracking-[0.12em] text-white/45">Order Type</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {(["market", "limit"] as const).map((o) => (
                      <button key={o} onClick={() => setOrderType(o)} className={`rounded-xl border px-4 py-2.5 text-left transition-colors ${orderType === o ? "border-gold-light/60 bg-gold-light/10" : "border-white/12 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                        <span className="text-sm font-semibold capitalize">{o}</span>
                        <span className="mt-0.5 block text-[10px] text-white/40">{o === "market" ? "Around current price" : "Exact entry level"}</span>
                      </button>
                    ))}
                  </div>

                  <button onClick={() => generate()} disabled={confs.length === 0} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-3.5 text-[13px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] transition-opacity hover:opacity-90 disabled:opacity-40">
                    <Sparkles className="h-4 w-4" /> Generate Signal <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.signal} credit</span>
                  </button>
                </>
              )}

              {step === "loading" && (
                <div className="py-4">
                  <div className="flex flex-col items-center">
                    <span className="grid h-16 w-16 animate-pulse place-items-center rounded-full bg-gradient-to-br from-gold-light to-[#8a6d35]"><Sparkles className="h-7 w-7 text-[#0a0b10]" /></span>
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
                  <FullCard r={result} onCheck={() => checkResult(result)} checking={checking === result.id} />
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <button onClick={() => setDive(result)} className="inline-flex w-full items-center justify-center gap-2 rounded-none border border-gold-light/40 bg-gold-light/10 px-6 py-3 text-[12px] font-medium uppercase tracking-[0.14em] text-gold-light transition-colors hover:bg-gold-light/20"><Sparkles className="h-4 w-4" /> Deep dive <span className="rounded-full bg-gold-light/20 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.deepdive} credit</span></button>
                    <button onClick={reset} className="inline-flex w-full items-center justify-center gap-2 rounded-none border border-white/20 px-6 py-3 text-[12px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-white/10"><RefreshCw className="h-4 w-4" /> New Signal</button>
                  </div>
                </>
              )}

              {step === "error" && (
                <div className="py-6 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-500/15 text-amber-400"><ShieldAlert className="h-6 w-6" /></span>
                  <p className="mt-4 text-sm text-white/70">{errorMsg}</p>
                  {needCredits && (
                    <a href="/portal/credits" className="mt-5 inline-flex items-center justify-center gap-2 rounded-none bg-gradient-to-br from-gold-light to-[#8a6d35] px-6 py-2.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0a0b10] hover:opacity-90"><Sparkles className="h-4 w-4" /> Get credits</a>
                  )}
                  <button onClick={reset} className="mt-3 block rounded-none border border-white/20 px-6 py-2.5 text-[12px] font-medium uppercase tracking-[0.14em] text-white hover:bg-white/10">Back to start</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {dive && (
        <DeepDiveModal
          ticker={dive.symbol}
          name={dive.name}
          type={dive.market}
          td={dive.td}
          context="signal"
          dir={dive.signal.direction === "LONG" || dive.signal.direction === "SHORT" ? dive.signal.direction : undefined}
          style={dive.style}
          onClose={() => setDive(null)}
        />
      )}
    </div>
  );
}

function dirStyle(dir: string) {
  const color = dir === "LONG" ? "text-emerald-400 bg-emerald-500/15" : dir === "SHORT" ? "text-red-400 bg-red-500/15" : "text-white/60 bg-white/10";
  const Icon = dir === "LONG" ? ArrowUp : dir === "SHORT" ? ArrowDown : Minus;
  return { color, Icon };
}
function StatusBadge({ status }: { status: Status }) {
  if (status === "win") return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400">Win</span>;
  if (status === "loss") return <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-red-400">Loss</span>;
  return <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/50">Open</span>;
}

function CompactCard({ r, onOpen, onCheck, onDelete, checking }: { r: Result; onOpen: () => void; onCheck: () => void; onDelete: () => void; checking: boolean }) {
  const s = r.signal; const { color, Icon } = dirStyle(s.direction);
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{r.symbol}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${color}`}><Icon className="h-3 w-3" />{s.direction}</span>
          <StatusBadge status={r.status} />
        </div>
        <p className="mt-0.5 truncate text-[11px] text-white/40">
          Entry {fmt(s.entry)} · {s.timeframe}
          {typeof s.confirmed === "number" && <span className="text-white/55"> · {s.confirmed}/{s.total ?? s.checklist?.length ?? 5} confirmed</span>}
        </p>
      </button>
      <div className="ml-2 flex flex-shrink-0 items-center gap-1.5">
        {r.status === "open" && s.direction !== "NEUTRAL" && (
          <button onClick={onCheck} disabled={checking} title="Check result" className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/60 hover:bg-white/10 disabled:opacity-40">
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        )}
        {confirmDel ? (
          <div className="flex items-center gap-1">
            <button onClick={() => { onDelete(); setConfirmDel(false); }} title="Confirm delete" className="grid h-8 w-8 place-items-center rounded-full bg-red-500/90 text-white hover:bg-red-500">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setConfirmDel(false)} title="Cancel" className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/60 hover:bg-white/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDel(true)} title="Delete play" className="grid h-8 w-8 place-items-center rounded-full border border-white/12 text-white/50 hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function LivePrice({ td, entry, direction, closed }: { td: string; entry: number | null; direction: Signal["direction"]; closed?: boolean }) {
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Load the price ONCE on open, then only on manual refresh — no background
  // timer, so an open card never quietly burns market-data credits.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/om-price?td=${encodeURIComponent(td)}`, { cache: "no-store" });
      const d = await res.json();
      if (typeof d.price === "number" && Number.isFinite(d.price)) { setPrice(d.price); setFailed(false); }
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [td]);

  useEffect(() => { void load(); }, [load]);

  const diff = price !== null && entry !== null ? price - entry : null;
  const favor = diff === null ? 0 : direction === "SHORT" ? -diff : direction === "LONG" ? diff : 0;
  const pct = diff !== null && entry ? (diff / entry) * 100 : null;
  const col = favor > 0 ? "text-emerald-400" : favor < 0 ? "text-red-400" : "text-white";

  return (
    <div className="mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-black/40 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          {!closed && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${closed ? "bg-amber-400" : "bg-emerald-400"}`} />
        </span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-white/45">{closed ? "Last price" : "Current price"}</span>
        {!closed && (
          <button onClick={() => void load()} disabled={loading} title="Refresh price" className="grid h-6 w-6 place-items-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/70 disabled:opacity-40">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>
      <div className="text-right">
        {loading && price === null ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-white/50"><Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…</span>
        ) : price === null ? (
          <span className="text-sm text-white/40">{failed ? "unavailable" : "—"}</span>
        ) : (
          <div className="flex items-baseline justify-end gap-2">
            <span className={`font-serif text-xl font-bold tabular-nums ${col}`}>{fmt(price)}</span>
            {diff !== null && (direction === "LONG" || direction === "SHORT") && (
              <span className={`text-xs tabular-nums ${col}`}>{diff >= 0 ? "+" : ""}{fmt(diff)}{pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FullCard({ r, onCheck, checking }: { r: Result; onCheck: () => void; checking: boolean }) {
  const s = r.signal; const { color, Icon } = dirStyle(s.direction);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-serif text-xl font-bold">{r.symbol}</p>
          <p className="text-xs text-white/40">{r.name} · {r.market} · {r.orderType}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${color}`}><Icon className="h-4 w-4" />{s.direction}</span>
          <StatusBadge status={r.status} />
        </div>
      </div>

      {r.td && <LivePrice td={r.td} entry={numOk(s.entry) ? s.entry : null} direction={s.direction} closed={r.marketClosed} />}

      {r.marketClosed && <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-1.5 text-xs text-amber-300/90">Market is currently closed — analysis based on the last session.</p>}

      {s.setup && (
        <div className="mt-3 rounded-xl border border-gold-light/25 bg-gold-light/[0.06] px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-gold-light/80">Setup{r.method ? ` · ${r.method === "smc" ? "Smart Money" : r.method === "structure" ? "Market Structure" : "Best"}` : ""}</p>
          <p className="text-sm font-semibold text-white">{s.setup}</p>
        </div>
      )}

      {s.direction === "NEUTRAL" && <p className="mt-3 rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2 text-xs text-white/65">No A+ setup right now — OM AI recommends standing aside. Read the analysis below.</p>}

      {Array.isArray(s.checklist) && s.checklist.length > 0 && (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <p className="mb-2.5 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-white/45">
            <span>Confirmations</span>
            <span className="font-semibold text-white/70">{s.confirmed ?? s.checklist.filter((c) => c.ok).length} of {s.checklist.length} confirmed</span>
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {s.checklist.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className={`grid h-4 w-4 flex-shrink-0 place-items-center rounded-full ${c.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-white/[0.04] text-white/25"}`}>
                  {c.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </span>
                <span className={c.ok ? "text-white/80" : "text-white/40"}>{c.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.candles && r.candles.length > 3 && <MiniChart candles={r.candles} entry={numOk(s.entry) ? s.entry : null} sl={numOk(s.stopLoss) ? s.stopLoss : null} tps={(s.takeProfits || []).filter(numOk)} />}

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Cell label="Entry" value={fmt(s.entry)} tint="text-white" />
        <Cell label="Stop Loss" value={fmt(s.stopLoss)} tint="text-red-400" icon={<ShieldAlert className="h-3 w-3" />} />
        <Cell label="Risk : Reward" value={s.riskReward || "—"} tint="text-gold-light" />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        {[0, 1, 2].map((i) => <Cell key={i} label={`TP${i + 1}`} value={fmt((s.takeProfits || [])[i])} tint="text-emerald-400" icon={<Target className="h-3 w-3" />} />)}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
        <span>Confidence: <span className="font-semibold text-white/80">{s.confidence}</span></span>
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {s.timeframe}</span>
        {r.status === "open" && s.direction !== "NEUTRAL" && (
          <button onClick={onCheck} disabled={checking} className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-40">
            {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Check result
          </button>
        )}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-white/80">{s.rationale}</p>
      <div className="mt-3 space-y-1 text-xs text-white/55">
        {s.bias && <p><span className="text-white/40">HTF bias:</span> {s.bias}</p>}
        {s.poi && <p><span className="text-white/40">POI:</span> {s.poi}</p>}
        {s.liquidityTarget && <p><span className="text-white/40">Targeting:</span> {s.liquidityTarget}</p>}
      </div>
      {s.invalidation && <p className="mt-2 text-xs text-white/45"><span className="text-white/60">Invalidation:</span> {s.invalidation}</p>}

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] text-white/35">Price {fmt(r.price)} · as of {r.asOf} · live data via Twelve Data. Educational analysis, not financial advice — verify before trading.</p>
    </div>
  );
}

function MiniChart({ candles, entry, sl, tps }: { candles: Candle[]; entry: number | null; sl: number | null; tps: number[] }) {
  const W = 320, H = 160, padT = 8, padB = 8, padL = 4, padR = 42;
  const cHi = Math.max(...candles.map((c) => c.h));
  const cLo = Math.min(...candles.map((c) => c.l));
  const cRange = cHi - cLo || 1;
  // Only levels within a sane band of the candle range are plotted/scaled.
  const inBand = (n: unknown): n is number => numOk(n) && n >= cLo - cRange * 0.6 && n <= cHi + cRange * 0.6;
  const levels = [entry, sl, ...tps].filter(inBand);
  const max0 = Math.max(cHi, ...levels), min0 = Math.min(cLo, ...levels);
  const pad = (max0 - min0 || 1) * 0.06;
  const max = max0 + pad, min = min0 - pad, span = max - min || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / candles.length, bodyW = Math.max(1.2, slot * 0.6);
  const y = (p: number) => padT + ((max - p) / span) * plotH;
  const x = (i: number) => padL + i * slot + slot / 2;
  const price = (p: number) => (Math.abs(p) >= 1000 ? p.toFixed(0) : Math.abs(p) >= 1 ? p.toFixed(2) : p.toFixed(4));

  // Build the labelled levels, then push their TEXT apart so labels never overlap
  // when entry/SL/TP sit close together (the dashed line stays at the true price).
  const raw: { col: string; p: number; label: string }[] = [
    { col: "#ffffff", p: entry as number, label: "Entry" },
    { col: "#f87171", p: sl as number, label: "SL" },
    ...tps.map((t, i) => ({ col: "#34d399", p: t, label: `TP${i + 1}` })),
  ].filter((L) => inBand(L.p));
  const placed = raw
    .map((L) => ({ ...L, ly: y(L.p) }))
    .sort((a, b) => a.ly - b.ly);
  const GAP = 9;
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].ly - placed[i - 1].ly < GAP) placed[i].ly = placed[i - 1].ly + GAP;
  }
  // keep the stack inside the frame
  const overflow = placed.length ? placed[placed.length - 1].ly - (H - 4) : 0;
  if (overflow > 0) placed.forEach((L) => { L.ly -= overflow; });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full rounded-xl border border-white/10 bg-black/30">
      {candles.map((c, i) => {
        const col = c.c >= c.o ? "#34d399" : "#f87171";
        const yo = y(c.o), yc = y(c.c);
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={0.5} opacity={0.7} />
            <rect x={x(i) - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(0.6, Math.abs(yc - yo))} fill={col} opacity={0.85} />
          </g>
        );
      })}
      {placed.map((L, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(L.p)} y2={y(L.p)} stroke={L.col} strokeWidth={0.7} strokeDasharray="3 2" opacity={0.85} />
          {/* thin connector from the true line to the (possibly nudged) label */}
          <line x1={W - padR} x2={W - padR + 3} y1={y(L.p)} y2={L.ly} stroke={L.col} strokeWidth={0.5} opacity={0.5} />
          <text x={W - padR + 4} y={L.ly + 2} fill={L.col} fontSize={6.5} fontWeight="bold">{L.label} {price(L.p)}</text>
        </g>
      ))}
    </svg>
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
