"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, ChevronDown, Link2, Loader2, RefreshCw } from "lucide-react";
import { Drawer } from "@/components/om/Drawer";
import { BE_PIPS_CHOICES, FOLLOW_MODES, PARTIAL_CHOICES, type FollowMode, type PartialPct } from "@/lib/flow/manageSettings";
import { MGMT_APPLIES, MGMT_UNREAD, BE_LABEL, FOLLOW_LABEL, PARTIALS_LABEL, FOLLOW_NAMES, beLine, followLine, PARTIAL_LINES, mgmtSummary } from "@/lib/flow/manageCopy";
import { accountName, maskAccount } from "@/lib/floor/overview";
import type { MgmtChange } from "@/components/portal/floor/TradeManagement";

/**
 * FLOW'S EXECUTION, IN THE PLATFORM'S SHELL (owner 11-20 brief §9).
 *
 * What one account takes and how — the summary beside the account's results — and, behind "Manage
 * execution", that account's settings grouped as Connection, Signal sources, Risk and Trade management.
 *
 * This file only draws. Every value comes from FlowConnect's state and every control calls FlowConnect's
 * own handler, so what is saved, when, and for which account is exactly what it was: each choice saves the
 * moment it is made, one account at a time, and nothing here reads or writes anything of its own.
 *
 * The words say what the service actually does (src/lib/flow/armState.ts, autoExec.ts, flowBilling.ts):
 *   Trading            this account takes GENX trades, and FLOW's forex and index trades while Auto-run is on;
 *                      tickets placed with Execute go to every account with Trading on.
 *   Follow GENX        this account takes every GENX signal. With Trading also on, Trading's fill is used.
 *   Auto-run FLOW      the member's master switch. Off: no automated trade reaches any account, and the
 *                      service switches Trading and Follow GENX off on all of them. Never set: FLOW's own
 *                      trades are not placed, GENX's still are.
 * A switch being on is a saved choice. Whether the service is acting on it is said separately, and only
 * from what the service itself reports (paused for credits, a Pass), never from the switch.
 */

export type ManageView = null | "settings" | "connect";

export type ExecAccount = {
  accountId: string; accNum?: string | null; name?: string | null; environment?: string; connectionId?: string;
  autotradeEnabled?: boolean; genxFollower?: boolean; riskPct?: number | null; riskMode?: string | null;
  manageTrades?: boolean; beEnabled?: boolean; breakEvenPips?: number; goldBePips?: number | null;
  followPrice?: FollowMode; followActive?: boolean; partialPct?: number; partialsEnabled?: boolean; profitGuard?: boolean;
  settingsUnread?: boolean; selected?: boolean;
  genfx?: { eurusd: boolean; gbpjpy: boolean };
};

export type ExecAuto = { enabled?: boolean; set?: boolean; paused?: boolean; credits?: number | null; pass?: boolean; passUntil?: string | null } | null;

export type ExecControls = {
  loading: boolean;
  connected: boolean;
  conn: { environment?: string; server?: string; email?: string } | null;
  accounts: ExecAccount[];
  view: ExecAccount | null;
  /** The name The Floor and FLOW's header use for this account, when it is the one being looked at there. */
  viewName: string | null;
  /** That account's connection, as The Floor reads it. */
  health: "connected" | "attention" | null;
  auto: ExecAuto;
  /**
   * Whether the page knows which account it is looking at. Until it does — and until the Auto-run setting has
   * been read — the panel says it is loading, and summarises no account (owner 11-21: FLOW showed "Taken ·
   * Trading on" for a moment before the chosen account's "Trading off" arrived).
   */
  viewReady?: boolean;
  /** The Auto-run setting could not be read. */
  autoFailed?: boolean;
  defaultRisk: number;
  riskLocked: boolean;
  autoBusy: boolean;
  autoMsg: string;
  /** The owner is signed in: the platform-wide switches exist, on their own page. */
  owner: boolean;
  busy: boolean;
  err: string;
  ok: string;
  mgmtBusy: boolean;
  mgmtErr: string;
  form: {
    env: "demo" | "live"; server: string; email: string; password: string; adding: boolean;
    setEnv: (v: "demo" | "live") => void; setServer: (v: string) => void; setEmail: (v: string) => void; setPassword: (v: string) => void;
    setAdding: (v: boolean) => void; connect: () => void;
  };
  onTrading: (a: ExecAccount, on: boolean) => void;
  onFollow: (a: ExecAccount, on: boolean) => void;
  onRisk: (a: ExecAccount, v: number | null) => void;
  onMgmt: (a: ExecAccount, c: MgmtChange) => void;
  onMode: (a: ExecAccount, m: "conservative" | "aggressive") => void;
  onDefaultRisk: (v: number) => void;
  onAuto: (on: boolean) => void;
  onRecheck: () => void;
  onDisconnect: () => void;
  manage: ManageView;
  onManage: (v: ManageView) => void;
};

