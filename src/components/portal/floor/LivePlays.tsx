"use client";

/**
 * Live Plays → Plays of the Week, in the One Mission palette (light / stone /
 * ink). A professional AI buy-&-hold desk posts the best longer-horizon ideas
 * across stocks + crypto each week, grounded in live prices. Tap any play to
 * open a Deep Dive — the full reasoning, a factor heat map, the strategy and the
 * risks behind the call. (Live *caller* plays you can copy arrive with Trade
 * Sync once the copy-trader is set up.)
 */
import { useCallback, useEffect, useState } from "react";
import {
  Repeat, RefreshCw, TrendingUp, Bitcoin, AlertTriangle, Clock, ShieldAlert, Users, Search,
} from "lucide-react";
import { DeepDiveModal } from "./DeepDive";
import { CREDIT_COST } from "@/lib/creditConfig";

type Play = {
  ticker: string; name: string; type: "Stock" | "Crypto";
  thesis: string; buyZone: string; horizon: string; risk: string; conviction: string;
  price?: number;
};

const fmtPrice = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(2) : n.toFixed(4));

const convStyle = (c: string) =>
  /high/i.test(c) ? "bg-gold/15 text-gold-deep"
    : /med/i.test(c) ? "bg-ice text-charcoal/70"
    : "bg-offwhite text-charcoal/50";

export function LivePlays({ isCaller = false, followerCount = 0 }: { isCaller?: boolean; followerCount?: number }) {
  void isCaller; void followerCount;
  const [plays, setPlays] = useState<Play[]>([]);
  const [note, setNote] = useState("");
  const [week, setWeek] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [dive, setDive] = useState<Play | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Show the last-loaded plays on open (from on-device cache) — never auto-fetch,
  // so clicking into Plays of the Week costs nothing. Fresh plays load only when
  // the member taps Refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("om_weekly_v1");
      if (raw) {
        const c = JSON.parse(raw) as { plays?: Play[]; note?: string; week?: string };
        if (Array.isArray(c.plays)) setPlays(c.plays);
        if (c.note) setNote(c.note);
        if (c.week) setWeek(c.week);
      }
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/om-weekly", { method: "POST" });
      const d = await r.json();
      if (d.notConfigured) { setMsg("OM AI isn't switched on yet."); return; }
      if (d.error) { setMsg("Couldn't load this week's plays — try again shortly."); return; }
      const fresh = Array.isArray(d.plays) ? d.plays : [];
      setPlays(fresh); setNote(d.note || ""); setWeek(d.week || "");
      try { localStorage.setItem("om_weekly_v1", JSON.stringify({ plays: fresh, note: d.note || "", week: d.week || "" })); } catch { /* ignore */ }
    } catch { setMsg("Couldn't load this week's plays — try again shortly."); }
    finally { setLoading(false); }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
            <TrendingUp className="h-5 w-5 text-primary" /> Plays of the Week
          </h2>
          <p className="text-xs text-charcoal/50">AI buy-&-hold desk · stocks + crypto {week && `· ${week}`}</p>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full border border-ice bg-white px-4 py-2 text-sm font-semibold text-charcoal/70 transition-colors hover:bg-offwhite focus-ring disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {note && !loading && (
        <p className="rounded-xl border border-ice bg-offwhite/60 px-4 py-2.5 text-sm text-charcoal/75">{note}</p>
      )}

      {msg && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" /> {msg}
        </div>
      )}

      {loading && plays.length === 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl border border-ice bg-offwhite/60" />)}
        </div>
      )}

      {hydrated && !loading && plays.length === 0 && !msg && (
        <div className="rounded-2xl border border-dashed border-[#E7E4DD] bg-offwhite/40 px-4 py-10 text-center">
          <TrendingUp className="mx-auto h-6 w-6 text-charcoal/30" />
          <p className="mt-2 text-sm text-charcoal/65">Tap <span className="font-semibold text-navy">Refresh</span> to load this week's plays.</p>
          <p className="mt-1 text-[11px] text-charcoal/40">Loading the list is free · a deep dive costs 1 credit</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {plays.map((p) => {
          const Icon = p.type === "Crypto" ? Bitcoin : TrendingUp;
          return (
            <button
              key={p.ticker}
              onClick={() => setDive(p)}
              className="group rounded-2xl border border-ice bg-white p-4 text-left shadow-card transition-colors hover:border-gold/40 focus-ring"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-ice text-primary"><Icon className="h-4 w-4" /></span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-navy">{p.ticker}</span>
                      <span className="rounded-full bg-offwhite px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-charcoal/50">{p.type}</span>
                    </div>
                    <p className="text-[11px] text-charcoal/45">{p.name}{typeof p.price === "number" ? ` · now $${fmtPrice(p.price)}` : ""}</p>
                  </div>
                </div>
                {p.conviction && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${convStyle(p.conviction)}`}>{p.conviction}</span>}
              </div>

              <p className="mt-3 text-sm leading-relaxed text-charcoal/80">{p.thesis}</p>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-offwhite/70 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-charcoal/40">Buy zone</div>
                  <div className="mt-0.5 font-semibold text-navy">{p.buyZone}</div>
                </div>
                <div className="rounded-lg bg-offwhite/70 px-3 py-2">
                  <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-charcoal/40"><Clock className="h-2.5 w-2.5" /> Horizon</div>
                  <div className="mt-0.5 font-semibold text-charcoal/80">{p.horizon}</div>
                </div>
              </div>

              {p.risk && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-charcoal/45">
                  <ShieldAlert className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-400" /> {p.risk}
                </p>
              )}

              <span className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary opacity-80 transition-opacity group-hover:opacity-100">
                <Search className="h-3 w-3" /> Deep dive into the reasoning
                <span className="rounded-full bg-ice px-1.5 py-0.5 text-[9px] font-bold text-charcoal/60">{CREDIT_COST.deepdive} credit</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Copy-trading teaser */}
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-[#E7E4DD] bg-offwhite/60 px-4 py-3">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-white text-charcoal/50 shadow-card"><Repeat className="h-4 w-4" /></span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy">Copy-trading is coming soon</p>
          <p className="text-[11px] text-charcoal/50">Follow top traders and mirror their entries once the copy-trader is live.</p>
        </div>
        <Users className="ml-auto hidden h-4 w-4 text-charcoal/30 sm:block" />
      </div>

      {!loading && plays.length > 0 && (
        <p className="text-center text-[11px] text-charcoal/40">Educational buy-&-hold ideas, refreshed weekly · not financial advice. Tap any play for the full reasoning.</p>
      )}

      {dive && (
        <DeepDiveModal
          ticker={dive.ticker}
          name={dive.name}
          type={dive.type}
          thesis={dive.thesis}
          onClose={() => setDive(null)}
        />
      )}
    </div>
  );
}
