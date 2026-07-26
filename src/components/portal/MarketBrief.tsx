"use client";

/**
 * Daily Market Brief — an AI morning read on the members' home, in the One
 * Mission palette. Shows the day's tone, a short summary, a live snapshot strip,
 * the notable movers and the levels/themes to watch. Refreshed once per day.
 */
import { useCallback, useEffect, useState } from "react";
import { Sunrise, RefreshCw, ArrowUp, ArrowDown, Minus, Eye, AlertTriangle } from "lucide-react";

type Mover = { symbol: string; name: string; dir: "up" | "down" | "flat"; note: string };
type Snap = { symbol: string; name: string; price: number; pct: number | null };
type Brief = { tone?: string; headline?: string; summary?: string; movers?: Mover[]; watch?: string[]; snapshot?: Snap[]; day?: string };

const fmtP = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(2) : n.toFixed(4));

const toneStyle = (t = "") =>
  /risk-on/i.test(t) ? "bg-navy/[0.06] text-navy"
    : /risk-off/i.test(t) ? "bg-red-50 text-red-600"
    : "bg-gold/15 text-gold-deep";

export function MarketBrief() {
  const [b, setB] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/om-brief", { method: "POST" });
      const d = await r.json();
      if (d.notConfigured) { setMsg("OM AI isn't switched on yet."); setB(null); return; }
      if (d.error) { setMsg("Couldn't load the brief right now — try again shortly."); return; }
      setB(d);
    } catch { setMsg("Couldn't load the brief right now — try again shortly."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="overflow-hidden rounded-2xl border border-[#E7E4DD] bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ice bg-offwhite/50 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-white"><Sunrise className="h-4 w-4" /></span>
          <div>
            <h2 className="font-serif text-sm font-semibold uppercase tracking-[0.12em] text-navy">Daily Market Brief</h2>
            <p className="text-[11px] text-charcoal/45">{today} · OM AI desk</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {b?.tone && <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${toneStyle(b.tone)}`}>{b.tone}</span>}
          <button onClick={() => void load()} disabled={loading} className="grid h-8 w-8 place-items-center rounded-full text-charcoal/50 transition-colors hover:bg-ice focus-ring disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="p-5">
        {loading && !b && (
          <div className="space-y-3">
            <div className="h-5 w-2/3 animate-pulse rounded bg-ice" />
            <div className="h-16 animate-pulse rounded bg-ice" />
            <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-ice" />)}</div>
          </div>
        )}

        {msg && !loading && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" /> {msg}
          </div>
        )}

        {b && !loading && (
          <div className="space-y-4">
            {b.headline && <p className="text-base font-semibold leading-snug text-navy">{b.headline}</p>}
            {b.summary && <p className="text-sm leading-relaxed text-charcoal/75">{b.summary}</p>}

            {Array.isArray(b.snapshot) && b.snapshot.length > 0 && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {b.snapshot.map((s) => {
                  const up = (s.pct ?? 0) >= 0;
                  return (
                    <div key={s.symbol} className="rounded-lg border border-ice bg-offwhite/50 px-3 py-2">
                      <div className="text-[11px] font-semibold text-navy">{s.symbol}</div>
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs text-charcoal/60">{fmtP(s.price)}</span>
                        {s.pct != null && (
                          <span className={`text-[11px] font-bold ${up ? "text-navy" : "text-red-500"}`}>
                            {up ? "+" : ""}{s.pct.toFixed(2)}%
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {Array.isArray(b.movers) && b.movers.length > 0 && (
              <div>
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-charcoal/45">Notable movers</h3>
                <ul className="space-y-1.5">
                  {b.movers.map((m, i) => {
                    const Icon = m.dir === "up" ? ArrowUp : m.dir === "down" ? ArrowDown : Minus;
                    const c = m.dir === "up" ? "bg-navy/10 text-navy" : m.dir === "down" ? "bg-red-50 text-red-500" : "bg-ice text-charcoal/50";
                    return (
                      <li key={i} className="flex items-start gap-2.5 text-sm">
                        <span className={`mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full ${c}`}><Icon className="h-3 w-3" /></span>
                        <span className="text-charcoal/75"><span className="font-semibold text-navy">{m.symbol}</span> — {m.note}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {Array.isArray(b.watch) && b.watch.length > 0 && (
              <div className="rounded-xl border border-gold/30 bg-gold/[0.05] p-3.5">
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gold-deep"><Eye className="h-3.5 w-3.5" /> On the radar</h3>
                <ul className="space-y-1">
                  {b.watch.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-charcoal/75">
                      <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gold" /> {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-charcoal/40">AI-generated from live prices · educational only, not financial advice.</p>
          </div>
        )}
      </div>
    </div>
  );
}