const ACCT_RISK = [0.25, 0.5, 1, 1.5, 2, 3, 5];
const DEFAULT_RISK = [0.5, 1, 2, 3];

const envWord = (e?: string | null) => (String(e ?? "").toLowerCase() === "live" ? "Live" : "Demo");
const nameOf = (a: ExecAccount, viewName: string | null) =>
  viewName ?? accountName(a.name, String(a.environment ?? "").toLowerCase() === "live" ? "live" : "demo", maskAccount(a.accountId, a.accNum));
const shortDate = (iso?: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
};

/** The master switch in words: on, off, or never set — three different things the service does. */
function autoState(auto: ExecAuto, failed = false): { on: boolean; label: string; line: string } {
  if (!auto && failed) return { on: false, label: "could not be read", line: "Your Auto-run setting could not be read just now, so what reaches this account automatically is not shown. Nothing was changed." };
  if (!auto) return { on: false, label: "reading…", line: "" };
  if (auto.enabled) return { on: true, label: "On", line: "FLOW places its forex and index trades on accounts with Trading on. GENX trades reach accounts with Trading or Follow GENX on." };
  if (auto.set === false) return { on: false, label: "Not switched on", line: "FLOW's own forex and index trades are not placed. GENX trades still reach accounts with Trading or Follow GENX on." };
  return { on: false, label: "Off", line: "No automated trade reaches any of your accounts — neither FLOW's nor GENX's." };
}

/** What the service itself reports about the master switch — never inferred from the switch. */
function serviceLine(auto: ExecAuto): string | null {
  if (!auto) return null;
  if (auto.pass) { const d = shortDate(auto.passUntil); return `FLOW Pass${d ? ` until ${d}` : ""}: FLOW and GENX use no credits.`; }
  if (auto.paused) return "Paused by FLOW: out of credits. It starts again on its own once you top up.";
  return null;
}

function Switch({ on, label, disabled, onClick }: { on: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="om-switch" disabled={disabled} onClick={onClick}><span aria-hidden="true" /></button>;
}

function Choice<T extends string | number>({ value, options, label, disabled, onPick, name }: {
  value: T | null; options: readonly T[]; label: string; disabled?: boolean; onPick: (v: T) => void; name: (v: T) => string;
}) {
  return (
    <div className="om-toggles" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o)} type="button" aria-pressed={value === o} disabled={disabled} onClick={() => value !== o && onPick(o)}>{name(o)}</button>
      ))}
    </div>
  );
}

/* ── the summary beside the results ───────────────────────────────────────────────────────────── */

