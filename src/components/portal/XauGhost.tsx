"use client";

/**
 * MFXGHOST — the front end for the dedicated multi-instrument intelligence engine
 * (FX majors + Gold). Pick an instrument, then it renders the full institutional
 * read (regime, HTF bias, liquidity map, chosen strategy, entries, confidence,
 * probabilities, reasons to avoid, invalidation, session behaviour, management)
 * — or a clear "No Trade" when there is no edge. Each instrument keeps its own
 * saved read and track record.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Ghost, Loader2, ArrowUp, ArrowDown, ShieldAlert, Target, Gauge, Layers, Droplets,
  Crosshair, Compass, Clock, AlertTriangle, Sparkles, TrendingUp, Trophy, BarChart3, ListChecks, BookOpen, GraduationCap, Activity, Eye,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";
import { CopyBtn, CopyAllBtn, buildTradeText } from "./copykit";

type Entries = { primary: number | null; aggressive: number | null; conservative: number | null; confirmation?: string };
type LiquidityMap = { buyside?: string[]; sellside?: string[]; taken?: string[]; resting?: string[] };
type KeyLevels = { support?: string[]; resistance?: string[] };
type ScoreItem = { condition?: string; strategy?: string; probability?: number; score?: number };
type Read = {
  regime?: string; bias?: string; htfBias?: string; narrative?: string;
  marketScorecard?: ScoreItem[]; strategyRanking?: ScoreItem[]; winningStrategy?: string; whyChosen?: string; bestStrategy?: string;
  liquidityMap?: LiquidityMap; keyLevels?: KeyLevels;
  decision?: "TRADE" | "NO_TRADE"; direction?: "LONG" | "SHORT" | "NONE";
  entries?: Entries; stopLoss?: number | null; takeProfits?: number[];
  riskReward?: string; confidence?: number; grade?: string;
  winProbability?: number; failureProbability?: number;
  longProbability?: number; shortProbability?: number;
  reasonsToAvoid?: string[]; invalidation?: string; sessionBehavior?: string; tradeManagement?: string;
};
type Result = { price: number; asOf: string; session?: string; symbol?: string; read: Read };
// Live "Get update" snapshot for the current call.
type TradeUpdate = {
  headline: string; thesis: "intact" | "weakening" | "invalidated"; price: number;
  pnl: { r: number; pips: number; side: string; percent: number };
  distance: { to_stop_pips: number; to_next_target_pips: number; next_target_label: string };
  market?: { flow_1h?: string; flow_4h?: string; rsi?: number | null };
  explanation: string[]; what_to_watch: string;
};

// The instruments MFXGHOST covers (must match the API allow-list).
const INSTRUMENTS: { td: string; label: string }[] = [
  { td: "USD/JPY", label: "USD/JPY" },
  { td: "EUR/USD", label: "EUR/USD" },
  { td: "GBP/USD", label: "GBP/USD" },
  { td: "AUD/USD", label: "AUD/USD" },
  { td: "USD/CAD", label: "USD/CAD" },
  { td: "XAU/USD", label: "Gold" },
];
const DEFAULT_SYM = "XAU/USD";

const STEPS = ["Pulling multi-timeframe data · Daily → 5M", "Detecting market regime", "Mapping liquidity & structure", "Scoring institutional confluence", "Writing the read"];
// Price precision auto-scales to the instrument's magnitude: gold (~3300) → 2dp,
// JPY (~157) → 3dp, FX majors (~1.08) → 5dp. Works across mixed-symbol journals.
const fmt = (n: number | null | undefined) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), d = a >= 1000 ? 2 : a >= 50 ? 3 : 5;
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};

type Trade = {
  client_id: string; as_of?: string; direction?: string; strategy?: string; regime?: string;
  entry?: number | null; stop_loss?: number | null; tp1?: number | null; tp2?: number | null; tp3?: number | null;
  confidence?: number | null; grade?: string; status?: string; hit_tp?: number | null; lesson?: string; created_at?: string;
};

export function XauGhost() {
  const [symbol, setSymbol] = useState(DEFAULT_SYM);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [res, setRes] = useState<Result | null>(null);
  const [msg, setMsg] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [checking, setChecking] = useState<string | null>(null);
  const [ghostUpdating, setGhostUpdating] = useState(false);
  const [ghostUpdate, setGhostUpdate] = useState<TradeUpdate | null>(null);

  const symLabel = INSTRUMENTS.find((i) => i.td === symbol)?.label ?? symbol;

  const loadTrades = useCallback(async (sym: string) => {
    try {
      const r = await fetch(`/api/xaughost/trades?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (Array.isArray(d.trades)) setTrades(d.trades);
      else setTrades([]);
    } catch { /* offline */ }
  }, []);

  // Load the saved read + journal for whatever instrument is selected. Runs on
  // mount and whenever the user switches pairs, so each instrument is independent.
  useEffect(() => {
    setGhostUpdate(null); setMsg("");
    let saved: Result | null = null;
    try { const raw = localStorage.getItem(`om_mfxghost:${symbol}`); if (raw) saved = JSON.parse(raw); } catch { /* ignore */ }
    setRes(saved);
    setHydrated(true);
    void loadTrades(symbol);
  }, [symbol, loadTrades]);

  const run = useCallback(async () => {
    setLoading(true); setMsg(""); setStep(0);
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1400);
    try {
      const r = await fetch("/api/xaughost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol }) });
      const d = await r.json().catch(() => ({}));
      if (d.notConfigured) { setMsg("The desk isn't switched on yet."); return; }
      if (r.status === 402 || d.error === "insufficient_credits") { setMsg(`You're out of credits — a run costs ${CREDIT_COST.ghost}. Free credits reset weekly, or top up on the Credits page.`); return; }
      if (d.error === "system_busy" || d.error === "ratelimit") { setMsg(d.detail || "The desk is at capacity for a moment — try again shortly."); return; }
      if (d.error || !d.read) { setMsg(d.detail || "Couldn't complete the read — try again shortly."); return; }
      const result: Result = { price: d.price, asOf: d.asOf, session: d.session, symbol: d.symbol || symbol, read: d.read };
      setRes(result); setGhostUpdate(null);
      try { localStorage.setItem(`om_mfxghost:${symbol}`, JSON.stringify(result)); } catch { /* ignore */ }
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
      // Auto-save every directional call (with levels) to this instrument's journal.
      const rd = d.read as Read;
      if (rd?.direction && rd.direction !== "NONE" && (rd.entries?.primary != null || rd.stopLoss != null)) {
        const trade = {
          id: Date.now(), symbol, asOf: d.asOf, direction: rd.direction, strategy: rd.winningStrategy || rd.bestStrategy,
          regime: rd.regime, entry: rd.entries?.primary, stopLoss: rd.stopLoss, takeProfits: rd.takeProfits,
          confidence: rd.confidence, grade: rd.grade, status: "open", payload: rd,
        };
        try { await fetch("/api/xaughost/trades", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trade }) }); } catch { /* ignore */ }
        void loadTrades(symbol);
      }
    } catch { setMsg("Something interrupted the connection. Try again."); }
    finally { clearInterval(timer); setLoading(false); }
  }, [symbol, loadTrades]);

  const checkOutcome = useCallback(async (id: string) => {
    setChecking(id);
    try {
      const r = await fetch("/api/xaughost/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const d = await r.json().catch(() => ({}));
      if (d.status === "win" || d.status === "loss") {
        setTrades((prev) => prev.map((t) => (t.client_id === id ? { ...t, status: d.status, hit_tp: typeof d.hitTp === "number" ? d.hitTp : t.hit_tp, lesson: d.lesson || t.lesson } : t)));
      }
    } catch { /* ignore */ } finally { setChecking(null); }
  }, []);

  // "Get update" — re-read the live market and explain what's happened to this call
  // since it was generated (profit/drawdown, stop-run vs real break, flow flip). Free.
  const getUpdate = useCallback(async () => {
    const rd = res?.read;
    if (!rd || ghostUpdating) return;
    const sym = res?.symbol || symbol;
    const dir = rd.direction === "LONG" ? "LONG" : rd.direction === "SHORT" ? "SHORT" : null;
    const entry = rd.entries?.primary, stop = rd.stopLoss;
    const tps = (rd.takeProfits || []).filter((n): n is number => typeof n === "number");
    if (!dir || entry == null || stop == null || tps.length === 0) return;
    setGhostUpdating(true);
    try {
      const r = await fetch("/api/om-signal-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td: sym, symbol: sym, style: "intraday", direction: dir, entry, stopLoss: stop, takeProfits: tps, since: res?.asOf || "" }),
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.status === "update") setGhostUpdate(d as TradeUpdate);
    } catch { /* ignore */ } finally { setGhostUpdating(false); }
  }, [res, symbol, ghostUpdating]);

  const read = res?.read;
  const noTrade = read?.decision === "NO_TRADE" || read?.direction === "NONE";
  const isLong = read?.direction === "LONG";
  const conf = typeof read?.confidence === "number" ? Math.max(0, Math.min(100, read.confidence)) : null;
  const longP = typeof read?.longProbability === "number" ? Math.max(0, Math.min(100, read.longProbability)) : null;
  const winP = typeof read?.winProbability === "number" ? Math.max(0, Math.min(100, read.winProbability)) : null;
  const scorecard = Array.isArray(read?.marketScorecard) ? read!.marketScorecard : [];
  const ranking = Array.isArray(read?.strategyRanking) ? read!.strategyRanking : [];

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      {/* Header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[#CFC7B3] to-[#8a8266] text-black shadow-[0_0_30px_rgba(207,199,179,0.25)]"><Ghost className="h-6 w-6" /></span>
          <div>
            <h2 className="font-serif text-2xl font-black tracking-tight">MFXGHOST</h2>
            <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Multi-FX + Gold intelligence · institutional engine</p>
          </div>
        </div>
        <button
          onClick={() => void run()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#CFC7B3] to-[#B8AE93] px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {loading ? "Analyzing…" : res ? "Run again" : "Run intelligence"}
          {!loading && <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[10px] font-bold">{CREDIT_COST.ghost} credits</span>}
        </button>
      </div>

      {/* Instrument selector — each pair has its own read + track record. */}
      <div className="relative z-10 flex flex-wrap items-center gap-2 border-b border-white/10 px-6 py-3 sm:px-8">
        <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white/35">Pair</span>
        {INSTRUMENTS.map((it) => {
          const active = it.td === symbol;
          return (
            <button key={it.td} onClick={() => { if (!loading && it.td !== symbol) setSymbol(it.td); }} disabled={loading}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors disabled:opacity-40 ${active ? "bg-gradient-to-r from-[#CFC7B3] to-[#B8AE93] text-black" : "border border-white/15 text-white/70 hover:bg-white/10"}`}>
              {it.label}
            </button>
          );
        })}
      </div>

      <div className="relative z-10 p-6 sm:p-8">
        {msg && (
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {msg}
          </div>
        )}

        {loading && !res && (
          <div className="space-y-2.5">
            {STEPS.map((s, i) => (
              <div key={i} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${i === step ? "bg-white/[0.06] ring-1 ring-[#CFC7B3]/30" : ""}`}>
                <span className={`grid h-5 w-5 place-items-center rounded-full ${i < step ? "bg-emerald-500/20 text-emerald-400" : i === step ? "text-[#CFC7B3]" : "text-white/20"}`}>
                  {i < step ? "✓" : i === step ? <Loader2 className="h-3 w-3 animate-spin" /> : "○"}
                </span>
                <span className={`text-sm ${i <= step ? "text-white/80" : "text-white/30"}`}>{s}</span>
              </div>
            ))}
          </div>
        )}

        {hydrated && !res && !loading && (
          <div className="rounded-2xl border border-dashed border-white/12 bg-white/[0.02] px-4 py-12 text-center">
            <Ghost className="mx-auto h-8 w-8 text-white/25" />
            <p className="mt-3 text-sm text-white/65">Run the desk for a full institutional read on <span className="font-semibold text-white">{symLabel}</span> — regime, liquidity, the highest-edge strategy right now, or a clear <span className="font-semibold text-white">No Trade</span>.</p>
            <p className="mt-1 text-[11px] text-white/35">Analyses Daily → 5M · costs {CREDIT_COST.ghost} credits · {symLabel}</p>
          </div>
        )}

        {read && (
          <div className="space-y-5">
            {/* Decision banner — always shows a directional call; NO_TRADE means low conviction (levels still given). */}
            <div className={`rounded-2xl border p-5 ${noTrade ? "border-amber-400/30 bg-amber-400/[0.06]" : isLong ? "border-emerald-400/30 bg-emerald-500/[0.07]" : "border-red-400/30 bg-red-500/[0.07]"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-black uppercase tracking-wide ${isLong ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                    {isLong ? <><ArrowUp className="h-4 w-4" /> Long</> : <><ArrowDown className="h-4 w-4" /> Short</>}
                  </span>
                  {noTrade
                    ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-3 py-1 text-xs font-bold text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> Low conviction</span>
                    : read.grade && <span className="rounded-full bg-[#CFC7B3]/15 px-3 py-1 text-xs font-bold text-[#CFC7B3]">{read.grade}</span>}
                  {read.regime && <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/60">{read.regime}</span>}
                </div>
                {res && (
                  <div className="text-right">
                    <p className="font-serif text-xl font-bold tabular-nums">{fmt(res.price)}</p>
                    <p className="text-[10px] uppercase tracking-wide text-white/40">live {res.symbol || symbol}</p>
                  </div>
                )}
              </div>
              {noTrade && <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/90">No clean A-grade edge right now — the levels below are the best available read. Consider smaller size or waiting for the confirmation trigger.</p>}
              {read.htfBias && <p className="mt-3 text-sm leading-relaxed text-white/75">{read.htfBias}</p>}
            </div>

            {/* Confidence + probability */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-white/45"><Gauge className="h-3.5 w-3.5" /> Confidence</p>
                <div className="mt-2 flex items-center gap-3">
                  <span className="font-serif text-2xl font-bold">{conf != null ? `${conf}` : "—"}<span className="text-sm text-white/40">/100</span></span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-gradient-to-r from-[#8a8266] to-[#CFC7B3]" style={{ width: `${conf ?? 0}%` }} />
                  </div>
                </div>
                {winP != null && <p className="mt-2 text-xs text-white/50">Win probability <span className="font-semibold text-emerald-300">{winP}%</span> · fail <span className="font-semibold text-red-300">{100 - winP}%</span></p>}
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-white/45"><TrendingUp className="h-3.5 w-3.5" /> Directional probability</p>
                {longP != null ? (
                  <>
                    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-red-500/30">
                      <div className="h-full bg-emerald-500/80" style={{ width: `${longP}%` }} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-xs font-semibold"><span className="text-emerald-300">Long {longP}%</span><span className="text-red-300">Short {100 - longP}%</span></div>
                  </>
                ) : <p className="mt-2 text-sm text-white/40">—</p>}
              </div>
            </div>

            {/* Market scorecard + strategy ranking */}
            <div className="grid gap-3 lg:grid-cols-2">
              {scorecard.length > 0 && (
                <Section icon={<BarChart3 className="h-3.5 w-3.5" />} title="Market scorecard">
                  <ul className="space-y-2">
                    {scorecard.map((c, i) => {
                      const p = Math.max(0, Math.min(100, Number(c.probability) || 0));
                      return (
                        <li key={i} className="flex items-center gap-2.5">
                          <span className="w-40 flex-shrink-0 truncate text-xs text-white/75">{c.condition}</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                            <div className={`h-full rounded-full ${p >= 70 ? "bg-[#CFC7B3]" : p >= 40 ? "bg-white/40" : "bg-white/20"}`} style={{ width: `${p}%` }} />
                          </div>
                          <span className="w-9 flex-shrink-0 text-right text-xs font-bold tabular-nums text-white/70">{p}%</span>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}
              {ranking.length > 0 && (
                <Section icon={<ListChecks className="h-3.5 w-3.5" />} title="Top strategies ranked">
                  <ul className="space-y-2">
                    {ranking.map((s, i) => {
                      const sc = Math.max(0, Math.min(100, Number(s.score) || 0));
                      const win = i === 0;
                      return (
                        <li key={i} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${win ? "bg-[#CFC7B3]/10 ring-1 ring-[#CFC7B3]/30" : ""}`}>
                          <span className={`grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-[10px] font-bold ${win ? "bg-[#CFC7B3] text-black" : "bg-white/10 text-white/50"}`}>{win ? <Trophy className="h-3 w-3" /> : i + 1}</span>
                          <span className={`flex-1 truncate text-xs ${win ? "font-bold text-white" : "text-white/70"}`}>{s.strategy}</span>
                          <span className={`text-xs font-bold tabular-nums ${win ? "text-[#CFC7B3]" : "text-white/50"}`}>{sc}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}
            </div>

            {/* Winning strategy + why chosen */}
            {(read.winningStrategy || read.whyChosen || read.bestStrategy) && (
              <Section icon={<Crosshair className="h-3.5 w-3.5" />} title="Winning strategy — why it was chosen">
                {read.winningStrategy && <p className="mb-1.5 font-serif text-lg font-bold text-[#CFC7B3]">{read.winningStrategy}</p>}
                <p className="text-sm leading-relaxed text-white/80">{read.whyChosen || read.bestStrategy}</p>
              </Section>
            )}

            {/* Narrative */}
            {read.narrative && (
              <Section icon={<Compass className="h-3.5 w-3.5" />} title="Institutional narrative">
                <p className="text-sm leading-relaxed text-white/80">{read.narrative}</p>
              </Section>
            )}

            {/* Liquidity map */}
            {read.liquidityMap && (
              <Section icon={<Droplets className="h-3.5 w-3.5" />} title="Liquidity map">
                <div className="grid gap-3 sm:grid-cols-2">
                  <LiqCol label="Buy-side liquidity" items={read.liquidityMap.buyside} tone="emerald" />
                  <LiqCol label="Sell-side liquidity" items={read.liquidityMap.sellside} tone="red" />
                  <LiqCol label="Already taken" items={read.liquidityMap.taken} tone="muted" />
                  <LiqCol label="Still resting" items={read.liquidityMap.resting} tone="gold" />
                </div>
              </Section>
            )}

            {/* Key support / resistance */}
            {read.keyLevels && ((read.keyLevels.resistance?.length ?? 0) > 0 || (read.keyLevels.support?.length ?? 0) > 0) && (
              <Section icon={<Layers className="h-3.5 w-3.5" />} title="Key support & resistance">
                <div className="grid gap-3 sm:grid-cols-2">
                  <LiqCol label="Resistance" items={read.keyLevels.resistance} tone="red" />
                  <LiqCol label="Support" items={read.keyLevels.support} tone="emerald" />
                </div>
              </Section>
            )}

            {/* Trade plan — always shown, even on a low-conviction (No Trade) read. */}
            {(read.entries || read.stopLoss != null || (read.takeProfits && read.takeProfits.length > 0)) && (
              <Section icon={<Target className="h-3.5 w-3.5" />} title={noTrade ? "Trade plan (low conviction)" : "Trade plan"}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Primary entry" value={fmt(read.entries?.primary)} copy={fmt(read.entries?.primary)} />
                  <Stat label="Aggressive" value={fmt(read.entries?.aggressive)} copy={fmt(read.entries?.aggressive)} />
                  <Stat label="Conservative" value={fmt(read.entries?.conservative)} copy={fmt(read.entries?.conservative)} />
                  <Stat label="Stop loss" value={fmt(read.stopLoss)} tone="red" copy={fmt(read.stopLoss)} />
                  <Stat label="Risk : reward" value={read.riskReward || "—"} tone="gold" />
                  <Stat label="—" value="" hidden />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => <Stat key={i} label={`TP${i + 1}`} value={fmt((read.takeProfits || [])[i])} tone="emerald" copy={fmt((read.takeProfits || [])[i])} />)}
                </div>
                {read.direction && read.direction !== "NONE" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <CopyAllBtn text={buildTradeText({ direction: read.direction, entry: read.entries?.primary, stopLoss: read.stopLoss, takeProfits: read.takeProfits, fmt })} />
                  </div>
                )}
                {read.entries?.confirmation && <p className="mt-3 text-xs text-white/55"><span className="text-white/40">Confirmation:</span> {read.entries.confirmation}</p>}
                {read.direction && read.direction !== "NONE" && read.entries?.primary != null && read.stopLoss != null && (read.takeProfits?.length ?? 0) > 0 && (
                  <button onClick={() => void getUpdate()} disabled={ghostUpdating}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 px-3.5 py-1.5 text-[12px] font-semibold text-sky-300 transition-colors hover:bg-sky-400/20 disabled:opacity-40">
                    {ghostUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />} Get update — what happened since
                  </button>
                )}
                {ghostUpdate && <UpdatePanel u={ghostUpdate} />}
              </Section>
            )}

            {/* Reasons to avoid */}
            {Array.isArray(read.reasonsToAvoid) && read.reasonsToAvoid.length > 0 && (
              <Section icon={<ShieldAlert className="h-3.5 w-3.5" />} title={noTrade ? "Why there's no edge right now" : "Reasons to avoid / watch"}>
                <ul className="space-y-1.5">
                  {read.reasonsToAvoid.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-white/75"><span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-amber-400" /> {r}</li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Invalidation + session + management */}
            <div className="grid gap-3 sm:grid-cols-2">
              {read.invalidation && <MiniCard icon={<Layers className="h-3.5 w-3.5" />} title="What invalidates it" body={read.invalidation} />}
              {read.sessionBehavior && <MiniCard icon={<Clock className="h-3.5 w-3.5" />} title="Expected session behaviour" body={read.sessionBehavior} />}
            </div>
            {read.tradeManagement && <MiniCard icon={<Gauge className="h-3.5 w-3.5" />} title="Trade management plan" body={read.tradeManagement} full />}

            {res && (
              <p className="border-t border-white/10 pt-3 text-[11px] text-white/35">
                {read.bias ? `Bias: ${read.bias} · ` : ""}{res.session ? `${res.session} · ` : ""}as of {new Date(res.asOf).toLocaleString()} · live data via Twelve Data. Educational analysis, not financial advice — verify before trading.
              </p>
            )}
          </div>
        )}

        {/* -- Track record & learning journal -- */}
        <TrackRecord trades={trades} checking={checking} onCheck={checkOutcome} />
      </div>
    </div>
  );
}

