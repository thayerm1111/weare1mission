"use client";

/* ==========================================================================
   RAPID — XAUUSD Rapid desk (strategy matty_rapid_v1)

   Four controls, in the order a member uses them:
     1. Analyze          — what the market is, and what has to happen for an entry
     2. Risk per trade   — a percentage of account equity, enforced server-side
     3. Trade Management — breakeven, partials, trailing, structural exit
     4. Automation       — standing permission to take qualifying trades

   Two rules this screen obeys strictly, because getting them wrong is how a UI
   lies to somebody about their own money:
     - Nothing here says "take it now". A scenario is conditional until it has
       triggered, and the snapshot's age is always on screen.
     - Opportunity identified, Order submitted and Filled are three different
       words, and they are never used interchangeably.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, Loader2, Lock, RefreshCw, Shield, Zap } from "lucide-react";

const C = {
  base: "#0A0E13", panel: "#0E141C", raised: "#131A24", line: "rgba(255,255,255,0.07)",
  lineSoft: "rgba(255,255,255,0.045)", text: "#EAF1F8", mut: "rgba(234,241,248,0.60)",
  mut2: "rgba(234,241,248,0.40)", cyan: "#22D3EE", blue: "#3B82F6", violet: "#7C3AED",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", gold: "#FFC24B",
};

type Scenario = {
  setupId: string; family: string; side: "buy" | "sell"; timeframe: string; state: string;
  entryBandLow: number; entryBandHigh: number; stop: number; target: number;
  stopUsd: number; targetUsd: number; refEntry: number; expiresAt: number;
  conditionsMet: string[]; conditionsPending: string[]; invalidation: number;
};

type Eligibility = {
  accountId: string; name: string | null; environment: string; currency: string | null;
  automationEnabled: boolean; managementEnabled: boolean; selectedRisk: number;
  equity: number | null; blockers: string[];
};

type Analyze = {
  available: boolean; reason?: string;
  snapshotId?: string; strategyVersion?: string; configVersion?: string;
  generatedAt?: string; ageMs?: number; stale?: boolean;
  feedSource?: string; quoteAgeMs?: number | null;
  health?: { state: string; reasons: string[] };
  regimes?: Record<string, string>; regimeConflict?: boolean;
  range?: { lower: { low: number }; upper: { high: number }; room: number } | null;
  scenarios?: Scenario[];
  deterministicExplanation?: string;
  accountEligibility?: Eligibility[];
  ownedPositions?: Array<Record<string, unknown>>;
  control?: { mode: string; entries_paused: boolean; pause_reason: string | null } | null;
};

const PRESETS = [0.25, 0.5, 1, 2];

const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
const ago = (ms: number | undefined) => (ms == null ? "—" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`);

/** Plain language for an internal state. Members should never read the enum. */
const STATE_WORDS: Record<string, string> = {
  watching: "Watching",
  approaching: "Approaching the level",
  armed: "Break confirmed — waiting for the retest",
  triggered: "Entry triggered",
  consumed: "Order placed for this visit",
  waiting_for_departure: "Waiting for price to leave before another trade here",
  invalidated: "Invalidated",
  expired: "Expired",
};