export function FlowExecution(c: ExecControls) {
  const { view, auto } = c;
  const asideRef = useRef<HTMLElement>(null);

  const { manage, onManage, loading, connected } = c;
  const setAdding = c.form.setAdding;
  // "Manage accounts". With nothing connected yet the connect form is already on screen: take the member to it.
  // Connected: open the settings panel on its connect form ("Back to settings" then shows the account's settings).
  useEffect(() => {
    if (manage !== "connect" || loading) return;
    if (connected) { setAdding(true); onManage("settings"); return; }
    asideRef.current?.scrollIntoView({ block: "center" });
    asideRef.current?.querySelector<HTMLInputElement>("input:not([type=hidden])")?.focus();
    onManage(null);
  }, [manage, loading, connected, setAdding, onManage]);

  const drawerOpen = connected && manage === "settings";
  const close = () => { setAdding(false); onManage(null); };

  let body: React.ReactNode;
  if (c.loading && !c.connected && !c.accounts.length) {
    body = <div className="om-flow-exec-skel" aria-busy="true"><span className="om-skel" style={{ width: 120, height: 20 }} /><span className="om-skel" style={{ width: "100%", height: 120 }} /></div>;
  } else if (!c.connected) {
    body = <ConnectForm c={c} title="Connect a broker" />;
  } else if (c.viewReady === false || (!auto && !c.autoFailed)) {
    // Neutral until this account's own settings and the Auto-run setting are both in: no state is guessed, and
    // nothing here can be pressed yet.
    body = (
      <div className="om-flow-exec-wait" aria-busy="true">
        <div className="om-flow-exec-head"><h2>Execution</h2><p className="om-label" role="status">Loading account status…</p></div>
        <span className="om-skel" style={{ width: "100%", height: 18 }} aria-hidden="true" />
        <span className="om-skel" style={{ width: "86%", height: 18 }} aria-hidden="true" />
        <span className="om-skel" style={{ width: "64%", height: 18 }} aria-hidden="true" />
      </div>
    );
  } else if (!view) {
    body = <p className="om-empty">This account&rsquo;s settings could not be read just now. <button type="button" className="om-go" onClick={c.onRecheck}>Try again</button></p>;
  } else {
    const st = autoState(auto, c.autoFailed);
    const off = !!auto && auto.set === true && auto.enabled === false;
    const unknown = !auto;      // the Auto-run setting could not be read: what it allows is not claimed
    const genx = unknown ? (view.autotradeEnabled || view.genxFollower ? "Depends on Auto-run, which could not be read" : "Not taken") : off ? "Not taken · Auto-run off" : view.autotradeEnabled ? "Taken · Trading on" : view.genxFollower ? "Every signal · Follow on" : "Not taken";
    const flow = !view.autotradeEnabled ? "Not taken · Trading off" : unknown ? "Depends on Auto-run, which could not be read" : auto.enabled ? "Taken · Auto-run on" : "Not taken · Auto-run not on";
    const fx = view.genfx && (view.genfx.eurusd || view.genfx.gbpjpy) ? [view.genfx.eurusd && "EUR/USD", view.genfx.gbpjpy && "GBP/JPY"].filter(Boolean).join(", ") + " · switched on in GEN FX" : null;
    const eff = view.riskPct ?? c.defaultRisk;
    const service = serviceLine(auto);
    body = (
      <>
        <div className="om-flow-exec-head">
          <h2>Execution</h2>
          <p className="om-label" data-no-i18n translate="no">{nameOf(view, c.viewName)} · {envWord(view.environment)}</p>
        </div>
        <dl className="om-kv">
          <div><dt>GENX trades</dt><dd>{genx}</dd></div>
          <div><dt>FLOW forex and index</dt><dd>{flow}</dd></div>
          {fx && <div><dt>GEN FX</dt><dd>{fx}</dd></div>}
          <div><dt>Your tickets</dt><dd>{view.autotradeEnabled ? "Placed here when you tap Execute" : "Not placed here · Trading off"}</dd></div>
        </dl>
        <hr className="om-hr" />
        <dl className="om-kv">
          <div><dt>Risk per trade</dt><dd className="om-num">{eff}% <small>{view.riskPct == null ? "your default" : "this account"}</small></dd></div>
          <div><dt>Open trades</dt><dd>{mgmtSummary(view) || "—"}</dd></div>
          <div><dt>After 2 losses in a row</dt><dd>{view.riskMode === "aggressive" ? "Keeps trading" : "Sits out 2 hours"}</dd></div>
        </dl>
        <hr className="om-hr" />
        <div className="om-flow-auto">
          <p><span className="om-dot" data-tone={st.on ? "ok" : "warn"} /> Auto-run FLOW · <b>{st.label}</b></p>
          <p className="om-label">{st.line}</p>
          {service && <p className="om-label">{service}</p>}
        </div>
        <button type="button" className="om-btn om-flow-manage" onClick={() => c.onManage("settings")}>Manage execution</button>
        {c.ok && <p className="om-flow-ok" role="status">{c.ok}</p>}
        {c.owner && <a className="om-go om-flow-admin" href="/admin/controls">Platform-wide switches are in Admin · Controls<ArrowUpRight aria-hidden="true" /></a>}
      </>
    );
  }

  return (
    <>
      <aside ref={asideRef} className="om-panel om-flow-exec" aria-label="Execution">{body}</aside>
      <Drawer id="om-flow-manage" open={drawerOpen} onClose={close} title={c.form.adding ? "Connect another account" : "Manage execution"}
        sub={view && !c.form.adding ? <span data-no-i18n translate="no">{nameOf(view, c.viewName)} · {envWord(view.environment)}</span> : undefined}>
        {c.form.adding ? <ConnectForm c={c} title={null} back={() => setAdding(false)} />
          : view && c.viewReady !== false ? <Settings c={c} a={view} />
            : <p className="om-label" role="status">Loading account status…</p>}
      </Drawer>
    </>
  );
}

