"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, Eye, EyeOff, Info, Mic, Send, Sparkles } from "lucide-react";
import { OmChart } from "@/components/om/chart/OmChart";
import { ProductIcon } from "@/components/om/ProductIcon";
import { useFlowAccount } from "@/components/om/FlowAccount";
import { ActiveTrades } from "./ActiveTrades";
import { WinStreaks } from "./WinStreaks";
import { WinningPipsPanel } from "./WinningPipsPanel";
import { AtlasLiveDesk } from "./AtlasLiveDesk";
import { NitrousAccountSummary } from "@/components/om/nitrous/NitrousAccountSummary";
import { timedBars } from "@/lib/chart/candleTime";
import { useSeeThePlay } from "@/components/portal/SetupLock";
import { openAtlas, type AtlasContext } from "@/lib/atlas/open";
import { FLOOR_INSTRUMENTS, setupQuery, type FloorMode } from "@/lib/floor/setupInstruments";
import { minutesLeft, type SetupGate } from "@/lib/setupLock";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { realCandles, priceText } from "@/lib/floor/chart";
import {
  FLOOR_PERIODS, STAGE_LABEL, stageSentence, setupView, ageText, money, pipsText, toneOf, periodOf,
  type FloorOverview, type FloorPeriod, type FloorAccount, type AccountFigures, type GenxResults, type FlowResults, type SetupView,
} from "@/lib/floor/overview";
import "./om-os-performance.css";
import { useExperienceMode } from "@/components/om/experience";

/**
 * THE FLOOR — the selected account, its live positions, current winning runs, and gold with Atlas.
 *
 * WHERE EVERYTHING COMES FROM. Nothing on this screen is written here:
 *   /api/floor/overview  the member's accounts, the broker's figures, the desk record, their FLOW results,
 *                        and whether their Command Center window is open
 *   /api/floor/setup     gold's candles, price and GENX's read — or, while the member's window on the play
 *                        is closed, only how far along the setup is (the server withholds the rest)
 *   /api/floor/ticker    the other markets' quotes
 *   /api/floor/active-trades  the selected account's broker positions and reviewed management actions
 *   /api/floor/win-streaks    the account's FLOW run and the community's GENX callout run
 *   /api/floor/winning-pips  gross positive winning pips in independent FLOW and GENX sources
 * LOADING, NOTHING, ZERO AND UNAVAILABLE ARE FOUR DIFFERENT THINGS and are shown as four: a grey bar while
 * an answer is on its way, plain words when there is nothing (no account connected, no trades in the
 * period), a real 0 only when the answer was zero, and an em dash with the reason when a number could not
 * be read. Nothing here opens a "connect your account" prompt on its own.
 *
 * WHAT IT CAN CHARGE. "See the play" opens the existing setup window at its stated price. Opening the
 * page, changing the timeframe, period or account, and opening Atlas do not generate a signal. Atlas
 * stays over this screen and shows the existing chat, voice and signal costs in its own conversation.
 *
 * CHOOSING AN ACCOUNT TO LOOK AT changes what this screen shows and nothing else. The figures and results
 * of the account that was showing are cleared the moment another is chosen, and an answer that arrives
 * for the earlier choice is dropped — so one account's money never appears under another's name.
 */
export type SetupAnswer = {
  g?: unknown; locked?: { stage?: string } | null; candles?: unknown; price?: unknown; asOf?: unknown;
  setups?: SetupGate | null; error?: string;
  /** "UTC" when the candles' stamps are UTC (the route says so); otherwise they are the feed's own clock. */
  candlesTz?: unknown;
};
export type Tick = { label: string; price: number; percent: number | null; dp: number };
/** Fixed, labelled sample content for the review route. Never mixed with a member's data. */
export type FloorSample = {
  overview: FloorOverview; setup: SetupAnswer; ticks: Tick[]; nowMs: number;
  /**
   * What the screen's own choices lead to on the review route, so a click there answers the way the product
   * does: the other timeframes, the other periods, the other account. All of it is the same labelled sample.
   */
  setups?: Partial<Record<FloorMode, SetupAnswer>>;
  /** What "See the play" shows there, where the sample starts with the play withheld. Nothing is charged: there is no member. */
  opened?: Partial<Record<FloorMode, SetupAnswer>>;
  genx?: Partial<Record<FloorPeriod, GenxResults>>;
  accounts?: Record<string, { figures: AccountFigures | null; flow: Partial<Record<FloorPeriod, FlowResults>> }>;
};

const GOLD = FLOOR_INSTRUMENTS[0];
const TFS: { mode: FloorMode; tf: string; name: string }[] = [
  { mode: "quick", tf: "5m", name: "Quick" },
  { mode: "intraday", tf: "15m", name: "Intraday" },
  { mode: "swing", tf: "1h", name: "Swing" },
];
const SETUP_EVERY_MS = 20_000, OVERVIEW_EVERY_MS = 60_000, TICKER_EVERY_MS = 45_000;
const TF_MS: Record<FloorMode, number> = { quick: 5 * 60_000, intraday: 15 * 60_000, swing: 60 * 60_000 };
/** Gold's calendar, for the chart's "market closed" shading — the same rule as the "gold is closed" line. */
const goldOpen = (t: number) => isOpen("metal", t);

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* a private window: the choice lasts for the visit */ } },
};

