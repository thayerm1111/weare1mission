"use client";

/**
 * Market Pulse — an AI scanner in the One Mission palette (light / stone / ink).
 * Runs the OM AI Plays multi-factor read across a universe of assets and ranks
 * them by how many professional confirmations line up right now, so the
 * strongest setups float to the top. Tap one to generate the full play.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity, RefreshCw, ArrowUp, ArrowDown, Check, X, ChevronDown, Zap, AlertTriangle, Search, Copy,
} from "lucide-react";
import { DeepDiveModal } from "./DeepDive";
import { TradeChat } from "../TradeChat";
import { CREDIT_COST } from "@/lib/creditConfig";

// Friendly asset category for the deep-dive header badge.
const catOf = (td: string) =>
  /BTC|ETH|SOL|XRP|DOGE/i.test(td) ? "Crypto"
    : /XAU|XAG|WTI|BRENT/i.test(td) ? "Commodity"
    : /DJI|NDX|SPX|QQQ|DIA|SPY|NAS100|US100|US500|US30/i.test(td) ? "Index"
    : "Forex";

type CheckItem = { label: string; ok: boolean };
type Setup = {
  symbol: string; name: string; td: string; dir: "LONG" | "SHORT";
  price: number; confirmed: number; total: number; checklist: CheckItem[];
  zone: "discount" | "premium"; rsi: number | null;
  entry?: number; stopLoss?: number; takeProfits?: number[]; riskReward?: string;
};
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const fmt = (n: number) => {
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};

export function MarketPulse() {
  const [setups, setSetups] = useState<Setup[]>([]);
  const [loading, setLoading] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [dive, setDive] = useState<Setup | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Show the LAST scan on open (from on-device cache) — never auto-scan, so just
  // clicking into Market Pulse costs nothing. A fresh scan only runs (and spends
  // credits) when the member taps "Scan the markets".
  useEffect(() => {
    try {
      const raw = localStorage.getItem("om_pulse_v1");
      if (raw) {
        const c = JSON.parse(raw) as { setups?: Setup[]; asOf?: string };
        if (Array.isArray(c.setups)) setSetups(c.setups);
        if (c.asOf) setAsOf(c.asOf);
      }
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const scan = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/om-scan", { method: "POST" });
      const d = await r.json();
      if (d.notConfigured) { setMsg("Live market data isn't connected yet."); return; }
      if (r.status === 402 || d.error === "insufficient_credits") { setMsg("You're out of credits — a scan costs 5. Free credits reset weekly, or top up on the Credits page."); return; }
      if (d.error === "system_busy") { setMsg(d.detail || "The scanner is at capacity for a moment — try again in a few seconds."); return; }
      const fresh = Array.isArray(d.setups) ? d.setups : [];
      setSetups(fresh); setAsOf(d.asOf || "");
      try { localStorage.setItem("om_pulse_v1", JSON.stringify({ setups: fresh, asOf: d.asOf || "" })); } catch { /* ignore */ }
      if (fresh.length && typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
    } catch { setMsg("Couldn't scan right now — try again shortly."); }
    finally { setLoading(false); }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
            <Activity className="h-5 w-5 text-primary" /> Market Pulse
          </h2>
          <p className="text-xs text-charcoal/50">AI scanner · {asOf ? `last scan ${asOf}` : "tap Scan to run the markets"}</p>
        </div>
        <button onClick={() => void scan()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {loading ? "Scanning…" : "Scan the markets"}
          {!loading && <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-bold">{CREDIT_COST.scan} credits</span>}
        </button>
      </div>

      {msg && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" /> {msg}
        </div>
      )}

      {loading && setups.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl border border-ice bg-offwhite/60" />)}
        </div>
      )}

      {hydrated && !loading && setups.length === 0 && !msg && (
        <div className="rounded-2xl border border-dashed border-[#E7E4DD] bg-offwhite/40 px-4 py-10 text-center">
          <Activity className="mx-auto h-6 w-6 text-charcoal/30" />
          <p className="mt-2 text-sm text-charcoal/65">Tap <span className="font-semibold text-navy">Scan the markets</span> to run the scanner.</p>
          <p className="mt-1 text-[11px] text-charcoal/40">Costs {CREDIT_COST.scan} credits · just clicking in here is free</p>
        </div>
      )}

      <ul className="space-y-2.5">
        {setups.map((s) => {
          const isLong = s.dir === "LONG";
          const strong = s.confirmed >= 6;
          const isOpen = open === s.td;
          const pct = Math.round((s.confirmed / s.total) * 100);
          return (
            <li key={s.td} className={`overflow-hidden rounded-2xl border bg-white shadow-card ${strong ? "border-gold/40" : "border-ice"}`}>
              <button onClick={() => setOpen(isOpen ? null : s.td)} className="flex w-full items-center gap-3 p-4 text-left focus-ring">
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${isLong ? "bg-navy/[0.06] text-navy" : "bg-red-50 text-red-600"}`}>
                  {isLong ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{s.dir}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-navy">{s.symbol}</span>
                    {strong && <span className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-gold-deep">A+ setup</span>}
                  </div>
                  <p className="text-[11px] text-charcoal/45">{s.name} · {fmt(s.price)} · {s.zone}{s.rsi != null ? ` · RSI ${s.rsi}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-20 text-right">
                    <div className="text-sm font-bold text-navy">{s.confirmed}/{s.total}</div>
                    <div className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-ice">
                      <div className={`h-full ${strong ? "bg-gold" : isLong ? "bg-navy" : "bg-red-500"}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <ChevronDown className={`h-4 w-4 text-charcoal/40 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </div>
              </button>
              {isOpen && (
                <div className="border-t border-ice px-4 pb-4 pt-3">
                  {numOk(s.entry) && numOk(s.stopLoss) && (
                    <div className="mb-3 rounded-xl border border-ice bg-offwhite/60 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-charcoal/55">{s.dir} · trade levels</span>
                        {s.riskReward && <span className="rounded-full bg-navy/[0.06] px-2 py-0.5 text-[11px] font-bold text-navy">R:R {s.riskReward}</span>}
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <Level label="Entry" value={fmt(s.entry)} tone="navy" />
                        <Level label="Stop" value={fmt(s.stopLoss)} tone="red" />
                        {(s.takeProfits ?? []).slice(0, 3).map((tp, i) => (
                          <Level key={i} label={`TP${i + 1}`} value={fmt(tp)} tone="green" />
                        ))}
                      </div>
                      <CopyTradeBtn text={pulseTradeText(s)} />
                      <p className="mt-2 text-[10px] leading-snug text-charcoal/45">
                        Entry is the current price (take-it-now read). Stop sits beyond the swing that invalidates the idea; targets are a clean R ladder. Tap any level to copy it. Objective read from live candles — not financial advice.
                      </p>
                    </div>
                  )}
                  {numOk(s.entry) && numOk(s.stopLoss) && (
                    <div className="mb-3">
                      <TradeChat trade={{ td: s.td, symbol: s.symbol, direction: s.dir, entry: s.entry, stopLoss: s.stopLoss, takeProfits: (s.takeProfits ?? []).filter(numOk), style: "intraday" }} creditCost={CREDIT_COST.signal} />
                    </div>
                  )}
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {s.checklist.map((c, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs">
                        <span className={`grid h-4 w-4 place-items-center rounded-full ${c.ok ? "bg-navy/10 text-navy" : "bg-ice text-charcoal/25"}`}>
                          {c.ok ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                        </span>
                        <span className={c.ok ? "text-charcoal/80" : "text-charcoal/40"}>{c.label}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/portal/signals?td=${encodeURIComponent(s.td)}&style=intraday`} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-cream transition-colors hover:bg-navy focus-ring">
                      <Zap className="h-3.5 w-3.5" /> Generate the full play <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-bold">{CREDIT_COST.signal} credit</span>
                    </Link>
                    <button onClick={() => setDive(s)} className="inline-flex items-center gap-1.5 rounded-full border border-ice bg-white px-4 py-2 text-xs font-semibold text-charcoal/70 transition-colors hover:bg-offwhite focus-ring">
                      <Search className="h-3.5 w-3.5" /> Deep dive <span className="rounded-full bg-ice px-1.5 py-0.5 text-[10px] font-bold text-charcoal/60">{CREDIT_COST.deepdive} credit</span>
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!loading && setups.length > 0 && (
        <p className="text-center text-[11px] text-charcoal/40">Objective read from live candles · not financial advice. Tap a setup for the confirmation breakdown.</p>
      )}

      {dive && (
        <DeepDiveModal
          ticker={dive.symbol}
          name={dive.name}
          type={catOf(dive.td)}
          td={dive.td}
          context="signal"
          dir={dive.dir}
          style="intraday"
          onClose={() => setDive(null)}
        />
      )}
    </div>
  );
}

function copyText(text: string) {
  try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ }
}
function pulseTradeText(s: Setup): string {
  const tps = (s.takeProfits ?? []).map((t, i) => `TP${i + 1}: ${fmt(t)}`).join("\n");
  return `${s.symbol} ${s.dir}\nEntry: ${fmt(s.entry as number)}\nStop: ${fmt(s.stopLoss as number)}\n${tps}${s.riskReward ? `\nR:R ${s.riskReward}` : ""}\n(Market Pulse — educational, not financial advice)`;
}
function Level({ label, value, tone }: { label: string; value: string; tone: "navy" | "red" | "green" }) {
  const [copied, setCopied] = useState(false);
  const color = tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : "text-navy";
  return (
    <button
      type="button"
      onClick={() => { copyText(value); setCopied(true); setTimeout(() => setCopied(false), 1100); }}
      className="rounded-lg border border-ice bg-white px-2 py-1.5 text-center transition-colors hover:border-navy/30 focus-ring"
      title="Tap to copy"
    >
      <div className="text-[9px] font-semibold uppercase tracking-wide text-charcoal/40">{label}</div>
      <div className={`text-sm font-bold ${copied ? "text-emerald-600" : color}`}>{copied ? "Copied ✓" : value}</div>
    </button>
  );
}
function CopyTradeBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
      className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ice bg-white px-3 py-2 text-xs font-semibold text-navy transition-colors hover:bg-offwhite focus-ring"
    >
      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy trade"}
    </button>
  );
}