/* ── connecting a broker ──────────────────────────────────────────────────────────────────────── */

function ConnectForm({ c, title, back }: { c: ExecControls; title: string | null; back?: () => void }) {
  const f = c.form;
  return (
    <div className="om-flow-connect">
      {back && <button type="button" className="om-go om-flow-back" onClick={back}>‹ Back to settings</button>}
      {title && <div className="om-flow-exec-head"><h2>{title}</h2><p className="om-label">TradeLocker. Your login goes straight to the broker and is stored encrypted.</p></div>}
      <div className="om-field">
        <span className="om-label">Account type</span>
        <div className="om-seg" role="group" aria-label="Account type">
          <button type="button" aria-pressed={f.env === "demo"} onClick={() => f.setEnv("demo")}>Demo</button>
          <button type="button" aria-pressed={f.env === "live"} onClick={() => f.setEnv("live")}>Live</button>
        </div>
        <p className="om-faint" style={{ fontSize: 12.5 }}>{f.env === "live" ? "Your real, funded account." : "Practice money. You can connect both."}</p>
      </div>
      <label className="om-field"><span className="om-label">Server</span><input className="om-input" value={f.server} onChange={(e) => f.setServer(e.target.value)} placeholder="e.g. GENFX" autoComplete="off" /></label>
      <label className="om-field"><span className="om-label">TradeLocker email</span><input className="om-input" type="email" value={f.email} onChange={(e) => f.setEmail(e.target.value)} placeholder="you@email.com" autoComplete="off" /></label>
      <label className="om-field"><span className="om-label">TradeLocker password</span><input className="om-input" type="password" value={f.password} onChange={(e) => f.setPassword(e.target.value)} autoComplete="off" /></label>
      {c.err && <p className="om-flow-err" role="alert"><AlertTriangle aria-hidden="true" /> {c.err}</p>}
      <button type="button" className="om-btn" onClick={f.connect} disabled={c.busy || !f.server || !f.email || !f.password}>
        {c.busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}{c.busy ? "Connecting…" : "Connect account"}
      </button>
      <p className="om-label om-flow-note">
        A new account starts with <b>Trading on</b>, so it can take GENX trades once it is connected. Check its switches under Manage execution, or switch Trading off there.
        {f.env === "live" ? " This is real money." : ""} Never share your withdrawal password.
      </p>
      {c.ok && <p className="om-flow-ok" role="status">{c.ok}</p>}
    </div>
  );
}

/* ── one account's settings ───────────────────────────────────────────────────────────────────── */

function Section({ title, scope, children }: { title: string; scope?: string; children: React.ReactNode }) {
  return (
    <section className="om-set">
      <div className="om-set-head"><h3>{title}</h3>{scope && <span className="om-label">{scope}</span>}</div>
      {children}
    </section>
  );
}

