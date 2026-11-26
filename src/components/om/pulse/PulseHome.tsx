"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { TrendingDown, TrendingUp, ArrowUpRight, Check, ChevronDown, Copy, Loader2, Search, X } from "lucide-react";
import { TradeChat } from "@/components/portal/TradeChat";
import { openAtlas, type AtlasContext } from "@/lib/atlas/open";
import { CREDIT_COST } from "@/lib/creditConfig";
import { ageText } from "@/lib/floor/overview";
import { SCAN_FRESH_MS, categoryOf, scanMs, type PulseCategory } from "@/lib/pulse/scan";
import { priceFor } from "@/lib/flow/display";
import { playsHref } from "@/lib/plays/intent";
import { ProductIcon } from "@/components/om/ProductIcon";
import { MobileSection } from "@/components/om/MobileSection";
import { MarketStory } from "../simple/MarketStory";
import { useExperienceMode } from "@/components/om/experience";
import "./pulse-experience.css";

/**
 * MARKET PULSE, IN THE TRADING PLATFORM'S SHELL (owner 11-20 brief §13).
 *
 *   header   Market Pulse, one sentence, Scan markets with its cost, and when the list was scanned
 *   list     the scanner's ranking, as it made it: most confirmations first, one compact row a market
 *   detail   the selected market: where it leans, its confirmation breakdown, the scan's take-it-now levels,
 *            Copy trade, and the deeper actions with what they cost — the full play, a deep dive, Atlas
 *
 * MarketPulse's own state and handlers draw this. The scan is the member's tap, as it always was: opening
 * the page shows the last scan kept on this device, with its date and its age, and never scans.
 */

