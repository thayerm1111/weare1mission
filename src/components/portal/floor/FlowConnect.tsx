"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link2,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Lock,
  Wallet,
  Gauge,
  Coins,
  Zap,
} from "lucide-react";
import { FlowTour } from "./FlowTour";
import { TradeManagement, optimisticMgmt, type MgmtChange } from "./TradeManagement";
import type { FollowMode } from "@/lib/flow/manageSettings";

// RETIRED ENGINES (owner 09-13: "Turn off Matty pips and send it... Hide Matty pips and
// send it as options to turn on. Nobody can have that turned on"). Only FLOW/GENX auto
// remains. Set back to true only to bring these options back.
const SHOW_LEGACY_ENGINES = false;

/* FLOW ↔ TradeLocker connect (desktop portal parity with the app's GxBrokerConnect).
 * Credentials are POSTed straight to /api/flow/broker; the browser never stores a
 * token. FLOW shows balances and prepares trades — it never places a live-money
 * order without an explicit per-trade confirmation. */

type Account = {
  accountId: string;
  accNum?: string | null;
  name?: string | null;
  currency?: string | null;
  balance?: number | null;
  equity?: number | null;
  openPositions?: number | null;
  selected?: boolean;
  autotradeEnabled?: boolean;
  genxFollower?: boolean;
  riskPct?: number | null;
  manageTrades?: boolean;
  beEnabled?: boolean;
  partialsEnabled?: boolean;
  profitGuard?: boolean;
  // Which horizons this account takes. Undefined reads as the previous behaviour, never as "off".
  styleQuick?: boolean;
  styleHold?: boolean;
  styleSwing?: boolean;
  sendIt?: boolean;
  sendItStack?: boolean;  // true = every entry (classic) · false = one at a time
  sendItGuards?: boolean; // true = safeguards respected · false = bypassed (classic)
  riskMode?: string | null;
  goldBePips?: number | null;
  // How the AI looks after a trade (owner 10-08) — see TradeManagement.tsx.
  breakEvenPips?: number;
  followPrice?: FollowMode;
  followActive?: boolean;
  partialPct?: number;
  settingsUnread?: boolean;
  connectionId?: string;
  environment?: string;
  server?: string;
};

type ConnView = {
  environment?: "demo" | "live";
  server?: string;
  email?: string;
};

type BrokerState = {
  connected?: boolean;
  connection?: ConnView | null;
  accounts?: Account[];
  selectedAccountId?: string | null;
};

type AutoRun = {
  enabled?: boolean;
  paused?: boolean;
  connected?: boolean;
  riskPct?: number | null;
  credits?: number | null;
  costPer30m?: number;
  /** An active FLOW Pass: FLOW and GENX are unmetered until passUntil. */
  pass?: boolean;
  passUntil?: string | null;
};

const RISK_CHIPS = [0.5, 1, 2, 3];
// Per-account risk options — conservative → aggressive. "" clears the override.
const ACCT_RISK_OPTS = [0.25, 0.5, 1, 1.5, 2, 3, 5];

function marketOpenNow(): boolean {
  const d = new Date();
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 0) return h >= 22;
  if (day === 5) return h < 22;
  return true;
}

