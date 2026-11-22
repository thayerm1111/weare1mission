"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Search } from "lucide-react";
import { Method, PeriodSelect, Skel, toneClass } from "@/components/om/floor/Floor";
import { FlowAccountBar, FlowAccountProvider, useFlowAccount, type FlowAccountValue } from "@/components/om/FlowAccount";
import { FlowConnect, type FlowViewing } from "@/components/portal/floor/FlowConnect";
import { FlowTrackRecord } from "@/components/portal/floor/FlowTrackRecord";
import type { ManageView } from "@/components/om/flow/FlowExecution";
import {
  FLOOR_PERIODS, SOURCE_LABEL, money, pipsText,
  type FloorOverview, type FloorPeriod, type FlowClosed, type FlowPosition, type FlowResults,
} from "@/lib/floor/overview";
import { lotsText, pairName, priceFor } from "@/lib/flow/display";

/**
 * FLOW, IN THE TRADING PLATFORM'S SHELL (owner 11-20 brief §9: "Lead with the account experience").
 *
 *   header       FLOW, one sentence, Find a trade and Manage accounts
 *   the account  the account being looked at — the same one The Floor shows, chosen in either place — with
 *                the broker's Balance and Equity, read live, dated, and hideable
 *   My FLOW      realized and open P&L, then Positions / History / Results: what FLOW did on THIS account
 *   Execution    what this account takes and how, and Manage execution (FlowConnect, in FlowExecution's dress)
 *   Find a trade FLOW's reading on one market, and the ticket (FlowDesk) — read only when asked
 *   Desk record  the engine's own record across every member, labelled as such (FlowTrackRecord)
 *
 * The account's figures, positions and results come from /api/floor/overview, read-only: choosing which
 * account to look at changes what is shown and nothing else — not the account's settings, not what it
 * takes, not which accounts a ticket goes to. The choice is remembered under The Floor's own key, so the
 * two screens always show the same account.
 */

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* a private window: the choice lasts for the visit */ } },
};
const KEY_TAB = "om:flow:tab";

type Tab = "positions" | "history" | "results";
const TABS: { key: Tab; label: string }[] = [{ key: "positions", label: "Positions" }, { key: "history", label: "History" }, { key: "results", label: "Results" }];

function whenText(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(now || t).toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
const sideWord = (s: "buy" | "sell") => (s === "sell" ? "Sell" : "Buy");
const calm = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return true; } };

export function FlowHome({ find }: { find: React.ReactNode }) {
  const account = useFlowAccount();
  // Keep the standalone/classic host functional. Inside AppShell, only its shared provider fetches.
  if (!account) return <FlowAccountProvider><FlowAccountBar /><FlowHome find={find} /></FlowAccountProvider>;
  return <FlowHomeView find={find} account={account} />;
}

function FlowHomeView({ find, account }: { find: React.ReactNode; account: FlowAccountValue }) {
  const { ov, state: ovState, failed, switching, flowPeriod: fp, setFlowPeriod: period, hide, now, refresh } = account;
  const [tab, setTab] = useState<Tab>("positions");
  const [manage, setManage] = useState<ManageView>(null);

  // Only FLOW's local workspace tab lives here. Account selection, periods and privacy are shared.
  useEffect(() => {
    const t = store.get(KEY_TAB);
    if (t === "positions" || t === "history" || t === "results") setTab(t);
    const openSettings = () => { if (window.location.hash === "#flow-settings") setManage("settings"); };
    openSettings();
    window.addEventListener("hashchange", openSettings);
    return () => window.removeEventListener("hashchange", openSettings);
  }, []);

  const pickTab = (t: Tab) => { setTab(t); store.set(KEY_TAB, t); };
  const reload = useCallback(() => { void refresh(); }, [refresh]);
  const toFind = (e: React.MouseEvent) => {
    const el = document.getElementById("flow-find");
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
    el.querySelector<HTMLElement>("select, button")?.focus({ preventScroll: true });
  };

  const a = ov?.account ?? null;
  const viewing: FlowViewing | null = a ? { id: a.id, environment: a.environment, name: a.name, health: a.connection } : null;
  const none = !!ov && ov.accountsKnown && !a;

  return (
    <div className="om-ws om-flow">
      <header className="om-ws-head">
        <div>
          <h1 className="om-title">FLOW</h1>
          <p className="om-sub">Your accounts, trade history and execution controls.</p>
        </div>
        <div className="om-flow-acts">
          <a href="#flow-find" className="om-btn-quiet" onClick={toFind}><Search aria-hidden="true" width={15} height={15} />Find a trade</a>
          <button type="button" className="om-btn-quiet" onClick={() => setManage(none ? "connect" : "settings")}><Link2 aria-hidden="true" width={15} height={15} />Manage accounts</button>
        </div>
      </header>

      <div className="om-flow-grid">
        <MyFlow ov={ov} state={ovState} failed={failed} switching={switching} period={fp} onPeriod={period} hide={hide} tab={tab} onTab={pickTab} now={now} />
        <FlowConnect viewing={viewing} viewReady={ovState !== "loading"} manage={manage} onManage={setManage} onAccountsChanged={reload} />
      </div>

      {find}

      <FlowTrackRecord />
    </div>
  );
}