function Settings({ c, a }: { c: ExecControls; a: ExecAccount }) {
  const [sure, setSure] = useState(false);
  const [why, setWhy] = useState(false);
  const trading = a.autotradeEnabled === true;
  const follows = a.genxFollower === true;
  const eff = a.riskPct ?? c.defaultRisk;
  const st = autoState(c.auto, c.autoFailed);
  const service = serviceLine(c.auto);
  const beOn = a.beEnabled !== false;
  const pips = a.breakEvenPips ?? 30;
  const ownPips = beOn && !BE_PIPS_CHOICES.includes(pips) ? pips : null;
  const follow: FollowMode = a.followPrice ?? "normal";
  const partial: PartialPct = a.partialPct === 25 || a.partialPct === 50 ? a.partialPct : 0;
  const mode = a.riskMode === "aggressive" ? "aggressive" : "conservative";
  const beChoices: readonly (number | "off")[] = ["off", ...(ownPips != null ? [ownPips] : []), ...BE_PIPS_CHOICES];

  return (
    <div className="om-sets">
      <Section title="Connection">
        <dl className="om-kv">
          <div><dt>Broker</dt><dd>TradeLocker · {envWord(c.conn?.environment)}</dd></div>
          <div><dt>Status</dt><dd>{c.health === "attention" ? <><span className="om-dot" data-tone="off" /> Needs reconnecting</> : <><span className="om-dot" data-tone="ok" /> Connected</>}</dd></div>
          <div><dt>Accounts</dt><dd>{c.accounts.length} connected · {c.accounts.filter((x) => x.autotradeEnabled).length} with Trading on</dd></div>
        </dl>
        <button type="button" className="om-disclose" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
          <span className="om-label">Connection details</span><ChevronDown aria-hidden="true" />
        </button>
        {why && (
          <dl className="om-kv om-kv-quiet" data-no-i18n translate="no">
            <div><dt>Server</dt><dd>{c.conn?.server || "—"}</dd></div>
            <div><dt>Login</dt><dd>{c.conn?.email || "—"}</dd></div>
            <div><dt>Account number</dt><dd>{a.accNum || a.accountId}</dd></div>
          </dl>
        )}
        <div className="om-set-acts">
          <button type="button" className="om-btn-quiet" onClick={c.onRecheck}><RefreshCw aria-hidden="true" width={14} height={14} />Re-check</button>
          <button type="button" className="om-btn-quiet" onClick={() => c.form.setAdding(true)}><Link2 aria-hidden="true" width={14} height={14} />Connect another account</button>
          {!sure && <button type="button" className="om-btn-quiet om-danger" onClick={() => setSure(true)}>Disconnect…</button>}
        </div>
        {sure && (
          <div className="om-confirm" role="group" aria-label="Disconnect">
            <p>This disconnects every broker login you have connected to FLOW, not just this account. Trades already open stay at your broker with their stop and target, and FLOW stops looking after them.</p>
            <div className="om-set-acts">
              <button type="button" className="om-btn-quiet om-danger" disabled={c.busy} onClick={() => { setSure(false); c.onDisconnect(); }}>Yes, disconnect</button>
              <button type="button" className="om-btn-quiet" onClick={() => setSure(false)}>Keep connected</button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Signal sources" scope="New trades on this account">
        <div className="om-src-row">
          <div><b>Trading</b><p className="om-label">Takes GENX trades, and FLOW&rsquo;s forex and index trades while Auto-run is on. Tickets you place with Execute go to every account with Trading on.</p></div>
          <Switch on={trading} label="Trading on this account" onClick={() => c.onTrading(a, !trading)} />
        </div>
        <div className="om-src-row">
          <div><b>Follow every GENX signal</b><p className="om-label">Takes every GENX signal at this account&rsquo;s risk. If Trading is on too, Trading&rsquo;s fill is used — never both.</p></div>
          <Switch on={follows} label="Follow every GENX signal on this account" onClick={() => c.onFollow(a, !follows)} />
        </div>
        {a.genfx && (
          <div className="om-src-row">
            <div><b>GEN FX</b><p className="om-label">{a.genfx.eurusd || a.genfx.gbpjpy ? `${[a.genfx.eurusd && "EUR/USD", a.genfx.gbpjpy && "GBP/JPY"].filter(Boolean).join(" and ")} switched on.` : "No pair switched on."} Set on the GEN FX desk.</p></div>
          </div>
        )}
        <p className="om-label om-flow-note">To pause new entries on this account, switch off Trading and Follow every GENX signal. Trades already open stay open and keep being looked after as set under Trade management.</p>
        <div className="om-src-row om-src-master">
          <div>
            <b>Auto-run FLOW · {st.label}</b>
            <p className="om-label">All your accounts. {st.line} Switching it off also switches Trading and Follow GENX off on every account.</p>
            {service && <p className="om-label">{service}</p>}
            {!c.auto?.pass && <p className="om-label">1 credit when a setup starts forming and 5 when a trade is placed — once each, however many accounts. Credits: <span className="om-num">{c.auto?.credits ?? "—"}</span>.</p>}
            {c.autoMsg && <p className="om-flow-ok" role="status">{c.autoMsg}</p>}
          </div>
          {/* A switch whose position could not be read is not offered: pressing it would set something unseen. */}
          <Switch on={st.on} label="Auto-run FLOW on all your accounts" disabled={c.autoBusy || !c.auto} onClick={() => { if (c.auto) c.onAuto(!c.auto.enabled); }} />
        </div>
      </Section>

      <Section title="Risk" scope="Sizes new trades">
        <div className="om-field">
          <span className="om-label">This account · {a.riskPct == null ? `using your default, ${c.defaultRisk}%` : `set to ${a.riskPct}%`}</span>
          <div className="om-toggles" role="group" aria-label="Risk per trade on this account">
            <button type="button" aria-pressed={a.riskPct == null} onClick={() => a.riskPct != null && c.onRisk(a, null)}>Default</button>
            {ACCT_RISK.map((v) => <button key={v} type="button" aria-pressed={a.riskPct === v} onClick={() => a.riskPct !== v && c.onRisk(a, v)}>{v}%</button>)}
          </div>
          {eff > 2 && <p className="om-flow-warn" role="note">{eff}% needs at least $2,000 in this account. Below that, trades are sized at 2% or less.</p>}
          <p className="om-faint om-flow-small">Around $500? Pick 0.5% or lower — it is capped there automatically. If a full-size trade does not fit your margin, it is taken at 0.01 lots instead of skipped.</p>
        </div>
        <div className="om-field">
          <span className="om-label">Your default · every account without its own{c.riskLocked ? ` · saved at ${c.defaultRisk}%` : ""}</span>
          <Choice value={c.riskLocked ? c.defaultRisk : null} options={DEFAULT_RISK} label="Default risk per trade" onPick={c.onDefaultRisk} name={(v) => `${v}%`} />
        </div>
      </Section>

      <Section title="Trade management" scope={MGMT_APPLIES}>
        {a.settingsUnread ? <p className="om-flow-warn" role="status">{MGMT_UNREAD}</p> : (
          <>
            <div className="om-field">
              <span className="om-label">{BE_LABEL}{c.mgmtBusy ? " · saving…" : ""}</span>
              <Choice value={beOn ? pips : "off"} options={beChoices} label="Break-even" disabled={c.mgmtBusy}
                onPick={(v) => c.onMgmt(a, { breakEven: v === "off" ? "off" : v })} name={(v) => (v === "off" ? "Off" : `${v} pips`)} />
              <p className="om-faint om-flow-small">{beLine(beOn, pips)}</p>
            </div>
            <div className="om-field">
              <span className="om-label">{FOLLOW_LABEL}</span>
              <Choice value={follow} options={FOLLOW_MODES} label="Follow price" disabled={c.mgmtBusy || !beOn} onPick={(v) => c.onMgmt(a, { followPrice: v })} name={(v) => FOLLOW_NAMES[v]} />
              <p className="om-faint om-flow-small">{followLine(follow, beOn)}</p>
            </div>
            <div className="om-field">
              <span className="om-label">{PARTIALS_LABEL}</span>
              <Choice value={partial} options={PARTIAL_CHOICES} label="Partials" disabled={c.mgmtBusy} onPick={(v) => c.onMgmt(a, { partials: v })} name={(v) => (v === 0 ? "Off" : `${v}%`)} />
              <p className="om-faint om-flow-small">{PARTIAL_LINES[partial]}</p>
            </div>
            {c.mgmtErr && <p className="om-flow-err" role="status"><AlertTriangle aria-hidden="true" /> {c.mgmtErr}</p>}
          </>
        )}
        <div className="om-field">
          <span className="om-label">After 2 losses in a row · new trades</span>
          <div className="om-seg" role="group" aria-label="Safety mode">
            <button type="button" aria-pressed={mode === "conservative"} onClick={() => mode !== "conservative" && c.onMode(a, "conservative")}>Conservative</button>
            <button type="button" aria-pressed={mode === "aggressive"} onClick={() => mode !== "aggressive" && c.onMode(a, "aggressive")}>Aggressive</button>
          </div>
          <p className="om-faint om-flow-small">{mode === "conservative" ? "Sits this account out for 2 hours after 2 losses in a row (gold and forex counted separately)." : "No pause after losses."}</p>
        </div>
      </Section>

      <p className="om-faint om-flow-small">Each change saves as you make it.</p>
    </div>
  );
}
