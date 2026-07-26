"use client";

/**
 * Watchlist — a member's personal set of pairs with live prices, the day's
 * change, and simple price alerts. Saves on-device. Gives traders a reason to
 * open the dashboard every day. Prices come from /api/om-quote (Twelve Data).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Star, Plus, X, Bell, BellRing, TrendingUp, TrendingDown, RefreshCw, ArrowRight, Check,
} from "lucide-react";
import { MARKETS } from "@/data/signalAssets";

const STORAGE_KEY = "1m_watchlist_v1";
const REFRESH_MS = 60_000; // 60s keeps us within the market-data rate limit

type Item = { td: string; symbol: string; name: string; alert?: number | null; alertAbove?: boolean; hit?: boolean };
type Quote = { price: number; percent: number | null } | { error: string };

const ALL_ASSETS = MARKETS.flatMap((m) => m.assets.map((a) => ({ ...a, market: m.name })));

const DEFAULTS: Item[] = [
  { td: "XAU/USD", symbol: "XAU/USD", name: "Gold Spot" },
  { td: "BTC/USD", symbol: "BTC/USD", name: "Bitcoin" },
  { td: "EUR/USD", symbol: "EUR/USD", name: "Euro / USD" },
];

function load(): Item[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Item[];
  } catch { /* ignore */ }
  return DEFAULTS;
}
function save(items: Item[]) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* ignore */ }
}

const fmtPrice = (n: number) => {
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { minimumFractionDigits: d > 2 ? 2 : d, maximumFractionDigits: d });
};