/* ── My FLOW: one account's results ───────────────────────────────────────────────────────────── */

function MyFlow({ ov, state, failed, switching, period, onPeriod, hide, tab, onTab, now }: {
  ov: FloorOverview | null; state: string; failed: boolean; switching: boolean; period: FloorPeriod; onPeriod: (p: FloorPeriod) => void;
  hide: boolean; tab: Tab; onTab: (t: Tab) => void; now: number;
}) {
  const a = ov?.account ?? null;
  const fl = !switching && ov?.flow && ov.flow.period === period ? ov.flow : null;
  const r = fl?.results ?? null;
  const f = switching ? null : ov?.figures ?? null;
  const waiting = !r && !!a && !failed && (state === "loading" || switching || (!!ov?.flow && ov.flow.period !== period));
  const unknown = !ov ? state !== "loading" : !ov.accountsKnown;
  const cur = a?.currency ?? null;
  const cash = (v: number | null | undefined, sign = true) => (hide ? "••••••" : money(v ?? null, cur, { sign }));
  // The broker's open profit is for every position on the account. It is FLOW's only when FLOW holds them all.
  const wholeAccount = !!r && f?.positions != null && f.positions !== r.open;
  const periodWord = (FLOOR_PERIODS.find((p) => p.key === period)?.label ?? "").toLowerCase();

  let body: React.ReactNode;
  if (!ov && state === "loading") body = <Loading />;
  else if (unknown) body = <p className="om-empty">Your FLOW results could not be loaded just now. This tries again on its own.</p>;
  else if (!a) body = <Steps />;
  else if (waiting) body = <Loading />;
  else if (!r) body = <p className="om-empty">Your FLOW results could not be loaded just now. This tries again on its own.</p>;
  else {
    const positions = r.positions ?? [];
    const history = r.history ?? [];
    body = (
      <>
        <div className="om-stats">
          <div className="om-stat">
            <span data-no-i18n translate="no" className={`om-figure om-num ${r.realized ? toneClass(r.realized.amount) : toneClass(r.netPips)}`}>{r.closed === 0 ? cash(0, false) : r.realized ? cash(r.realized.amount) : pipsText(r.netPips)}</span>
            <span className="om-label">{r.closed > 0 && !r.realized ? "Realized, in pips" : "Realized P&L"}{r.realized && r.closed > 0 ? <span className="om-faint"> · estimate</span> : null}</span>
          </div>
          <div className="om-stat">
            <span className={`om-figure om-num ${f?.state === "live" ? toneClass(f?.openPnl) : ""}`} data-stale={f && f.state !== "live" ? true : undefined} data-no-i18n translate="no" title={f?.openPnl == null ? (f?.note ?? "Your broker has not reported open profit for this account.") : undefined}>{f ? cash(f.openPnl) : <Skel w={110} h={26} />}</span>
            <span className="om-label">Open P&amp;L{f && f.state !== "live" && f.openPnl != null ? <span className="om-faint"> · last reading</span> : wholeAccount ? <span className="om-faint"> · whole account</span> : null}</span>
          </div>
          <div className="om-stat"><span className="om-figure om-num">{r.open}</span><span className="om-label">Open positions</span></div>
          <div className="om-stat" data-no-i18n translate="no">
            <span className={`om-figure om-num ${r.closed ? toneClass(r.netPips) : ""}`}>{r.closed ? pipsText(r.netPips) : "—"}</span>
            <span className="om-label">{r.closed === 0 ? `No trades closed ${periodWord}` : `${r.closed} closed`}</span>
          </div>
        </div>

        <div className="om-tabs" role="tablist" aria-label="My FLOW">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" id={`om-flow-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="om-flow-tabpanel" tabIndex={tab === t.key ? 0 : -1}
              onClick={() => onTab(t.key)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                const i = TABS.findIndex((x) => x.key === tab), n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                onTab(n.key); document.getElementById(`om-flow-tab-${n.key}`)?.focus();
              }}>
              {t.label}{t.key === "positions" ? <span className="om-faint om-num"> {positions.length}</span> : t.key === "history" ? <span className="om-faint om-num"> {r.closed}</span> : null}
            </button>
          ))}
        </div>
        <div id="om-flow-tabpanel" role="tabpanel" aria-labelledby={`om-flow-tab-${tab}`} className="om-flow-tabpanel">
          {tab === "positions" ? <Positions rows={positions} broker={f?.positions ?? null} now={now} />
            : tab === "history" ? <History rows={history} more={r.historyMore ?? 0} cash={cash} periodWord={periodWord} now={now} />
              : <Results r={r} periodWord={periodWord} />}
        </div>
      </>
    );
  }

  return (
    <section className="om-panel om-flow-main" aria-label="My FLOW">
      <div className="om-res-head">
        <div style={{ minWidth: 0 }}>
          <h2>My FLOW</h2>
          <p className="om-label" data-no-i18n translate="no">{a ? `${a.name} · ${a.environment === "live" ? "Live" : "Demo"} · trades FLOW placed on this account` : "What FLOW does on your connected account"}</p>
        </div>
        {a && (
          <span className="om-res-tools">
            <PeriodSelect value={period} onChange={onPeriod} label="My FLOW period" />
            <Method id="om-method-myflow">
              Trades FLOW placed on this account — GENX, GEN FX and FLOW&rsquo;s own — and nothing else: a ticket you placed yourself is not in it, and deposits, withdrawals and transfers are never counted as results.
              {r?.realized && r.closed > 0 ? ` The amount is an estimate from each trade's recorded result and size, before your broker's commission, swap and fees${r.realized.left ? `; ${r.realized.left} ${r.realized.left === 1 ? "trade is" : "trades are"} not in it` : ""}.` : ""}
              {r && r.ungraded ? ` ${r.ungraded} closed with no recorded result.` : ""}
              {wholeAccount ? ` Open P&L is your broker's figure for all ${f!.positions} open ${f!.positions === 1 ? "position" : "positions"} on the account.` : ""}
            </Method>
          </span>
        )}
      </div>
      {body}
    </section>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className="om-stats">
        <div className="om-stat"><Skel w={130} h={26} /><span className="om-label">Realized P&amp;L</span></div>
        <div className="om-stat"><Skel w={110} h={26} /><span className="om-label">Open P&amp;L</span></div>
        <div className="om-stat"><Skel w={36} h={26} /><span className="om-label">Open positions</span></div>
      </div>
      <div className="om-flow-skel-rows"><Skel w="100%" h={18} /><Skel w="100%" h={18} /><Skel w="70%" h={18} /></div>
    </div>
  );
}