function TrackRecord({ trades, checking, onCheck }: { trades: Trade[]; checking: string | null; onCheck: (id: string) => void }) {
  if (!trades.length) return null;
  const wins = trades.filter((t) => t.status === "win").length;
  const losses = trades.filter((t) => t.status === "loss").length;
  const open = trades.filter((t) => t.status !== "win" && t.status !== "loss").length;
  const rate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  return (
    <div className="mt-8 border-t border-white/10 pt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.14em] text-white/70"><BookOpen className="h-4 w-4 text-[#CFC7B3]" /> Track record & learning</h3>
        <div className="flex items-center gap-3 text-xs">
          {rate != null && <span className="font-serif text-lg font-bold text-emerald-400">{rate}%<span className="ml-1 text-[10px] font-normal text-white/40">win</span></span>}
          <span className="text-white/50">{wins}W · {losses}L · {open} open</span>
        </div>
      </div>
      <p className="mb-3 text-[11px] text-white/40">Each call is saved and checked against real candles. MFXGHOST learns from every result on this pair — repeating what wins, avoiding what fails — and feeds those lessons into future reads.</p>
      <ul className="space-y-2">
        {trades.map((t) => {
          const isWin = t.status === "win", isLoss = t.status === "loss";
          const isLong = t.direction === "LONG";
          return (
            <li key={t.client_id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${isLong ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                  {isLong ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{t.direction}
                </span>
                <span className="text-sm font-semibold text-white/85">{t.strategy || "Call"}</span>
                {t.grade && <span className="rounded-full bg-[#CFC7B3]/15 px-2 py-0.5 text-[10px] font-bold text-[#CFC7B3]">{t.grade}</span>}
                <span className="ml-auto">
                  {isWin ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">Win{t.hit_tp ? ` · TP${t.hit_tp}` : ""}</span>
                    : isLoss ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-red-300">Stopped</span>
                    : <button onClick={() => onCheck(t.client_id)} disabled={checking === t.client_id} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-[11px] font-semibold text-white/70 hover:bg-white/10 disabled:opacity-40">
                        {checking === t.client_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Check outcome
                      </button>}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-white/40">
                {t.regime ? `${t.regime} · ` : ""}entry {fmt(t.entry)} · SL {fmt(t.stop_loss)} · TP {fmt(t.tp1)}/{fmt(t.tp2)}/{fmt(t.tp3)}{t.as_of ? ` · ${new Date(t.as_of).toLocaleDateString()}` : ""}
              </p>
              {t.lesson && (
                <div className={`mt-2.5 rounded-xl border p-3 ${isWin ? "border-emerald-400/20 bg-emerald-500/[0.05]" : "border-amber-400/20 bg-amber-400/[0.05]"}`}>
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[#CFC7B3]/80"><GraduationCap className="h-3 w-3" /> {isWin ? "What worked — repeat this" : "Lesson — what went wrong"}</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/80">{t.lesson}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <p className="mb-2.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-[#CFC7B3]/80">{icon}{title}</p>
      {children}
    </div>
  );
}

function LiqCol({ label, items, tone }: { label: string; items?: string[]; tone: "emerald" | "red" | "gold" | "muted" }) {
  const col = tone === "emerald" ? "text-emerald-300" : tone === "red" ? "text-red-300" : tone === "gold" ? "text-[#CFC7B3]" : "text-white/45";
  return (
    <div className="rounded-xl bg-black/30 p-3">
      <p className={`text-[10px] font-bold uppercase tracking-wide ${col}`}>{label}</p>
      {Array.isArray(items) && items.length ? (
        <ul className="mt-1.5 space-y-1">{items.map((it, i) => <li key={i} className="text-xs text-white/70">{it}</li>)}</ul>
      ) : <p className="mt-1.5 text-xs text-white/30">none noted</p>}
    </div>
  );
}

function Stat({ label, value, tone, hidden, copy }: { label: string; value: string; tone?: "red" | "emerald" | "gold"; hidden?: boolean; copy?: string }) {
  if (hidden) return <div className="hidden sm:block" />;
  const col = tone === "red" ? "text-red-400" : tone === "emerald" ? "text-emerald-400" : tone === "gold" ? "text-[#CFC7B3]" : "text-white";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5 text-center">
      <p className="text-[10px] uppercase tracking-[0.1em] text-white/40">{label}</p>
      <p className={`mt-0.5 flex items-center justify-center gap-1 font-serif text-base font-bold tabular-nums ${col}`}>{value}{copy ? <CopyBtn value={copy} label={label} /> : null}</p>
    </div>
  );
}

function MiniCard({ icon, title, body, full }: { icon: React.ReactNode; title: string; body: string; full?: boolean }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.02] p-4 ${full ? "sm:col-span-2" : ""}`}>
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-white/45">{icon}{title}</p>
      <p className="text-sm leading-relaxed text-white/80">{body}</p>
    </div>
  );
}

function UpdatePanel({ u }: { u: TradeUpdate }) {
  const side = u.pnl?.side;
  const tone = side === "profit" ? "emerald" : side === "drawdown" ? "amber" : "sky";
  const border = tone === "emerald" ? "border-emerald-400/30 bg-emerald-500/[0.06]" : tone === "amber" ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-sky-400/30 bg-sky-400/[0.06]";
  const chip = u.thesis === "intact" ? "bg-emerald-500/15 text-emerald-300" : u.thesis === "weakening" ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300";
  const rStr = `${u.pnl.r >= 0 ? "+" : ""}${u.pnl.r}R`;
  return (
    <div className={`mt-4 rounded-2xl border px-4 py-3.5 ${border}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70"><Activity className="h-3.5 w-3.5 text-sky-300" /> Live update</p>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${chip}`}>Idea {u.thesis}</span>
      </div>
      <p className="mt-2 text-sm font-semibold text-white">{u.headline}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
        <span>Now: <span className="font-semibold tabular-nums text-white/85">{fmt(u.price)}</span></span>
        <span>P/L: <span className={`font-semibold tabular-nums ${side === "profit" ? "text-emerald-400" : side === "drawdown" ? "text-amber-300" : "text-white/70"}`}>{rStr} · {u.pnl.pips >= 0 ? "+" : ""}{u.pnl.pips} pips</span></span>
        <span>To stop: <span className="tabular-nums text-white/75">{u.distance.to_stop_pips} pips</span></span>
        <span>To {u.distance.next_target_label}: <span className="tabular-nums text-white/75">{u.distance.to_next_target_pips} pips</span></span>
      </div>
      {Array.isArray(u.explanation) && u.explanation.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {u.explanation.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-white/80"><span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-sky-300/70" /> {e}</li>
          ))}
        </ul>
      )}
      {u.what_to_watch && (
        <p className="mt-3 inline-flex items-start gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/70"><Eye className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-white/50" /> <span><span className="text-white/50">What to watch:</span> {u.what_to_watch}</span></p>
      )}
      <p className="mt-2 text-[10px] text-white/35">Educational market-management context, not financial advice. Live data via Twelve Data.</p>
    </div>
  );
}
