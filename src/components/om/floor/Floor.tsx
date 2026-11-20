"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, Eye, EyeOff, Mic, Send } from "lucide-react";
import { CandleChart } from "./CandleChart";
import { AtlasMark } from "./AtlasMark";
import { useSeeThePlay } from "@/components/portal/SetupLock";
import { leaveFloorQuestion } from "@/components/command-center/hud/floorAsk";
import { FLOOR_INSTRUMENTS, setupQuery, type FloorMode } from "@/lib/floor/setupInstruments";
import { minutesLeft, type SetupGate } from "@/lib/setupLock";
import { realCandles, priceText } from "@/lib/floor/chart";
import {
  FLOOR_PERIODS, STAGE_LABEL, stageSentence, setupView, ageText, money, pipsText, toneOf, periodOf,
  type FloorOverview, type FloorPeriod, type FloorAccount, type AccountFigures,
} from "@/lib/floor/overview";

/**
 * THE FLOOR (owner 11-20) — the first screen: the selected account's Balance and Equity, gold with GENX's
 * current state, Atlas, GENX's results and the member's own FLOW results, in one composition.
 *
 * WHERE EVERYTHING COMES FROM. Nothing on this screen is written here:
 *   /api/floor/overview  the member's accounts, the broker's figures, the desk record, their FLOW results,
 *                        and whether their Command Center window is open
 *   /api/floor/setup     gold's candles, price and GENX's read — or, while the member's window on the play
 *                        is closed, only how far along the setup is (the server withholds the rest)
 *   /api/floor/ticker    the other markets' quotes
 * LOADING, NOTHING, ZERO AND UNAVAILABLE ARE FOUR DIFFERENT THINGS and are shown as four: a grey bar while
 * an answer is on its way, plain words when there is nothing (no account connected, no trades in the
 * period), a real 0 only when the answer was zero, and an em dash with the reason when a number could not
 * be read. Nothing here opens a "connect your account" prompt on its own.
 *
 * WHAT IT CAN CHARGE. One thing, and only on a tap that says its price: "See the play" (the existing
 * setup window, through the existing request — SetupLock.useSeeThePlay). Opening the page, changing the
 * timeframe, the period or the account, and asking Atlas a question from here charge nothing; Atlas's own
 * window is opened, and priced, in the Command Center as it always has been.
 *
 * CHOOSING AN ACCOUNT TO LOOK AT changes what this screen shows and nothing else. The figures and results
 * of the account that was showing are cleared the moment another is chosen, and an answer that arrives
 * for the earlier choice is dropped — so one account's money never appears under another's name.
 */
export type SetupAnswer = {
  g?: unknown; locked?: { stage?: string } | null; candles?: unknown; price?: unknown; asOf?: unknown;
  setups?: SetupGate | null; error?: string;
};
export type Tick = { label: string; price: number; percent: number | null; dp: number };
/** Fixed, labelled sample content for the review route. Never mixed with a member's data. */
export type FloorSample = { overview: FloorOverview; setup: SetupAnswer; ticks: Tick[]; nowMs: number };

const GOLD = FLOOR_INSTRUMENTS[0];
const TFS: { mode: FloorMode; tf: string; name: string }[] = [
  { mode: "quick", tf: "5m", name: "Quick" },
  { mode: "intraday", tf: "15m", name: "Intraday" },
  { mode: "swing", tf: "1h", name: "Swing" },
];
const SETUP_EVERY_MS = 20_000, OVERVIEW_EVERY_MS = 60_000, TICKER_EVERY_MS = 45_000;

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* a private window: the choice lasts for the visit */ } },
};

/** Hand a question to Atlas. It is asked in the Command Center, where Atlas's window and its price live. */
function askAtlas(question: string | null) {
  try { leaveFloorQuestion(window.sessionStorage, question, Date.now()); } catch { /* the Command Center still opens; the question is typed again there */ }
  window.location.assign("/command-center");
}

const Skel = ({ w, h = "1em" }: { w: number | string; h?: number | string }) => <span className="om-skel" style={{ width: w, height: h }} aria-hidden="true">&nbsp;</span>;
const Go = ({ href, children }: { href: string; children: React.ReactNode }) => <Link href={href} className="om-go">{children}<ArrowUpRight aria-hidden="true" /></Link>;
const clock = (iso: unknown): string | null => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : null;
};