/** Connect broker → choose accounts → choose what each takes → review its settings → switch it on (brief §9). */
function Steps() {
  return (
    <ol className="om-steps">
      <li><b>Connect your TradeLocker login</b><span className="om-label">Demo is practice money; Live is your real account. You can connect both.</span></li>
      <li><b>Choose your accounts</b><span className="om-label">Every account on the login is listed. A new account starts with Trading on.</span></li>
      <li><b>Choose what each one takes</b><span className="om-label">GENX trades, FLOW&rsquo;s forex and index trades, every GENX signal, or nothing.</span></li>
      <li><b>Review its settings</b><span className="om-label">Risk per trade, break-even, follow price, partials and the pause after losses.</span></li>
      <li><b>Turn on Auto-run FLOW</b><span className="om-label">On, FLOW&rsquo;s own forex and index trades are placed as well. Off, no automated trade reaches any of your accounts.</span></li>
    </ol>
  );
}

function Positions({ rows, broker, now }: { rows: FlowPosition[]; broker: number | null; now: number }) {
  const outside = broker != null && broker > rows.length ? broker - rows.length : 0;
  if (!rows.length) {
    return <p className="om-empty">No FLOW trades are open on this account.{outside ? ` Your broker shows ${outside} open ${outside === 1 ? "position" : "positions"} that FLOW did not place.` : ""}</p>;
  }
  return (
    <>
      <table className="om-table">
        <thead><tr><th scope="col">Market</th><th scope="col">Side</th><th scope="col" className="om-r">Size</th><th scope="col" className="om-r">Entry</th><th scope="col" className="om-r">Stop</th><th scope="col" className="om-r">Target</th><th scope="col">Source</th><th scope="col" className="om-r">Opened</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="om-lead" data-no-i18n translate="no"><b>{pairName(p.symbol)}</b></td>
              <td data-label="Side"><span className="om-side" data-side={p.side}>{sideWord(p.side)}</span></td>
              <td data-label="Size" className="om-r om-num">{lotsText(p.qty)}</td>
              <td data-label="Entry" className="om-r om-num" data-no-i18n translate="no">{priceFor(p.symbol, p.entry)}</td>
              <td data-label="Stop" className="om-r om-num" data-no-i18n translate="no">{priceFor(p.symbol, p.stop)}</td>
              <td data-label="Target" className="om-r om-num" data-no-i18n translate="no">{priceFor(p.symbol, p.target)}</td>
              <td data-label="Source">{SOURCE_LABEL[p.source]}</td>
              <td data-label="Opened" className="om-r">{whenText(p.at, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {outside > 0 && <p className="om-label om-flow-foot">Your broker also shows {outside} open {outside === 1 ? "position" : "positions"} FLOW did not place. Open P&amp;L above is for all of them.</p>}
    </>
  );
}

function History({ rows, more, cash, periodWord, now }: { rows: FlowClosed[]; more: number; cash: (v: number | null | undefined) => string; periodWord: string; now: number }) {
  if (!rows.length) return <p className="om-empty">No FLOW trades closed on this account {periodWord === "all" ? "yet" : periodWord}.</p>;
  return (
    <>
      <table className="om-table">
        <thead><tr><th scope="col">Market</th><th scope="col">Side</th><th scope="col" className="om-r">Size</th><th scope="col" className="om-r">Result</th><th scope="col" className="om-r">Amount</th><th scope="col">Source</th><th scope="col" className="om-r">Closed</th></tr></thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id + h.at}>
              <td className="om-lead" data-no-i18n translate="no"><b>{pairName(h.symbol)}</b></td>
              <td data-label="Side"><span className="om-side" data-side={h.side}>{sideWord(h.side)}</span></td>
              <td data-label="Size" className="om-r om-num">{lotsText(h.qty)}</td>
              <td data-label="Result" className={`om-r om-num ${toneClass(h.pips)}`} data-no-i18n translate="no">{h.pips == null ? "No result recorded" : pipsText(h.pips)}</td>
              <td data-label="Amount" className={`om-r om-num ${toneClass(h.amount)}`} data-no-i18n translate="no">{h.amount == null ? "—" : cash(h.amount)}</td>
              <td data-label="Source">{SOURCE_LABEL[h.source]}</td>
              <td data-label="Closed" className="om-r">{whenText(h.at, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && <p className="om-label om-flow-foot">The latest {rows.length} are listed; {more} more closed in this period and are counted in the figures above.</p>}
    </>
  );
}

function Results({ r, periodWord }: { r: FlowResults; periodWord: string }) {
  if (r.closed === 0) return <p className="om-empty">No FLOW trades closed on this account {periodWord === "all" ? "yet" : periodWord}. Results appear here as they close.</p>;
  const decided = r.wins + r.losses;
  const rate = decided ? Math.round((r.wins / decided) * 100) : null;
  return (
    <div className="om-flow-results">
      <div className="om-stats">
        <div className="om-stat"><span className={`om-figure om-num ${rate != null && rate >= 50 ? "om-pos" : ""}`}>{rate == null ? "—" : `${rate}%`}</span><span className="om-label">Win rate{decided ? ` · ${r.wins} of ${decided}` : ""}</span></div>
        <div className="om-stat"><span className="om-figure om-num">{r.wins}</span><span className="om-label">Won</span></div>
        <div className="om-stat"><span className="om-figure om-num">{r.losses}</span><span className="om-label">Lost</span></div>
        <div className="om-stat"><span className="om-figure om-num">{r.breakeven}</span><span className="om-label">Break-even</span></div>
        {r.ungraded > 0 && <div className="om-stat"><span className="om-figure om-num">{r.ungraded}</span><span className="om-label">No result recorded</span></div>}
      </div>
      <Bars rows={r.history ?? []} />
      <p className="om-label">A trade counts as won or lost by its recorded result in pips; break-even trades are not in the win rate.</p>
    </div>
  );
}

/** Each closed trade of the period as a bar, oldest on the left: above the line a gain, below it a loss. */
function Bars({ rows }: { rows: FlowClosed[] }) {
  const vals = rows.filter((h) => h.pips != null).map((h) => h.pips as number).reverse();
  if (vals.length < 2) return null;
  const n = vals.length, W = Math.max(n * 10, 120), H = 72, mid = H / 2;
  const max = Math.max(...vals.map((v) => Math.abs(v))) || 1;
  const bw = Math.max(2, Math.min(14, (W / n) * 0.62));
  return (
    <figure className="om-bars">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`The last ${n} closed trades in pips: ${vals.filter((v) => v > 0).length} gains, ${vals.filter((v) => v < 0).length} losses.`}>
        <line x1="0" x2={W} y1={mid} y2={mid} className="om-bars-zero" vectorEffect="non-scaling-stroke" />
        {vals.map((v, i) => {
          const h = Math.max(1.5, (Math.abs(v) / max) * (mid - 3));
          const x = (i + 0.5) * (W / n) - bw / 2;
          return <rect key={i} x={x} y={v >= 0 ? mid - h : mid} width={bw} height={h} rx="1.5" className={v > 0 ? "om-bars-up" : v < 0 ? "om-bars-down" : "om-bars-flat"} />;
        })}
      </svg>
      <figcaption className="om-faint">Each closed trade in this period, in pips — oldest on the left.</figcaption>
    </figure>
  );
}