export function Watchlist() {
  const [items, setItems] = useState<Item[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [prices, setPrices] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [alertFor, setAlertFor] = useState<string | null>(null);
  const [alertVal, setAlertVal] = useState("");
  const itemsRef = useRef<Item[]>([]);

  useEffect(() => { const i = load(); setItems(i); itemsRef.current = i; setHydrated(true); }, []);

  const persist = (next: Item[]) => { setItems(next); itemsRef.current = next; save(next); };

  const refresh = useCallback(async () => {
    const list = itemsRef.current;
    if (!list.length) return;
    setLoading(true);
    try {
      const results = await Promise.all(
        list.map(async (it) => {
          try {
            const r = await fetch(`/api/om-quote?td=${encodeURIComponent(it.td)}`);
            const j = await r.json();
            return [it.td, j] as [string, Quote];
          } catch {
            return [it.td, { error: "unavailable" }] as [string, Quote];
          }
        })
      );
      const map: Record<string, Quote> = {};
      for (const [td, q] of results) map[td] = q;
      setPrices(map);

      // Client-side alert check (fires while the dashboard is open).
      const next = list.map((it) => {
        const q = map[it.td];
        if (!it.alert || it.hit || !q || "error" in q) return it;
        const crossed = it.alertAbove ? q.price >= it.alert : q.price <= it.alert;
        if (crossed) {
          notify(`${it.symbol} hit ${fmtPrice(it.alert)}`, `Now ${fmtPrice(q.price)}`);
          return { ...it, hit: true };
        }
        return it;
      });
      if (next.some((n, i) => n.hit !== list[i].hit)) persist(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const available = useMemo(
    () => ALL_ASSETS.filter((a) => !items.some((it) => it.td === a.td)),
    [items]
  );

  const add = (a: { td: string; symbol: string; name: string }) => {
    persist([...items, { td: a.td, symbol: a.symbol, name: a.name }]);
    setAdding(false);
    setTimeout(() => void refresh(), 50);
  };
  const remove = (td: string) => persist(items.filter((it) => it.td !== td));
  const setAlert = (td: string) => {
    const v = parseFloat(alertVal);
    if (!Number.isFinite(v)) { setAlertFor(null); return; }
    const q = prices[td];
    const cur = q && !("error" in q) ? q.price : v;
    persist(items.map((it) => (it.td === td ? { ...it, alert: v, alertAbove: v >= cur, hit: false } : it)));
    setAlertFor(null); setAlertVal("");
  };
  const clearAlert = (td: string) =>
    persist(items.map((it) => (it.td === td ? { ...it, alert: null, hit: false } : it)));

  return (
    <div className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
          <Star className="h-5 w-5 text-primary" aria-hidden="true" /> Your Watchlist
        </h2>
        <div className="flex items-center gap-1.5">
          <button onClick={() => void refresh()} disabled={loading} title="Refresh prices"
            className="grid h-8 w-8 place-items-center rounded-full border border-ice text-charcoal/60 hover:bg-offwhite focus-ring disabled:opacity-40">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button onClick={() => setAdding((a) => !a)} title="Add a pair"
            className="grid h-8 w-8 place-items-center rounded-full bg-primary text-cream hover:bg-navy focus-ring">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {adding && available.length > 0 && (
        <div className="mt-3 max-h-52 overflow-y-auto rounded-xl border border-ice bg-offwhite/50 p-2">
          {available.map((a) => (
            <button key={a.td} onClick={() => add(a)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-white focus-ring">
              <span><span className="font-semibold text-navy">{a.symbol}</span> <span className="text-charcoal/50">· {a.name}</span></span>
              <Plus className="h-3.5 w-3.5 text-charcoal/40" />
            </button>
          ))}
        </div>
      )}

      <ul className="mt-3 divide-y divide-ice">
        {hydrated && items.length === 0 && (
          <li className="py-6 text-center text-sm text-charcoal/55">Your watchlist is empty — tap + to add a pair.</li>
        )}
        {items.map((it) => {
          const q = prices[it.td];
          const hasPrice = q && !("error" in q);
          const pct = hasPrice ? (q as { percent: number | null }).percent : null;
          const up = pct != null && pct >= 0;
          return (
            <li key={it.td} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-navy">{it.symbol}</span>
                    {it.alert != null && (
                      <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${it.hit ? "bg-emerald-500 text-white" : "bg-ice text-charcoal/60"}`}>
                        <BellRing className="h-2.5 w-2.5" /> {fmtPrice(it.alert)}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-charcoal/45">{it.name}</p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-semibold tabular-nums text-navy">
                      {hasPrice ? fmtPrice((q as { price: number }).price) : "—"}
                    </div>
                    {pct != null && (
                      <div className={`flex items-center justify-end gap-0.5 text-xs font-medium ${up ? "text-emerald-600" : "text-red-600"}`}>
                        {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {up ? "+" : ""}{pct.toFixed(2)}%
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => { setAlertFor(alertFor === it.td ? null : it.td); setAlertVal(it.alert ? String(it.alert) : ""); }}
                      title="Set price alert"
                      className={`grid h-7 w-7 place-items-center rounded-full hover:bg-offwhite focus-ring ${it.alert != null ? "text-primary" : "text-charcoal/35"}`}>
                      <Bell className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => remove(it.td)} title="Remove"
                      className="grid h-7 w-7 place-items-center rounded-full text-charcoal/30 hover:bg-red-50 hover:text-red-500 focus-ring">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {alertFor === it.td && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-offwhite/60 px-2.5 py-2">
                  <span className="text-xs text-charcoal/60">Alert me at</span>
                  <input value={alertVal} onChange={(e) => setAlertVal(e.target.value)} inputMode="decimal"
                    placeholder="price" className="w-24 rounded-md border border-ice bg-white px-2 py-1 text-sm focus:border-primary focus:outline-none" />
                  <button onClick={() => setAlert(it.td)} className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-cream hover:bg-navy focus-ring">
                    <Check className="h-3 w-3" /> Set
                  </button>
                  {it.alert != null && (
                    <button onClick={() => clearAlert(it.td)} className="text-xs font-medium text-charcoal/50 hover:text-red-600">Clear</button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-center justify-between border-t border-ice pt-3">
        <span className="text-[11px] text-charcoal/40">Live prices · alerts fire while this page is open</span>
        <Link href="/portal/signals" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
          Get a play <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function notify(title: string, body: string) {
  try {
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "granted") { new Notification(title, { body }); return; }
      if (Notification.permission !== "denied") { Notification.requestPermission().then((p) => { if (p === "granted") new Notification(title, { body }); }); }
    }
  } catch { /* ignore */ }
}
