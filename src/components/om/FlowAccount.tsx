"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Eye, EyeOff, Link2, RefreshCw } from "lucide-react";
import {
  ageText, figuresState, money, periodOf,
  type FloorAccount, type FloorOverview, type FloorPeriod,
} from "@/lib/floor/overview";

export type FlowAccountState = "loading" | "ready" | "error" | "off";
export type FlowAccountValue = {
  ov: FloorOverview | null;
  state: FlowAccountState;
  failed: boolean;
  switching: boolean;
  hide: boolean;
  now: number;
  genxPeriod: FloorPeriod;
  flowPeriod: FloorPeriod;
  chooseAccount: (account: FloorAccount) => void;
  toggleHide: () => void;
  setGenxPeriod: (period: FloorPeriod) => void;
  setFlowPeriod: (period: FloorPeriod) => void;
  refresh: () => Promise<void>;
};

const Context = createContext<FlowAccountValue | null>(null);
const KEY_ACCOUNT = "om:floor:account", KEY_GENX = "om:floor:genx", KEY_FLOW = "om:floor:flow", KEY_HIDE = "om:floor:hide";
const EVERY_MS = 60_000;
const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* The choice still lasts for this visit. */ } },
};
type Pick = { id: string; env: "live" | "demo" } | null;

/**
 * One read-only account view for the shell, The Floor, and FLOW. The view selection is never a trading
 * destination or an automation setting. Those remain owned by FLOW's existing authenticated controls.
 * Returning null outside the provider lets review/classic surfaces keep their own isolated loader.
 */
export function useFlowAccount(): FlowAccountValue | null { return useContext(Context); }