function money(n: number | null | undefined) {
  const v = typeof n === "number" ? n : null;
  if (v == null) return "—";
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function FlowConnect() {
  const [state, setState] = useState<BrokerState | null>(null);
  const [loading, setLoading] = useState(true);
  // 🧠 Matty Pips per-account copy state (lives in matty_pips_* tables, read via the
  // matty-pips API — FLOW's own API and tables are untouched by this feature).
  const [mpMap, setMpMap] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/api/matty-pips/accounts");
        const j = await r.json();
        if (!dead && j?.ok && Array.isArray(j.accounts)) {
          const m: Record<string, boolean> = {};
          for (const a of j.accounts as { connection_id: string; account_id: string; enabled: boolean }[]) m[`${a.connection_id}:${a.account_id}`] = a.enabled === true;
          setMpMap(m);
        }
      } catch { /* best-effort */ }
    })();
    return () => { dead = true; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const [env, setEnv] = useState<"demo" | "live">("demo");
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [addingAccount, setAddingAccount] = useState(false);

  const [auto, setAuto] = useState<AutoRun | null>(null);
  const [risk, setRisk] = useState<number>(1);
  const [riskLocked, setRiskLocked] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState("");
  // Owner-only global kill switch. GET returns 404 for non-owners → stays null → hidden.
  const [adminSw, setAdminSw] = useState<{ flow: boolean; genx: boolean } | null>(null);
  const [swBusy, setSwBusy] = useState<string | null>(null);
  // Trade settings being saved, and why one could not be, per account (connectionId:accountId).
  const [mgmtBusy, setMgmtBusy] = useState<Record<string, boolean>>({});
  const [mgmtErr, setMgmtErr] = useState<Record<string, string>>({});
  // The same, read synchronously: a double tap lands before the "saving" state has re-drawn the buttons.
  const mgmtInflight = useRef(new Set<string>());

  const loadAdmin = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/switches", { cache: "no-store" });
      if (r.status === 404) { setAdminSw(null); return; }
      const d = (await r.json()) as { flow?: boolean; genx?: boolean };
      setAdminSw({ flow: d.flow !== false, genx: d.genx !== false });
    } catch { /* noop */ }
  }, []);

  async function saveSwitch(which: "flow" | "genx", next: boolean) {
    if (swBusy) return;
    setSwBusy(which);
    setAdminSw((p) => p ? { ...p, [which]: next } : p); // optimistic
    try {
      const r = await fetch("/api/admin/switches", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ [which]: next }),
      });
      const d = (await r.json()) as { flow?: boolean; genx?: boolean };
      if (d) setAdminSw({ flow: d.flow !== false, genx: d.genx !== false });
    } catch {
      void loadAdmin();
    } finally {
      setSwBusy(null);
    }
  }

  const loadAuto = useCallback(async () => {
    try {
      const r = await fetch("/api/flow/autorun", { cache: "no-store" });
      const d = (await r.json()) as AutoRun;
      setAuto(d || {});
      if (d && typeof d.riskPct === "number" && d.riskPct > 0) {
        setRisk(d.riskPct);
        setRiskLocked(true);
      }
    } catch {
      /* noop */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/flow/broker", { cache: "no-store" });
      const d = (await r.json()) as BrokerState;
      setState(d || {});
    } catch {
      /* leave prior state */
    } finally {
      setLoading(false);
    }
    void loadAuto();
    void loadAdmin();
  }, [loadAuto, loadAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function lockRisk(v: number) {
    setRisk(v);
    setRiskLocked(false);
    setAutoMsg("");
    try {
      await fetch("/api/flow/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ riskPct: v }),
      });
      setRiskLocked(true);
      setAutoMsg(`Risk locked at ${v}% per trade.`);
      void loadAuto();
    } catch {
      setAutoMsg("Couldn't save your risk — try again.");
    }
  }

  async function toggleAuto(on: boolean) {
    if (autoBusy) return;
    setAutoBusy(true);
    setAutoMsg("");
    try {
      const r = await fetch("/api/flow/autorun", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: on ? "enable" : "disable" }),
      });
      const d = await r.json();
      if (!d || d.error) {
        setAutoMsg(d?.detail || "Couldn't update auto-run.");
      } else if (d.lowCredits) {
        setAutoMsg("Auto-run is on, but you're low on credits — it'll pause until you top up.");
      } else {
        setAutoMsg(on ? "Auto-run is ON. FLOW will place your trades automatically." : "Auto-run is off.");
      }
      await loadAuto();
    } catch {
      setAutoMsg("Something went wrong — try again.");
    } finally {
      setAutoBusy(false);
    }
  }

  async function connect() {
    if (busy) return;
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const r = await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          environment: env,
          server: server.trim(),
          email: email.trim(),
          password,
        }),
      });
      const d = await r.json();
      if (!d || d.error) {
        setErr((d && d.detail) || "Couldn't connect — check your details.");
      } else {
        setPassword("");
        setServer("");
        setEmail("");
        setAddingAccount(false);
        setOk(`Connected — ${d.accountsFound || 0} account(s) loaded.`);
        await load();
      }
    } catch {
      setErr("Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAccount(a: Account, enabled: boolean) {
    // Optimistic: flip locally, then persist.
    setState((prev) => prev ? { ...prev, accounts: (prev.accounts || []).map((x) => x.accountId === a.accountId && x.connectionId === a.connectionId ? { ...x, autotradeEnabled: enabled } : x) } : prev);
    try {
      await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "toggle", accountId: a.accountId, connectionId: a.connectionId, enabled }),
      });
    } catch {
      void load();
    }
  }

  async function setAccountRisk(a: Account, riskPct: number | null) {
    // Optimistic: set locally, then persist. null → clear override (use default).
    setState((prev) => prev ? { ...prev, accounts: (prev.accounts || []).map((x) => x.accountId === a.accountId && x.connectionId === a.connectionId ? { ...x, riskPct } : x) } : prev);
    try {
      await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "risk", accountId: a.accountId, connectionId: a.connectionId, riskPct }),
      });
    } catch {
      void load();
    }
  }

  /*
   * HOW THE AI LOOKS AFTER A TRADE (owner 10-08) — break-even, follow price, partials, one change at a
   * time per account. Shown at once; put back, with the reason, if the server refuses or cannot be reached.
   */
  async function setManagement(a: Account, change: MgmtChange) {
    const key = `${a.connectionId || ""}:${a.accountId}`;
    if (a.settingsUnread || mgmtInflight.current.has(key)) return;
    mgmtInflight.current.add(key);
    const same = (x: Account) => x.accountId === a.accountId && x.connectionId === a.connectionId;
    const before = (state?.accounts || []).find(same) ?? a;
    const put = (next: Account) => setState((prev) => prev ? { ...prev, accounts: (prev.accounts || []).map((x) => same(x) ? next : x) } : prev);
    put(optimisticMgmt(before, change));
    setMgmtBusy((b) => ({ ...b, [key]: true }));
    setMgmtErr((e) => ({ ...e, [key]: "" }));
    try {
      const r = await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "management", accountId: a.accountId, connectionId: a.connectionId, ...change }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.error || !d.ok) {
        put(before);
        setMgmtErr((e) => ({ ...e, [key]: (d && typeof d.detail === "string" && d.detail) || "Couldn't save that — try again." }));
      } else {
        // The server saved it to every row of this broker account (the same login can sit on two cards):
        // both cards show what now runs.
        const { manageTrades, beEnabled, breakEvenPips, goldBePips, followPrice, followActive, partialPct, partialsEnabled, profitGuard } = d;
        const view = { manageTrades, beEnabled, breakEvenPips, goldBePips, followPrice, followActive, partialPct, partialsEnabled, profitGuard, settingsUnread: false };
        setState((prev) => prev ? { ...prev, accounts: (prev.accounts || []).map((x) => x.accountId === a.accountId ? { ...x, ...view } : x) } : prev);
      }
    } catch {
      put(before);
      setMgmtErr((e) => ({ ...e, [key]: "Couldn't reach the server — check your connection and try again." }));
    } finally {
      mgmtInflight.current.delete(key);
      setMgmtBusy((b) => ({ ...b, [key]: false }));
    }
  }

  /*
   * WHICH TRADE STYLES THIS ACCOUNT TAKES.
   *
   * Optimistic like the others, with one difference: the last one cannot be switched off. An account
   * that is on and takes nothing looks like a broken system rather than a choice, so the button for
   * the only remaining style simply does not respond, and the line underneath says why.
   */
  async function setAccountMatty(a: Account, enabled: boolean) {
    // 🧠 MATTY PIPS (owner 09-04): copy the standalone Matty Pips AI onto this account.
    // Stored ONLY in matty_pips_* tables via the matty-pips API — FLOW's engine, tables
    // and behavior are untouched; Matty Pips places and manages its own trades.
    setMpMap((prev) => ({ ...prev, [`${a.connectionId}:${a.accountId}`]: enabled }));
    try {
      await fetch("/api/matty-pips/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: a.accountId, connectionId: a.connectionId, accNum: a.accNum, enabled }),
      });
    } catch { /* optimistic; the Matty Pips page shows authoritative state */ }
  }

  async function setAccountMode(a: Account, mode: "conservative" | "aggressive") {
    // Optimistic: flip locally, then persist. Conservative auto-pauses THIS account for 4h
    // after 2 losing trades in a row (gold + forex tracked separately); aggressive has no cap.
    setState((prev) => prev ? { ...prev, accounts: (prev.accounts || []).map((x) => x.accountId === a.accountId && x.connectionId === a.connectionId ? { ...x, riskMode: mode } : x) } : prev);
    try {
      await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mode", accountId: a.accountId, connectionId: a.connectionId, mode }),
      });
    } catch {
      void load();
    }
  }

  async function setAccountFollow(a: Account, enabled: boolean) {
    // Optimistic: flip locally, then persist. Turns this account into a GENX follower —
    // it takes EVERY GENX gold signal, sized to this account's risk % (separate from FLOW).
    setState((prev) => prev ? { ...prev, accounts: (prev.accounts || []).map((x) => x.accountId === a.accountId && x.connectionId === a.connectionId ? { ...x, genxFollower: enabled } : x) } : prev);
    try {
      await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "genxfollow", accountId: a.accountId, connectionId: a.connectionId, enabled }),
      });
    } catch {
      void load();
    }
  }

  async function disconnect() {
    setBusy(true);
    setOk("");
    setErr("");
    try {
      await fetch("/api/flow/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      await load();
    } catch {
      /* noop */
    } finally {
      setBusy(false);
    }
  }

  const connected = !!state?.connected;
  const accounts = state?.accounts ?? [];
  const conn = state?.connection ?? null;

  return (
    <div className="space-y-4">
      {/* Guided tour: connect walkthrough → per-toggle explainers → credits reminder. */}
      {!loading && <FlowTour connected={connected} />}
      <div>
        <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <span className="bg-gradient-to-r from-navy via-charcoal to-gold-deep bg-clip-text text-transparent">
            {connected ? "FLOW — Your accounts and settings" : "FLOW — Connect your broker"}
          </span>
        </h2>
        <p className="text-sm text-charcoal/50">
          {connected
            ? "Risk and how the AI looks after a trade are set per account below. Nothing here changes until you change it."
            : "Link your TradeLocker account so FLOW can show your balance and prepare your trades. Your login is sent straight to the broker and stored encrypted — it never sits in your browser."}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-ice bg-white p-6 text-sm text-charcoal/60">
          <Loader2 className="h-4 w-4 animate-spin text-navy" /> Checking your broker connection…
        </div>
      ) : connected && !addingAccount ? (
        /* ---------------- Connected ---------------- */
        /* Anchored so the top of the tab, and a deep link, can land straight on the settings. */
        <div id="flow-settings" className="scroll-mt-24 space-y-4">
          {adminSw && (
            <div className="rounded-2xl border-2 border-amber-500/30 bg-amber-500/[0.04] p-5">
              <p className="inline-flex items-center gap-2 text-sm font-bold text-amber-700">
                <ShieldCheck className="h-4 w-4" /> Admin · Trading controls
              </p>
              <p className="mt-1 text-xs text-charcoal/55">
                Global on/off for everyone. Turning an engine off pauses <b>new</b> trades community-wide — open trades keep being managed. Only you can see this.
              </p>
              <div className="mt-3 space-y-2">
                {([
                  { key: "flow" as const, label: "FLOW", desc: "Auto-executes forex + index setups for every armed member." },
                  { key: "genx" as const, label: "GENX (gold)", desc: "Places the GENX gold ENTER-NOW calls across members + followers." },
                ]).map(({ key, label, desc }) => {
                  const on = adminSw[key];
                  return (
                    <div key={key} className="flex items-center justify-between gap-3 rounded-xl border border-ice bg-white p-3">
                      <div className="min-w-0">
                        <span className="inline-flex items-center gap-2 text-sm font-bold">
                          {label}
                          <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${on ? "bg-emerald-500/12 text-emerald-600" : "bg-red-500/12 text-red-500"}`}>{on ? "ON" : "OFF — PAUSED"}</span>
                        </span>
                        <p className="mt-0.5 text-[11px] leading-tight text-charcoal/45">{desc}</p>
                      </div>
                      <button
                        onClick={() => void saveSwitch(key, !on)}
                        disabled={swBusy === key}
                        aria-pressed={on}
                        className={`relative h-8 w-[58px] flex-shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-emerald-500" : "bg-red-400"}`}
                      >
                        <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? "left-[29px]" : "left-1"}`} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="rounded-2xl border border-ice bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-2 text-sm font-bold">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" /> TradeLocker connected
                <span
                  className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    conn?.environment === "live"
                      ? "bg-amber-500/15 text-amber-600"
                      : "bg-navy/[0.06] text-navy"
                  }`}
                >
                  {(conn?.environment || "demo").toUpperCase()}
                </span>
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void load()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ice px-3 py-1.5 text-xs font-semibold text-charcoal/70 hover:bg-offwhite"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Re-check
                </button>
                <button
                  onClick={() => void disconnect()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-500/[0.06] disabled:opacity-50"
                >
                  Disconnect
                </button>
              </div>
            </div>
            {(() => {
              const activeN = accounts.filter((a) => a.autotradeEnabled).length;
              return (
                <p className="mt-1 text-xs text-charcoal/45">
                  {accounts.length} account{accounts.length === 1 ? "" : "s"} connected · <b className="text-emerald-600">{activeN} trading</b>. FLOW takes every trade on all the accounts switched on below.
                </p>
              );
            })()}

            <div className="mt-4 space-y-2">
              {accounts.length === 0 && (
                <p className="rounded-xl border border-ice bg-offwhite/60 px-3 py-3 text-xs text-charcoal/50">
                  No account details loaded yet. Tap re-check, or reconnect.
                </p>
              )}
              {accounts.map((a, ai) => {
                const on = a.autotradeEnabled !== false;
                const tour = (name: string) => (ai === 0 ? { "data-tour": name } : {}); // tour spotlights the FIRST account only
                return (
                  <div
                    {...tour("ft-account")}
                    key={`${a.connectionId || ""}-${a.accountId}`}
                    className={`w-full rounded-xl border px-3.5 py-3 ${
                      on ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-ice bg-offwhite/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-navy">
                          {a.name || `Account ${a.accountId}`}
                          {a.environment && (
                            <span className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${a.environment === "live" ? "bg-amber-500/15 text-amber-600" : "bg-navy/[0.06] text-navy"}`}>{a.environment}</span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11px] text-charcoal/45">
                          #{a.accNum || a.accountId}
                          {a.currency ? ` · ${a.currency}` : ""} · <span className="inline-flex items-center gap-0.5"><Wallet className="inline h-3 w-3" />{money(a.equity != null ? a.equity : a.balance)}</span>
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2" {...tour("ft-trading")}>
                        <span className={`text-[11px] font-semibold ${on ? "text-emerald-600" : "text-charcoal/40"}`}>{on ? "Trading" : "Off"}</span>
                        <button
                          onClick={() => void toggleAccount(a, !on)}
                          aria-pressed={on}
                          className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-charcoal/20"}`}
                        >
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
                        </button>
                      </div>
                    </div>
                    {/* Follow every GENX signal — takes every gold call, sized to this account's risk % */}
                    {(() => {
                      const follows = a.genxFollower === true;
                      return (
                        <div {...tour("ft-genx")} className={`mt-2.5 flex items-center justify-between gap-3 rounded-lg border px-2.5 py-2 ${follows ? "border-amber-500/45 bg-amber-500/[0.07]" : "border-ice bg-offwhite/40"}`}>
                          <div className="min-w-0">
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-600"><Zap className="h-3.5 w-3.5" /> Follow every GENX signal</span>
                            <p className="mt-0.5 text-[10px] leading-tight text-charcoal/45">Takes every GENX gold call on this account, sized to the risk % below. Separate from FLOW.</p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <span className={`text-[11px] font-semibold ${follows ? "text-amber-600" : "text-charcoal/40"}`}>{follows ? "On" : "Off"}</span>
                            <button
                              onClick={() => void setAccountFollow(a, !follows)}
                              aria-pressed={follows}
                              className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${follows ? "bg-amber-500" : "bg-charcoal/20"}`}
                            >
                              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${follows ? "left-[22px]" : "left-0.5"}`} />
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                    {/* Per-account risk override */}
                    <div {...tour("ft-risk")} className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-ice/70 pt-2.5">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-charcoal/55"><Gauge className="h-3.5 w-3.5" /> Risk</span>
                      <button
                        onClick={() => void setAccountRisk(a, null)}
                        className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${a.riskPct == null ? "border-navy/40 bg-navy/[0.06] text-navy" : "border-ice bg-white text-charcoal/50 hover:border-charcoal/25"}`}
                      >
                        Default ({risk}%)
                      </button>
                      {ACCT_RISK_OPTS.map((v) => {
                        const sel = a.riskPct === v;
                        return (
                          <button
                            key={v}
                            onClick={() => void setAccountRisk(a, v)}
                            className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${sel ? "border-emerald-500/60 bg-emerald-500/[0.10] text-emerald-600" : "border-ice bg-white text-navy hover:border-charcoal/25"}`}
                          >
                            {v}%
                          </button>
                        );
                      })}
                      {/* SIZE-TO-ACCOUNT REMINDERS (owner 09-08): above 2% needs a $2,000+
                          account; ~$500 accounts belong at 0.5% or lower. The desk enforces
                          the same caps at trade time and falls back to 0.01 lots on margin
                          rejections, so nobody misses a trade over sizing. */}
                      {(() => {
                        const eff = a.riskPct ?? risk;
                        return (
                          <>
                            {eff > 2 && (
                              <p className="mt-1 w-full text-[10px] font-semibold leading-tight text-amber-700">
                                ⚠️ {eff}% risk needs at least $2,000 in this account — below that, trades are automatically sized at 2% or less.
                              </p>
                            )}
                            <p className="mt-0.5 w-full text-[10px] leading-tight text-charcoal/40">
                              Account around $500? Pick 0.5% or lower (it&rsquo;s capped there automatically). If a full-size position ever doesn&rsquo;t fit your margin, the desk takes the trade at 0.01 lots instead of skipping it.
                            </p>
                          </>
                        );
                      })()}
                    </div>
                    {/*
                      * HOW THE AI LOOKS AFTER A TRADE (owner 10-08: "change from AI PIPs to picking
                      * breakeven, AI management (follow price and taking partials), giving the customer the
                      * opportunity to tweak how they want the AI to trade"). It replaces the one AI Pips
                      * switch of 09-22 with its three parts, each the member's to pick — and every account
                      * starts exactly where AI Pips left it. Then safety mode, which changes exactly one
                      * thing: a conservative account sits out for 2 hours after 2 losses in a row.
                      */}
                    {(() => {
                      const mode = a.riskMode === "aggressive" ? "aggressive" : "conservative";
                      const key = `${a.connectionId || ""}:${a.accountId}`;
                      return (
                        <>
                          <TradeManagement a={a} busy={!!mgmtBusy[key]} error={mgmtErr[key] || ""} onChange={(c) => void setManagement(a, c)} tour={tour} />
                          <div className="mt-2 flex items-start justify-between gap-3 border-t border-ice/70 pt-2.5">
                            <div className="min-w-0">
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-charcoal/55"><ShieldCheck className="h-3.5 w-3.5" /> Safety mode</span>
                              <p className="mt-0.5 text-[10px] leading-tight text-charcoal/40">
                                The only difference: conservative sits this account out for 2 hours after 2 losses in a row (gold and forex counted separately). Aggressive has no cap.
                              </p>
                            </div>
                            <div className="flex flex-shrink-0 items-center gap-1.5">
                              <button onClick={() => void setAccountMode(a, "conservative")} aria-pressed={mode === "conservative"}
                                className={`rounded-lg border px-2 py-1 text-[10.5px] font-bold ${mode === "conservative" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700" : "border-ice bg-white text-charcoal/45"}`}>Cons.</button>
                              <button onClick={() => void setAccountMode(a, "aggressive")} aria-pressed={mode === "aggressive"}
                                className={`rounded-lg border px-2 py-1 text-[10.5px] font-bold ${mode === "aggressive" ? "border-amber-500/40 bg-amber-500/10 text-amber-700" : "border-ice bg-white text-charcoal/45"}`}>Aggr.</button>
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                );
              })}
            </div>

            <button
              data-tour="ft-addaccount"
              onClick={() => { setAddingAccount(true); setOk(""); setErr(""); }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-charcoal/25 px-3 py-2 text-xs font-semibold text-navy hover:bg-offwhite"
            >
              <Link2 className="h-3.5 w-3.5" /> Connect another account
            </button>
          </div>

          {/* Risk % lock-in */}
          <div data-tour="ft-defaultrisk" className="rounded-2xl border border-ice bg-white p-5">
            <p className="inline-flex items-center gap-2 text-sm font-bold">
              <Gauge className="h-4 w-4 text-navy" /> Default risk per trade
            </p>
            <p className="mt-1 text-xs text-charcoal/50">
              The fallback size FLOW uses for any account without its own risk set above. Lock it in.
            </p>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {RISK_CHIPS.map((v) => {
                const on = risk === v && riskLocked;
                return (
                  <button
                    key={v}
                    onClick={() => void lockRisk(v)}
                    className={`rounded-xl border px-3 py-2.5 text-sm font-bold transition-colors ${
                      on
                        ? "border-emerald-500/60 bg-emerald-500/[0.08] text-emerald-600"
                        : "border-ice bg-offwhite/60 text-navy hover:border-charcoal/25"
                    }`}
                  >
                    {v}%
                  </button>
                );
              })}
            </div>
            {riskLocked && (
              <p className="mt-2 text-xs font-semibold text-emerald-600">✓ Locked at {risk}% per trade</p>
            )}
          </div>

          {/* Auto-run toggle */}
          <div data-tour="ft-autorun" className="rounded-2xl border border-ice bg-white p-5">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="inline-flex items-center gap-2 text-sm font-bold">
                  <Zap className="h-4 w-4 text-navy" /> Auto-run FLOW
                </p>
                <p className="mt-1 text-xs text-charcoal/55">
                  FLOW places your trades automatically the moment a setup confirms — no clicking.
                </p>
              </div>
              <button
                onClick={() => void toggleAuto(!auto?.enabled)}
                disabled={autoBusy}
                aria-pressed={!!auto?.enabled}
                className={`relative h-8 w-[58px] flex-shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                  auto?.enabled ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.55)]" : "bg-charcoal/20"
                }`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
                    auto?.enabled ? "left-[29px]" : "left-1"
                  }`}
                />
              </button>
            </div>

            {auto?.pass ? (
            <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
              <p className="text-xs leading-relaxed text-emerald-700">
                <b>FLOW Pass active{auto.passUntil ? ` until ${new Date(auto.passUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</b> —
                FLOW and GENX are free: no credits for setups or trades, on every account you connect. Your
                credits are only used by other tools.
              </p>
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-charcoal/60">
                <Coins className="h-3.5 w-3.5" /> Credits:{" "}
                <b className="text-navy">{auto?.credits ?? "—"}</b>
              </p>
            </div>
            ) : (
            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
              <p className="text-xs leading-relaxed text-amber-700">
                <b>1 credit when a setup starts forming, 5 when a trade is actually placed</b> on your
                account — once each, no matter how many accounts you connect. Watching is free: on a quiet
                day with no setups, FLOW costs you nothing.
              </p>
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-charcoal/60">
                <Coins className="h-3.5 w-3.5" /> Credits:{" "}
                <b className="text-navy">{auto?.credits ?? "—"}</b>
                <a href="/portal/credits" className="ml-1 font-semibold text-primary hover:underline">
                  Get more ›
                </a>
              </p>
            </div>
            )}

            {auto?.enabled && (
              <p
                className={`mt-2 text-xs font-semibold ${
                  auto?.paused ? "text-amber-600" : "text-emerald-600"
                }`}
              >
                {auto?.paused
                  ? "⏸ Paused — out of credits. Top up and it resumes automatically."
                  : `● Auto-run active${
                      marketOpenNow() ? " — markets open, watching now." : " — markets closed, resumes at the open."
                    }`}
              </p>
            )}
            {autoMsg && <p className="mt-2 text-xs text-charcoal/60">{autoMsg}</p>}
          </div>

          <div className="flex items-start gap-2 rounded-2xl border border-ice bg-offwhite/60 p-4 text-xs text-charcoal/55">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy" />
            <p>
              FLOW uses this account only to show balances and prepare the trades you approve. It never
              trades on its own, and never places a live-money order without your explicit per-trade
              confirmation.
            </p>
          </div>
        </div>
      ) : (
        /* ---------------- Connect form ---------------- */
        <div className="space-y-4">
          <div className="rounded-2xl border border-ice bg-white p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="inline-flex items-center gap-2 text-sm font-bold">
                <Link2 className="h-4 w-4 text-navy" /> {addingAccount ? "Connect another account" : "Connect TradeLocker"}
              </p>
              {addingAccount && (
                <button onClick={() => { setAddingAccount(false); setErr(""); }} className="text-xs font-semibold text-charcoal/60 hover:text-navy">
                  ‹ Back to accounts
                </button>
              )}
            </div>
            {addingAccount && (
              <p className="mt-1 text-xs text-charcoal/50">Link a second TradeLocker login (another broker or account). FLOW will trade every account you switch on.</p>
            )}

            {/* Environment */}
            <div className="mt-4" data-tour="ft-env">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">
                Environment
              </label>
              <div className="mt-1.5 inline-flex rounded-xl border border-ice bg-offwhite p-1">
                <button
                  onClick={() => setEnv("demo")}
                  className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                    env === "demo" ? "bg-primary text-cream" : "text-charcoal/55 hover:text-navy"
                  }`}
                >
                  Demo
                </button>
                <button
                  onClick={() => setEnv("live")}
                  className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                    env === "live" ? "bg-amber-500 text-white" : "text-charcoal/55 hover:text-navy"
                  }`}
                >
                  Live
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Server">
                <input
                  data-tour="ft-server"
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="e.g. GENFX"
                  className="w-full rounded-lg border border-ice bg-offwhite px-3 py-2.5 text-sm text-navy placeholder:text-charcoal/30 focus:border-charcoal/30 focus:outline-none"
                />
              </Field>
              <Field label="Email">
                <input
                  data-tour="ft-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  className="w-full rounded-lg border border-ice bg-offwhite px-3 py-2.5 text-sm text-navy placeholder:text-charcoal/30 focus:border-charcoal/30 focus:outline-none"
                />
              </Field>
              <Field label="Password" className="sm:col-span-2">
                <input
                  data-tour="ft-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="TradeLocker password"
                  className="w-full rounded-lg border border-ice bg-offwhite px-3 py-2.5 text-sm text-navy placeholder:text-charcoal/30 focus:border-charcoal/30 focus:outline-none"
                />
              </Field>
            </div>

            {err && (
              <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs font-semibold text-red-500">
                <AlertTriangle className="h-3.5 w-3.5" /> {err}
              </p>
            )}

            <button
              data-tour="ft-connect"
              onClick={() => void connect()}
              disabled={busy || !server || !email || !password}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-navy to-primary px-5 py-3 text-sm font-bold text-cream shadow-card transition hover:shadow-cardhover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {busy ? "Connecting…" : "Connect account"}
            </button>

            {env === "live" && (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                You&apos;ve selected a LIVE account. FLOW will show balances and prepare trades, but will
                never place a live-money order without your explicit per-trade confirmation.
              </p>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-2xl border border-ice bg-offwhite/60 p-4 text-xs text-charcoal/55">
            <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-navy" />
            <p>
              Powered by the official TradeLocker API. FLOW stores only an encrypted session — never your
              password in plain text. Never share your withdrawal password.
            </p>
          </div>
        </div>
      )}

      {ok && (
        <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-xs font-semibold text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" /> {ok}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
