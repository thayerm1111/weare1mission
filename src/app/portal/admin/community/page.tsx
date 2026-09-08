"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, Trophy, Wifi, WifiOff } from "lucide-react";

/**
 * COMMUNITY P&L — the owner's leaderboard (owner 09-07: "see how much everyone is up
 * on their accounts... who's up the most"). Every connected broker account with live
 * equity, Today / 7-day / 30-day equity change (from daily snapshots), and the desk's
 * own closed-trade P&L alongside — so a deposit or a member's manual trading is never
 * mistaken for desk performance. Admin-only; everyone else sees Not found.
 */
type Row = {
  userId: string; member: string; accNum: string | null;
  equity: number | null; balance: number | null; connected: boolean;
  pnlToday: number | null; pnl7: number | null; pnl30: number | null;
  deskToday: number; desk30: number; trades30: number;
  autotrade: boolean; follower: boolean; sendIt: boolean;
};
type Totals = { accounts: number; connected: number; equity: number; pnlToday: number; pnl7: number; pnl30: number; deskToday: number; desk30: number };

const fmt = (n: number | null | undefined, dash = "—") =>
  n == null ? dash : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const Pnl = ({ v }: { v: number | null }) => (
  <span className={v == null ? "text-charcoal/40" : v > 0 ? "font-semibold text-emerald-600" : v < 0 ? "font-semibold text-red-600" : "text-charcoal/70"}>
    {v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v)}`}
  </span>
);

type SortKey = "today" | "d7" | "d30" | "equity" | "desk30";

export default function CommunityPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("today");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/community", { cache: "no-store" });
      if (r.status === 404) { setDenied(true); return; }
      const d = (await r.json()) as { ok?: boolean; rows?: Row[]; totals?: Totals };
      if (d.ok) { setRows(d.rows ?? []); setTotals(d.totals ?? null); }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const view = useMemo(() => {
    let v = rows ?? [];
    const needle = q.trim().toLowerCase();
    if (needle) v = v.filter((r) => r.member.toLowerCase().includes(needle) || (r.accNum ?? "").includes(needle));
    const key = (r: Row): number => sort === "today" ? (r.pnlToday ?? -Infinity)
      : sort === "d7" ? (r.pnl7 ?? -Infinity)
      : sort === "d30" ? (r.pnl30 ?? -Infinity)
      : sort === "equity" ? (r.equity ?? -Infinity)
      : r.desk30;
    return [...v].sort((a, b) => key(b) - key(a));
  }, [rows, q, sort]);

  if (denied) return <main className="p-10"><p>Not found.</p></main>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold text-navy"><Trophy className="h-6 w-6 text-gold" aria-hidden="true" /> Community P&amp;L</h1>
          <p className="mt-1 text-sm text-charcoal/60">
            Live equity for every connected account. Today / 7d / 30d = total equity change (includes members&rsquo; own trades and deposits);
            the Desk column is what the automation&rsquo;s closed gold trades earned (estimate). Baselines build from today forward.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-4 py-2 text-sm font-semibold text-charcoal/75 hover:border-primary hover:text-primary disabled:opacity-60">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" /> Refresh
        </button>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Community equity", val: fmt(totals.equity), sub: `${totals.connected}/${totals.accounts} accounts live` },
            { label: "Today", val: `${totals.pnlToday > 0 ? "+" : ""}${fmt(totals.pnlToday)}`, red: totals.pnlToday < 0 },
            { label: "Last 7 days", val: `${totals.pnl7 > 0 ? "+" : ""}${fmt(totals.pnl7)}`, red: totals.pnl7 < 0 },
            { label: "Desk trades (30d est.)", val: `${totals.desk30 > 0 ? "+" : ""}${fmt(totals.desk30)}`, red: totals.desk30 < 0 },
          ].map((c) => (
            <div key={c.label} className="rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
              <p className="text-xs font-semibold uppercase tracking-wide text-charcoal/55">{c.label}</p>
              <p className={`mt-1 text-xl font-extrabold ${c.red ? "text-red-600" : "text-navy"}`}>{c.val}</p>
              {"sub" in c && c.sub && <p className="mt-0.5 text-xs text-charcoal/55">{c.sub}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/40" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search member or account…" aria-label="Search"
            className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary" />
        </div>
        <label className="sr-only" htmlFor="pl-sort">Sort</label>
        <select id="pl-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-xl border border-[#E4DCCB] bg-cream px-3 py-2.5 text-sm outline-none focus:border-primary">
          <option value="today">Top today</option>
          <option value="d7">Top 7 days</option>
          <option value="d30">Top 30 days</option>
          <option value="equity">Biggest accounts</option>
          <option value="desk30">Top desk P&L (30d)</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-[#E4DCCB] text-left text-xs font-semibold uppercase tracking-wide text-charcoal/55">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Acct</th>
              <th className="px-4 py-3 text-right">Equity</th>
              <th className="px-4 py-3 text-right">Today</th>
              <th className="px-4 py-3 text-right">7d</th>
              <th className="px-4 py-3 text-right">30d</th>
              <th className="px-4 py-3 text-right">Desk 30d</th>
              <th className="px-4 py-3 text-right">Trades</th>
            </tr>
          </thead>
          <tbody>
            {loading && !rows ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-charcoal/55">Reading live equity from every connection — a few seconds…</td></tr>
            ) : view.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-charcoal/55">No connected accounts found.</td></tr>
            ) : view.map((r, i) => (
              <tr key={`${r.userId}-${r.accNum}-${i}`} className="border-b border-[#E4DCCB]/60 last:border-0">
                <td className="px-4 py-3 font-bold text-charcoal/60">{i + 1}</td>
                <td className="px-4 py-3">
                  <span className="font-semibold text-navy">{r.member}</span>
                  <span className="ml-2 inline-flex align-middle" title={r.connected ? "Connection live" : "Connection offline — showing last snapshot"}>
                    {r.connected ? <Wifi className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <WifiOff className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />}
                  </span>
                  {r.sendIt && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">SEND IT</span>}
                  {r.follower && <span className="ml-1 rounded-full bg-ice px-2 py-0.5 text-[10px] font-bold text-navy">follower</span>}
                </td>
                <td className="px-4 py-3 text-charcoal/70">{r.accNum ?? "—"}</td>
                <td className="px-4 py-3 text-right font-semibold text-navy">{fmt(r.equity)}</td>
                <td className="px-4 py-3 text-right"><Pnl v={r.pnlToday} /></td>
                <td className="px-4 py-3 text-right"><Pnl v={r.pnl7} /></td>
                <td className="px-4 py-3 text-right"><Pnl v={r.pnl30} /></td>
                <td className="px-4 py-3 text-right"><Pnl v={r.desk30} /></td>
                <td className="px-4 py-3 text-right text-charcoal/70">{r.trades30}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-charcoal/50">
        Dollar figures come straight from each broker account; Desk columns are estimated from the trade ledger (gold pips × lots).
        A deposit or withdrawal shows up in the equity change — check the Desk column before crediting the automation.
      </p>
    </div>
  );
}
