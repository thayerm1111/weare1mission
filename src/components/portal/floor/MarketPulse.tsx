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
  Activity, RefreshCw, ArrowUp, ArrowDown, Check, X, ChevronDown, Zap, AlertTriangle, Search,
} from "lucide-react";
import { DeepDiveModal } from "./DeepDive";
import { CREDIT_COST } from "@/lib/creditConfig";

// Friendly asset category for the deep-dive header badge.
const catOf = (td: string) =>
  /BTC|ETH|SOL|XRP|DOGE/i.test(td) ? "Crypto"
    : /XAU|XAG|WTI|BRENT/i.test(td) ? "Commodity"
    : /DJI|NDX|SPX|QQQ|DIA|SPY/i.test(td) ? "Index"
    : "Forex";

type CheckItem = { label: string; ok: boolean };
type Setup = {
  symbol: string; name: string; td: string; dir: "LONG" | "SHORT";
  price: number; confirmed: number; total: number; checklist: CheckItem[];
  zone: "discount" | "premium"; rsi: number | null;
};

const fmt = (n: number) => {
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};

export function MarketPulse() {
  const [setups, setSetups] = useState<Setup[]>([]);
  const [loading, setLoading] = useState(true);
  const [asOf, setAsOf] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [dive, setDive] = useState<Setup | null>(null);

  const scan = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/om-scan", { method: "POST" });
      const d = await r.json();
      if (d.notConfigured) { setMsg("Live market data isn't connected yet."); setSetups([]); return; }
      if (r.status === 402 || d.error === "insufficient_credits") { setMsg("You're out of credits — a scan costs 2. Free credits reset tomorrow, or top up on the Credits page."); setSetups([]); return; }
      if (d.error === "system_busy") { setMsg(d.detail || "The scanner is at capacity for a moment — try again in a few seconds."); setSetups([]); return; }
      setSetups(Array.isArray(d.setups) ? d.setups : []);
      setAsOf(d.asOf || "");
      if (Array.isArray(d.setups) && d.setups.length && typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
    } catch { setMsg("Couldn't scan right now — try again shortly."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void scan(); }, [scan]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
            <Activity className="h-5 w-5 text-primary" /> Market Pulse
          </h2>
          <p className="text-xs text-charcoal/50">AI scanner · ranks live setups by confirmations {asOf && `· ${asOf}`}</p>
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
