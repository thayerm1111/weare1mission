"use client";

/**
 * Deep Dive — the full reasoning behind a play, in the One Mission palette.
 * Opens over any play/setup, pulls /api/om-deepdive (live technicals + AI), and
 * lays out a factor heat map, the drivers, the technical read, the professional
 * strategy, key levels and the risks. Educational only, not financial advice.
 */
import { useCallback, useEffect, useState } from "react";
import {
  X, Search, AlertTriangle, TrendingUp, Activity, Layers, ShieldAlert, Target, Gauge,
} from "lucide-react";

type Heat = { factor: string; score: number; note?: string };
type Levels = { support?: string; resistance?: string; invalidation?: string };
type Dive = {
  headline?: string; stance?: string; heat?: Heat[]; drivers?: string[];
  technical?: string; strategy?: string; levels?: Levels; risks?: string[];
  tech?: {
    price?: number | null; sma50?: number | null; sma200?: number | null; rsi?: number | null;
    high52?: number | null; low52?: number | null; fromHigh?: number; chg90?: number | null; trend?: string;
  } | null;
};

const heatColor = (s: number) =>
  s >= 70 ? "bg-navy" : s >= 55 ? "bg-gold" : s >= 40 ? "bg-gold-light" : s >= 25 ? "bg-red-300" : "bg-red-400";
const heatText = (s: number) => (s >= 55 ? "text-navy" : s >= 40 ? "text-charcoal/70" : "text-red-600");

const stanceStyle = (s = "") =>
  /accumulate|buy|long/i.test(s) ? "bg-navy/[0.06] text-navy"
    : /reduce|sell|short/i.test(s) ? "bg-red-50 text-red-600"
    : "bg-ice text-charcoal/70";

