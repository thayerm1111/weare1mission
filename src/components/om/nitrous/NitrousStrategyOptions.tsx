import React from "react";
import type { NitrousAccount, NitrousMode } from "../../../lib/nitrous/types";
import { hasFastConsent, hasSweepConsent, NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION, NITROUS_SWEEP_CONSENT_VERSION } from "../../../lib/nitrous/policy";

type StrategyAccount = Pick<NitrousAccount, "mode" | "fastStrategyEnabled" | "sweepStrategyEnabled">;

/** Reopening authorization never silently adds a strategy to an existing account. */
export function accountStrategyConsent(account: StrategyAccount, mode: NitrousMode): string {
  if (mode === "nitrous" && account.mode === "nitrous") {
    if (account.sweepStrategyEnabled === true) return NITROUS_SWEEP_CONSENT_VERSION;
    if (account.fastStrategyEnabled === true) return NITROUS_FAST_CONSENT_VERSION;
  }
  return NITROUS_CONSENT_VERSION;
}

export function accountStrategyName(account: StrategyAccount): string {
  const consent = accountStrategyConsent(account, account.mode);
  return hasSweepConsent(consent) ? "Faster Nitrous + sweep & reclaim"
    : hasFastConsent(consent) ? "Faster Nitrous" : "Original setups";
}

export function sweepAccountMessage(account: (StrategyAccount & Pick<NitrousAccount, "automationEnabled">) | null, fresh: boolean): string {
  if (!account) return "Sweep & reclaim is available in Nitrous. Connect an account and review this strategy before auto entries can use it.";
  if (!fresh) return "Refreshing this account's sweep & reclaim authorization.";
  if (account.mode !== "nitrous" || !account.sweepStrategyEnabled)
    return "Sweep & reclaim is available, but this account has not authorized it. Review sweep & reclaim in the account controls to enable these entries.";
  return account.automationEnabled
    ? "Sweep & reclaim is authorized on this account. A fill still requires broker and risk checks."
    : "Sweep & reclaim is authorized on this account. Auto trading is paused.";
}

const choices = [
  { version: NITROUS_CONSENT_VERSION, name: "Original setups", detail: "Trend pullbacks and break-and-retest entries with aligned hourly and 15-minute structure." },
  { version: NITROUS_FAST_CONSENT_VERSION, name: "Faster Nitrous", detail: "Original setups plus additional trend and validated range opportunities during 15-minute consolidation." },
  { version: NITROUS_SWEEP_CONSENT_VERSION, name: "Faster Nitrous + sweep & reclaim", detail: "Adds entries after a completed candle sweeps a known swing high or low and closes back through it." },
] as const;

export function NitrousStrategyOptions({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (version: string) => void }) {
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: "20px 0" }}>
    <legend style={{ fontSize: 14, fontWeight: 600 }}>Choose entry strategies</legend>
    {choices.map(choice => <label className="nitrous-check" key={choice.version}>
      <input type="radio" name="nitrous-entry-strategy" value={choice.version} checked={value === choice.version} onChange={() => onChange(choice.version)} />
      <span><strong>{choice.name}</strong><small style={{ display: "block", marginTop: 3, fontSize: 13, lineHeight: 1.55 }}>{choice.detail}</small></span>
    </label>)}
    {hasFastConsent(value) && <p className="nitrous-risk-note">Faster Nitrous uses unproven rules that may qualify more setups and trade more often. Your selected risk per trade and daily loss allowance stay the same.</p>}
    {hasSweepConsent(value) && <p className="nitrous-risk-note" style={{ marginTop: 12 }}>Sweep &amp; reclaim first requires price to pierce an already confirmed swing high or low, then a completed 5- or 15-minute candle to close back through that level. An entry can qualify near the reclaim close without another retest. The hourly trend, structural stop, reward/risk, spread, margin and account risk checks still apply. This new entry rule is unproven and may increase trading frequency.</p>}
  </fieldset>;
}
