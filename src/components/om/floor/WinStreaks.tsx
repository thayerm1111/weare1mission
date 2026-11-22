"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Info, RefreshCw } from "lucide-react";
import { ProductIcon } from "@/components/om/ProductIcon";
import type { FloorAccount } from "@/lib/floor/overview";
import type { FloorWinStreaks, WinStreakMetrics } from "@/lib/floor/winStreaks";
import "./win-streaks.css";

type Props = {
  account: FloorAccount | null;
  accountsKnown: boolean;
  switching: boolean;
  hideAccountPips: boolean;
  sample?: boolean;
};
type Reading = { key: string; data: FloorWinStreaks | null; failed: boolean; loading: boolean };
const POLL_MS = 30_000;
const keyOf = (account: { id: string; environment: string } | null) => account ? `${account.environment}:${account.id}` : "none";
const dated = (value: string | undefined | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const valid = (metrics: WinStreakMetrics | null | undefined) => metrics?.state === "ready"
  && Number.isInteger(metrics.currentWins) && Number(metrics.currentWins) >= 0
  && typeof metrics.currentPips === "number" && Number.isFinite(metrics.currentPips) && metrics.currentPips >= 0;

function StreakCard({ kind, metrics, loading, stale, account, hidden, sample }: {
  kind: "flow" | "genx"; metrics?: WinStreakMetrics; loading: boolean; stale: boolean;
  account: FloorAccount | null; hidden: boolean; sample: boolean;
}) {
  const ready = valid(metrics), wins = ready ? metrics!.currentWins! : null;
  const pips = ready ? metrics!.currentPips! : null;
  const noAccount = kind === "flow" && !account;
  const stamp = dated(metrics?.asOf);
  const unavailable = sample ? "Sample view" : loading ? "Reading results…" : noAccount ? "No account selected" : "Streak unavailable";
  return (
    <article className={`om-streak-card om-streak-${kind}`} data-winning={ready && wins! > 0 && !stale ? "true" : "false"} aria-label={`${kind === "flow" ? "Your FLOW account" : "GENX community callouts"} winning streak`} aria-busy={loading && !metrics}>
      <div className="om-streak-identity">
        <ProductIcon kind={kind} size="sm" />
        <div><h3>{kind === "flow" ? "FLOW" : "GENX"}</h3><p>{kind === "flow" ? "Your account" : "Community callouts"}</p></div>
        {ready && wins! > 0 && <span className="om-streak-mark" aria-hidden="true"><Check /></span>}
      </div>
      <div className="om-streak-count"><strong data-no-i18n translate="no">{wins == null ? "—" : wins.toLocaleString("en-US")}</strong><span>Wins in a row</span></div>
      <div className="om-streak-pips"><strong data-no-i18n translate="no" aria-label={hidden && ready ? "Pips hidden" : undefined}>{pips == null ? "—" : hidden ? "••••" : `${pips > 0 ? "+" : ""}${pips.toLocaleString("en-US", { maximumFractionDigits: 1 })}`}<span>{ready && !hidden ? " pips" : ""}</span></strong><span>Pips this streak</span></div>
      <p className="om-streak-status">{!ready ? unavailable : stale ? "Last reading" : wins === 0 ? "Next streak starts here" : "Completed wins"}</p>
      {stamp && <time className="om-streak-time" dateTime={metrics!.asOf}>{stale ? "As of " : "Updated "}{stamp}</time>}
    </article>
  );
}

/** A read-only view of the current winning run, with independent account and community scopes. */
export function WinStreaks({ account, accountsKnown, switching, hideAccountPips, sample = false }: Props) {
  const key = keyOf(account);
  const current = useRef({ key, accountsKnown, switching, sample });
  current.current = { key, accountsKnown, switching, sample };
  const [reading, setReading] = useState<Reading>({ key, data: null, failed: false, loading: !sample });
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true, sequence = 0;
    let request: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    setReading({ key, data: null, failed: false, loading: !sample });
    if (sample || !accountsKnown || switching) { reload.current = () => {}; return; }
    const permitted = () => alive && current.current.key === key && current.current.accountsKnown && !current.current.switching && !current.current.sample;
    const load = async () => {
      if (!permitted()) return;
      const mine = ++sequence;
      request?.abort();
      if (timeout) clearTimeout(timeout);
      const controller = new AbortController();
      request = controller;
      const deadline = setTimeout(() => controller.abort(), 25_000);
      timeout = deadline;
      setReading((previous) => ({ ...previous, loading: true }));
      const headers: Record<string, string> = {};
      if (account) { headers["x-floor-account"] = account.id; headers["x-floor-env"] = account.environment; }
      try {
        const response = await fetch("/api/floor/win-streaks", { cache: "no-store", headers, signal: controller.signal });
        const data = await response.json().catch(() => null) as (FloorWinStreaks & { error?: string }) | null;
        if (!permitted() || mine !== sequence) return;
        // A fallback account must never put someone else's selection under the current account name.
        if (!response.ok || !data || data.error || !data.flow || !data.genx || keyOf(data.account) !== key) throw new Error("streak_read_unavailable");
        setReading({ key, data, failed: false, loading: false });
      } catch {
        if (permitted() && mine === sequence) setReading((previous) => ({ ...previous, failed: true, loading: false }));
      } finally {
        clearTimeout(deadline);
        if (request === controller) { request = null; timeout = null; }
      }
    };
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    reload.current = () => { void load(); };
    void load();
    const poll = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("om:flow-trades-changed", refresh);
    return () => {
      alive = false; sequence += 1; request?.abort();
      if (timeout) clearTimeout(timeout);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("om:flow-trades-changed", refresh);
      reload.current = () => {};
    };
  }, [key, accountsKnown, switching, sample]); // Primitive identity avoids restarting on each overview refresh.

  const matching = reading.key === key && !switching && !sample;
  const data = matching ? reading.data : null;
  const failed = matching && reading.failed;
  const loading = !sample && (!matching || !accountsKnown || reading.loading);
  return (
    <section className="om-win-streaks" aria-labelledby="om-win-streaks-heading">
      <div className="om-streak-heading">
        <h2 id="om-win-streaks-heading">Winning streaks</h2>
        <div className="om-streak-tools">
          {failed && <span role="status">Refresh unavailable</span>}
          <button type="button" onClick={() => reload.current()} disabled={sample || loading || !accountsKnown || switching} aria-label="Refresh winning streaks"><RefreshCw aria-hidden="true" /></button>
        </div>
      </div>
      <div className="om-streak-grid">
        <StreakCard kind="flow" metrics={data?.flow} loading={loading} stale={failed} account={account} hidden={hideAccountPips} sample={sample} />
        <StreakCard kind="genx" metrics={data?.genx} loading={loading} stale={failed} account={account} hidden={false} sample={sample} />
      </div>
      <details className="om-streak-method"><summary><Info aria-hidden="true" />How streaks are counted</summary><p>Only completed, recorded wins count toward the current run. Pips are the total captured in those wins. Flat closes leave the run unchanged. FLOW follows the selected account; GENX counts each community callout once.</p></details>
    </section>
  );
}