/** Carry only the gold read the member can already see; locked levels are never handed to Atlas. */
function floorAtlasContext(setup: SetupAnswer | null, view: SetupView, tf: FloorMode, now: number): AtlasContext {
  return {
    source: "floor", label: `Gold · ${TFS.find((t) => t.mode === tf)!.name}`,
    data: {
      td: "XAU/USD", symbol: "XAUUSD", mode: tf, style: tf === "quick" ? "scalp" : tf,
      asOf: typeof setup?.asOf === "string" ? setup.asOf : null,
      marketClosed: now > 0 ? !goldOpen(now) : null, stage: view.stage,
      price: typeof setup?.price === "number" ? setup.price : null,
      ...(view.open ? { levels: view.levels, entryZone: view.zone, waitingFor: view.waitingFor, invalidation: view.changesIf } : { levelsLocked: true }),
    },
  };
}

export const Skel = ({ w, h = "1em" }: { w: number | string; h?: number | string }) => <span className="om-skel" style={{ width: w, height: h }} aria-hidden="true">&nbsp;</span>;
const Go = ({ href, children }: { href: string; children: React.ReactNode }) => <Link href={href} className="om-go">{children}<ArrowUpRight aria-hidden="true" /></Link>;
const clock = (iso: unknown): string | null => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : null;
};

