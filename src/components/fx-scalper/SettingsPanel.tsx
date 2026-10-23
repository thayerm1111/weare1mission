"use client";

import { useEffect, useState } from "react";
import { PAIR_KEYS, PAIRS, type PairKey } from "@/lib/fxscalper/pairs";
import type { Settings } from "@/lib/fxscalper/settings";
import { C, money, post, type StatusPayload } from "./theme";
import { Btn, Card } from "./ui";

type Path = [keyof Settings, string];

function NumField({ label, hint, value, onChange, step = "any", nullable = false }: { label: string; hint?: string; value: number | null; onChange: (v: number | null) => void; step?: string; nullable?: boolean }) {
  return (
    <label className="block text-sm">
      <span style={{ color: C.ink }}>{label}</span>
      <input type="number" step={step} value={value ?? ""} placeholder={nullable ? "not set" : ""}
        onChange={(e) => onChange(e.target.value === "" ? (nullable ? null : NaN) : Number(e.target.value))}
        className="mt-1 w-full rounded-lg border px-3 py-1.5 tabular-nums" style={{ borderColor: C.line }} />
      {hint && <span className="mt-0.5 block text-xs" style={{ color: C.muted }}>{hint}</span>}
    </label>
  );
}

function TextField({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span style={{ color: C.ink }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-1.5" style={{ borderColor: C.line }} />
      {hint && <span className="mt-0.5 block text-xs" style={{ color: C.muted }}>{hint}</span>}
    </label>
  );
}

export function SettingsPanel({ data, reload }: { data: StatusPayload; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(() => JSON.parse(JSON.stringify(data.settings.values)));
  const [baseVersion, setBaseVersion] = useState(data.settings.version);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!dirty && data.settings.version !== baseVersion) {
      setDraft(JSON.parse(JSON.stringify(data.settings.values)));
      setBaseVersion(data.settings.version);
    }
  }, [data.settings.version, data.settings.values, dirty, baseVersion]);

  const set = ([sec, key]: Path, v: unknown) => {
    setDraft((d) => ({ ...d, [sec]: { ...(d[sec] as Record<string, unknown>), [key]: v } }));
    setDirty(true);
  };
  const setPair = (k: PairKey, f: "enabled" | "maxCostPips" | "maxStopPips", v: unknown) => {
    setDraft((d) => ({ ...d, pairs: { ...d.pairs, [k]: { ...d.pairs[k], [f]: v } } }));
    setDirty(true);
  };
  const setOverride = (k: PairKey, v: string) => {
    setDraft((d) => {
      const o = { ...d.symbolOverrides };
      if (v) o[k] = v; else delete o[k];
      return { ...d, symbolOverrides: o };
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setErrors([]);
    setMsg(null);
    const patch: Record<string, unknown> = { ...draft, symbolOverrides: Object.fromEntries(PAIR_KEYS.map((k) => [k, draft.symbolOverrides[k] ?? null])) };
    const r = await post("/api/fx-scalper/settings", { patch, expectVersion: baseVersion });
    setSaving(false);
    if (!r.ok) {
      setErrors(Array.isArray(r.data.errors) ? (r.data.errors as string[]) : [String(r.data.error ?? "Not saved")]);
      return;
    }
    setDirty(false);
    setBaseVersion(Number(r.data.version));
    setMsg("Saved. Changes apply to the next entry; open trades keep what they were opened with.");
    await reload();
  };

  const s = draft;
  const ccy = data.control.account_currency ?? "account currency";
  const inst = new Map(data.instruments.map((r) => [String(r.pair), r]));

  return (
    <div className="space-y-4">
      {data.settings.warnings.length > 0 && (
        <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "#F1D9A6", background: C.amberSoft, color: C.amber }}>
          {data.settings.warnings.map((w, i) => <p key={i}>{w}</p>)}
        </div>
      )}

      <Card title="Trade shape">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label="Take profit (pips)" hint="Buy: closed when the executable bid is this far above the fill. Sell: when the ask is this far below." value={s.strategy.tpPips} onChange={(v) => set(["strategy", "tpPips"], v)} />
          <label className="block text-sm">
            <span style={{ color: C.ink }}>Target measured</span>
            <select value={s.strategy.tpMode} onChange={(e) => set(["strategy", "tpMode"], e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-1.5" style={{ borderColor: C.line }}>
              <option value="executable">On executable prices, before commission (default)</option>
              <option value="after_fees">After fees (target widened by the round-trip charges)</option>
            </select>
            <span className="mt-0.5 block text-xs" style={{ color: C.muted }}>The spread is already in executable prices and is never deducted twice.</span>
          </label>
          <NumField label="Time exit (seconds)" hint="Close requested at this age whatever the P&L." value={s.strategy.maxHoldSec} step="1" onChange={(v) => set(["strategy", "maxHoldSec"], v)} />
          <NumField label="Signal window (seconds)" hint="An entry must be sent within this long after the candle closes." value={s.strategy.signalExpirySec} step="1" onChange={(v) => set(["strategy", "signalExpirySec"], v)} />
          <NumField label="Stop: minimum (pips)" value={s.strategy.stopMinPips} onChange={(v) => set(["strategy", "stopMinPips"], v)} />
          <NumField label="Stop: × one-minute ATR(14)" value={s.strategy.stopAtrMult} onChange={(v) => set(["strategy", "stopAtrMult"], v)} />
          <NumField label="Stop: × current spread" value={s.strategy.stopSpreadMult} onChange={(v) => set(["strategy", "stopSpreadMult"], v)} />
          <NumField label="Max move since the signal (pips)" hint="Skip if price has already run this far past the signal close." value={s.strategy.maxSignalDriftPips} onChange={(v) => set(["strategy", "maxSignalDriftPips"], v)} />
        </div>
        <p className="mt-3 text-xs" style={{ color: C.muted }}>Stop = the largest of the three, rounded out to the tick. If that is wider than the pair&apos;s maximum (below), there is no trade — the maximum is never raised to fit one. After a fill the stop can only tighten.</p>
        <button className="mt-3 text-xs underline" style={{ color: C.blue }} onClick={() => setAdvanced(!advanced)}>{advanced ? "Hide" : "Show"} indicator settings</button>
        {advanced && (
          <div className="mt-3 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <NumField label="M1 fast EMA" step="1" value={s.strategy.m1EmaFast} onChange={(v) => set(["strategy", "m1EmaFast"], v)} />
            <NumField label="M1 slow EMA" step="1" value={s.strategy.m1EmaSlow} onChange={(v) => set(["strategy", "m1EmaSlow"], v)} />
            <NumField label="M5 fast EMA" step="1" value={s.strategy.m5EmaFast} onChange={(v) => set(["strategy", "m5EmaFast"], v)} />
            <NumField label="M5 slow EMA" step="1" value={s.strategy.m5EmaSlow} onChange={(v) => set(["strategy", "m5EmaSlow"], v)} />
            <NumField label="M5 slope (candles back)" step="1" value={s.strategy.m5SlopeBars} onChange={(v) => set(["strategy", "m5SlopeBars"], v)} />
            <NumField label="Band lookback (candles)" step="1" value={s.strategy.bandLookback} onChange={(v) => set(["strategy", "bandLookback"], v)} />
            <NumField label="Stochastic %K" step="1" value={s.strategy.stochK} onChange={(v) => set(["strategy", "stochK"], v)} />
            <NumField label="%K smoothing" step="1" value={s.strategy.stochSmooth} onChange={(v) => set(["strategy", "stochSmooth"], v)} />
            <NumField label="%D" step="1" value={s.strategy.stochD} onChange={(v) => set(["strategy", "stochD"], v)} />
            <NumField label="Oversold level" value={s.strategy.stochLow} onChange={(v) => set(["strategy", "stochLow"], v)} />
            <NumField label="Overbought level" value={s.strategy.stochHigh} onChange={(v) => set(["strategy", "stochHigh"], v)} />
            <NumField label="ATR period" step="1" value={s.strategy.atrPeriod} onChange={(v) => set(["strategy", "atrPeriod"], v)} />
          </div>
        )}
      </Card>

      <Card title="Costs of THIS account">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label={`Commission per 1.0 lot, per side (${ccy})`} hint="From your Genesis account terms. Round trip = 2 sides. Required — the broker's API does not report it." nullable value={s.costs.commissionPerLotPerSide} onChange={(v) => set(["costs", "commissionPerLotPerSide"], v)} />
          <NumField label={`Other charges per lot, round trip (${ccy})`} value={s.costs.otherChargesPerLotRoundTrip} onChange={(v) => set(["costs", "otherChargesPerLotRoundTrip"], v)} />
          <NumField label="Slippage allowance (pips)" hint="Raised automatically when measured fills are worse." value={s.costs.slippageAllowancePips} onChange={(v) => set(["costs", "slippageAllowancePips"], v)} />
          <label className="flex items-start gap-2 pt-6 text-sm">
            <input type="checkbox" checked={s.costs.confirmed} onChange={(e) => set(["costs", "confirmed"], e.target.checked)} className="mt-0.5" />
            <span style={{ color: C.ink }}>These are this account&apos;s actual costs (commission and any other charges).</span>
          </label>
        </div>
      </Card>

      <Card title="Risk limits">
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <NumField label="Risk per trade (% of risk capital)" value={s.risk.riskPerTradePct} onChange={(v) => set(["risk", "riskPerTradePct"], v)} />
          <NumField label="Max open risk (% of risk capital)" value={s.risk.maxOpenRiskPct} onChange={(v) => set(["risk", "maxOpenRiskPct"], v)} />
          <NumField label="Max bot positions at once" step="1" value={s.risk.maxConcurrent} onChange={(v) => set(["risk", "maxConcurrent"], v)} />
          <NumField label="Max lots per trade" value={s.risk.maxLotsPerTrade} onChange={(v) => set(["risk", "maxLotsPerTrade"], v)} />
          <NumField label="Max gross notional (× risk capital)" hint="Every position on the account counts, yours included." value={s.risk.maxGrossNotionalX} onChange={(v) => set(["risk", "maxGrossNotionalX"], v)} />
          <NumField label="Daily loss limit (%)" hint="Of the day's starting risk capital; then entries stop and bot positions close." value={s.risk.dailyLossLimitPct} onChange={(v) => set(["risk", "dailyLossLimitPct"], v)} />
          <NumField label="Losses in a row before a pause" step="1" value={s.risk.lossStreakCount} onChange={(v) => set(["risk", "lossStreakCount"], v)} />
          <NumField label="Pause length (minutes)" step="1" value={s.risk.lossStreakPauseMin} onChange={(v) => set(["risk", "lossStreakPauseMin"], v)} />
          <NumField label="Max bot positions one way in one currency" step="1" value={s.risk.maxSameCurrencyDirection} onChange={(v) => set(["risk", "maxSameCurrencyDirection"], v)} />
          <NumField label="Free margin to keep (% of equity)" value={s.risk.marginReservePct} onChange={(v) => set(["risk", "marginReservePct"], v)} />
          <NumField label={`Excluded from risk capital (${ccy})`} hint="Promotional credit, payouts left in the account." value={s.risk.excludedCapital} onChange={(v) => set(["risk", "excludedCapital"], v)} />
        </div>
      </Card>

      <Card title="Pairs">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: C.faint }}>
              <th className="py-1.5 pr-3">Pair</th><th className="pr-3">On</th><th className="pr-3">Max costs (pips)</th><th className="pr-3">Max stop (pips)</th><th className="pr-3">Broker symbol</th>
            </tr></thead>
            <tbody>
              {PAIR_KEYS.map((k) => {
                const row = inst.get(k) as { broker_symbol?: string; candidates?: string[]; status?: string; problem?: string } | undefined;
                const cands = row?.candidates ?? [];
                return (
                  <tr key={k} className="border-t" style={{ borderColor: C.line }}>
                    <td className="py-2 pr-3 font-semibold">{PAIRS[k].label}{PAIRS[k].note && <span className="block text-xs font-normal" style={{ color: C.muted }}>{PAIRS[k].note}</span>}</td>
                    <td className="pr-3"><input type="checkbox" checked={s.pairs[k].enabled} onChange={(e) => setPair(k, "enabled", e.target.checked)} /></td>
                    <td className="pr-3"><input type="number" step="0.1" value={s.pairs[k].maxCostPips} onChange={(e) => setPair(k, "maxCostPips", Number(e.target.value))} className="w-24 rounded border px-2 py-1" style={{ borderColor: C.line }} /></td>
                    <td className="pr-3"><input type="number" step="0.1" value={s.pairs[k].maxStopPips} onChange={(e) => setPair(k, "maxStopPips", Number(e.target.value))} className="w-24 rounded border px-2 py-1" style={{ borderColor: C.line }} /></td>
                    <td className="pr-3 text-xs">
                      {cands.length > 1 ? (
                        <select value={s.symbolOverrides[k] ?? ""} onChange={(e) => setOverride(k, e.target.value)} className="rounded border px-2 py-1" style={{ borderColor: C.line }}>
                          <option value="">automatic</option>
                          {cands.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : <span style={{ color: row?.status === "ready" ? C.ink : C.muted }}>{row?.broker_symbol ?? "—"}</span>}
                      {row?.status === "blocked" && <span className="block" style={{ color: C.red }}>{row.problem}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Market hours (New York time)">
        <div className="grid gap-4 sm:grid-cols-4">
          <TextField label="Rollover pause starts" value={s.session.rolloverStart} onChange={(v) => set(["session", "rolloverStart"], v)} />
          <TextField label="Rollover pause ends" value={s.session.rolloverEnd} onChange={(v) => set(["session", "rolloverEnd"], v)} />
          <TextField label="No new entries Friday after" value={s.session.fridayCutoff} onChange={(v) => set(["session", "fridayCutoff"], v)} />
          <NumField label="Minutes after the Sunday reopen" step="1" value={s.session.sundayOpenDelayMin} onChange={(v) => set(["session", "sundayOpenDelayMin"], v)} />
        </div>
        <p className="mt-2 text-xs" style={{ color: C.muted }}>Only NEW entries are held in these windows; open positions are always managed.</p>
      </Card>

      <Card title="Genesis partner terms (for payout tracking)">
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <label className="flex items-start gap-2 pt-6 text-sm">
            <input type="checkbox" checked={s.payout.termsEntered} onChange={(e) => { setDraft((d) => ({ ...d, payout: { ...d.payout, termsEntered: e.target.checked } })); setDirty(true); }} className="mt-0.5" />
            <span>Terms entered from the actual agreement</span>
          </label>
          <NumField label="Rate per eligible lot" nullable value={s.payout.ratePerLot} onChange={(v) => { setDraft((d) => ({ ...d, payout: { ...d.payout, ratePerLot: v } })); setDirty(true); }} />
          <label className="block text-sm">
            <span>Counted per</span>
            <select value={s.payout.basis} onChange={(e) => { setDraft((d) => ({ ...d, payout: { ...d.payout, basis: e.target.value as Settings["payout"]["basis"] } })); setDirty(true); }} className="mt-1 w-full rounded-lg border px-3 py-1.5" style={{ borderColor: C.line }}>
              <option value="round_turn">round turn (open + close = 1)</option>
              <option value="per_side">side (open and close each count)</option>
            </select>
          </label>
          <NumField label="Minimum hold for eligibility (s)" nullable step="1" value={s.payout.minHoldSec} onChange={(v) => { setDraft((d) => ({ ...d, payout: { ...d.payout, minHoldSec: v } })); setDirty(true); }} />
          <TextField label="Currency" value={s.payout.currency} onChange={(v) => { setDraft((d) => ({ ...d, payout: { ...d.payout, currency: v } })); setDirty(true); }} />
        </div>
        <p className="mt-2 text-xs" style={{ color: C.muted }}>Until the terms are entered, eligibility is unknown and counted as zero. The bot never trades for volume: every order comes from a signal.</p>
      </Card>

      <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-xl border bg-white px-4 py-3 shadow-sm" style={{ borderColor: C.line }}>
        <Btn kind="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Btn>
        {dirty && <Btn disabled={saving} onClick={() => { setDraft(JSON.parse(JSON.stringify(data.settings.values))); setBaseVersion(data.settings.version); setDirty(false); setErrors([]); }}>Discard changes</Btn>}
        <span className="text-xs" style={{ color: C.muted }}>Version {baseVersion}{dirty ? " · unsaved changes" : ""}</span>
        {msg && <span className="text-xs" style={{ color: C.green }}>{msg}</span>}
        {errors.length > 0 && <ul className="w-full list-disc pl-5 text-xs" style={{ color: C.red }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      </div>
    </div>
  );
}

/** Everything the owner is about to start, shown before START LIVE. */
export function StartReview({ data, busy, onCancel, onStart }: { data: StatusPayload; busy: boolean; onCancel: () => void; onStart: () => void }) {
  const [ack, setAck] = useState(false);
  const s = data.settings.values;
  const c = data.control;
  const ccy = data.control.account_currency ?? "";
  const workerBlockers = (data.worker?.snapshot?.bot?.blockers ?? []).filter((b) => !/press START LIVE/i.test(b));
  const offline = data.worker?.ageMs == null || data.worker.ageMs > 15_000;
  const blockers = [...data.settings.blockers, ...(offline ? ["The worker service is not running."] : [])];
  const enabled = PAIR_KEYS.filter((k) => s.pairs[k].enabled);
  const comm = s.costs.commissionPerLotPerSide;
  const rows: Array<[string, string]> = [
    ["Account", `${c.account_label ?? "—"} · accNum ${c.acc_num ?? "—"} · ${ccy || "currency unknown"} · LIVE`],
    ["Pairs", enabled.map((k) => PAIRS[k].label).join(", ") || "none"],
    ["Take profit", `${s.strategy.tpPips} pips ${s.strategy.tpMode === "executable" ? "on executable prices, before commission" : "after fees (widened by round-trip charges)"}`],
    ["Stop", `max(${s.strategy.stopMinPips} pips, ${s.strategy.stopAtrMult} × M1 ATR14, ${s.strategy.stopSpreadMult} × spread); no trade if wider than the pair maximum (${[...new Set(enabled.map((k) => s.pairs[k].maxStopPips))].join("/")} pips)`],
    ["Time exit", `${s.strategy.maxHoldSec} s after the fill, whatever the P&L`],
    ["Max costs", `${[...new Set(enabled.map((k) => s.pairs[k].maxCostPips))].join("/")} pips (spread + round-trip commission + other + slippage)`],
    ["Commission", comm == null ? "NOT SET" : `${money(comm, ccy)} per lot per side (${money(comm * 2, ccy)} round trip) · other ${money(s.costs.otherChargesPerLotRoundTrip, ccy)} · slippage allowance ${s.costs.slippageAllowancePips} pips${s.costs.confirmed ? "" : " · NOT CONFIRMED"}`],
    ["Risk per trade", `${s.risk.riskPerTradePct}% of risk capital · at most ${s.risk.maxLotsPerTrade} lots`],
    ["Open risk", `${s.risk.maxOpenRiskPct}% · ${s.risk.maxConcurrent} positions · ${s.risk.maxSameCurrencyDirection} per currency direction · notional ${s.risk.maxGrossNotionalX}× · keep ${s.risk.marginReservePct}% free margin`],
    ["Daily loss limit", `${s.risk.dailyLossLimitPct}% of the day's starting risk capital (then entries stop and bot positions close)`],
    ["Loss streak", `${s.risk.lossStreakCount} losses in a row → ${s.risk.lossStreakPauseMin}-minute pause`],
    ["Excluded capital", money(s.risk.excludedCapital, ccy)],
  ];
  return (
    <div>
      <h2 className="text-lg font-semibold" style={{ color: C.ink }}>START LIVE</h2>
      <p className="mt-1 text-sm" style={{ color: C.muted }}>Review what the bot will trade with. Once started, it places live market orders on this account automatically — no confirmation per trade.</p>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t align-top" style={{ borderColor: C.line }}>
              <td className="w-40 py-1.5 pr-3 text-xs font-semibold uppercase tracking-wider" style={{ color: C.faint }}>{k}</td>
              <td className="py-1.5" style={{ color: /NOT/.test(v) ? C.red : C.ink }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(blockers.length > 0 || workerBlockers.length > 0) && (
        <div className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "#F1D9A6", background: C.amberSoft }}>
          {blockers.length > 0 && <p className="font-semibold" style={{ color: C.red }}>Cannot start yet:</p>}
          {blockers.map((b, i) => <p key={`b${i}`} style={{ color: C.red }}>• {b}</p>)}
          {workerBlockers.length > 0 && <p className="mt-1 font-semibold" style={{ color: C.amber }}>After starting, entries will still wait for:</p>}
          {workerBlockers.slice(0, 6).map((b, i) => <p key={`w${i}`} style={{ color: C.amber }}>• {b}</p>)}
        </div>
      )}
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        <span style={{ color: C.ink }}>I understand this trades my live account automatically with the settings above. Pause, Stop and Emergency stop are on this page.</span>
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" disabled={!ack || busy || blockers.length > 0} onClick={onStart}>{busy ? "Starting…" : "START LIVE"}</Btn>
      </div>
    </div>
  );
}