export default function RapidDesk() {
  const [data, setData] = useState<Analyze | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rapid/analyze", { cache: "no-store" });
      const body = (await res.json()) as Analyze & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setData(body);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // The snapshot ages on screen whether or not anything is refetched, so nobody reads a stale
  // scenario as if it were current.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  const liveAge = useMemo(() => {
    if (!data?.generatedAt) return undefined;
    void tick;
    return Date.now() - new Date(data.generatedAt).getTime();
  }, [data?.generatedAt, tick]);

  const patch = useCallback(async (accountId: string, body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch("/api/rapid/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, ...body }),
      });
      const out = (await res.json()) as { error?: string; blockers?: string[] };
      if (!res.ok) throw new Error(out.blockers?.length ? out.blockers.join("; ") : out.error ?? "could not save");
      await load();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const accounts = data?.accountEligibility ?? [];
  const scenarios = data?.scenarios ?? [];
  const mode = data?.control?.mode ?? "off";

  return (
    <div style={{ background: C.base, color: C.text }} className="min-h-[70vh] rounded-xl p-4">
      <Header
        mode={mode}
        paused={data?.control?.entries_paused !== false}
        pauseReason={data?.control?.pause_reason ?? null}
        strategyVersion={data?.strategyVersion}
        ageMs={liveAge}
        loading={loading}
        onRefresh={() => void load()}
      />

      {error && <Banner tone="red" icon={<AlertTriangle size={14} />}>{error}</Banner>}

      {data && !data.available && (
        <Banner tone="amber" icon={<Clock size={14} />}>
          No analysis yet — {data.reason}. The desk shows nothing rather than guessing.
        </Banner>
      )}

      {data?.health && data.health.state !== "ok" && (
        <Banner tone={data.health.state === "blocked" ? "red" : "amber"} icon={<AlertTriangle size={14} />}>
          <strong style={{ textTransform: "capitalize" }}>{data.health.state}</strong> — {data.health.reasons.join("; ")}
        </Banner>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-3">
          <StructurePanel regimes={data?.regimes} conflict={data?.regimeConflict} range={data?.range ?? null} />
          <ScenarioPanel scenarios={scenarios} explanation={data?.deterministicExplanation} stale={Boolean(data?.stale)} />
        </div>
        <div className="space-y-3">
          {accounts.length === 0 ? (
            <Panel title="Your accounts">
              <p style={{ color: C.mut }} className="text-[12px] leading-relaxed">
                No TradeLocker account is connected to Rapid yet. Analyze works without one; execution needs a
                connected account so entry prices, spread and risk can be checked against the money that would
                actually be traded.
              </p>
            </Panel>
          ) : (
            accounts.map((a) => (
              <AccountPanel
                key={a.accountId}
                account={a}
                busy={busy}
                onRisk={(pct) => void patch(a.accountId, { riskPct: pct }, `risk:${a.accountId}`)}
                onManagement={(on) => void patch(a.accountId, { managementEnabled: on }, `mgmt:${a.accountId}`)}
                onAutomation={(on) => void patch(a.accountId, { automationEnabled: on }, `auto:${a.accountId}`)}
              />
            ))
          )}
          <PositionsPanel positions={data?.ownedPositions ?? []} />
        </div>
      </div>

      <p style={{ color: C.mut2 }} className="mt-4 text-[11px] leading-relaxed">
        Rapid looks for $5–$15 of movement in the quoted price of gold. That is a distance, not a profit: what
        it is worth depends on position size. {data?.strategyVersion ?? "matty_rapid_v1"} · config{" "}
        {data?.configVersion ?? "—"}. The parameters are research defaults and have not been shown to be
        profitable.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Header(p: {
  mode: string; paused: boolean; pauseReason: string | null; strategyVersion?: string;
  ageMs?: number; loading: boolean; onRefresh: () => void;
}) {
  const tone = p.mode === "live" && !p.paused ? C.green : p.mode === "off" ? C.mut2 : C.amber;
  const label = p.mode === "off" ? "Off" : p.mode === "analyze_only" ? "Analyze only" : p.paused ? "Live — entries paused" : "Live";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Zap size={16} style={{ color: C.gold }} />
        <span className="text-[15px] font-semibold tracking-tight">Rapid · XAUUSD</span>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(255,255,255,0.06)", color: tone }}>
          {label}
        </span>
        {p.pauseReason && <span className="text-[11px]" style={{ color: C.amber }}>{p.pauseReason}</span>}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[11px]" style={{ color: C.mut2 }}>analysis {ago(p.ageMs)} old</span>
        <button
          onClick={p.onRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors hover:bg-white/5"
          style={{ background: "rgba(34,211,238,0.14)", color: C.cyan }}
        >
          {p.loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Analyze
        </button>
      </div>
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl p-3" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em]" style={{ color: C.mut }}>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Banner({ tone, icon, children }: { tone: "red" | "amber" | "green"; icon: React.ReactNode; children: React.ReactNode }) {
  const col = tone === "red" ? C.red : tone === "amber" ? C.amber : C.green;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px]" style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${col}33`, color: col }}>
      <span className="mt-0.5">{icon}</span>
      <span className="leading-relaxed">{children}</span>
    </div>
  );
}

function StructurePanel({ regimes, conflict, range }: { regimes?: Record<string, string>; conflict?: boolean; range: Analyze["range"] }) {
  const order = ["D1", "H4", "H1", "M15", "M5"];
  const labels: Record<string, string> = { D1: "Daily", H4: "4H", H1: "1H", M15: "15m", M5: "5m" };
  const colour = (r?: string) => (r === "up" ? C.blue : r === "down" ? C.red : r === "sideways" ? C.violet : C.mut2);
  return (
    <Panel
      title="Structure"
      right={conflict ? <span className="text-[11px]" style={{ color: C.amber }}>timeframes disagree</span> : null}
    >
      <div className="grid grid-cols-5 gap-2">
        {order.map((tf) => (
          <div key={tf} className="rounded-lg px-2 py-2 text-center" style={{ background: C.raised, border: `1px solid ${C.lineSoft}` }}>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>{labels[tf]}</div>
            <div className="mt-0.5 text-[12px] font-semibold capitalize" style={{ color: colour(regimes?.[tf]) }}>
              {regimes?.[tf] ?? "unknown"}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px]" style={{ color: C.mut }}>
        {range ? (
          <>Validated range <strong style={{ color: C.violet }}>{fmt(range.lower.low)} – {fmt(range.upper.high)}</strong>, {fmt(range.room)} of room.</>
        ) : (
          <>No validated range. Blue is support, red is resistance, purple is range context.</>
        )}
      </div>
    </Panel>
  );
}

function ScenarioPanel({ scenarios, explanation, stale }: { scenarios: Scenario[]; explanation?: string; stale: boolean }) {
  return (
    <Panel
      title="Scenarios"
      right={stale ? <span className="text-[11px]" style={{ color: C.amber }}>snapshot is stale</span> : null}
    >
      {scenarios.length === 0 ? (
        <p className="text-[12px] leading-relaxed" style={{ color: C.mut }}>
          Nothing qualifies right now. {explanation}
        </p>
      ) : (
        <div className="space-y-2">
          {scenarios.map((s) => (
            <div key={s.setupId} className="rounded-lg p-2.5" style={{ background: C.raised, border: `1px solid ${C.lineSoft}` }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ background: s.side === "buy" ? "rgba(52,211,153,0.16)" : "rgba(248,113,113,0.16)", color: s.side === "buy" ? C.green : C.red }}>
                  {s.side === "buy" ? "Long" : "Short"}
                </span>
                <span className="text-[12px] font-semibold capitalize">{s.family.replace(/_/g, " ")}</span>
                <span className="text-[11px]" style={{ color: C.mut2 }}>{s.timeframe}</span>
                <span className="ml-auto text-[11px] font-medium" style={{ color: C.cyan }}>
                  {STATE_WORDS[s.state] ?? s.state}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-4">
                <Field label="Entry band" value={`${fmt(s.entryBandLow)} – ${fmt(s.entryBandHigh)}`} />
                <Field label="Stop" value={`${fmt(s.stop)} (${fmt(s.stopUsd)})`} tone={C.red} />
                <Field label="Target" value={`${fmt(s.target)} (${fmt(s.targetUsd)})`} tone={C.green} />
                <Field label="Invalidation" value={fmt(s.invalidation)} />
              </div>
              {s.conditionsPending.length > 0 && (
                <p className="mt-2 text-[11px] leading-relaxed" style={{ color: C.amber }}>
                  Still needs: {s.conditionsPending.join("; ")}
                </p>
              )}
              {s.conditionsMet.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px]" style={{ color: C.mut2 }}>Why this qualifies</summary>
                  <ul className="mt-1 space-y-0.5 pl-4 text-[11px]" style={{ color: C.mut }}>
                    {s.conditionsMet.map((c, i) => <li key={i} className="list-disc">{c}</li>)}
                  </ul>
                </details>
              )}
            </div>
          ))}
          <p className="text-[11px] leading-relaxed" style={{ color: C.mut2 }}>
            Conditional until triggered. A scenario on screen is not an order.
          </p>
        </div>
      )}
    </Panel>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>{label}</div>
      <div className="font-mono text-[12px]" style={{ color: tone ?? C.text }}>{value}</div>
    </div>
  );
}

function AccountPanel(p: {
  account: Eligibility; busy: string | null;
  onRisk: (pct: number) => void; onManagement: (on: boolean) => void; onAutomation: (on: boolean) => void;
}) {
  const a = p.account;
  const armBlocked = a.blockers.filter((b) => !/automation is off/.test(b));
  return (
    <Panel
      title={a.name ? `${a.name} · ${a.environment}` : `Account · ${a.environment}`}
      right={<span className="text-[11px]" style={{ color: C.mut2 }}>{a.currency ?? ""} {a.equity != null ? fmt(a.equity, 2) : ""}</span>}
    >
      <div className="mb-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider" style={{ color: C.mut2 }}>Risk per trade</div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((v) => (
            <button
              key={v}
              onClick={() => p.onRisk(v)}
              disabled={p.busy === `risk:${a.accountId}`}
              className="rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors hover:bg-white/5 disabled:opacity-50"
              style={a.selectedRisk === v
                ? { background: "rgba(34,211,238,0.16)", color: C.cyan }
                : { background: C.raised, color: C.mut }}
            >
              {v}%
            </button>
          ))}
        </div>
      </div>

      <Toggle
        icon={<Shield size={13} />}
        label="Trade Management"
        hint={a.managementEnabled
          ? "Breakeven, a partial, trailing and a structural exit are active."
          : "Off: your broker still holds the original stop and target. Nothing discretionary runs."}
        on={a.managementEnabled}
        busy={p.busy === `mgmt:${a.accountId}`}
        onChange={p.onManagement}
      />

      <Toggle
        icon={a.automationEnabled ? <Activity size={13} /> : <Lock size={13} />}
        label="Automation"
        hint={a.automationEnabled
          ? "Rapid may take qualifying new trades on this account. Closing your browser changes nothing."
          : "Off: no new trades. Any open position keeps being managed."}
        on={a.automationEnabled}
        busy={p.busy === `auto:${a.accountId}`}
        disabled={!a.automationEnabled && armBlocked.length > 0}
        onChange={p.onAutomation}
      />

      {armBlocked.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px]" style={{ color: C.amber }}>
          {armBlocked.map((b, i) => <li key={i}>• {b}</li>)}
        </ul>
      )}
      {armBlocked.length === 0 && a.automationEnabled && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: C.green }}>
          <CheckCircle2 size={12} /> Execution ready
        </div>
      )}
    </Panel>
  );
}