export function FlowAccountProvider({ children, configured = true }: { children: React.ReactNode; configured?: boolean }) {
  const [ov, setOv] = useState<FloorOverview | null>(null);
  const [state, setState] = useState<FlowAccountState>(configured ? "loading" : "off");
  const [failed, setFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pick, setPick] = useState<Pick>(null);
  const [genxPeriod, updateGenxPeriod] = useState<FloorPeriod>("7d");
  const [flowPeriod, updateFlowPeriod] = useState<FloorPeriod>("today");
  const [hide, setHide] = useState(false);
  const [now, setNow] = useState(0);
  const [prefs, setPrefs] = useState(false);
  const query = useRef({ pick, genxPeriod, flowPeriod });
  query.current = { pick, genxPeriod, flowPeriod };
  const allowed = useRef(false);
  const seq = useRef(0);
  const request = useRef<AbortController | null>(null);
  const retries = useRef(0);
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const saved = store.get(KEY_ACCOUNT);
    if (saved) {
      const i = saved.indexOf(":"), env = saved.slice(0, i), id = saved.slice(i + 1);
      if (i > 0 && id && (env === "live" || env === "demo")) setPick({ env, id });
    }
    updateGenxPeriod(periodOf(store.get(KEY_GENX), "7d"));
    updateFlowPeriod(periodOf(store.get(KEY_FLOW), "today"));
    setHide(store.get(KEY_HIDE) === "1");
    setNow(Date.now());
    setPrefs(true);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(clock);
  }, []);

  const invalidate = useCallback(() => {
    // Invalidate before React's next effect: an old account's response cannot win a rapid switch.
    seq.current += 1;
    request.current?.abort();
    request.current = null;
    if (again.current) { clearTimeout(again.current); again.current = null; }
  }, []);

  const load = useCallback(async () => {
    if (!allowed.current) return;
    invalidate();
    const mine = seq.current;
    const controller = new AbortController();
    request.current = controller;
    const current = query.current;
    const headers: Record<string, string> = {};
    if (current.pick) {
      // Account identifiers stay out of the URL. The endpoint independently validates ownership.
      headers["x-floor-account"] = current.pick.id;
      headers["x-floor-env"] = current.pick.env;
    }
    try {
      const response = await fetch(`/api/floor/overview?gp=${current.genxPeriod}&fp=${current.flowPeriod}&tz=${new Date().getTimezoneOffset()}`, { cache: "no-store", headers, signal: controller.signal });
      const data = (await response.json().catch(() => null)) as (FloorOverview & { error?: string }) | null;
      if (mine !== seq.current || !allowed.current) return;
      if (data?.error === "not_configured") {
        setOv(null); setState("off"); setFailed(false); setSwitching(false); return;
      }
      if (!response.ok || !data || data.error) {
        setState((previous) => previous === "ready" ? previous : "error");
        setFailed(true); setSwitching(false); return;
      }
      setOv(data); setState("ready"); setFailed(false); setSwitching(false); setNow(Date.now());
      // Preserve the broker's short deferred-reading retry, bounded to three attempts per selection.
      if (data.figures?.reading && retries.current < 3) {
        retries.current += 1;
        again.current = setTimeout(() => { again.current = null; void loadRef.current(); }, 5000);
      } else if (!data.figures?.reading) retries.current = 0;
    } catch {
      if (mine !== seq.current || !allowed.current || controller.signal.aborted) return;
      setState((previous) => previous === "ready" ? previous : "error");
      setFailed(true); setSwitching(false);
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [invalidate]);
  loadRef.current = load;

  useEffect(() => {
    allowed.current = prefs && configured;
    retries.current = 0;
    if (!configured) { invalidate(); setOv(null); setState("off"); setFailed(false); setSwitching(false); return; }
    if (!prefs) return;
    setState((previous) => previous === "off" ? "loading" : previous);
    void load();
    const poll = setInterval(() => { if (document.visibilityState === "visible") void load(); }, EVERY_MS);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      allowed.current = false;
      invalidate();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [prefs, configured, pick?.id, pick?.env, genxPeriod, flowPeriod, invalidate, load]);

  const chooseAccount = useCallback((account: FloorAccount) => {
    const next = { id: account.id, env: account.environment };
    if (query.current.pick?.id === next.id && query.current.pick?.env === next.env) return;
    invalidate();
    query.current = { ...query.current, pick: next };
    retries.current = 0;
    setSwitching(true); setFailed(false);
    // Clear account-specific amounts immediately; keep the source-level GENX record separate.
    setOv((previous) => previous ? { ...previous, account, figures: null, flow: null } : previous);
    setPick(next);
    store.set(KEY_ACCOUNT, `${account.environment}:${account.id}`);
  }, [invalidate]);
  const setGenxPeriod = useCallback((period: FloorPeriod) => {
    const next = periodOf(period, "7d");
    if (query.current.genxPeriod === next) return;
    invalidate(); query.current = { ...query.current, genxPeriod: next };
    setFailed(false); updateGenxPeriod(next); store.set(KEY_GENX, next);
  }, [invalidate]);
  const setFlowPeriod = useCallback((period: FloorPeriod) => {
    const next = periodOf(period, "today");
    if (query.current.flowPeriod === next) return;
    invalidate(); query.current = { ...query.current, flowPeriod: next };
    setFailed(false); updateFlowPeriod(next); store.set(KEY_FLOW, next);
  }, [invalidate]);
  const toggleHide = useCallback(() => setHide((previous) => {
    store.set(KEY_HIDE, previous ? "0" : "1"); return !previous;
  }), []);
  const refresh = useCallback(async () => { await loadRef.current(); }, []);
  const value = useMemo<FlowAccountValue>(() => ({
    ov, state, failed, switching, hide, now, genxPeriod, flowPeriod,
    chooseAccount, toggleHide, setGenxPeriod, setFlowPeriod, refresh,
  }), [ov, state, failed, switching, hide, now, genxPeriod, flowPeriod, chooseAccount, toggleHide, setGenxPeriod, setFlowPeriod, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Compact, real account figures only. Connection health is not trading permission or automation state. */
export function FlowAccountBar() {
  const account = useFlowAccount();
  const [expanded, setExpanded] = useState(false);
  if (!account) return null;
  const { ov, state, failed, switching, hide, now, chooseAccount, toggleHide, refresh } = account;
  const selected = ov?.account ?? null;
  const figures = switching ? null : ov?.figures ?? null;
  const waiting = state === "loading" || switching;
  const fresh = !!figures && figures.state === "live" && figuresState(figures.at, now, true) === "live" && !failed;
  const key = (item: FloorAccount) => `${item.environment}:${item.id}`;
  const hasAccounts = !!ov?.accountsKnown && !!selected;
  let status = "Account figures unavailable";
  if (waiting) status = switching ? "Reading selected account…" : "Reading your accounts…";
  else if (state === "off") status = "Account connection unavailable";
  else if (ov && !ov.accountsKnown) status = "Accounts could not be loaded";
  else if (ov?.accountsKnown && !selected) status = "Connect a broker account in FLOW";
  else if (selected?.connection === "attention") status = "Reconnect in FLOW";
  else if (fresh) status = `Updated ${ageText(figures!.at, now)}`;
  else if (figures?.reading) status = figures.at ? `Reading broker · last read ${ageText(figures.at, now)}` : "Reading your broker…";
  else if (figures?.at) status = `Last reading ${ageText(figures.at, now)}${failed ? " · refresh unavailable" : ""}`;
  else if (failed) status = "Refresh unavailable · retrying";
  const cash = (value: number | null | undefined, sign = false) => value == null ? "—" : hide ? "••••••" : money(value, selected?.currency, { sign });
  const stats = [
    { label: "Balance", value: figures?.balance, sign: false, title: "Broker balance for the selected account" },
    { label: "Equity", value: figures?.equity, sign: false, title: "Broker equity for the selected account" },
    { label: "Open P&L", value: figures?.openPnl, sign: true, title: "Open profit and loss across the whole selected account" },
  ];
  return (
    <section className="om-flow-account" data-expanded={expanded || undefined} data-empty={!!ov?.accountsKnown && !selected && !waiting || undefined} aria-label="FLOW account overview" aria-busy={waiting}>
      <div className="om-flow-account-brand"><Link2 width={16} height={16} aria-hidden="true" /><span>FLOW</span></div>
      <div className="om-flow-account-select-area">
        {hasAccounts ? (
          <div className="om-flow-account-picker">
            <select aria-label="Account shown" aria-describedby="om-flow-account-view-note" value={key(selected!)} data-no-i18n translate="no"
              onChange={(event) => { const next = ov!.accounts.find((item) => key(item) === event.target.value); if (next && key(next) !== key(selected!)) chooseAccount(next); }}>
              {ov!.accounts.map((item) => <option key={key(item)} value={key(item)}>{item.name} · {item.environment === "live" ? "Live" : "Demo"} · {item.masked}</option>)}
            </select>
            <ChevronDown width={13} height={13} aria-hidden="true" />
          </div>
        ) : <strong className="om-flow-account-name">{waiting ? "Your accounts" : ov?.accountsKnown ? "No account connected" : "Your accounts"}</strong>}
        <span className="om-flow-account-meta" title={figures?.note ?? undefined}>
          <i data-tone={selected?.connection === "connected" && fresh ? "connected" : "unknown"} aria-hidden="true" />
          <span data-no-i18n translate="no">{selected ? `${selected.broker} · ` : ""}{status}</span>
        </span>
        <span id="om-flow-account-view-note" className="om-flow-account-sr">This selects the account to view. It does not change which accounts trade.</span>
      </div>
      <div className="om-flow-account-figures" id="om-flow-account-figures">
        {stats.map((stat) => (
          <div className="om-flow-account-stat" key={stat.label} title={stat.title}>
            <span className="om-flow-account-label">{stat.label}</span>
            <span className="om-flow-account-number" data-no-i18n translate="no" data-stale={figures && !fresh ? true : undefined}
              data-tone={stat.sign && fresh && !hide && stat.value != null ? stat.value > 0 ? "positive" : stat.value < 0 ? "negative" : undefined : undefined}>
              {waiting ? <span className="om-flow-account-placeholder" aria-label="Loading" /> : cash(stat.value, stat.sign)}
            </span>
          </div>
        ))}
      </div>
      <div className="om-flow-account-actions">
        <button type="button" className="om-flow-account-icon" onClick={toggleHide} aria-pressed={hide} aria-label={hide ? "Show amounts" : "Hide amounts"} title={hide ? "Show amounts" : "Hide amounts"}>
          {hide ? <EyeOff width={16} height={16} aria-hidden="true" /> : <Eye width={16} height={16} aria-hidden="true" />}
        </button>
        {failed && <button type="button" className="om-flow-account-icon" onClick={() => void refresh()} aria-label="Refresh account figures" title="Refresh account figures"><RefreshCw width={15} height={15} aria-hidden="true" /></button>}
      </div>
      <a href="/portal/trading?view=flow#flow-settings" className="om-flow-account-manage">{ov?.accountsKnown && !selected ? "Connect FLOW" : "Manage FLOW"}<ArrowUpRight width={13} height={13} aria-hidden="true" /></a>
      <button type="button" className="om-flow-account-expand" aria-expanded={expanded} aria-controls="om-flow-account-figures" onClick={() => setExpanded((open) => !open)}>
        {expanded ? "Less" : "Account details"}<ChevronDown width={14} height={14} aria-hidden="true" />
      </button>
    </section>
  );
}
