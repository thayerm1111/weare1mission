"use client";

/**
 * XAUGHOST — the front end for the dedicated Gold (XAU/USD) intelligence engine.
 * Self-contained and gold-only; renders the full institutional read (regime,
 * HTF bias, liquidity map, chosen strategy, entries, confidence, probabilities,
 * reasons to avoid, invalidation, session behaviour, management) — or a clear
 * "No Trade" when there is no edge.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Ghost, Loader2, ArrowUp, ArrowDown, ShieldAlert, Target, Gauge, Layers, Droplets,
  Crosshair, Compass, Clock, AlertTriangle, Ban, Sparkles, TrendingUp,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";

type Entries = { primary: number | null; aggressive: number | null; conservative: number | null; confirmation?: string };
type LiquidityMap = { buyside?: string[]; sellside?: string[]; taken?: string[]; resting?: string[] };
type Read = {
  bias?: string; regime?: string; htfBias?: string; narrative?: string;
  liquidityMap?: LiquidityMap; bestStrategy?: string;
  decision?: "TRADE" | "NO_TRADE"; direction?: "LONG" | "SHORT" | "NONE";
  entries?: Entries; stopLoss?: number | null; takeProfits?: number[];
  riskReward?: string; confidence?: number; grade?: string;
  longProbability?: number; shortProbability?: number;
  reasonsToAvoid?: string[]; invalidation?: string; sessionBehavior?: string; tradeManagement?: string;
};
type Result = { price: number; asOf: string; session?: string; read: Read };

const STEPS = ["Pulling XAU/USD across Daily → 5M", "Detecting market regime", "Mapping liquidity & structure", "Scoring institutional confluence", "Writing the gold read"];
const fmt = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");

export function XauGhost() {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [res, setRes] = useState<Result | null>(null);
  const [msg, setMsg] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try { const raw = localStorage.getItem("om_xaughost"); if (raw) setRes(JSON.parse(raw)); } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const run = useCallback(async () => {
    setLoading(true); setMsg(""); setStep(0);
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1400);
    try {
      const r = await fetch("/api/xaughost", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (d.notConfigured) { setMsg("The gold desk isn't switched on yet."); return; }
      if (r.status === 402 || d.error === "insufficient_credits") { setMsg(`You're out of credits — a gold run costs ${CREDIT_COST.ghost}. Free credits reset tomorrow, or top up on the Credits page.`); return; }
      if (d.error === "system_busy" || d.error === "ratelimit") { setMsg(d.detail || "The desk is at capacity for a moment — try again shortly."); return; }
      if (d.error || !d.read) { setMsg(d.detail || "Couldn't complete the gold read — try again shortly."); return; }
      const result: Result = { price: d.price, asOf: d.asOf, session: d.session, read: d.read };
      setRes(result);
      try { localStorage.setItem("om_xaughost", JSON.stringify(result)); } catch { /* ignore */ }
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
    } catch { setMsg("Something interrupted the connection. Try again."); }
    finally { clearInterval(timer); setLoading(false); }
  }, []);

  const read = res?.read;
  const noTrade = read?.decision === "NO_TRADE" || read?.direction === "NONE";
  const isLong = read?.direction === "LONG";
  const conf = typeof read?.confidence === "number" ? Math.max(0, Math.min(100, read.confidence)) : null;
  const longP = typeof read?.longProbability === "number" ? Math.max(0, Math.min(100, read.longProbability)) : null;

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      {/* Header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[#CFC7B3] to-[#8a8266] text-black shadow-[0_0_30px_rgba(207,199,179,0.25)]"><Ghost className="h-6 w-6" /></span>
          <div>
            <h2 className="font-serif text-2xl font-black tracking-tight">XAUGHOST</h2>
            <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Gold-only intelligence · XAU/USD · institutional engine</p>
          </div>
        </div>
        <button
          onClick={() => void run()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#CFC7B3] to-[#B8AE93] px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {loading ? "Analyzing…" : res ? "Run again" : "Run gold intelligence"}
          {!loading && <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[10px] font-bold">{CREDIT_COST.ghost} credits</span>}
        </button>
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
            <p className="mt-3 text-sm text-white/65">Run the desk for a full institutional gold read — regime, liquidity, the highest-edge strategy right now, or a clear <span className="font-semibold text-white">No Trade</span>.</p>
            <p className="mt-1 text-[11px] text-white/35">Analyses Daily → 5M · costs {CREDIT_COST.ghost} credits · gold only</p>
          </div>
        )}

        {read && (
          <div className="space-y-5">
            {/* Decision banner */}
            <div className={`rounded-2xl border p-5 ${noTrade ? "border-white/15 bg-white/[0.03]" : isLong ? "border-emerald-400/30 bg-emerald-500/[0.07]" : "border-red-400/30 bg-red-500/[0.07]"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-black uppercase tracking-wide ${noTrade ? "bg-white/10 text-white/70" : isLong ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                    {noTrade ? <><Ban className="h-4 w-4" /> No Trade</> : isLong ? <><ArrowUp className="h-4 w-4" /> Long</> : <><ArrowDown className="h-4 w-4" /> Short</>}
                  </span>
                  {read.grade && <span className="rounded-full bg-[#CFC7B3]/15 px-3 py-1 text-xs font-bold text-[#CFC7B3]">{read.grade}</span>}
                  {read.regime && <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/60">{read.regime}</span>}
                </div>
                {res && (
                  <div className="text-right">
                    <p className="font-serif text-xl font-bold tabular-nums">{fmt(res.price)}</p>
                    <p className="text-[10px] uppercase tracking-wide text-white/40">live XAU/USD</p>
                  </div>
                )}
              </div>
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

            {/* Narrative */}
            {read.narrative && (
              <Section icon={<Compass className="h-3.5 w-3.5" />} title="Institutional narrative">
                <p className="text-sm leading-relaxed text-white/80">{read.narrative}</p>
              </Section>
            )}

            {/* Best strategy */}
            {read.bestStrategy && (
              <Section icon={<Crosshair className="h-3.5 w-3.5" />} title="Best strategy for current conditions">
                <p className="text-sm leading-relaxed text-white/80">{read.bestStrategy}</p>
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

            {/* Trade plan */}
            {!noTrade && (
              <Section icon={<Target className="h-3.5 w-3.5" />} title="Trade plan">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Primary entry" value={fmt(read.entries?.primary)} />
                  <Stat label="Aggressive" value={fmt(read.entries?.aggressive)} />
                  <Stat label="Conservative" value={fmt(read.entries?.conservative)} />
                  <Stat label="Stop loss" value={fmt(read.stopLoss)} tone="red" />
                  <Stat label="Risk : reward" value={read.riskReward || "—"} tone="gold" />
                  <Stat label="—" value="" hidden />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => <Stat key={i} label={`TP${i + 1}`} value={fmt((read.takeProfits || [])[i])} tone="emerald" />)}
                </div>
                {read.entries?.confirmation && <p className="mt-3 text-xs text-white/55"><span className="text-white/40">Confirmation:</span> {read.entries.confirmation}</p>}
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
      </div>
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

function Stat({ label, value, tone, hidden }: { label: string; value: string; tone?: "red" | "emerald" | "gold"; hidden?: boolean }) {
  if (hidden) return <div className="hidden sm:block" />;
  const col = tone === "red" ? "text-red-400" : tone === "emerald" ? "text-emerald-400" : tone === "gold" ? "text-[#CFC7B3]" : "text-white";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5 text-center">
      <p className="text-[10px] uppercase tracking-[0.1em] text-white/40">{label}</p>
      <p className={`mt-0.5 font-serif text-base font-bold tabular-nums ${col}`}>{value}</p>
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
