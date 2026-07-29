"use client";

/**
 * OM STRATEGY SCANNER — front end for the confirmations-as-strategies engine.
 *
 * Each strategy the trader toggles is a "scout" that scans the pair and returns
 * its own read (direction + what it saw). The card shows every scout's read on
 * its own line, then the combined verdict: a qualified trade, or an honest WAIT
 * when the strategies don't agree. Every number is computed server-side in code;
 * this component only displays and journals the result.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Radar, Loader2, ShieldAlert, ArrowUp, ArrowDown, Target, Gauge, Check, X, Sparkles,
  Ban, Layers, TrendingUp, Trash2, Search, Activity, Eye, Send,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";
import { CopyBtn, CopyAllBtn, buildTradeText, cleanNum } from "./copykit";

// -- Instrument catalog --
// The search box below matches against this list, but you can also just TYPE any
// symbol (e.g. "EURJPY", "gold", "nas") and scan it — the engine normalises it and
// passes it straight to the live-data feed.
type Inst = { td: string; name: string; cat: string };

const CUR: Record<string, string> = {
  EUR: "Euro", USD: "US Dollar", GBP: "Pound", JPY: "Yen",
  AUD: "Aussie", NZD: "Kiwi", CAD: "Loonie", CHF: "Franc",
};
// Base-currency priority (market convention) so pairs read the standard way.
const ORDER = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"];
function majorCrosses(): Inst[] {
  const out: Inst[] = [];
  for (let i = 0; i < ORDER.length; i++)
    for (let j = i + 1; j < ORDER.length; j++)
      out.push({ td: `${ORDER[i]}/${ORDER[j]}`, name: `${CUR[ORDER[i]]} / ${CUR[ORDER[j]]}`, cat: "Forex" });
  return out;
}
const EXOTICS: Inst[] = [
  { td: "USD/SGD", name: "US Dollar / Singapore", cat: "Forex" },
  { td: "USD/HKD", name: "US Dollar / Hong Kong", cat: "Forex" },
  { td: "USD/SEK", name: "US Dollar / Swedish Krona", cat: "Forex" },
  { td: "USD/NOK", name: "US Dollar / Norwegian Krone", cat: "Forex" },
  { td: "USD/MXN", name: "US Dollar / Mexican Peso", cat: "Forex" },
  { td: "USD/ZAR", name: "US Dollar / South African Rand", cat: "Forex" },
  { td: "USD/TRY", name: "US Dollar / Turkish Lira", cat: "Forex" },
  { td: "USD/CNH", name: "US Dollar / Chinese Yuan", cat: "Forex" },
  { td: "USD/PLN", name: "US Dollar / Polish Zloty", cat: "Forex" },
  { td: "EUR/SEK", name: "Euro / Swedish Krona", cat: "Forex" },
  { td: "EUR/NOK", name: "Euro / Norwegian Krone", cat: "Forex" },
  { td: "EUR/TRY", name: "Euro / Turkish Lira", cat: "Forex" },
  { td: "EUR/PLN", name: "Euro / Polish Zloty", cat: "Forex" },
  { td: "GBP/SGD", name: "Pound / Singapore", cat: "Forex" },
];
const COMMODITIES: Inst[] = [
  { td: "XAU/USD", name: "Gold", cat: "Commodity" },
  { td: "XAG/USD", name: "Silver", cat: "Commodity" },
  { td: "XPT/USD", name: "Platinum", cat: "Commodity" },
  { td: "XPD/USD", name: "Palladium", cat: "Commodity" },
  { td: "XCU/USD", name: "Copper", cat: "Commodity" },
  { td: "WTI/USD", name: "Crude Oil (WTI)", cat: "Commodity" },
];
const INDICES: Inst[] = [
  { td: "SPY", name: "S&P 500 (SPY)", cat: "Index" },
  { td: "NAS100", name: "Nasdaq 100 (NAS100)", cat: "Index" },
  { td: "DIA", name: "Dow Jones (DIA)", cat: "Index" },
  { td: "IWM", name: "Russell 2000 (IWM)", cat: "Index" },
];
const CRYPTO: Inst[] = [
  { td: "BTC/USD", name: "Bitcoin", cat: "Crypto" },
  { td: "ETH/USD", name: "Ethereum", cat: "Crypto" },
  { td: "SOL/USD", name: "Solana", cat: "Crypto" },
  { td: "XRP/USD", name: "XRP", cat: "Crypto" },
  { td: "DOGE/USD", name: "Dogecoin", cat: "Crypto" },
  { td: "ADA/USD", name: "Cardano", cat: "Crypto" },
  { td: "BNB/USD", name: "BNB", cat: "Crypto" },
  { td: "LTC/USD", name: "Litecoin", cat: "Crypto" },
];
const CATALOG: Inst[] = [...COMMODITIES, ...INDICES, ...majorCrosses(), ...EXOTICS, ...CRYPTO];
const POPULAR = ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "WTI/USD", "SPY", "NAS100", "BTC/USD"];

// Friendly aliases so typing "gold", "nasdaq", "us30" etc. resolves to a symbol.
const ALIASES: Record<string, string> = {
  GOLD: "XAU/USD", SILVER: "XAG/USD", PLATINUM: "XPT/USD", PALLADIUM: "XPD/USD", COPPER: "XCU/USD",
  OIL: "WTI/USD", CRUDE: "WTI/USD", WTI: "WTI/USD",
  NASDAQ: "NAS100", NAS100: "NAS100", NAS: "NAS100", US100: "NAS100", USTEC: "NAS100", QQQ: "NAS100",
  SPX: "SPY", SP500: "SPY", US500: "SPY", SPX500: "SPY",
  DOW: "DIA", US30: "DIA", DJIA: "DIA", DJI: "DIA",
  RUSSELL: "IWM", US2000: "IWM",
  BITCOIN: "BTC/USD", ETHEREUM: "ETH/USD",
};
const CODES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SGD", "HKD", "SEK", "NOK", "DKK", "MXN", "ZAR", "TRY", "CNH", "PLN", "HUF", "CZK"];

// Turn whatever the trader typed into a canonical symbol the feed understands.
function normalizeSymbol(input: string): string {
  const s = (input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return "";
  if (ALIASES[s]) return ALIASES[s];
  if (s.includes("/")) return s;
  if (/^(XAU|XAG|XPT|XPD|XCU)USD$/.test(s)) return s.slice(0, 3) + "/USD";
  if (/^[A-Z]{6}$/.test(s)) {
    const a = s.slice(0, 3), b = s.slice(3);
    if (CODES.includes(a) && CODES.includes(b)) return `${a}/${b}`;
  }
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|BNB|LTC|DOT|AVAX|MATIC)USDT?$/.test(s)) return s.replace(/USDT?$/, "/USD");
  return s; // plain ticker (SPY, AAPL, …)
}

const STYLES: { key: string; label: string; note: string }[] = [
  { key: "scalp", label: "Scalp", note: "next ~30–90 min · 30–100 pips" },
  { key: "intraday", label: "Intraday", note: "the bigger intraday move" },
  { key: "swing", label: "Swing", note: "the overall direction" },
];
const SCOUTS: { key: string; label: string }[] = [
  { key: "structure", label: "Market Structure" },
  { key: "liquidity", label: "Liquidity Sweeps" },
  { key: "fvg", label: "Fair Value Gaps" },
  { key: "fib", label: "Fib / OTE" },
  { key: "breakRetest", label: "Break & Retest" },
  { key: "sr", label: "Support / Resistance" },
  { key: "trend", label: "Trend (MAs)" },
  { key: "rsi", label: "RSI Momentum" },
];

type ScoutRead = { key: string; label: string; fired: boolean; dir: "LONG" | "SHORT" | null; strength: number; read: string; level?: number };
type Result = Record<string, unknown> & {
  status: string; symbol?: string; style?: string; price?: number; htf_trend?: string; confluence?: number; agreement?: number;
  headline?: string; reason?: string; direction?: string; order_type?: string; confidence?: string;
  entry?: number; stop_loss?: number; take_profits?: number[]; risk_reward?: string; stop_pips?: number; reversal?: boolean;
  scouts?: ScoutRead[]; reasoning?: string[]; educational?: string; error?: string;
};
type Journal = Result & { id: number };
// Live "Get update" snapshot for a signal the scanner produced.
type TradeUpdate = {
  headline: string; thesis: "intact" | "weakening" | "invalidated"; price: number;
  pnl: { r: number; pips: number; side: string; percent: number };
  distance: { to_stop_pips: number; to_next_target_pips: number; next_target_label: string };
  market?: { flow_1h?: string; flow_4h?: string; rsi?: number | null };
  explanation: string[]; what_to_watch: string;
};

const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toFixed(6)) : "—");

export function StrategyScanner({ isAdmin = false }: { isAdmin?: boolean }) {
  const [td, setTd] = useState("XAU/USD");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState("scalp");
  const [scouts, setScouts] = useState<string[]>(SCOUTS.map((s) => s.key));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [journal, setJournal] = useState<Journal[]>([]);
  const [updating, setUpdating] = useState<number | null>(null);
  const [updates, setUpdates] = useState<Record<number, TradeUpdate>>({});
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { try { const raw = localStorage.getItem("om_scanner"); if (raw) setJournal(JSON.parse(raw)); } catch { /* ignore */ } }, []);
  function persist(next: Journal[]) { setJournal(next); try { localStorage.setItem("om_scanner", JSON.stringify(next.slice(0, 15))); } catch { /* ignore */ } }

  const toggle = (k: string) => setScouts((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  // Filtered suggestions for whatever is typed.
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase().replace(/\s+/g, "");
    if (!q) return CATALOG.slice(0, 10);
    const qLoose = q.replace("/", "");
    return CATALOG.filter((i) => {
      const t = i.td.toUpperCase().replace("/", "");
      return t.includes(qLoose) || i.name.toUpperCase().includes(query.trim().toUpperCase()) || i.cat.toUpperCase().startsWith(q);
    }).slice(0, 10);
  }, [query]);

  const normalized = useMemo(() => normalizeSymbol(query), [query]);
  const showCustom = normalized && !matches.some((m) => m.td === normalized) && query.trim().length > 0;

  function pick(sym: string) {
    const canon = normalizeSymbol(sym);
    if (!canon) return;
    setTd(canon); setQuery(""); setOpen(false); setError("");
  }

  async function scan() {
    if (loading) return;
    setLoading(true); setError(""); setNeedCredits(false); setResult(null);
    try {
      const res = await fetch("/api/strategy-scanner", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ td, style, scouts }),
      });
      const d: Result = await res.json().catch(() => ({ status: "error" }));
      if (res.status === 402 || d.error === "insufficient_credits") { setNeedCredits(true); setError("You're out of credits — they reset tomorrow, or grab more."); return; }
      if (d.error === "unknown_asset") { setError(`"${td}" isn't a symbol we could read. Try a form like EUR/USD, XAU/USD, GBP/JPY, or SPY.`); return; }
      if (d.error === "marketdata_error") { setError((d.reason as string) || `No live candles came back for ${td} on this timeframe — check the symbol or try another.`); return; }
      if (d.error === "ratelimit" || d.error === "system_busy" || d.error === "notConfigured") { setError((d.reason as string) || "Market data is busy — try again shortly."); return; }
      if (d.error) { setError((d.reason as string) || "Couldn't run the scan right now. Try again shortly."); return; }
      const item: Journal = { ...d, id: Date.now() };
      setResult(item);
      persist([item, ...journal].slice(0, 15));
      try { window.dispatchEvent(new Event("credits-updated")); } catch { /* ignore */ }
    } catch { setError("Something interrupted the connection. Try again."); }
    finally { setLoading(false); }
  }

  // "Get update" — re-read the live market and explain what happened / is happening
  // to a signal the scanner already called. Free to run; works for any symbol.
  async function getUpdate(r: Result) {
    const rid = (r as Journal).id;
    if (updating != null || rid == null || r.status !== "setup") return;
    setUpdating(rid);
    try {
      const ageMs = Date.now() - rid;
      const res = await fetch("/api/om-signal-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          td: (r.instrument as string) || r.symbol,
          symbol: r.symbol,
          style: String(r.style || "").toLowerCase(),
          direction: r.direction,
          entry: r.entry, stopLoss: r.stop_loss, takeProfits: r.take_profits,
          since: ageMs > 20 * 60 * 1000 ? new Date(rid).toISOString() : "",
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (d && d.status === "update") setUpdates((u) => ({ ...u, [rid]: d as TradeUpdate }));
    } catch { /* ignore */ } finally { setUpdating(null); }
  }

  return (
    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(129,140,248,0.16),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-300 to-indigo-600"><Radar className="h-4 w-4 text-[#0a0b10]" /></span>
          <div>
            <p className="font-serif text-base font-semibold uppercase tracking-[0.14em]">OM Strategy Scanner</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Each confirmation is a strategy · combined into one read</p>
          </div>
        </div>
        <span className="rounded-full border border-white/15 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-white/50">WAIT is a valid result</span>
      </div>

      <div className="relative z-10 px-6 py-6 sm:px-8">
        {/* Instrument — search or type any symbol */}
        <p className="text-[11px] uppercase tracking-[0.12em] text-white/45">Instrument</p>
        <div ref={boxRef} className="relative mt-2">
          <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2.5 focus-within:border-indigo-400/60">
            <Search className="h-4 w-4 flex-shrink-0 text-white/40" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); pick(query || td); } if (e.key === "Escape") setOpen(false); }}
              placeholder="Search or type any symbol — EUR/USD, XAU/USD, GBP/JPY, SPY…"
              className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/35 focus:outline-none"
            />
            <span className="flex-shrink-0 rounded-lg border border-indigo-400/40 bg-indigo-400/10 px-2.5 py-1 text-xs font-semibold text-indigo-200">{td}</span>
          </div>

          {open && (
            <>
              <button aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-10 cursor-default" />
              <div className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-72 overflow-auto rounded-xl border border-white/15 bg-[#0d0e15] p-1.5 shadow-xl shadow-black/40">
                {showCustom && (
                  <button onMouseDown={(e) => { e.preventDefault(); pick(query); }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]">
                    <span className="text-sm font-semibold text-white">Scan “{normalized}”</span>
                    <span className="text-[10px] uppercase tracking-wide text-indigo-300">Use typed symbol</span>
                  </button>
                )}
                {matches.map((m) => (
                  <button key={m.td} onMouseDown={(e) => { e.preventDefault(); pick(m.td); }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{m.td}</span>
                      <span className="text-xs text-white/45">{m.name}</span>
                    </span>
                    <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/45">{m.cat}</span>
                  </button>
                ))}
                {!showCustom && matches.length === 0 && (
                  <p className="px-3 py-3 text-sm text-white/45">No match — press Enter to scan “{normalized || query}” anyway.</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Popular quick-picks */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {POPULAR.map((p) => (
            <button key={p} onClick={() => pick(p)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${td === p ? "border-indigo-400/60 bg-indigo-400/10 text-white" : "border-white/10 bg-white/[0.03] text-white/55 hover:text-white/90"}`}>
              {p}
            </button>
          ))}
        </div>

        {/* Timeframe intent */}
        <p className="mt-4 text-[11px] uppercase tracking-[0.12em] text-white/45">Timeframe intent</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {STYLES.map((s) => (
            <button key={s.key} onClick={() => setStyle(s.key)}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${style === s.key ? "border-indigo-400/60 bg-indigo-400/10" : "border-white/12 bg-white/[0.03] hover:border-white/25"}`}>
              <p className="text-sm font-semibold text-white">{s.label}</p>
              <p className="text-[10px] text-white/45">{s.note}</p>
            </button>
          ))}
        </div>

        {/* Strategy scouts */}
        <p className="mt-4 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
          <span>Strategies to scan with</span>
          <span className="text-white/35">{scouts.length}/{SCOUTS.length} on · tap to toggle</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SCOUTS.map((s) => {
            const on = scouts.includes(s.key);
            return (
              <button key={s.key} onClick={() => toggle(s.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${on ? "border-indigo-400/50 bg-indigo-400/10 text-white" : "border-white/12 bg-white/[0.02] text-white/40 hover:text-white/70"}`}>
                {on ? <Check className="h-3 w-3 text-indigo-300" /> : <X className="h-3 w-3" />} {s.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-end">
          <button onClick={scan} disabled={loading || scouts.length === 0}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-300 to-indigo-600 px-6 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#0a0b10] transition-opacity hover:opacity-90 disabled:opacity-40">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {loading ? "Scanning…" : "Scan strategies"}
            <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">{CREDIT_COST.signal}</span>
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
            <p className="inline-flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> {error}</p>
            {needCredits && <a href="/portal/credits" className="mt-2 inline-flex rounded-lg bg-indigo-400/90 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#0a0b10]">Get credits</a>}
          </div>
        )}

        {result && <ResultView r={result} isAdmin={isAdmin} onUpdate={() => getUpdate(result)} updating={updating === (result as Journal).id} update={updates[(result as Journal).id ?? -1]} />}

        {/* Recent */}
        {journal.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
              <span>Recent scans</span>
              <button onClick={() => persist([])} className="inline-flex items-center gap-1 text-white/40 hover:text-white/70"><Trash2 className="h-3 w-3" /> clear</button>
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {journal.map((j) => (
                <button key={j.id} onClick={() => setResult(j)} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:border-white/25">
                  <span className="flex items-center gap-2 text-sm font-semibold">{j.symbol}
                    {j.status === "setup"
                      ? <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${j.direction === "LONG" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{j.direction}</span>
                      : <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/50"><Ban className="h-3 w-3" /> wait</span>}
                  </span>
                  <span className="text-[10px] text-white/35">{j.confluence != null ? `${j.confluence}/100` : ""}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-5 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-white/35">
          Educational market analysis &amp; paper-trading decision support — not financial advice, and not a prediction. The scanner returns WAIT whenever the strategies don&apos;t agree. Trading involves substantial risk; manage your own exposure.
        </p>
      </div>
    </div>
  );
}

function ResultView({ r, onUpdate, updating, update, isAdmin }: { r: Result; onUpdate?: () => void; updating?: boolean; update?: TradeUpdate; isAdmin?: boolean }) {
  const scouts = Array.isArray(r.scouts) ? r.scouts : [];
  const isSetup = r.status === "setup";
  const buy = r.direction === "LONG";

  const tradeBlock = buildTradeText({
    direction: r.direction,
    entry: r.entry,
    stopLoss: r.stop_loss,
    takeProfits: r.take_profits,
    fmt,
  });

  const [tgBusy, setTgBusy] = useState(false);
  const [tgDone, setTgDone] = useState(false);
  const [tgErr, setTgErr] = useState("");
  async function pushTelegram() {
    if (tgBusy) return;
    setTgBusy(true); setTgErr("");
    try {
      const res = await fetch("/api/telegram-call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: r.symbol,
          direction: r.direction,
          entry: cleanNum(fmt(r.entry)),
          stop_loss: cleanNum(fmt(r.stop_loss)),
          take_profits: (r.take_profits || []).map((t) => cleanNum(fmt(t))),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) { setTgDone(true); setTimeout(() => setTgDone(false), 3000); }
      else if (j.notConfigured) { setTgErr("Telegram isn't connected yet — add TELEGRAM_BOT_TOKEN & TELEGRAM_CHANNEL_ID in Vercel."); }
      else { setTgErr(j.detail || "Couldn't post to Telegram. Try again."); }
    } catch { setTgErr("Couldn't reach the server. Try again."); }
    finally { setTgBusy(false); }
  }

  return (
    <div className="mt-5 rounded-2xl border border-white/12 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-serif text-xl font-bold">{r.symbol}</p>
          <p className="text-xs text-white/40">{r.style} · HTF trend {r.htf_trend}</p>
        </div>
        {isSetup ? (
          <div className="flex flex-col items-end gap-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${buy ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{buy ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}{r.direction} · {r.order_type}</span>
            {r.reversal && <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">Confirmed reversal</span>}
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white/60"><Ban className="h-4 w-4" /> WAIT</span>
        )}
      </div>

      {isSetup && onUpdate && (
        <button onClick={onUpdate} disabled={updating}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 px-3.5 py-1.5 text-[12px] font-semibold text-sky-300 transition-colors hover:bg-sky-400/20 disabled:opacity-40">
          {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />} Get update — what happened since
        </button>
      )}
      {update && <UpdatePanel u={update} />}

      {/* Confluence meter */}
      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/45">
          <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" /> Confluence · {Math.round((r.agreement ?? 0) * 100)}% agree</span>
          <span className="font-serif text-lg font-bold text-white">{r.confluence ?? 0}/100</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className={`h-full rounded-full ${(r.confluence ?? 0) >= 78 ? "bg-emerald-400" : (r.confluence ?? 0) >= 60 ? "bg-indigo-400" : "bg-amber-400"}`} style={{ width: `${Math.min(100, r.confluence ?? 0)}%` }} />
        </div>
      </div>

      {/* Per-strategy reads */}
      <p className="mt-4 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-white/45"><Layers className="h-3.5 w-3.5" /> What each strategy sees</p>
      <div className="mt-2 space-y-1.5">
        {scouts.map((s) => (
          <div key={s.key} className="flex items-start gap-2.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
            <span className={`mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full ${s.fired ? (s.dir === "LONG" ? "bg-emerald-500/15 text-emerald-400" : s.dir === "SHORT" ? "bg-red-500/15 text-red-400" : "bg-white/10 text-white/40") : "bg-white/[0.04] text-white/25"}`}>
              {s.fired ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-white/85">{s.label}
                {s.fired && s.dir && <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.dir === "LONG" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{s.dir}</span>}
              </p>
              <p className={`text-[12px] leading-relaxed ${s.fired ? "text-white/70" : "text-white/40"}`}>{s.read}</p>
            </div>
          </div>
        ))}
      </div>

      {isSetup ? (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Cell label="Entry" v={fmt(r.entry)} tint="text-white" copy={fmt(r.entry)} />
            <Cell label="Stop" v={fmt(r.stop_loss)} tint="text-red-400" icon={<ShieldAlert className="h-3 w-3" />} copy={fmt(r.stop_loss)} />
            <Cell label="Risk : Reward" v={r.risk_reward || "—"} tint="text-indigo-300" small />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {(r.take_profits || []).map((t, i) => <Cell key={i} label={`TP${i + 1}`} v={fmt(t)} tint="text-emerald-400" icon={<Target className="h-3 w-3" />} copy={fmt(t)} />)}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyAllBtn text={tradeBlock} />
            {isAdmin && (
              <button type="button" onClick={pushTelegram} disabled={tgBusy}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 px-3.5 py-1.5 text-[12px] font-semibold text-sky-300 transition-colors hover:bg-sky-400/20 disabled:opacity-40">
                {tgBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : tgDone ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Send className="h-3.5 w-3.5" />}
                {tgDone ? "Posted to Telegram" : "Push to Telegram"}
              </button>
            )}
          </div>
          {tgErr && <p className="mt-2 text-[11px] leading-relaxed text-amber-300">{tgErr}</p>}
          {Array.isArray(r.reasoning) && r.reasoning.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {r.reasoning.map((x, i) => <li key={i} className="flex items-start gap-2 text-sm text-white/80"><Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-indigo-300" /> {x}</li>)}
            </ul>
          )}
          <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-white/45"><TrendingUp className="h-3 w-3" /> Confidence: <span className="font-semibold text-white/75">{r.confidence}</span> · ~{r.stop_pips} pip stop</p>
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm leading-relaxed text-white/80">{r.reason}</p>
      )}

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/35">{r.educational}</p>
    </div>
  );
}

function Cell({ label, v, tint, icon, small, copy }: { label: string; v: string; tint: string; icon?: React.ReactNode; small?: boolean; copy?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5">
      <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.08em] text-white/40">{icon}{label}</p>
      <p className={`mt-0.5 flex items-center justify-center gap-1 font-serif ${small ? "text-sm" : "text-base"} font-bold tabular-nums ${tint}`}>{v}{copy ? <CopyBtn value={copy} label={label} /> : null}</p>
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