export function DeepDiveModal({
  ticker, name, type, thesis, td, context, dir, style, onClose,
}: {
  ticker: string; name: string; type: string; thesis?: string;
  td?: string; context?: "signal" | "buyhold"; dir?: "LONG" | "SHORT"; style?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Dive | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/om-deepdive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, name, type, thesis, td, context, dir, style }),
      });
      const d = await r.json();
      if (d.notConfigured) { setErr("OM AI isn't switched on yet."); return; }
      if (r.status === 402 || d.error === "insufficient_credits") { setErr("You're out of credits — a deep dive costs 1. Free credits reset tomorrow, or top up on the Credits page."); return; }
      if (d.error === "system_busy") { setErr(d.detail || "The data desk is at capacity for a moment — try again in a few seconds."); return; }
      if (d.error) { setErr("Couldn't build the deep dive right now — try again shortly."); return; }
      setData(d);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
    } catch { setErr("Couldn't build the deep dive right now — try again shortly."); }
    finally { setLoading(false); }
  }, [ticker, name, type, thesis, td, context, dir, style]);

  useEffect(() => { void load(); }, [load]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const t = data?.tech;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-navy/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-ice bg-offwhite shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-ice bg-white/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-primary" />
              <span className="text-lg font-extrabold tracking-tight text-navy">{ticker}</span>
              <span className="rounded-full bg-offwhite px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-charcoal/50">{type}</span>
              {data?.stance && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${stanceStyle(data.stance)}`}>{data.stance}</span>}
            </div>
            <p className="mt-0.5 truncate text-xs text-charcoal/50">{name} · Deep Dive{t?.price != null ? ` · $${t.price.toLocaleString()}` : ""}</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full text-charcoal/50 transition-colors hover:bg-ice focus-ring">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {loading && (
            <div className="space-y-3">
              <div className="h-6 w-3/4 animate-pulse rounded bg-ice" />
              <div className="grid grid-cols-5 gap-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-ice" />)}</div>
              <div className="h-24 animate-pulse rounded-xl bg-ice" />
              <p className="text-center text-xs text-charcoal/40">Reading live market data and building the breakdown…</p>
            </div>
          )}

          {err && !loading && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4" /> {err}
            </div>
          )}

          {data && !loading && (
            <>
              {data.headline && (
                <p className="text-base font-semibold leading-snug text-navy">{data.headline}</p>
              )}

              {/* Factor heat map */}
              {Array.isArray(data.heat) && data.heat.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50"><Gauge className="h-3.5 w-3.5" /> Factor heat map</h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {data.heat.map((h, i) => (
                      <div key={i} className="rounded-xl border border-ice bg-white p-2.5 shadow-card">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-charcoal/45">{h.factor}</span>
                          <span className={`text-sm font-extrabold ${heatText(h.score)}`}>{h.score}</span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ice">
                          <div className={`h-full ${heatColor(h.score)}`} style={{ width: `${Math.max(4, Math.min(100, h.score))}%` }} />
                        </div>
                        {h.note && <p className="mt-1.5 text-[10px] leading-snug text-charcoal/50">{h.note}</p>}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Live technical snapshot */}
              {t && (
                <section className="rounded-xl border border-ice bg-white p-3 shadow-card">
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50"><Activity className="h-3.5 w-3.5" /> Live snapshot</h3>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                    <Stat label="Trend" value={t.trend ?? "—"} />
                    <Stat label="RSI(14)" value={t.rsi != null ? String(t.rsi) : "—"} />
                    <Stat label="50d SMA" value={t.sma50 != null ? `$${t.sma50.toLocaleString()}` : "—"} />
                    <Stat label="200d SMA" value={t.sma200 != null ? `$${t.sma200.toLocaleString()}` : "—"} />
                    <Stat label="52w high" value={t.high52 != null ? `$${t.high52.toLocaleString()}` : "—"} />
                    <Stat label="52w low" value={t.low52 != null ? `$${t.low52.toLocaleString()}` : "—"} />
                    <Stat label="vs high" value={t.fromHigh != null ? `${t.fromHigh}%` : "—"} />
                    <Stat label="90d chg" value={t.chg90 != null ? `${t.chg90}%` : "—"} />
                  </dl>
                </section>
              )}

              {/* Drivers */}
              {Array.isArray(data.drivers) && data.drivers.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50"><TrendingUp className="h-3.5 w-3.5" /> Drivers &amp; catalysts</h3>
                  <ul className="space-y-1.5">
                    {data.drivers.map((d, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-charcoal/80">
                        <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gold" /> {d}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Technical read */}
              {data.technical && (
                <Block icon={<Layers className="h-3.5 w-3.5" />} title="Technical read">{data.technical}</Block>
              )}

              {/* Strategy */}
              {data.strategy && (
                <Block icon={<Target className="h-3.5 w-3.5" />} title="The professional playbook" accent>{data.strategy}</Block>
              )}

              {/* Levels */}
              {data.levels && (data.levels.support || data.levels.resistance || data.levels.invalidation) && (
                <section className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <LevelCard label="Support" value={data.levels.support} tone="navy" />
                  <LevelCard label="Resistance" value={data.levels.resistance} tone="charcoal" />
                  <LevelCard label="Invalidation" value={data.levels.invalidation} tone="red" />
                </section>
              )}

              {/* Risks */}
              {Array.isArray(data.risks) && data.risks.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50"><ShieldAlert className="h-3.5 w-3.5 text-red-400" /> Risks</h3>
                  <ul className="space-y-1.5">
                    {data.risks.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 text-[13px] text-charcoal/65">
                        <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-300" /> {r}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <p className="border-t border-ice pt-3 text-center text-[11px] text-charcoal/40">
                Built from live market data + OM AI analysis · educational only, not financial advice.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-charcoal/40">{label}</dt>
      <dd className="font-semibold text-navy">{value}</dd>
    </div>
  );
}

function Block({ icon, title, children, accent = false }: { icon: React.ReactNode; title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <section className={`rounded-xl border p-3.5 ${accent ? "border-gold/40 bg-gold/[0.05]" : "border-ice bg-white shadow-card"}`}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-charcoal/50">{icon} {title}</h3>
      <p className="text-sm leading-relaxed text-charcoal/80">{children}</p>
    </section>
  );
}

function LevelCard({ label, value, tone }: { label: string; value?: string; tone: "navy" | "charcoal" | "red" }) {
  if (!value) return null;
  const c = tone === "navy" ? "text-navy" : tone === "red" ? "text-red-600" : "text-charcoal/80";
  return (
    <div className="rounded-xl border border-ice bg-white px-3 py-2 shadow-card">
      <div className="text-[10px] uppercase tracking-wide text-charcoal/40">{label}</div>
      <div className={`mt-0.5 text-sm font-bold ${c}`}>{value}</div>
    </div>
  );
}