function PeriodSelect({ value, onChange, label }: { value: FloorPeriod; onChange: (p: FloorPeriod) => void; label: string }) {
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

function AccountSummary({ ov, state, switching, hide, onHide, onPick, now }: {
  ov: FloorOverview | null; state: "loading" | "ready" | "error" | "off"; switching: boolean;
  hide: boolean; onHide: () => void; onPick: (a: FloorAccount) => void; now: number;
}) {
  if (!ov) {
    if (state === "loading") return <div className="om-panel om-acct" aria-busy="true"><div><Skel w={190} h={22} /><Skel w={92} h={22} /></div><span className="om-rule" /><div><span className="om-label">Balance</span><Skel w={132} h={26} /></div><span className="om-rule" /><div><span className="om-label">Equity</span><Skel w={132} h={26} /></div></div>;
    return <div className="om-panel om-acct"><div><span>Account figures are not available right now.</span><span className="om-label">The rest of The Floor is unaffected.</span></div></div>;
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

function ChartCard({ setup, failed, tf, onTf, change, onOpened, now, sample }: {
  setup: SetupAnswer | null; failed: boolean; tf: FloorMode; onTf: (m: FloorMode) => void; change: number | null;
  onOpened: () => void; now: number; sample: boolean;
}) {
  const view = useMemo(() => setupView(setup), [setup]);
  const candles = useMemo(() => realCandles(setup?.candles), [setup]);
  const price = typeof setup?.price === "number" && Number.isFinite(setup.price) ? setup.price : candles.length ? candles[candles.length - 1].c : null;
  const horizon = TFS.find((t) => t.mode === tf)!;
  const gate = setup?.setups ?? null;
  const locked = !!setup && !view.open && view.stage != null;
  const play = useSeeThePlay(onOpened);
  const left = minutesLeft(gate, now);
  const at = clock(setup?.asOf);
  const px = (p: number) => priceText(p, GOLD.dec);

  return (
    <section className="om-panel om-chart-card" aria-label="Gold">
      <div className="om-chart-top">
        <div style={{ minWidth: 0 }}>
          <span style={{ fontSize: 16 }}>GENX · Gold intelligence</span>
          <div className="om-quote" data-no-i18n translate="no">
            <span className="om-sym">XAU / USD</span>
            <span className="om-px om-num">{price != null ? px(price) : setup || failed ? "—" : <Skel w={150} h={34} />}</span>
            {change != null && price != null && <span className={`om-chg om-num ${change > 0 ? "om-pos" : change < 0 ? "om-neg" : "om-dim"}`} title="Change since the previous daily close">{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change).toFixed(2)}%</span>}
          </div>
          <span className="om-label" style={{ display: "block", marginTop: 6 }} data-no-i18n translate="no">
            {sample ? "Sample" : at ? `Twelve Data · price as of ${at} · checked every ${SETUP_EVERY_MS / 1000} seconds` : failed ? "Market data did not load" : " "}
          </span>
        </div>
        <Link href="/portal/signals" className="om-btn">Generate a play<ArrowUpRight aria-hidden="true" /></Link>
      </div>

      <div className="om-tfs">
        <div className="om-tf" role="group" aria-label="Timeframe">
          {TFS.map((t) => <button key={t.mode} type="button" aria-pressed={t.mode === tf} title={`${t.name} setup · ${t.tf} candles`} onClick={() => onTf(t.mode)}>{t.tf}</button>)}
        </div>
        <span style={{ fontSize: 14.5 }}>{view.stage ? <><span className="om-dim">{horizon.name} · </span>{STAGE_LABEL[view.stage]}</> : setup || failed ? <span className="om-dim">{horizon.name}</span> : <Skel w={170} h={16} />}</span>
      </div>

      <div className="om-chart" data-no-i18n translate="no">
        {candles.length >= 2
          ? <CandleChart candles={candles} price={price} dec={GOLD.dec} levels={view.levels} zone={view.zone} label={`Gold, ${horizon.tf} candles${price != null ? `, last price ${px(price)}` : ""}`} />
          : <div className="om-chart-note">{!setup && !failed ? "Loading the chart…" : "The chart could not be loaded just now. It will try again on its own."}</div>}
      </div>

      <div className="om-read">
        <div className="om-read-main">
          <span className="om-ring" data-stage={view.stage ?? undefined} aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 14.5 }}>{view.stage ? stageSentence(view.stage, GOLD.engine, GOLD.name) : !setup && !failed ? "Reading GENX…" : "GENX's read is not available right now."}</p>
            {view.open && view.waitingFor && <p className="om-dim" style={{ fontSize: 13.5, marginTop: 6 }}><span className="om-faint">Waiting for </span>{view.waitingFor}</p>}
            {view.open && view.changesIf && <p className="om-dim" style={{ fontSize: 13.5, marginTop: 4 }}><span className="om-faint">Changes if </span>{view.changesIf}</p>}
            {locked && <p className="om-dim" style={{ fontSize: 13.5, marginTop: 6 }}>Which way, the entry, the stop and the targets open with credits.</p>}
            {play.err && <p className="om-neg" role="alert" style={{ fontSize: 13.5, marginTop: 6 }}>{play.err}</p>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {locked && (
            <button type="button" className="om-btn-quiet" onClick={() => void play.open()} disabled={play.phase !== "idle" || sample} aria-busy={play.phase !== "idle"}
              title={gate ? `Opens every live setup on the site for ${gate.minutes} minutes` : undefined}>
              {play.phase === "busy" ? "Opening…" : play.phase === "opened" ? "Open — loading the play…" : gate ? `See the play · ${gate.cost} credits` : "See the play"}
            </button>
          )}
          {left != null && <span className="om-chip" title="Your window on the live setups">Open · {left} min left</span>}
          <Link href="/portal/genx" className="om-btn-quiet">Analyze gold<ArrowUpRight width={14} height={14} aria-hidden="true" /></Link>
        </div>
      </div>
    </section>
  );
}

/* ── Atlas ────────────────────────────────────────────────────────────────────────────────────── */

function AtlasPanel({ atlas, stage, sample, now }: { atlas: FloorOverview["atlas"]; stage: "watching" | "forming" | "live" | null; sample: boolean; now: number }) {
  const [q, setQ] = useState("");
  const go = (question: string | null) => { if (!sample) askAtlas(question); };
  // What Atlas says here is either its own newest read (while the member's window is open) or the one
  // thing every member may know — how far along GENX's setup is. It never describes the market otherwise.
  const say = atlas?.read?.summary
    ?? (stage === "live" ? "GENX has a confirmed entry on gold. Ask me to walk you through it."
      : stage === "forming" ? "A gold setup is forming. I'm watching for confirmation."
        : stage === "watching" ? "No confirmed entry on gold right now. I'm watching for a trigger."
          : "Ask me about gold, a setup, or how your account is doing.");
  const terms = !atlas ? null : atlas.open ? "Your Command Center window is open." : atlas.preview ? "Your first look inside is free." : `${atlas.cost} credits for ${atlas.minutes} minutes, confirmed before anything is charged.`;
  return (
    <section className="om-panel om-panel-atlas om-atlas" aria-label="Atlas">
      <div className="om-atlas-head">
        <div>
          <h2>Atlas</h2>
          <p className="om-dim" style={{ margin: "6px 0 0", fontSize: 16.5 }}>Your AI copilot</p>
        </div>
        <AtlasMark className="om-atlas-mark" />
      </div>
      <hr className="om-hr" style={{ marginTop: 20 }} />
      <p className="om-atlas-say">{say}</p>
      {atlas?.read && <p className="om-label" style={{ margin: "8px 0 0" }}>Atlas · {ageText(atlas.read.at, now)}</p>}
      <div className="om-atlas-asks">
        <button type="button" className="om-go" onClick={() => go("Explain the current gold setup.")}>Explain this setup<ArrowUpRight aria-hidden="true" /></button>
        <button type="button" className="om-go" onClick={() => go("Analyze gold right now.")}>Analyze gold<ArrowUpRight aria-hidden="true" /></button>
        <Go href="/portal/signals">Generate an OM AI Play</Go>
        <Go href="/portal/trading?view=flow">Check FLOW</Go>
      </div>
      <div className="om-atlas-cta">
        <button type="button" className="om-btn" onClick={() => go(null)}>Open Command Center<ArrowUpRight aria-hidden="true" /></button>
        {terms && <span className="om-label">{terms}</span>}
      </div>
      <form className="om-ask" style={{ marginTop: 22 }} onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask Atlas…" aria-label="Ask Atlas" maxLength={400} enterKeyHint="send" />
        {/* Voice lives in the Command Center. This opens it; the microphone is only ever asked for there, on a tap. */}
        <button type="button" className="om-ask-mic" aria-label="Talk to Atlas in the Command Center" title="Talk to Atlas in the Command Center" onClick={() => go(null)}><Mic aria-hidden="true" /></button>
        <button type="submit" aria-label="Send to Atlas"><Send aria-hidden="true" /></button>
      </form>
    </section>
  );
}

/* ── results ──────────────────────────────────────────────────────────────────────────────────── */

function Spark({ series }: { series: number[] }) {
  if (series.length < 3) return null;
  const W = 190, H = 56, lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * W, 4 + (1 - (v - lo) / span) * (H - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const up = series[series.length - 1] >= series[0];
  const col = up ? "#87C6AF" : "#E099A1";
  return (
    <div className="om-spark" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs><linearGradient id="om-spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={col} stopOpacity="0.28" /><stop offset="1" stopColor={col} stopOpacity="0" /></linearGradient></defs>
        <path d={`${line}L${W} ${H}L0 ${H}Z`} fill="url(#om-spark-fill)" />
        <path d={line} fill="none" stroke={col} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const toneClass = (v: number | null | undefined) => { const t = toneOf(v); return t === "up" ? "om-pos" : t === "down" ? "om-neg" : ""; };

function GenxCard({ ov, state, failed, period, onPeriod }: { ov: FloorOverview | null; state: string; failed: boolean; period: FloorPeriod; onPeriod: (p: FloorPeriod) => void }) {
  const g = ov?.genx && ov.genx.period === period ? ov.genx : null;
  const r = g?.results ?? null;
  // Waiting only while an answer is actually on its way: an ask that failed ends it, and the card says so.
  const waiting = !r && !failed && (state === "loading" || (!!ov?.genx && ov.genx.period !== period));
  return (
    <section className="om-panel om-res" aria-label="GENX results">
      <div className="om-res-head">
        <h2>GENX results</h2>
        <PeriodSelect value={period} onChange={onPeriod} label="GENX results period" />
      </div>
      {waiting ? <div className="om-stats" aria-busy="true"><div className="om-stat"><Skel w={150} h={30} /><span className="om-label">Net result</span></div><span className="om-rule" /><div className="om-stat"><Skel w={70} h={30} /><span className="om-label">Win rate</span></div><span className="om-rule" /><div className="om-stat"><Skel w={50} h={30} /><span className="om-label">Closed trades</span></div></div>
        : !r ? <p className="om-empty">GENX's results could not be loaded just now.</p>
          : r.trades === 0 ? <p className="om-empty">No GENX trades have closed in this period.{r.open > 0 ? ` ${r.open} ${r.open === 1 ? "is" : "are"} open now.` : ""}</p>
            : (
              <div className="om-stats">
                <div className="om-stat"><span data-no-i18n translate="no" className={`om-figure om-num ${toneClass(r.netPips)}`}>{pipsText(r.netPips)}</span><span className="om-label">Net result</span></div>
                <span className="om-rule" />
                <div className="om-stat"><span className={`om-figure om-num ${r.winRate != null && r.winRate >= 50 ? "om-pos" : ""}`}>{r.winRate == null ? "—" : `${r.winRate}%`}</span><span className="om-label">Win rate</span></div>
                <span className="om-rule" />
                <div className="om-stat"><span className="om-figure om-num">{r.trades.toLocaleString("en-US")}</span><span className="om-label">Closed trades</span></div>
                <Spark series={r.series} />
              </div>
            )}
      <p className="om-foot" data-no-i18n translate="no">
        {r && r.trades > 0 && <>{r.wins} won, {r.losses} lost{r.breakeven ? `, ${r.breakeven} flat` : ""}{r.open ? ` · ${r.open} open now` : ""}. </>}
        {r && r.recent.length > 0 && <>Latest: {r.recent.slice(0, 5).map((x, i) => <span key={x.at + i} className={x.pips > 0 ? "om-pos" : x.pips < 0 ? "om-neg" : undefined}>{i ? ", " : ""}{x.pips > 0 ? "+" : x.pips < 0 ? "−" : ""}{Math.abs(x.pips)}</span>)} pips. </>}
        GENX engine results on gold — each trade counted once, at the average result of the accounts that took it. Not a return for any one account.
      </p>
    </section>
  );
}

function FlowCard({ ov, state, failed, switching, period, onPeriod, hide }: { ov: FloorOverview | null; state: string; failed: boolean; switching: boolean; period: FloorPeriod; onPeriod: (p: FloorPeriod) => void; hide: boolean }) {
  const a = ov?.account ?? null;
  const fl = !switching && ov?.flow && ov.flow.period === period ? ov.flow : null;
  const r = fl?.results ?? null;
  const f = switching ? null : ov?.figures ?? null;
  const waiting = !r && !!a && !failed && (state === "loading" || switching || (!!ov?.flow && ov.flow.period !== period));
  // Whether the member has an account is only known once their accounts have been read.
  const unknown = !ov ? state !== "loading" : !ov.accountsKnown;
  const cur = a?.currency ?? null;
  const cash = (v: number | null | undefined, sign = true) => (hide ? "••••••" : money(v ?? null, cur, { sign }));
  // The broker's open profit is for every position on the account. It is FLOW's only when FLOW holds them all.
  const wholeAccount = r && f?.positions != null && f.positions !== r.open;
  return (
    <section className="om-panel om-res om-res-flow" aria-label="My FLOW">
      <div className="om-res-head">
        <div style={{ minWidth: 0 }}>
          <h2>My FLOW</h2>
          <p className="om-label" style={{ fontSize: 14.5 }}>{a ? `${a.name} · ${a.environment === "live" ? "Live" : "Demo"}` : "Your connected account"}</p>
        </div>
        {a && <PeriodSelect value={period} onChange={onPeriod} label="My FLOW period" />}
      </div>
      {!ov && state === "loading" ? <div className="om-stats" aria-busy="true"><div className="om-stat"><Skel w={150} h={30} /><span className="om-label">Realized P&amp;L</span></div></div>
        : unknown ? <p className="om-empty">Your FLOW results could not be loaded just now.</p>
        : !a ? <><p className="om-empty">Connect a broker account in FLOW and what FLOW does on it shows here.</p><p style={{ margin: "10px 0 0" }}><Go href="/portal/trading?view=flow">Manage accounts</Go></p></>
          : waiting ? <div className="om-stats" aria-busy="true"><div className="om-stat"><Skel w={150} h={30} /><span className="om-label">Realized P&amp;L</span></div><span className="om-rule" /><div className="om-stat"><Skel w={120} h={30} /><span className="om-label">Open P&amp;L</span></div><span className="om-rule" /><div className="om-stat"><Skel w={40} h={30} /><span className="om-label">Open positions</span></div></div>
            : !r ? <p className="om-empty">Your FLOW results could not be loaded just now.</p>
              : (
                <div className="om-stats">
                  <div className="om-stat">
                    <span data-no-i18n translate="no" className={`om-figure om-num ${r.realized ? toneClass(r.realized.amount) : toneClass(r.netPips)}`}>{r.closed === 0 ? cash(0, false) : r.realized ? cash(r.realized.amount) : pipsText(r.netPips)}</span>
                    <span className="om-label">{r.closed > 0 && !r.realized ? "Realized, in pips" : "Realized P&L"}{r.realized && r.closed > 0 ? <span className="om-faint"> · estimate</span> : null}</span>
                  </div>
                  <span className="om-rule" />
                  <div className="om-stat">
                    <span className={`om-figure om-num ${f?.state === "live" ? toneClass(f?.openPnl) : ""}`} data-stale={f && f.state !== "live" ? true : undefined} data-no-i18n translate="no" title={f?.openPnl == null ? (f?.note ?? "Your broker has not reported open profit for this account.") : undefined}>{f ? cash(f.openPnl) : <Skel w={110} h={30} />}</span>
                    <span className="om-label">Open P&amp;L{f && f.state !== "live" && f.openPnl != null ? <span className="om-faint"> · last reading</span> : wholeAccount ? <span className="om-faint"> · whole account</span> : null}</span>
                  </div>
                  <span className="om-rule" />
                  <div className="om-stat"><span className="om-figure om-num">{r.open}</span><span className="om-label">Open positions</span></div>
                </div>
              )}
      {a && r && (
        <p className="om-foot" data-no-i18n translate="no">
          {r.closed === 0 ? "No FLOW trades closed in this period. " : `${r.closed} closed · ${pipsText(r.netPips)} net${r.ungraded ? ` · ${r.ungraded} with no recorded result` : ""}. `}
          {r.realized && r.closed > 0 && <>The amount is worked out from each trade's recorded result and size, before your broker's commission and swap{r.realized.left ? `; ${r.realized.left} ${r.realized.left === 1 ? "trade is" : "trades are"} not in it` : ""}. </>}
          {wholeAccount && <>Open P&amp;L is your broker's figure for all {f!.positions} open {f!.positions === 1 ? "position" : "positions"} on the account. </>}
          Trades FLOW placed on this account only.
        </p>
      )}
    </section>
  );
}

/* ── the screen ───────────────────────────────────────────────────────────────────────────────── */

export function Floor({ sample }: { sample?: FloorSample }) {
  const isSample = !!sample;
  const [tf, setTf] = useState<FloorMode>("intraday");
  const [setup, setSetup] = useState<SetupAnswer | null>(sample?.setup ?? null);
  const [setupFailed, setSetupFailed] = useState(false);
  const [ov, setOv] = useState<FloorOverview | null>(sample?.overview ?? null);
  const [ovState, setOvState] = useState<"loading" | "ready" | "error" | "off">(sample ? "ready" : "loading");
  const [pick, setPick] = useState<{ id: string; env: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  /** The last ask for the member's numbers did not come back. What is on screen keeps its dates; nothing waits on it. */
  const [ovFailed, setOvFailed] = useState(false);
  const [gp, setGp] = useState<FloorPeriod>("7d");
  const [fp, setFp] = useState<FloorPeriod>("today");
  const [hide, setHide] = useState(false);
  const [ticks, setTicks] = useState<Tick[]>(sample?.ticks ?? []);
  const [now, setNow] = useState<number>(sample?.nowMs ?? 0);
  const [prefs, setPrefs] = useState(isSample);

  // What the member chose last time: which account to look at, the two periods, whether amounts are hidden.
  useEffect(() => {
    if (isSample) return;
    const acct = store.get("om:floor:account");
    if (acct && acct.includes(":")) { const i = acct.indexOf(":"); setPick({ env: acct.slice(0, i), id: acct.slice(i + 1) }); }
    const savedTf = store.get("om:floor:tf");
    if (savedTf === "quick" || savedTf === "intraday" || savedTf === "swing") setTf(savedTf);
    setGp(periodOf(store.get("om:floor:genx"), "7d"));
    setFp(periodOf(store.get("om:floor:flow"), "today"));
    setHide(store.get("om:floor:hide") === "1");
    setNow(Date.now());
    setPrefs(true);
    const iv = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(iv);
  }, [isSample]);

  // ── the member's own numbers ──
  const ovSeq = useRef(0);
  const soon = useRef(0);
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const loadOverview = useCallback(async () => {
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
  }, [gp, fp, pick]);
  loadRef.current = loadOverview;
  useEffect(() => () => { if (again.current) clearTimeout(again.current); }, []);
  useEffect(() => {
    if (isSample || !prefs) return;
    void loadOverview();
    const iv = setInterval(() => { if (document.visibilityState === "visible") void loadOverview(); }, OVERVIEW_EVERY_MS);
    const onVis = () => { if (document.visibilityState === "visible") void loadOverview(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [isSample, prefs, loadOverview]);

  const choose = (a: FloorAccount) => {
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

  const stage = useMemo(() => setupView(setup).stage, [setup]);
  const gold = ticks.find((t) => t.label === "XAUUSD");
  const others = ticks.filter((t) => t.label !== "XAUUSD").slice(0, 4);
  const pair = (l: string) => (/^[A-Z]{6}$/.test(l) ? `${l.slice(0, 3)}/${l.slice(3)}` : l);

  return (
    <div className="om-floor">
      {ovState === "error" && !ov && <div className="om-banner" role="status">Your account and results could not be loaded just now. The chart and the tools still work, and this will try again on its own.</div>}

      <header className="om-head">
        <div>
          <h1 className="om-title">The Floor{isSample && <span className="om-chip om-sample" role="note">Sample data</span>}</h1>
          <p className="om-sub">Your trading intelligence, connected.</p>
        </div>
        <AccountSummary ov={ov} state={ovState} switching={switching} hide={hide} onHide={() => setHide((h) => { store.set("om:floor:hide", h ? "0" : "1"); return !h; })} onPick={choose} now={now} />
      </header>

      <div className="om-stage">
        <ChartCard setup={setup} failed={setupFailed} tf={tf} onTf={(m) => { setTf(m); store.set("om:floor:tf", m); }} change={gold?.percent ?? null} onOpened={() => void loadSetup(true)} now={now} sample={isSample} />
        <AtlasPanel atlas={ov?.atlas ?? null} stage={stage} sample={isSample} now={now} />
      </div>

      <div className="om-results">
        <GenxCard ov={ov} state={ovState} failed={ovFailed} period={gp} onPeriod={(p) => { setOvFailed(false); setGp(p); store.set("om:floor:genx", p); }} />
        <FlowCard ov={ov} state={ovState} failed={ovFailed} switching={switching} period={fp} onPeriod={(p) => { setOvFailed(false); setFp(p); store.set("om:floor:flow", p); }} hide={hide} />
      </div>

      <div>
        <div className="om-pulse">
          <h2>Market Pulse</h2>
          <div className="om-pulse-list" data-no-i18n translate="no">
            {others.map((t) => (
              <span key={t.label} className="om-pulse-item om-num">
                {pair(t.label)}
                <span className="om-dim">{t.price.toLocaleString("en-US", { minimumFractionDigits: t.dp, maximumFractionDigits: t.dp })}</span>
                {t.percent != null && <span className={t.percent > 0 ? "om-pos" : t.percent < 0 ? "om-neg" : "om-dim"}>{t.percent > 0 ? "+" : t.percent < 0 ? "−" : ""}{Math.abs(t.percent).toFixed(2)}%</span>}
              </span>
            ))}
          </div>
          <Go href="/portal/trading?view=pulse">View markets</Go>
        </div>
        <nav className="om-tools" aria-label="Tools">
          <Link href="/portal/signals" className="om-tool"><div style={{ minWidth: 0 }}>OM AI Plays<span>Generate a play</span></div><ArrowUpRight aria-hidden="true" /></Link>
          <Link href="/portal/genx" className="om-tool"><div style={{ minWidth: 0 }}>GENX<span>Analyze gold</span></div><ArrowUpRight aria-hidden="true" /></Link>
          <Link href="/portal/trading?view=pulse" className="om-tool"><div style={{ minWidth: 0 }}>Market Pulse<span>Scan the markets</span></div><ArrowUpRight aria-hidden="true" /></Link>
          <Link href="/portal/trading?view=flow" className="om-tool"><div style={{ minWidth: 0 }}>FLOW<span>Review in FLOW · manage accounts</span></div><ArrowUpRight aria-hidden="true" /></Link>
        </nav>
        <p className="om-legal">Educational only — not financial advice. You approve every action on your own account.{isSample && " Sample data: this page is a review of the design, and none of its figures, prices or results are a member's."}</p>
      </div>
    </div>
  );
}