function Toggle(p: {
  icon: React.ReactNode; label: string; hint: string; on: boolean; busy: boolean;
  disabled?: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <div className="mt-2 rounded-lg p-2.5" style={{ background: C.raised, border: `1px solid ${C.lineSoft}` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold">
          <span style={{ color: p.on ? C.green : C.mut2 }}>{p.icon}</span>
          {p.label}
        </span>
        <button
          role="switch"
          aria-checked={p.on}
          aria-label={p.label}
          disabled={p.busy || p.disabled}
          onClick={() => p.onChange(!p.on)}
          className="relative h-5 w-9 rounded-full transition-colors disabled:opacity-40"
          style={{ background: p.on ? "rgba(52,211,153,0.5)" : "rgba(255,255,255,0.12)" }}
        >
          <span
            className="absolute top-0.5 h-4 w-4 rounded-full transition-all"
            style={{ left: p.on ? 18 : 2, background: p.on ? C.green : C.mut }}
          />
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed" style={{ color: C.mut }}>{p.hint}</p>
    </div>
  );
}

function PositionsPanel({ positions }: { positions: Array<Record<string, unknown>> }) {
  if (!positions.length) {
    return (
      <Panel title="Open Rapid position">
        <p className="text-[12px]" style={{ color: C.mut }}>None.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Open Rapid position">
      {positions.map((p) => {
        const protectedOk = p.protection_state === "protected";
        return (
          <div key={String(p.id)} className="rounded-lg p-2.5" style={{ background: C.raised, border: `1px solid ${C.lineSoft}` }}>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold capitalize">{String(p.side)}</span>
              <span className="font-mono text-[12px]" style={{ color: C.mut }}>{fmt(Number(p.entry))}</span>
              <span className="ml-auto text-[11px]" style={{ color: protectedOk ? C.green : C.amber }}>
                {protectedOk ? "broker-confirmed protection" : "protection not confirmed"}
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
              <Field label="Stop" value={fmt(Number(p.current_stop ?? p.initial_stop))} tone={C.red} />
              <Field label="Target" value={fmt(Number(p.target))} tone={C.green} />
              <Field label="Size" value={String(p.current_qty)} />
            </div>
            <div className="mt-1.5 flex gap-2 text-[11px]" style={{ color: C.mut2 }}>
              {p.breakeven_done ? <span style={{ color: C.green }}>breakeven done</span> : <span>breakeven pending</span>}
              {p.partial_done ? <span style={{ color: C.green }}>partial taken</span> : null}
              <span>status {String(p.status)}</span>
            </div>
          </div>
        );
      })}
    </Panel>
  );
}