export function PeriodSelect({ value, onChange, label }: { value: FloorPeriod; onChange: (p: FloorPeriod) => void; label: string }) {
  return (
    <span className="om-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(periodOf(e.target.value, value))}>
        {FLOOR_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

/* ── the selected account ─────────────────────────────────────────────────────────────────────── */

/** Which account the screen shows. It lists the member's own accounts; choosing one changes the view and nothing else. */
function AccountPicker({ accounts, current, onPick }: { accounts: FloorAccount[]; current: FloorAccount; onPick: (a: FloorAccount) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  if (accounts.length < 2) return <span className="om-acct-name" data-no-i18n translate="no">{current.name}</span>;
  const key = (a: FloorAccount) => `${a.environment}:${a.id}`;
  return (
    <div ref={box} style={{ position: "relative", minWidth: 0 }}>
      <button type="button" className="om-acct-pick" aria-haspopup="listbox" aria-expanded={open} aria-label={`Account shown: ${current.name}. Change account`} onClick={() => setOpen((o) => !o)}>
        <span data-no-i18n translate="no">{current.name}</span><ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="om-menu om-acct-menu" role="listbox" aria-label="Account shown">
          {accounts.map((x) => (
            <button key={key(x)} type="button" role="option" aria-selected={key(x) === key(current)} onClick={() => { setOpen(false); if (key(x) !== key(current)) onPick(x); }}>
              <span style={{ flex: "1 1 auto", minWidth: 0 }} data-no-i18n translate="no">{x.name}<small>{x.broker} {x.masked}{x.connection === "attention" ? " · needs reconnecting" : ""}</small></span>
              <span className="om-chip">{x.environment === "live" ? "Live" : "Demo"}</span>
            </button>
          ))}
          <p className="om-menu-note">Choosing an account here changes what you see. It does not change what any account trades.</p>
        </div>
      )}
    </div>
  );
}

export function AccountSummary({ ov, state, switching, hide, onHide, onPick, now }: {
  ov: FloorOverview | null; state: "loading" | "ready" | "error" | "off"; switching: boolean;
  hide: boolean; onHide: () => void; onPick: (a: FloorAccount) => void; now: number;
}) {
  if (!ov) {
    if (state === "loading") return <div className="om-panel om-acct" aria-busy="true"><div><Skel w={190} h={22} /><Skel w={92} h={22} /></div><span className="om-rule" /><div><span className="om-label">Balance</span><Skel w={132} h={26} /></div><span className="om-rule" /><div><span className="om-label">Equity</span><Skel w={132} h={26} /></div></div>;
    return <div className="om-panel om-acct"><div><span>Account figures are not available right now.</span><span className="om-label">The rest of OM OS is unaffected.</span></div></div>;
  }
  if (!ov.accountsKnown) return <div className="om-panel om-acct"><div><span>Your accounts could not be loaded just now.</span><span className="om-label">This will try again on its own.</span></div></div>;
  const a = ov.account;
  if (!a) {
    return (
      <div className="om-panel om-acct">
        <div><span style={{ fontSize: 19 }}>No account connected</span><span className="om-label">Balance, Equity and your FLOW results appear here once a broker account is connected.</span></div>
        <span className="om-rule" />
        <div><Link href="/portal/trading?view=flow" className="om-btn-quiet">Manage accounts<ArrowUpRight width={14} height={14} aria-hidden="true" /></Link></div>
      </div>
    );
  }
  const f: AccountFigures | null = switching ? null : ov.figures;
  // Grey bars mean "on its way". Once an answer has come back without figures, it says so instead.
  const pending = switching || (state === "loading");
  const cur = a.currency;
  const fig = (v: number | null | undefined) => (hide ? "••••••" : money(v ?? null, cur));
  // A reading that is no longer current is drawn quieter, as well as dated: it cannot pass for the present.
  const stale = !!f && f.state !== "live" ? true : undefined;
  let tone: "ok" | "warn" | "off" = "warn", meta = pending ? "Reading your broker…" : "Not available right now";
  if (a.connection === "attention") { tone = "off"; meta = "Needs reconnecting in FLOW"; }
  else if (f?.state === "live") { tone = "ok"; meta = `Connected · updated ${ageText(f.at, now)}`; }
  else if (f?.reading) meta = f.at ? `Reading your broker · last reading ${ageText(f.at, now)}` : "Reading your broker…";
  else if (f?.state === "last_known") meta = f.at ? `Last reading ${ageText(f.at, now)}` : (f.note ?? "An earlier balance");
  else if (f) meta = f.note ?? "Not available right now";
  return (
    <div className="om-panel om-acct">
      <div>
        <AccountPicker accounts={ov.accounts} current={a} onPick={onPick} />
        <span className="om-acct-meta">
          <span className="om-chip">{a.environment === "live" ? "Live" : "Demo"}{cur ? ` · ${cur}` : ""}</span>
          <span data-no-i18n translate="no">{a.broker} {a.masked}</span>
        </span>
        <span className="om-acct-meta" title={f?.note ?? undefined} data-no-i18n translate="no"><span className="om-dot" data-tone={tone} />{meta}</span>
      </div>
      <span className="om-rule" />
      <div>
        <span className="om-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Balance
          <button type="button" className="om-icon-btn" onClick={onHide} aria-pressed={hide} aria-label={hide ? "Show amounts" : "Hide amounts"} title={hide ? "Show amounts" : "Hide amounts"} style={{ margin: "-8px 0" }}>
            {hide ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </span>
        <span className="om-figure om-num" data-stale={stale} data-no-i18n translate="no">{f ? fig(f.balance) : pending ? <Skel w={132} h={26} /> : "—"}</span>
      </div>
      <span className="om-rule" />
      <div>
        <span className="om-label">Equity</span>
        <span className="om-figure om-num" data-stale={stale} data-no-i18n translate="no" title={f && f.equity == null ? (f.note ?? "Your broker has not reported equity for this account.") : undefined}>{f ? fig(f.equity) : pending ? <Skel w={132} h={26} /> : "—"}</span>
      </div>
    </div>
  );
}

/* ── gold, with GENX's state ──────────────────────────────────────────────────────────────────── */

/**
 * The chart, with what GENX makes of it beside it: the state, what it is waiting for, what would change
 * that, and the one next step. One action per state — the play when it is withheld, otherwise the way
 * into GENX's own workspace, where its tickets live.
 */
function ChartCard({ setup, failed, tf, onTf, change, onOpened, now, sample, onSamplePlay, layers, onLayer }: {
  setup: SetupAnswer | null; failed: boolean; tf: FloorMode; onTf: (m: FloorMode) => void; change: number | null;
  onOpened: () => void; now: number; sample: boolean;
  layers: { levels: boolean; setup: boolean }; onLayer: (layer: "levels" | "setup") => void;
  /** The review route only: shows the sample's opened play. It asks the server for nothing and charges nothing. */
  onSamplePlay?: () => void;
}) {
  const view = useMemo(() => setupView(setup), [setup]);
  const tb = useMemo(() => timedBars(setup?.candles, setup?.candlesTz), [setup]);
  const candles = tb.bars;
  const price = typeof setup?.price === "number" && Number.isFinite(setup.price) ? setup.price : candles.length ? candles[candles.length - 1].c : null;
  const horizon = TFS.find((t) => t.mode === tf)!;
  const gate = setup?.setups ?? null;
  const locked = !!setup && !view.open && view.stage != null;
  const play = useSeeThePlay(onOpened);
  const left = minutesLeft(gate, now);
  const at = clock(setup?.asOf);
  const px = (p: number) => priceText(p, GOLD.dec);
  // Gold does not trade from Friday evening to Sunday evening or in its daily break. The last price is
  // then the last price, and is said to be — never dated as if it had just been made.
  const shut = now > 0 && !isOpen("metal", now);
  const asOfMs = Date.parse(String(setup?.asOf ?? ""));
  // The price tag is drawn as moving only while gold trades and the quote is recent.
  const quoteLive = !sample && !shut && Number.isFinite(asOfMs) && now - asOfMs < 120_000;
  // The engine's sentences are shown as it wrote them, under a label; only the first letter is raised.
  const own = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const hasLevels = view.levels.some((l) => l.kind === "support" || l.kind === "resistance");
  const hasSetup = !!view.zone || view.levels.some((l) => l.kind === "entry" || l.kind === "stop" || l.kind === "target");
  const visibleLevels = view.levels.filter((l) => l.kind === "support" || l.kind === "resistance" ? layers.levels : layers.setup);

  return (
    <section id="floor-gold-chart" className="om-panel om-chart-card" aria-label="Gold">
      <div className="om-chart-top">
        <div style={{ minWidth: 0 }}>
          <div className="om-os-instrument">
            <span className="om-os-gold-coin" aria-hidden="true">Au</span>
            <div><h2>Gold</h2><span className="om-label" data-no-i18n translate="no">XAU/USD · {horizon.name}</span></div>
          </div>
          <div className="om-quote" data-no-i18n translate="no">
            <span className="om-px om-num">{price != null ? px(price) : setup || failed ? "—" : <Skel w={150} h={30} />}</span>
            {change != null && price != null && <span className={`om-chg om-num ${change > 0 ? "om-pos" : change < 0 ? "om-neg" : "om-dim"}`} title="Change since the previous daily close">{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change).toFixed(2)}%</span>}
          </div>
        </div>
        <div className="om-os-chart-controls">
          <div className="om-tf" role="group" aria-label="Candle timeframe">
            {TFS.map((t) => <button key={t.mode} type="button" aria-pressed={t.mode === tf} title={`${t.name} setup · ${t.tf} candles`} onClick={() => onTf(t.mode)}>{t.tf}</button>)}
          </div>
          <span className="om-label om-fresh" data-no-i18n translate="no"
            title={sample ? "Illustrative sample data" : at ? `${shut ? "Twelve Data · gold is closed · this is the last price before the close" : `Twelve Data · checked every ${SETUP_EVERY_MS / 1000} seconds`} · as of ${at}` : undefined}>
            {sample ? "Sample session" : at ? `${shut ? "Market closed · " : ""}${at}` : failed ? "Feed unavailable" : "Reading market data…"}
          </span>
        </div>
      </div>

      <div className="om-os-chart-layers" role="group" aria-label="Chart overlays">
        <button type="button" aria-pressed={layers.levels} disabled={!hasLevels} onClick={() => onLayer("levels")} title={hasLevels ? "Show or hide GENX support and resistance" : "Levels appear when the GENX read is open"}>Levels</button>
        <button type="button" aria-pressed={layers.setup} disabled={!hasSetup} onClick={() => onLayer("setup")} title={hasSetup ? "Show or hide GENX entry, stop and target" : "A confirmed or forming GENX setup supplies these levels"}>Setup</button>
        <span className="om-label">GENX · {horizon.name}</span>
      </div>
      <div className="om-chart-body">
        <div className="om-chart" data-no-i18n translate="no">
          {candles.length >= 2
            ? <OmChart bars={candles} timeKnown={tb.known} tfMs={TF_MS[tf]} tfLabel={horizon.tf} price={price} priceLive={quoteLive} dec={GOLD.dec}
                levels={visibleLevels} zone={layers.setup ? view.zone : null} isOpenAt={goldOpen} viewKey={`XAUUSD:${tf}`}
                label={`Gold, ${horizon.tf} candles${price != null ? `, last price ${px(price)}` : ""}`} />
            : <div className="om-chart-note">{!setup && !failed ? "Loading the chart…" : "The chart could not be loaded just now. It will try again on its own."}</div>}
        </div>
        <div className="om-os-chart-foot">
          <span>Drag to explore <span aria-hidden="true">·</span> Scroll or pinch to zoom</span>
          <button type="button" onClick={() => { if (!sample) openAtlas({ question: `Explain the gold chart and GENX's ${horizon.name.toLowerCase()} setup shown here.`, context: floorAtlasContext(setup, view, tf, now) }); }} disabled={sample}>Explain with Atlas<ArrowUpRight aria-hidden="true" /></button>
        </div>

        <div className="om-read">
          <div className="om-read-main">
            <div className="om-os-engine-state"><ProductIcon kind="genx" size="sm" /><div><p className="om-label">GENX</p><p className="om-read-state">
                <span className="om-ring" data-stage={view.stage ?? undefined} aria-hidden="true" />
                {view.stage ? STAGE_LABEL[view.stage] : !setup && !failed ? <Skel w={150} h={18} /> : "Not available right now"}
              </p></div></div>
            {view.stage && <p className="om-read-says">{stageSentence(view.stage, GOLD.engine, GOLD.name)}{shut && view.stage === "live" ? " Gold is closed now, so it cannot be entered." : ""}</p>}
            {view.open && (view.waitingFor || view.changesIf) && <details className="om-os-setup-details">
              <summary>Setup conditions<ChevronDown aria-hidden="true" /></summary>
              {view.waitingFor && <p className="om-read-line"><span className="om-faint">Trigger</span><span>{own(view.waitingFor)}</span></p>}
              {view.changesIf && <p className="om-read-line"><span className="om-faint">Invalidation</span><span>{own(view.changesIf)}</span></p>}
            </details>}
            {locked && <p className="om-read-says">Open the entry, stop and targets with credits.</p>}
            {play.err && <p className="om-neg om-read-says" role="alert">{play.err}</p>}
          </div>
          <div className="om-read-act">
            {left != null && <span className="om-label" title="Your window on the live setups">Open · {left} min left</span>}
            {locked ? (
              <button type="button" className="om-btn" onClick={() => { if (sample) onSamplePlay?.(); else void play.open(); }} disabled={play.phase !== "idle" || (sample && !onSamplePlay)} aria-busy={play.phase !== "idle"}
                title={gate ? `Opens every live setup on the site for ${gate.minutes} minutes` : undefined}>
                {play.phase === "busy" ? "Opening…" : play.phase === "opened" ? "Open — loading the play…" : gate ? `See the play · ${gate.cost} credits` : "See the play"}
              </button>
            ) : (
              <Link href="/portal/genx" className={view.stage === "live" ? "om-btn" : "om-btn-quiet"}>Open GENX<ArrowUpRight width={15} height={15} aria-hidden="true" /></Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Atlas ────────────────────────────────────────────────────────────────────────────────────── */

function AtlasPanel({ atlas, view, setup, tf, sample, now, onShowLevels }: {
  atlas: FloorOverview["atlas"]; view: SetupView; setup: SetupAnswer | null; tf: FloorMode;
  sample: boolean; now: number; onShowLevels: () => void;
}) {
  const [q, setQ] = useState("");
  const context = floorAtlasContext(setup, view, tf, now);
  const go = (question?: string, voice = false) => { if (!sample) openAtlas({ question, voice, context }); };
  const stage = view.stage;
  // What Atlas says here is either its own newest read (while the member's window is open) or the one
  // thing every member may know — how far along GENX's setup is. It never describes the market otherwise.
  const read = atlas?.read?.summary?.trim();
  const say = read
    ?? (stage === "live" ? "GENX has a confirmed entry on gold. Ask me to walk you through it."
      : stage === "forming" ? "A gold setup is forming. I'm watching for confirmation."
        : stage === "watching" ? "No confirmed entry on gold right now. I'm watching for a trigger."
          : "Ask me about gold, a setup, or how your account is doing.");
  // A concise lead may be lifted verbatim from Atlas's own read. No market thesis is fabricated here.
  const firstSentence = read?.match(/^(.{1,110}?[.!?])(?:\s|$)/)?.[1] ?? null;
  const shut = now > 0 && !isOpen("metal", now);
  const headline = firstSentence ?? (read ? "Your latest gold read." : shut ? "Gold is between sessions." : stage === "live" ? "A gold setup is ready." : stage === "forming" ? "Waiting for confirmation." : "Your next move starts here.");
  const explanation = firstSentence ? read!.slice(firstSentence.length).trim() : say;
  const g = view.open && setup?.g && typeof setup.g === "object" ? setup.g as Record<string, unknown> : null;
  const field = (key: string) => typeof g?.[key] === "string" && String(g[key]).trim() ? String(g[key]).trim().replace(/_/g, " ") : null;
  const direction = field("directional_bias") ?? field("market_structure");
  const momentum = field("momentum");
  const entry = view.levels.find((l) => l.kind === "entry");
  const watchLabel = view.zone ? "GENX entry zone" : entry ? "GENX entry" : null;
  const watchValue = view.zone ? `${priceText(view.zone.low, GOLD.dec)} – ${priceText(view.zone.high, GOLD.dec)}` : entry ? priceText(entry.price, GOLD.dec) : null;
  return (
    <section className="om-panel om-panel-atlas om-atlas" aria-label="Atlas">
      <div className="om-atlas-head">
        <ProductIcon kind="atlas" size="md" />
        <div style={{ minWidth: 0 }}>
          <h2>Atlas</h2>
          <p className="om-label">Your AI trading partner</p>
        </div>
        {sample ? <button type="button" className="om-os-atlas-open" disabled>Gold Command Center<ArrowUpRight aria-hidden="true" /></button>
          : <a className="om-os-atlas-open" href="/command-center">Gold Command Center<ArrowUpRight aria-hidden="true" /></a>}
      </div>
      <div className="om-os-atlas-story">
        <h3>{headline}</h3>
        {explanation && <p className="om-atlas-say">{explanation}</p>}
        {atlas?.read && <span className="om-label om-os-atlas-age">Atlas read · {ageText(atlas.read.at, now)}</span>}
      </div>
      <div className="om-os-market-readings" aria-label="GENX context">
        <div><span className="om-label">{direction ? "GENX direction" : "Market"}</span><strong>{direction ?? (shut ? "Closed" : "Gold")}</strong></div>
        <div><span className="om-label">{momentum ? "Momentum" : "Timeframe"}</span><strong>{momentum ?? TFS.find((t) => t.mode === tf)!.tf}</strong></div>
        <div><span className="om-label">GENX state</span><strong>{stage ? STAGE_LABEL[stage] : "—"}</strong></div>
      </div>
      {watchLabel && watchValue && <div className="om-os-watch-level">
        <div><span className="om-label">{watchLabel}</span><strong className="om-num" data-no-i18n translate="no">{watchValue}</strong></div>
        <a href="#floor-gold-chart" onClick={onShowLevels}>Show on chart</a>
      </div>}
      {shut && <p className="om-os-market-closed">Gold is closed. Any displayed read refers to the last available market data.</p>}
      <div className="om-os-atlas-prompt">
        <form className="om-ask" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { go(q.trim()); setQ(""); } }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about gold or find a signal…" aria-label="Ask Atlas about gold, a setup, or your tools" maxLength={400} enterKeyHint="send" />
          <button type="button" className="om-ask-mic" aria-label="Talk to Atlas" title="Talk to Atlas here" onClick={() => go(undefined, true)} disabled={sample}><Mic aria-hidden="true" /></button>
          <button type="submit" aria-label="Send to Atlas" disabled={sample || !q.trim()}><Send aria-hidden="true" /></button>
        </form>
        <div className="om-atlas-asks">
          <button type="button" className="om-go" onClick={() => go("Explain the current gold setup from GENX, what it is waiting for, and what would invalidate it.")} disabled={sample}>Explain GENX</button>
          <button type="button" className="om-go" onClick={() => { if (!sample) openAtlas({ tool: "plays", context }); }} disabled={sample}>Find a signal</button>
          <button type="button" className="om-go" onClick={() => go("What should I watch next on gold, and which One Mission tool should I use?")} disabled={sample}>What’s next?</button>
        </div>
        <p className="om-label om-os-atlas-terms">Ask, generate, and review your signal here in the app.</p>
      </div>
    </section>
  );
}

/* ── results ──────────────────────────────────────────────────────────────────────────────────── */

export function Spark({ series }: { series: number[] }) {
  if (series.length < 3) return null;
  const W = 190, H = 56, lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * W, 4 + (1 - (v - lo) / span) * (H - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const up = series[series.length - 1] >= series[0];
  // The look's own gain and loss colours (om.css tokens), set through style: SVG attributes cannot read a CSS variable.
  const col = up ? "var(--om-pos)" : "var(--om-neg)";
  return (
    <div className="om-spark" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs><linearGradient id="om-spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: col }} stopOpacity="0.28" /><stop offset="1" style={{ stopColor: col }} stopOpacity="0" /></linearGradient></defs>
        <path d={`${line}L${W} ${H}L0 ${H}Z`} fill="url(#om-spark-fill)" />
        <path d={line} fill="none" style={{ stroke: col }} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export const toneClass = (v: number | null | undefined) => { const t = toneOf(v); return t === "up" ? "om-pos" : t === "down" ? "om-neg" : ""; };
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`;

/** How a figure is counted, a tap away: the definitions stay whole, and stay out of the figures' way. */
export function Method({ id, children }: { id: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span ref={box} className="om-method">
      <button type="button" className="om-icon-btn" aria-expanded={open} aria-controls={id} aria-label="How this is counted" title="How this is counted" onClick={() => setOpen((o) => !o)}><Info aria-hidden="true" /></button>
      {open && <span id={id} role="note" className="om-menu om-method-note">{children}</span>}
    </span>
  );
}

export function GenxCard({ ov, state, failed, period, onPeriod, icon = false }: { ov: FloorOverview | null; state: string; failed: boolean; period: FloorPeriod; onPeriod: (p: FloorPeriod) => void; icon?: boolean }) {
  const g = ov?.genx && ov.genx.period === period ? ov.genx : null;
  const r = g?.results ?? null;
  // Waiting only while an answer is actually on its way: an ask that failed ends it, and the card says so.
  const waiting = !r && !failed && (state === "loading" || (!!ov?.genx && ov.genx.period !== period));
  const decided = r ? r.wins + r.losses : 0;
  return (
    <section className="om-panel om-res" aria-label="GENX results">
      <div className="om-res-head">
        <div className="om-os-result-heading">
          {icon && <ProductIcon kind="genx" size="sm" />}
          <div style={{ minWidth: 0 }}><h2>GENX results</h2>
            <p className="om-label">The engine's trades on gold</p></div>
        </div>
        <span className="om-res-tools">
          <PeriodSelect value={period} onChange={onPeriod} label="GENX results period" />
          <Method id="om-method-genx">
            Each GENX trade is counted once, at the average result of the accounts that took it. These are the engine's results on gold, not a return for any one account.
            {r && r.breakeven ? ` ${r.breakeven} closed flat.` : ""}{r && r.open ? ` ${r.open} ${r.open === 1 ? "is" : "are"} open now and not counted yet.` : ""}
          </Method>
        </span>
      </div>
      {waiting ? <div className="om-stats" aria-busy="true"><div className="om-stat"><Skel w={130} h={26} /><span className="om-label">Net result</span></div><div className="om-stat"><Skel w={64} h={26} /><span className="om-label">Win rate</span></div><div className="om-stat"><Skel w={44} h={26} /><span className="om-label">Closed trades</span></div></div>
        : !r ? <p className="om-empty">GENX's results could not be loaded just now.</p>
          : r.trades === 0 ? <p className="om-empty">No GENX trades have closed in this period.{r.open > 0 ? ` ${r.open} ${r.open === 1 ? "is" : "are"} open now.` : ""}</p>
            : (
              <div className="om-stats">
                <div className="om-stat"><span data-no-i18n translate="no" className={`om-figure om-num ${toneClass(r.netPips)}`}>{pipsText(r.netPips)}</span><span className="om-label">Net result</span></div>
                <div className="om-stat"><span className={`om-figure om-num ${r.winRate != null && r.winRate >= 50 ? "om-pos" : ""}`}>{r.winRate == null ? "—" : `${r.winRate}%`}</span><span className="om-label">Win rate{decided ? <span className="om-faint"> · {r.wins} of {decided}</span> : null}</span></div>
                <div className="om-stat"><span className="om-figure om-num">{r.trades.toLocaleString("en-US")}</span><span className="om-label">Closed trades</span></div>
                {r.recent.length > 0 && (
                  <div className="om-stat om-stat-last" data-no-i18n translate="no">
                    <span className="om-figure om-num">{r.recent.slice(0, 3).map((x, i) => <span key={x.at + i} className={x.pips > 0 ? "om-pos" : x.pips < 0 ? "om-neg" : undefined}>{signed(x.pips)}</span>)}</span>
                    <span className="om-label">Latest, in pips</span>
                  </div>
                )}
                <Spark series={r.series} />
              </div>
            )}
    </section>
  );
}

/* ── the screen ───────────────────────────────────────────────────────────────────────────────── */

export function Floor({ sample }: { sample?: FloorSample }) {
  const { isSimple } = useExperienceMode();
  const [showResults, setShowResults] = useState(false);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const sync = () => setCompact(media.matches);
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const isSample = !!sample;
  const accountContext = useFlowAccount();
  // The OS shell owns the member's selected account. A labelled sample keeps its own isolated figures.
  const shared = isSample ? null : accountContext;
  const usingSharedAccount = shared !== null;
  const [tf, setTf] = useState<FloorMode>("intraday");
  const [setup, setSetup] = useState<SetupAnswer | null>(sample?.setup ?? null);
  const [setupFailed, setSetupFailed] = useState(false);
  const [localOv, setOv] = useState<FloorOverview | null>(sample?.overview ?? null);
  const [localOvState, setOvState] = useState<"loading" | "ready" | "error" | "off">(sample ? "ready" : "loading");
  const [pick, setPick] = useState<{ id: string; env: string } | null>(null);
  const [localSwitching, setSwitching] = useState(false);
  /** The last ask for the member's numbers did not come back. What is on screen keeps its dates; nothing waits on it. */
  const [localOvFailed, setOvFailed] = useState(false);
  const [localGp, setGp] = useState<FloorPeriod>("7d");
  const [localFp, setFp] = useState<FloorPeriod>("today");
  const [localHide, setHide] = useState(false);
  const [ticks, setTicks] = useState<Tick[]>(sample?.ticks ?? []);
  const [localNow, setNow] = useState<number>(sample?.nowMs ?? 0);
  const [prefs, setPrefs] = useState(isSample);
  const [layers, setLayers] = useState({ levels: true, setup: true });
  const ov = shared ? shared.ov : localOv;
  const ovState = shared ? shared.state : localOvState;
  const switching = shared ? shared.switching : localSwitching;
  const ovFailed = shared ? shared.failed : localOvFailed;
  const gp = shared ? shared.genxPeriod : localGp;
  const fp = shared ? shared.flowPeriod : localFp;
  const hide = shared ? shared.hide : localHide;
  const now = shared ? shared.now : localNow;

  // What the member chose last time: which account to look at, the two periods, whether amounts are hidden.
  useEffect(() => {
    if (isSample) return;
    const savedTf = store.get("om:floor:tf");
    if (savedTf === "quick" || savedTf === "intraday" || savedTf === "swing") setTf(savedTf);
    setPrefs(true);
    if (usingSharedAccount) return;
    const acct = store.get("om:floor:account");
    if (acct && acct.includes(":")) { const i = acct.indexOf(":"); setPick({ env: acct.slice(0, i), id: acct.slice(i + 1) }); }
    setGp(periodOf(store.get("om:floor:genx"), "7d"));
    setFp(periodOf(store.get("om:floor:flow"), "today"));
    setHide(store.get("om:floor:hide") === "1");
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(iv);
  }, [isSample, usingSharedAccount]);

  // ── the member's own numbers ──
  const ovSeq = useRef(0);
  const soon = useRef(0);
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const loadOverview = useCallback(async () => {
    if (usingSharedAccount) return;
    const mine = ++ovSeq.current;
    if (again.current) { clearTimeout(again.current); again.current = null; }
    const headers: Record<string, string> = {};
    // The account is named in a header, not the address, so it stays out of request logs.
    if (pick) { headers["x-floor-account"] = pick.id; headers["x-floor-env"] = pick.env; }
    try {
      const r = await fetch(`/api/floor/overview?gp=${gp}&fp=${fp}&tz=${new Date().getTimezoneOffset()}`, { cache: "no-store", headers });
      const d = await r.json().catch(() => null);
      if (mine !== ovSeq.current) return;                       // a newer question is out: this answers an old one
      if (d?.error === "not_configured") { setOvState("off"); return; }
      if (!r.ok || !d || d.error) { setOvState((s) => (s === "ready" ? s : "error")); setOvFailed(true); setSwitching(false); return; }   // the last good answer stays, with its ages
      setOv(d as FloorOverview); setOvState("ready"); setOvFailed(false); setSwitching(false); setNow(Date.now());
      // The broker had not answered in time: its reading is on its way, so ask again shortly — a few times, not forever.
      if ((d as FloorOverview).figures?.reading && soon.current < 3) { soon.current += 1; again.current = setTimeout(() => void loadRef.current(), 5000); }
      else if (!(d as FloorOverview).figures?.reading) soon.current = 0;
    } catch { if (mine === ovSeq.current) { setOvState((s) => (s === "ready" ? s : "error")); setOvFailed(true); setSwitching(false); } }
  }, [gp, fp, pick, usingSharedAccount]);
  loadRef.current = loadOverview;
  useEffect(() => () => { if (again.current) clearTimeout(again.current); }, []);
  useEffect(() => {
    if (isSample || usingSharedAccount || !prefs) return;
    void loadOverview();
    const iv = setInterval(() => { if (document.visibilityState === "visible") void loadOverview(); }, OVERVIEW_EVERY_MS);
    const onVis = () => { if (document.visibilityState === "visible") void loadOverview(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [isSample, usingSharedAccount, prefs, loadOverview]);

  const acctKey = (a: { id: string; environment: string }) => `${a.environment}:${a.id}`;
  const sampleSince = (o: FloorOverview) => o.flow?.since ?? sample?.overview.flow?.since ?? o.asOf;
  const choose = (a: FloorAccount) => {
    if (sample) {
      // The review route has no member to ask about: it shows that account's own sample figures.
      const other = sample.accounts?.[acctKey(a)];
      const res = other?.flow[fp];
      if (other) setOv((o) => (o ? { ...o, account: a, figures: other.figures, flow: res ? { period: fp, since: sampleSince(o), results: res } : null } : o));
      return;
    }
    if (shared) { shared.chooseAccount(a); return; }
    // The old account's money leaves the screen now, before the new account's is asked for.
    setSwitching(true); setOvFailed(false);
    setOv((o) => (o ? { ...o, account: a, figures: null, flow: null } : o));
    setPick({ id: a.id, env: a.environment });
    store.set("om:floor:account", `${a.environment}:${a.id}`);
  };

  // ── gold and GENX's state ──
  const suSeq = useRef(0);
  const loadSetup = useCallback(async (fresh = false) => {
    const mine = ++suSeq.current;
    try {
      const r = await fetch(`/api/floor/setup?${setupQuery(tf, "XAUUSD", fresh ? "&fresh=1" : "")}`, { cache: "no-store" });
      const d = (await r.json().catch(() => null)) as SetupAnswer | null;
      if (mine !== suSeq.current) return;
      if (!r.ok || !d) { setSetupFailed(true); return; }
      setSetup(d); setSetupFailed(!!d.error && realCandles(d.candles).length < 2);
    } catch { if (mine === suSeq.current) setSetupFailed(true); }
  }, [tf]);
  useEffect(() => {
    if (isSample || !prefs) return;
    setSetup(null); setSetupFailed(false);                      // another timeframe's candles and levels do not linger under this one
    void loadSetup(true);
    const iv = setInterval(() => { if (document.visibilityState === "visible") void loadSetup(); }, SETUP_EVERY_MS);
    return () => clearInterval(iv);
  }, [isSample, prefs, loadSetup]);

  // ── the other markets ──
  useEffect(() => {
    if (isSample) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/floor/ticker", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && Array.isArray(j?.ticks)) setTicks(j.ticks as Tick[]);
      } catch { /* the row simply stays as it was */ }
    };
    void load();
    const iv = setInterval(() => { if (document.visibilityState === "visible") void load(); }, TICKER_EVERY_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [isSample]);

  // ── the screen's own choices ──
  // On the review route each choice shows the sample prepared for it (or stays put where there is none);
  // for a member it is remembered and the real answer is asked for.
  const [samplePlay, setSamplePlay] = useState(false);
  const pickTf = (m: FloorMode) => {
    if (sample) { const su = (samplePlay ? sample.opened?.[m] : undefined) ?? sample.setups?.[m]; if (su) { setTf(m); setSetup(su); } return; }
    setTf(m); store.set("om:floor:tf", m);
  };
  const openSamplePlay = () => { const su = sample?.opened?.[tf]; if (su) { setSamplePlay(true); setSetup(su); } };
  const pickGenx = (p: FloorPeriod) => {
    if (sample) {
      const r = sample.genx?.[p];
      if (r) { setGp(p); setOv((o) => (o && o.genx ? { ...o, genx: { ...o.genx, period: p, results: r } } : o)); }
      return;
    }
    if (shared) { shared.setGenxPeriod(p); return; }
    setOvFailed(false); setGp(p); store.set("om:floor:genx", p);
  };
  const pickFlow = (p: FloorPeriod) => {
    if (sample) {
      const r = ov?.account ? sample.accounts?.[acctKey(ov.account)]?.flow[p] : undefined;
      if (r) { setFp(p); setOv((o) => (o ? { ...o, flow: { period: p, since: sampleSince(o), results: r } } : o)); }
      return;
    }
    if (shared) { shared.setFlowPeriod(p); return; }
    setOvFailed(false); setFp(p); store.set("om:floor:flow", p);
  };

  const view = useMemo(() => setupView(setup), [setup]);
  const gold = ticks.find((t) => t.label === "XAUUSD");
  const others = ticks.filter((t) => t.label !== "XAUUSD").slice(0, 3);
  const pair = (l: string) => (/^[A-Z]{6}$/.test(l) ? `${l.slice(0, 3)}/${l.slice(3)}` : l);

  return (
    <div className="om-floor om-floor-os">
      {ovState === "error" && !ov && <div className="om-banner" role="status">Your account and results could not be loaded just now. The chart and the tools still work, and this will try again on its own.</div>}

      <header className={`om-head${usingSharedAccount ? " om-os-floor-head" : ""}`}>
        <div>
          <h1 className="om-title">OM OS{isSample && <span className="om-chip om-sample" role="note">Sample data</span>}</h1>
          <p className="om-sub">{isSimple ? "Pick a market. See the setup. Follow the chart." : "Your markets, intelligence and performance. One workspace."}</p>
        </div>
        {!usingSharedAccount && <AccountSummary ov={ov} state={ovState} switching={switching} hide={hide} onHide={() => setHide((h) => { store.set("om:floor:hide", h ? "0" : "1"); return !h; })} onPick={choose} now={now} />}
      </header>

      <AtlasLiveDesk goldSetup={setup} goldFailed={setupFailed} atlasRead={ov?.atlas?.read ?? null}
        sample={isSample} sampleNow={sample?.nowMs} tf={tf} onTf={pickTf} />

      {!isSample && <NitrousAccountSummary />}

      <div className="om-os-performance">
      {isSimple && <button type="button" className="om-simple-results-toggle" aria-expanded={showResults} onClick={() => setShowResults(value => !value)}>{showResults ? "Hide results and streaks" : "View results and streaks"}<ChevronDown size={16} aria-hidden="true"/></button>}
      {(!isSimple || showResults) && <>
      <WinningPipsPanel account={ov?.account ?? null} accountsKnown={!!ov?.accountsKnown} switching={switching}
        hideAccountPips={hide} sample={isSample} />

      <WinStreaks account={ov?.account ?? null} accountsKnown={!!ov?.accountsKnown} switching={switching}
        hideAccountPips={hide} sample={isSample} />
      </>}

      {!isSample && <ActiveTrades />}
      </div>

      {!isSimple && <details className="om-floor-deep">
        <summary>Open detailed gold workspace</summary>
      <div className="om-stage">
        <ChartCard setup={setup} failed={setupFailed} tf={tf} onTf={pickTf} change={gold?.percent ?? null} onOpened={() => void loadSetup(true)} now={now} sample={isSample} onSamplePlay={sample?.opened ? openSamplePlay : undefined} layers={layers} onLayer={(layer) => setLayers((current) => ({ ...current, [layer]: !current[layer] }))} />
        <AtlasPanel atlas={ov?.atlas ?? null} view={view} setup={setup} tf={tf} sample={isSample} now={now} onShowLevels={() => setLayers({ levels: true, setup: true })} />
      </div>
      </details>}

      {!isSimple && !compact && <div className="om-lower">
        <div className="om-pulse">
          <Link className="om-os-pulse-title" href="/portal/trading?view=pulse"><span>Market watch<small>Latest quotes</small></span></Link>
          <div className="om-pulse-list" data-no-i18n translate="no">
            {others.map((t) => (
              <span key={t.label} className="om-pulse-item om-num">
                {pair(t.label)}
                <span className="om-dim">{t.price.toLocaleString("en-US", { minimumFractionDigits: t.dp, maximumFractionDigits: t.dp })}</span>
                {t.percent != null && <span className={t.percent > 0 ? "om-pos" : t.percent < 0 ? "om-neg" : "om-dim"}>{t.percent > 0 ? "+" : t.percent < 0 ? "−" : ""}{Math.abs(t.percent).toFixed(2)}%</span>}
              </span>
            ))}
            {others.length === 0 && <span className="om-label">Market quotes are not available right now.</span>}
          </div>
          <Go href="/portal/trading?view=pulse">Explore markets</Go>
        </div>
        <p className="om-legal">Educational only — not financial advice. You approve every action on your own account.{isSample && " Sample data: this page is a review of the design, and none of its figures, prices or results are a member's."}</p>
      </div>}
    </div>
  );
}
