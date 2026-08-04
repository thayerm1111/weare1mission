"use client";

/**
 * xGhost — the website Floor build of the AI forex scalping scanner, in the One
 * Mission light palette (cream / navy / ink). Scans the five major dollar pairs
 * together, confirms each against the Dollar Index (read on 1m/5m/15m/30m), scores
 * every setup out of 100 and ranks them — handing back the single best clean trade
 * or a disciplined No Trade. Same deterministic engine as the app; same /api/xghost.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Ghost, RefreshCw, ArrowUp, ArrowDown, ChevronDown, AlertTriangle, ShieldCheck, Check, X, Copy,
} from "lucide-react";
import { TradeChat } from "../TradeChat";
import { CREDIT_COST } from "@/lib/creditConfig";

type Tp = { label: string; price: number; rr: number | null; basis?: string };
type Cand = {
  symbol: string; label: string; execState: string; direction: "BUY" | "SELL" | null;
  family: string; regime: string; grade: string; score: number; price: number;
  entryType: string; entryLow: number | null; entryHigh: number | null; stop: number | null;
  tps: Tp[]; rr1: number | null; rrMain: number | null; keyLevel: number | null;
  developingStage: string; triggerRequired: string; dxyConfirm: string; dxyNote: string;
  thesis: string; supporting: string[]; conflicting: string[]; vetoes: string[];
};
type DxyByTf = { tf: string; dir: string };
type Scan = {
  ok?: boolean; asOf?: string; session?: string;
  dxy?: { state: string; score: number; source: string; byTf: DxyByTf[]; note?: string };
  anyTradeable?: boolean; best?: Cand | null; ranked?: Cand[]; suppressed?: { symbol: string; reason: string }[];
  news_warning?: string; strategy_version?: string;
};

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isLong = (d: string | null) => d === "BUY";
const sym = (s: string) => String(s || "").replace("/", "");
const fmt = (n: number) => {
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};

function entryOf(c: Cand): number | null {
  if (c.entryType === "MARKET") return c.price ?? c.entryLow ?? c.entryHigh;
  if (numOk(c.entryLow) && numOk(c.entryHigh)) return (c.entryLow + c.entryHigh) / 2;
  return c.entryLow ?? c.entryHigh ?? c.price ?? null;
}
const EXEC: Record<string, { word: string; cls: string }> = {
  ENTER_NOW: { word: "Enter now", cls: "bg-emerald-50 text-emerald-600" },
  LIMIT_ENTRY: { word: "Limit", cls: "bg-navy/[0.06] text-navy" },
  WAIT_FOR_CONFIRMATION: { word: "Wait", cls: "bg-amber-50 text-amber-700" },
  WATCHLIST: { word: "Watchlist", cls: "bg-sky-50 text-sky-600" },
  NO_TRADE: { word: "No trade", cls: "bg-ice text-charcoal/45" },
};
const execMeta = (s: string) => EXEC[s] || EXEC.NO_TRADE;
const scoreTone = (n: number) => (n >= 78 ? "text-emerald-600" : n >= 70 ? "text-amber-600" : "text-charcoal/45");
const scoreBar = (n: number) => (n >= 78 ? "bg-emerald-500" : n >= 70 ? "bg-amber-500" : "bg-charcoal/30");
const dirWord = (dir: string) =>
  dir === "up" ? "USD up" : dir === "down" ? "USD dn" : "flat";

export function XGhost() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Show the last scan on open (from on-device cache) — never auto-scan, so just
  // clicking in costs nothing. A fresh scan only runs (and spends credits) on tap.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("om_xghost_v1");
      if (raw) setScan(JSON.parse(raw) as Scan);
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const run = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/xghost", { method: "POST" });
      const d = (await r.json()) as Scan & { notConfigured?: string; error?: string; reason?: string };
      if (d.notConfigured) { setMsg("Live market data isn't connected yet."); return; }
      if (r.status === 402 || d.error === "insufficient_credits") { setMsg("You're out of credits — a scan costs 2. Free credits reset weekly, or top up on the Credits page."); return; }
      if (d.error === "ratelimit") { setMsg(d.reason || "Market data is busy — wait a minute and rescan."); return; }
      if (!d.ok) { setMsg(d.reason || "Couldn't run the scan — try again shortly."); return; }
      setScan(d); setOpen(null);
      try { localStorage.setItem("om_xghost_v1", JSON.stringify(d)); } catch { /* ignore */ }
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
    } catch { setMsg("Couldn't run the scan — try again shortly."); }
    finally { setLoading(false); }
  }, []);

  const ranked = scan?.ranked ?? [];
  const dxy = scan?.dxy;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-navy">
            <Ghost className="h-5 w-5 text-primary" /> xGhost
          </h2>
          <p className="text-xs text-charcoal/50">AI forex scalping scanner · 5 pairs + DXY{scan?.asOf ? ` · last scan ${scan.asOf.slice(11, 16)} UTC` : " · tap Scan to run"}</p>
        </div>
        <button onClick={() => void run()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {loading ? "Scanning…" : "Scan the 5 pairs"}
          {!loading && <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-bold">{CREDIT_COST.scan} credits</span>}
        </button>
      </div>

      {msg && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" /> {msg}
        </div>
      )}

      {/* DXY condition strip */}
      {dxy && (
        <div className="rounded-2xl border border-ice bg-white p-3.5 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-charcoal/55">
              Dollar Index · DXY <span className="ml-1 font-semibold normal-case text-charcoal/40">{dxy.source === "free" ? "live ICE feed" : dxy.source === "native" ? "TwelveData" : "computed proxy"}</span>
            </p>
            <span className={`text-sm font-extrabold ${dxy.score > 20 ? "text-emerald-600" : dxy.score < -20 ? "text-red-500" : "text-charcoal/50"}`}>
              {dxy.state} {dxy.score > 0 ? `+${dxy.score}` : dxy.score}
            </span>
          </div>
          <div className="mt-2.5 grid grid-cols-4 gap-2">
            {(dxy.byTf ?? []).map((t) => {
              const up = t.dir === "up", dn = t.dir === "down";
              return (
                <div key={t.tf} className={`rounded-xl border px-2 py-2 text-center ${up ? "border-emerald-200 bg-emerald-50/60" : dn ? "border-red-200 bg-red-50/60" : "border-ice bg-offwhite/60"}`}>
                  <div className="text-[11px] font-bold text-charcoal/55">{t.tf}</div>
                  <div className={`text-base font-black leading-none ${up ? "text-emerald-600" : dn ? "text-red-500" : "text-charcoal/40"}`}>{up ? "↑" : dn ? "↓" : "→"}</div>
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-charcoal/40">{dirWord(t.dir)}</div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-charcoal/40">Strength read across 1m · 5m · 15m · 30m. Every pair below is confirmed against this.</p>
        </div>
      )}

      {/* News warning */}
      {scan?.news_warning && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {scan.news_warning}
        </div>
      )}

      {/* No-trade banner when nothing clean */}
      {scan?.ok && !scan.anyTradeable && (
        <div className="rounded-2xl border border-ice bg-offwhite/50 px-4 py-8 text-center">
          <ShieldCheck className="mx-auto h-6 w-6 text-charcoal/35" />
          <p className="mt-2 text-sm font-bold text-navy">No clean trade right now.</p>
          <p className="mt-1 text-[12px] text-charcoal/55">None of the five pairs cleared the quality bar — that&apos;s the scanner protecting capital. Check the board below or rescan in a few minutes.</p>
        </div>
      )}

      {/* Correlation guard */}
      {scan?.suppressed && scan.suppressed.length > 0 && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-[12px] text-charcoal/70">
          <span className="font-bold text-sky-700">Correlation guard:</span> {scan.suppressed.map((s) => `${sym(s.symbol)} — ${s.reason}`).join(" · ")}
        </div>
      )}

      {/* Loading skeletons */}
      {loading && ranked.length === 0 && (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border border-ice bg-offwhite/60" />)}</div>
      )}

      {/* Empty state */}
      {hydrated && !loading && !scan && !msg && (
        <div className="rounded-2xl border border-dashed border-[#E7E4DD] bg-offwhite/40 px-4 py-10 text-center">
          <Ghost className="mx-auto h-6 w-6 text-charcoal/30" />
          <p className="mt-2 text-sm text-charcoal/65">Tap <span className="font-semibold text-navy">Scan the 5 pairs</span> to read EUR/USD, GBP/USD, AUD/USD, USD/CAD &amp; USD/JPY together.</p>
          <p className="mt-1 text-[11px] text-charcoal/40">Costs {CREDIT_COST.scan} credits · protecting capital beats forcing a trade</p>
        </div>
      )}

      {/* Ranked board */}
      {ranked.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-charcoal/45">All five pairs — ranked</p>
          <ul className="space-y-2.5">
            {ranked.map((c, i) => {
              const long = isLong(c.direction);
              const em = execMeta(c.execState);
              const tradeable = c.execState === "ENTER_NOW" || c.execState === "LIMIT_ENTRY";
              const isOpen = open === c.symbol;
              const entry = entryOf(c);
              const tps = (c.tps ?? []).map((t) => t.price).filter(numOk);
              return (
                <li key={c.symbol} className={`overflow-hidden rounded-2xl border bg-white shadow-card ${c.score >= 78 ? "border-gold/40" : "border-ice"}`}>
                  <button onClick={() => setOpen(isOpen ? null : c.symbol)} className="flex w-full items-center gap-3 p-3.5 text-left focus-ring">
                    <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-lg bg-navy/[0.05] text-[11px] font-black text-navy">{i + 1}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${c.direction ? (long ? "bg-navy/[0.06] text-navy" : "bg-red-50 text-red-600") : "bg-ice text-charcoal/40"}`}>
                      {c.direction ? (long ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}{c.direction ? (long ? "LONG" : "SHORT") : "—"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-navy">{sym(c.symbol)}</div>
                      <p className="truncate text-[11px] text-charcoal/45">{c.family && c.family !== "None" ? c.family : "No qualified setup"}</p>
                    </div>
                    <span className={`hidden flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide sm:inline ${em.cls}`}>{em.word}</span>
                    <div className="w-12 flex-shrink-0 text-right">
                      <div className={`text-sm font-black ${scoreTone(c.score)}`}>{c.score}</div>
                      <div className="mt-1 h-1.5 w-12 overflow-hidden rounded-full bg-ice"><div className={`h-full ${scoreBar(c.score)}`} style={{ width: `${Math.max(4, Math.min(100, c.score))}%` }} /></div>
                    </div>
                    <ChevronDown className={`h-4 w-4 flex-shrink-0 text-charcoal/40 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>

                  {isOpen && (
                    <div className="border-t border-ice px-3.5 pb-4 pt-3">
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${em.cls}`}>{em.word}</span>
                        {c.grade && c.grade !== "NONE" && <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold-deep">Grade {c.grade}</span>}
                        {c.dxyConfirm && <span className="rounded-full bg-offwhite px-2 py-0.5 text-[10px] font-semibold text-charcoal/60">DXY {c.dxyConfirm}</span>}
                        <span className="rounded-full bg-offwhite px-2 py-0.5 text-[10px] font-semibold text-charcoal/60">{c.regime}</span>
                      </div>

                      {tradeable && numOk(entry) && numOk(c.stop) && tps.length > 0 ? (
                        <div className="mb-3 rounded-xl border border-ice bg-offwhite/60 p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[11px] font-bold uppercase tracking-wide text-charcoal/55">{long ? "BUY" : "SELL"} · trade plan</span>
                            {numOk(c.rrMain) && <span className="rounded-full bg-navy/[0.06] px-2 py-0.5 text-[11px] font-bold text-navy">R:R 1:{c.rrMain}</span>}
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                            <Level label="Entry" value={fmt(entry)} tone="navy" />
                            <Level label="Stop" value={fmt(c.stop)} tone="red" />
                            {tps.slice(0, 3).map((tp, k) => <Level key={k} label={`TP${k + 1}`} value={fmt(tp)} tone="green" />)}
                          </div>
                          <CopyTradeBtn text={tradeText(c, entry)} />
                        </div>
                      ) : (
                        <div className="mb-3 rounded-xl border border-ice bg-offwhite/50 p-3 text-[12px] text-charcoal/65">
                          {c.triggerRequired ? <p><span className="font-semibold text-navy">What has to happen: </span>{c.triggerRequired}</p>
                            : c.developingStage ? <p><span className="font-semibold text-navy">Forming: </span>{c.developingStage}</p>
                            : <p>No qualified setup right now.</p>}
                          {numOk(c.keyLevel) && <p className="mt-1 text-charcoal/50">Key level: <span className="font-semibold">{fmt(c.keyLevel)}</span></p>}
                        </div>
                      )}

                      {tradeable && numOk(entry) && numOk(c.stop) && tps.length > 0 && (
                        <div className="mb-3">
                          <TradeChat trade={{ td: c.symbol, symbol: sym(c.symbol), direction: c.direction || "BUY", entry, stopLoss: c.stop, takeProfits: tps, style: "scalp" }} creditCost={CREDIT_COST.signal} />
                        </div>
                      )}

                      {(c.supporting?.length ?? 0) > 0 && (
                        <ul className="grid gap-1.5 sm:grid-cols-2">
                          {c.supporting.map((s, k) => (
                            <li key={k} className="flex items-start gap-2 text-xs">
                              <span className="mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full bg-navy/10 text-navy"><Check className="h-2.5 w-2.5" /></span>
                              <span className="text-charcoal/80">{s}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {(c.vetoes?.length ?? 0) > 0 && (
                        <ul className="mt-2 space-y-1">
                          {c.vetoes.map((v, k) => (
                            <li key={k} className="flex items-start gap-2 text-xs">
                              <span className="mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full bg-red-50 text-red-500"><X className="h-2.5 w-2.5" /></span>
                              <span className="text-charcoal/60">{v}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {scan?.ok && (
        <p className="text-center text-[11px] text-charcoal/40">xGhost {scan.strategy_version || ""} · objective read from live candles · not financial advice.</p>
      )}
    </div>
  );
}

function copyText(text: string) {
  try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ }
}
function tradeText(c: Cand, entry: number): string {
  const tps = (c.tps ?? []).map((t, i) => `TP${i + 1}: ${fmt(t.price)}`).join("\n");
  return `${sym(c.symbol)} ${c.direction === "BUY" ? "LONG" : "SHORT"}\nEntry: ${fmt(entry)}\nStop: ${fmt(c.stop as number)}\n${tps}${numOk(c.rrMain) ? `\nR:R 1:${c.rrMain}` : ""}\n(xGhost — educational, not financial advice)`;
}
function Level({ label, value, tone }: { label: string; value: string; tone: "navy" | "red" | "green" }) {
  const [copied, setCopied] = useState(false);
  const color = tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : "text-navy";
  return (
    <button type="button" onClick={() => { copyText(value); setCopied(true); setTimeout(() => setCopied(false), 1100); }}
      className="rounded-lg border border-ice bg-white px-2 py-1.5 text-center transition-colors hover:border-navy/30 focus-ring" title="Tap to copy">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-charcoal/40">{label}</div>
      <div className={`text-sm font-bold ${copied ? "text-emerald-600" : color}`}>{copied ? "Copied ✓" : value}</div>
    </button>
  );
}
function CopyTradeBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => { copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
      className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ice bg-white px-3 py-2 text-xs font-semibold text-navy transition-colors hover:bg-offwhite focus-ring">
      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy trade"}
    </button>
  );
}
