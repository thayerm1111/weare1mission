"use client";

import { useCallback, useEffect, useState } from "react";
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
};

const RISK_CHIPS = [0.5, 1, 2, 3];

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
  }, [loadAuto]);

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
      <div>
        <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <span className="bg-gradient-to-r from-navy via-charcoal to-gold-deep bg-clip-text text-transparent">
            FLOW — Connect your broker
          </span>
        </h2>
        <p className="text-sm text-charcoal/50">
          Link your TradeLocker account so FLOW can show your balance and prepare your trades. Your
          login is sent straight to the broker and stored encrypted — it never sits in your browser.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-ice bg-white p-6 text-sm text-charcoal/60">
          <Loader2 className="h-4 w-4 animate-spin text-navy" /> Checking your broker connection…
        </div>
      ) : connected && !addingAccount ? (
        /* ---------------- Connected ---------------- */
        <div className="space-y-4">
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
              {accounts.map((a) => {
                const on = a.autotradeEnabled !== false;
                return (
                  <div
                    key={`${a.connectionId || ""}-${a.accountId}`}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 ${
                      on ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-ice bg-offwhite/50"
                    }`}
                  >
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
                    <div className="flex flex-shrink-0 items-center gap-2">
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
                );
              })}
            </div>

            <button
              onClick={() => { setAddingAccount(true); setOk(""); setErr(""); }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-charcoal/25 px-3 py-2 text-xs font-semibold text-navy hover:bg-offwhite"
            >
              <Link2 className="h-3.5 w-3.5" /> Connect another account
            </button>
          </div>

          {/* Risk % lock-in */}
          <div className="rounded-2xl border border-ice bg-white p-5">
            <p className="inline-flex items-center gap-2 text-sm font-bold">
              <Gauge className="h-4 w-4 text-navy" /> Your risk per trade
            </p>
            <p className="mt-1 text-xs text-charcoal/50">
              FLOW sizes every trade to this % of your account. Lock it in.
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
          <div className="rounded-2xl border border-ice bg-white p-5">
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
                  auto?.enabled ? "bg-emerald-500" : "bg-charcoal/20"
                }`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
                    auto?.enabled ? "left-[29px]" : "left-1"
                  }`}
                />
              </button>
            </div>

            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
              <p className="text-xs leading-relaxed text-amber-700">
                <b>Costs {auto?.costPer30m ?? 1} credit every 30 min</b> that auto-run is on and the
                market is open. FLOW isn&apos;t free to run — you&apos;re only charged while it&apos;s
                actively watching for you.
              </p>
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-charcoal/60">
                <Coins className="h-3.5 w-3.5" /> Credits:{" "}
                <b className="text-navy">{auto?.credits ?? "—"}</b>
                <a href="/portal/credits" className="ml-1 font-semibold text-primary hover:underline">
                  Get more ›
                </a>
              </p>
            </div>

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
            <div className="mt-4">
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
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="e.g. CRUC"
                  className="w-full rounded-lg border border-ice bg-offwhite px-3 py-2.5 text-sm text-navy placeholder:text-charcoal/30 focus:border-charcoal/30 focus:outline-none"
                />
              </Field>
              <Field label="Email">
                <input
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