export type PulseSetup = {
  symbol: string; name: string; td: string; dir: "LONG" | "SHORT"; price: number; confirmed: number; total: number;
  checklist: { label: string; ok: boolean }[]; zone: "discount" | "premium"; rsi: number | null;
  entry?: number; stopLoss?: number; takeProfits?: number[]; riskReward?: string;
};

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const CATS: ("All" | PulseCategory)[] = ["All", "Forex", "Crypto", "Commodities", "Indices"];
const when = (ms: number) => { const d = new Date(ms); return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`; };
/** A price from the scan, to the market's own precision where this site knows the market. */
const pp = (s: { td: string }, v: number | null | undefined) => priceFor(s.td, v ?? null);
const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* clipboard blocked */ } };
const tradeText = (s: PulseSetup) =>
  `${s.symbol} ${s.dir}\nEntry: ${pp(s, s.entry)}\nStop: ${pp(s, s.stopLoss)}\n${(s.takeProfits ?? []).map((t, i) => `TP${i + 1}: ${pp(s, t)}`).join("\n")}${s.riskReward ? `\nR:R ${s.riskReward}` : ""}\n(Market Pulse — educational, not financial advice)`;

export function PulseHome({ setups, loading, asOf, msg, hydrated, scan, onDeepDive }: {
  setups: PulseSetup[]; loading: boolean; asOf: string; msg: string; hydrated: boolean;
  scan: () => void; onDeepDive: (s: PulseSetup) => void;
}) {
  const { isSimple } = useExperienceMode();
  const [now, setNow] = useState(0);
  const [cat, setCat] = useState<"All" | PulseCategory>("All");
  const [sel, setSel] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const at = scanMs(asOf);
  const old = at != null && now > 0 && now - at > SCAN_FRESH_MS;
  const present = useMemo(() => new Set(setups.map((s) => categoryOf(s.td))), [setups]);
  // The scanner's own order is kept; a filter only hides rows, and every row keeps its rank in the whole scan.
  const ranked = useMemo(() => setups.map((s, i) => ({ s, rank: i + 1 })), [setups]);
  const rows = ranked.filter((r) => cat === "All" || categoryOf(r.s.td) === cat);
  const current = rows.find((r) => r.s.td === sel) ?? rows[0] ?? null;
  useEffect(() => { if (cat !== "All" && !present.has(cat)) setCat("All"); }, [cat, present]);

  const pick = (td: string) => {
    setSel(td);
    setDetailOpen(true);
    // A narrow screen has the detail under the list: take the member to it.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 980px)").matches) setTimeout(() => detailRef.current?.scrollIntoView({ block: "start" }), 0);
  };

  return (
    <div className="om-ws om-pulsews om-os-product om-tool-mobile" data-experience={isSimple ? "simple" : "advanced"}>
      <header className="om-ws-head om-product-header">
        <div className="om-product-heading">
          <ProductIcon kind="pulse" size="lg" />
          <div className="om-product-copy">
            {!isSimple && <p className="om-product-kicker">Market discovery</p>}
            <h1 className="om-title">Market Pulse</h1>
            <p className="om-sub">{isSimple ? "Multi-market setup scanner" : "Find a market worth a closer look, then take it into OM AI Plays."}</p>
          </div>
        </div>
        <div className="om-pulse-go">
          <button type="button" className="om-btn" onClick={scan} disabled={loading}>
            {loading && <Loader2 className="animate-spin" aria-hidden="true" />}{loading ? "Scanning…" : "Scan markets"}
          </button>
          <p className="om-label">{CREDIT_COST.scan} credits a scan{at ? <> · {isSimple && now ? "Scanned " + ageText(new Date(at).toISOString(), now) : "Last scan " + when(at)}</> : !isSimple && " · no scan on this device yet"}</p>
        </div>
      </header>

      {msg && <p className="om-flow-err" role="alert">{msg}{setups.length && at ? ` The list below is still the scan from ${when(at)}.` : ""}</p>}
      {old && !loading && (
        <p className="om-pulse-old" role="status"><b>An earlier scan · {when(at!)}</b> <span className="om-label">{isSimple ? "Scan again for current conditions." : <> {ageText(new Date(at!).toISOString(), now)}. It shows the markets as they were then, not what is tradable now. Scan markets for now.</>}</span></p>
      )}

      {hydrated && !loading && setups.length === 0 ? (
        <div className="om-panel om-state">
          <Search aria-hidden="true" />
          <p>No scan yet</p>
          <span className="om-label">{isSimple ? "Scan to find markets worth watching." : <>Scan markets ranks the markets it covers. It costs {CREDIT_COST.scan} credits.</>}</span>
        </div>
      ) : (
        <div className="om-pulse-grid">
          <section className="om-panel om-pulse-listwrap" aria-label="Ranked markets">
            <div className="om-product-section-head">
              <h2>Choose a market</h2>
              <p className="om-label">{isSimple ? "Ranked by how many checks line up." : "Select a row to see the scan’s confirmations and levels."}</p>
            </div>
            {present.size > 1 && (
              <div className="om-toggles" role="group" aria-label="Show">
                {CATS.filter((c) => c === "All" || present.has(c)).map((c) => <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}
              </div>
            )}
            {loading && setups.length === 0 ? <div className="om-flow-skel-rows"><span className="om-skel" style={{ width: "100%", height: 18 }} /><span className="om-skel" style={{ width: "100%", height: 18 }} /><span className="om-skel" style={{ width: "70%", height: 18 }} /></div> : (
              <>
              <ul className="om-pulse-mobile-markets" aria-label="Markets ranked by confirmations">
                {rows.map(({ s, rank }) => (
                  <li key={s.td}>
                    <button type="button" onClick={() => pick(s.td)} aria-pressed={(isSimple || detailOpen) && current?.s.td === s.td} data-no-i18n translate="no">
                      <span className="om-pulse-mobile-rank">{isSimple ? s.dir === "LONG" ? <TrendingUp aria-label="Upward lean"/> : <TrendingDown aria-label="Downward lean"/> : String(rank).padStart(2, "0")}</span>
                      <span className="om-pulse-mobile-name"><b>{s.name}</b><small>{s.symbol}</small></span>
                      <span className="om-pulse-mobile-lean" data-side={s.dir}><b>{isSimple ? s.dir === "LONG" ? "Leans up" : "Leans down" : s.dir === "LONG" ? "Long" : "Short"}</b><small>{isSimple ? s.total > 0 && <meter min={0} max={s.total} value={s.confirmed} aria-label={s.confirmed + " of " + s.total + " checks lined up"}/> : <>{s.confirmed} of {s.total}</>}</small></span>
                      <ArrowUpRight width={16} height={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <table className="om-table om-pulse-table">
                <thead><tr><th scope="col" className="om-r">#</th><th scope="col">Market</th><th scope="col">Leans</th><th scope="col" className="om-r">Confirmations</th><th scope="col" className="om-r">Price</th></tr></thead>
                <tbody>
                  {rows.map(({ s, rank }) => (
                    <tr key={s.td} data-current={current?.s.td === s.td ? "" : undefined}>
                      <td className="om-r om-faint om-num om-pulse-rank">{rank}</td>
                      <td className="om-lead"><button type="button" className="om-pulse-pick" onClick={() => pick(s.td)} aria-pressed={current?.s.td === s.td} data-no-i18n translate="no"><b>{s.symbol}</b><small>{s.name}</small></button></td>
                      <td data-label="Leans">{s.dir === "LONG" ? "Long" : "Short"}</td>
                      <td data-label="Confirmations" className="om-r om-num"><span className="om-pulse-meter" aria-hidden="true"><span style={{ width: `${Math.round((s.confirmed / Math.max(1, s.total)) * 100)}%` }} /></span>{s.confirmed} of {s.total}</td>
                      <td data-label="Price" className="om-r om-num" data-no-i18n translate="no">{pp(s, s.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </>
            )}
            <details className="om-pulse-method"><summary>How ranking works</summary><p className="om-faint om-flow-small">Ranked by the scan: the more of its confirmations line up, the higher a market sits. A lean is not a trade.</p></details>
          </section>

          <section ref={detailRef} className="om-pulse-detail-wrap" aria-label="Selected market">
          <MobileSection title={current?.s.symbol ?? "Market details"} meta="View setup" expanded={isSimple || detailOpen} onExpanded={setDetailOpen}>
          <div className="om-panel om-pulse-detail">
            {current ? <Detail s={current.s} rank={current.rank} of={setups.length} scanAt={at} onDeepDive={onDeepDive}
              isSimple={isSimple} stale={old || !!msg || at === null} /> : <p className="om-empty">Nothing in this group in the last scan.</p>}
          </div>
          </MobileSection>
          </section>
        </div>
      )}
    </div>
  );
}

function Detail({ s, rank, of, scanAt, onDeepDive, isSimple, stale }: { s: PulseSetup; rank: number; of: number; scanAt: number | null; onDeepDive: (s: PulseSetup) => void; isSimple: boolean; stale: boolean }) {
  const [copied, setCopied] = useState(false);
  const [chat, setChat] = useState(false);
  useEffect(() => { setCopied(false); setChat(false); }, [s.td]);
  const levels = fin(s.entry) && fin(s.stopLoss);
  const context: AtlasContext = {
    source: "pulse", label: `${s.symbol} · Pulse scan`,
    data: { td: s.td, symbol: s.symbol, style: "intraday", asOf: scanAt ? new Date(scanAt).toISOString() : null, rank, of, direction: s.dir, confirmations: s.confirmed, total: s.total, checklist: s.checklist, price: s.price, entry: s.entry, stopLoss: s.stopLoss, takeProfits: s.takeProfits, riskReward: s.riskReward, confirmedSetup: false },
  };
  const LevelSection = isSimple ? "details" : "div";
  const ask = () => openAtlas({ question: `Explain ${s.symbol} from this Pulse scan and what needs confirmation before I consider a trade.`, context });
  return (
    <div className="om-pulse-d">
      <div className="om-pulse-d-head">
        <div style={{ minWidth: 0 }}>
          {!isSimple && <p className="om-label">#{rank} of {of} · {categoryOf(s.td)}{scanAt ? ` · scanned ${when(scanAt)}` : ""}</p>}
          <h2 data-no-i18n translate="no">{s.symbol} <span className="om-faint">{s.name}</span></h2>
        </div>
        {!isSimple && <span className="om-chip">{s.dir === "LONG" ? "Leans long" : "Leans short"}</span>}
      </div>
      {isSimple ? <MarketStory market={s.name || s.symbol} direction={s.dir === "LONG" ? "up" : "down"} lean
        stage="forming" feed={stale ? "delayed" : "recorded"} stamp={scanAt ? "Scan · " + when(scanAt) : "Scan time unavailable"}
        next="Open OM AI Plays to check for an entry." pausedNext="Run a new scan before making a plan."/> : <dl className="om-kv" data-no-i18n translate="no">
        <div><dt>Confirmations</dt><dd className="om-num">{s.confirmed} of {s.total}</dd></div>
        <div><dt>Price at the scan</dt><dd className="om-num">{pp(s, s.price)}</dd></div>
        <div><dt>Where price sits</dt><dd>{s.zone === "discount" ? "Discount (lower half of its range)" : "Premium (upper half of its range)"}</dd></div>
        {s.rsi != null && <div><dt>RSI</dt><dd className="om-num">{s.rsi}</dd></div>}
      </dl>}

      {!isSimple && <MobileSection title="Confirmations" meta={`${s.confirmed} of ${s.total}`}>
      <div>
        <p className="om-label om-pulse-sub">The confirmations</p>
        <ul className="om-pulse-checks">
          {s.checklist.map((c, i) => <li key={i} data-ok={c.ok ? "true" : "false"}>{c.ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}<span>{c.label}</span><span className="om-sr">{c.ok ? " — lined up" : " — not lined up"}</span></li>)}
        </ul>
      </div>
      </MobileSection>}

      {levels && (
        <LevelSection className={isSimple ? "om-pulse-levels om-simple-fold" : "om-pulse-levels"}>
          {isSimple && <summary>Reference prices</summary>}
          <p className="om-label om-pulse-sub">Levels from the scan{s.riskReward ? ` · R:R ${s.riskReward}` : ""}</p>
          <dl className="om-levels" data-no-i18n translate="no">
            <div><dt>Entry</dt><dd className="om-num">{pp(s, s.entry)}</dd></div>
            <div><dt>Stop</dt><dd className="om-num om-neg">{pp(s, s.stopLoss)}</dd></div>
            <div><dt>Target 1</dt><dd className="om-num om-pos">{pp(s, s.takeProfits?.[0])}</dd></div>
          </dl>
          {(s.takeProfits?.length ?? 0) > 1 && <p className="om-label om-num" data-no-i18n translate="no">Then {(s.takeProfits ?? []).slice(1, 3).map((t, i) => `target ${i + 2} ${pp(s, t)}`).join(" · ")}</p>}
          <p className="om-faint om-flow-small">{isSimple ? "Reference prices from this scan. The stop marks where the idea fails. Not a confirmed setup."
            : "A take-it-now read at the scan’s price: the stop sits beyond the swing that cancels the idea, the targets are a plain R ladder. Not a confirmed setup."}</p>
          <button type="button" className="om-btn-quiet" onClick={() => { copy(tradeText(s)); setCopied(true); setTimeout(() => setCopied(false), 1400); }}><Copy aria-hidden="true" width={14} height={14} />{copied ? "Copied" : "Copy trade"}</button>
        </LevelSection>
      )}
      {!levels && <p className="om-play-note" role="status">This scan did not provide usable entry and stop levels. Open a full play for a new market read.</p>}

      {/* Atlas keeps this market attached to the conversation. Only its priced Generate action makes a play. */}
      <div className="om-pulse-next">
        {!isSimple && <div className="om-product-handoff">
          <ProductIcon kind="plays" size="sm" />
          <div>
            <h3>Build the full play</h3>
            <p className="om-label">Take <span data-no-i18n translate="no">{s.symbol}</span> from discovery to a complete setup with Atlas.</p>
          </div>
        </div>}
        <div className="om-pulse-acts">
          <button type="button" className="om-btn" onClick={() => openAtlas({ tool: "plays", context })}>{isSimple ? "Build with Atlas" : "Build the full play with Atlas"}</button>
          <Link href={playsHref(s.td, "intraday")} className="om-btn-quiet">Open in OM AI Plays</Link>
          {!isSimple && <button type="button" className="om-btn-quiet" onClick={() => onDeepDive(s)}>Deep dive · {CREDIT_COST.deepdive} credit{CREDIT_COST.deepdive === 1 ? "" : "s"}</button>}
          <button type="button" className="om-btn-quiet" onClick={ask}>Ask Atlas<ArrowUpRight aria-hidden="true" width={14} height={14} /></button>
        </div>
        <p className="om-faint om-flow-small">{isSimple ? <>Generating a play costs {CREDIT_COST.signal} credits or is included with the FLOW Pass.</> : <>Review the market and style with Atlas, then generate for {CREDIT_COST.signal} credits, included with the FLOW Pass. The signal and its execution ticket stay in your conversation.</>}</p>
      </div>

      {!isSimple && levels && (
        <div>
          <button type="button" className="om-disclose" aria-expanded={chat} onClick={() => setChat((c) => !c)}>
            <span className="om-label">Ask about this trade</span><ChevronDown aria-hidden="true" />
          </button>
          {chat && <TradeChat trade={{ td: s.td, symbol: s.symbol, direction: s.dir, entry: s.entry as number, stopLoss: s.stopLoss as number, takeProfits: (s.takeProfits ?? []).filter(fin), style: "intraday" }} creditCost={CREDIT_COST.signal} />}
        </div>
      )}
    </div>
  );
}
