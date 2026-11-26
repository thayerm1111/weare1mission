import React from "react";
import type { NitrousAccount, NitrousMode } from "../../../lib/nitrous/types";
import { hasFastConsent, hasSweepConsent, hasAggressiveConsent, NITROUS_AGGRESSIVE_CONSENT_VERSION, NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION, NITROUS_SWEEP_CONSENT_VERSION } from "../../../lib/nitrous/policy";

type StrategyAccount = Pick<NitrousAccount, "mode" | "fastStrategyEnabled" | "sweepStrategyEnabled" | "aggressiveStrategyEnabled">;

/** Reopening authorization never silently adds a strategy to an existing account. */
export function accountStrategyConsent(account: StrategyAccount, mode: NitrousMode): string {
  if (mode === "nitrous" && account.mode === "nitrous") {
    if (account.aggressiveStrategyEnabled === true) return NITROUS_AGGRESSIVE_CONSENT_VERSION;
    if (account.sweepStrategyEnabled === true) return NITROUS_SWEEP_CONSENT_VERSION;
    if (account.fastStrategyEnabled === true) return NITROUS_FAST_CONSENT_VERSION;
  }
  return NITROUS_CONSENT_VERSION;
}

export function accountStrategyName(account: StrategyAccount): string {
  const consent = accountStrategyConsent(account, account.mode);
  return hasAggressiveConsent(consent) ? "Aggressive entries" : hasSweepConsent(consent) ? "Faster Nitrous + sweep & reclaim"
    : hasFastConsent(consent) ? "Faster Nitrous" : "Original setups";
}

export function sweepAccountMessage(account: (StrategyAccount & Pick<NitrousAccount, "automationEnabled">) | null, fresh: boolean): string {
  if (!account) return "Sweep & reclaim is available in Nitrous. Connect an account and review this strategy before auto entries can use it.";
  if (!fresh) return "Refreshing this account's sweep & reclaim authorization.";
  if (account.mode !== "nitrous" || !account.sweepStrategyEnabled)
    return "Sweep & reclaim is available, but this account has not authorized it. Review entry strategies in the account controls to enable these entries.";
  return account.automationEnabled
    ? "Sweep & reclaim is authorized on this account. A fill still requires broker and risk checks."
    : "Sweep & reclaim is authorized on this account. Auto trading is paused.";
}

export function aggressiveAccountMessage(account: (StrategyAccount & Pick<NitrousAccount, "automationEnabled">) | null, fresh: boolean): string {
  if (!account) return "Connect a TradeLocker account to use aggressive entries.";
  if (!fresh) return "Checking this account’s strategy settings.";
  if (account.mode !== "nitrous" || !account.aggressiveStrategyEnabled) return "Watching only. Choose Aggressive entries in this account’s strategy settings to use this setup.";
  return account.automationEnabled
    ? "Aggressive entries are authorized on this account. Broker checks apply."
    : "Aggressive entries are authorized on this account. Auto trading is paused.";
}

const choices = [
  { version: NITROUS_CONSENT_VERSION, name: "Original setups", detail: "Trend pullbacks and break-and-retest entries with aligned hourly and 15-minute structure." },
  { version: NITROUS_FAST_CONSENT_VERSION, name: "Faster Nitrous", detail: "Original setups plus additional trend and validated range opportunities during 15-minute consolidation." },
  { version: NITROUS_SWEEP_CONSENT_VERSION, name: "Faster Nitrous + sweep & reclaim", detail: "Adds entries after a completed candle sweeps a known swing high or low and closes back through it." },
  { version: NITROUS_AGGRESSIVE_CONSENT_VERSION, name: "Aggressive entries", detail: "Includes all earlier strategies plus range edge rejection and compression breakout. Both can qualify while gold is moving sideways." },
] as const;

export function NitrousStrategyOptions({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (version: string) => void }) {
  return <fieldset disabled={disabled} className="nitrous-strategy-choices">
    <legend>Choose entry strategies</legend>
    {choices.map(choice => <label className="nitrous-check" key={choice.version} data-selected={value === choice.version}>
      <input type="radio" name="nitrous-entry-strategy" value={choice.version} checked={value === choice.version} onChange={() => onChange(choice.version)} />
      <span><strong>{choice.name}</strong><small>{choice.detail}</small></span>
    </label>)}
    {hasFastConsent(value) && <p className="nitrous-risk-note">Faster Nitrous uses unproven rules that may qualify more setups and trade more often. Your selected risk per trade and daily loss allowance stay the same.</p>}
    {value === NITROUS_SWEEP_CONSENT_VERSION && <p className="nitrous-risk-note" style={{ marginTop: 12 }}>Sweep &amp; reclaim first requires price to pierce an already confirmed swing high or low, then a completed 5- or 15-minute candle to close back through that level. An entry can qualify near the reclaim close without another retest. The hourly trend, structural stop, reward/risk, spread, margin and account risk checks still apply. This new entry rule is unproven and may increase trading frequency.</p>}
    {hasAggressiveConsent(value) && <div className="nitrous-strategy-explainer">
      <p><strong>Range edge rejection</strong> When the hourly and 15-minute charts are moving sideways, gold moves away from a range edge, tests it again and closes back inside on a 5-minute candle.</p>
      <p><strong>Compression breakout</strong> Gold closes outside a tight half-hour range on a 5-minute candle. The hourly and 15-minute charts must agree with the move or be sideways.</p>
      <p className="nitrous-risk-note">In a preliminary simulation, these two strategies together lost money after estimated trading costs.</p>
    </div>}
  </fieldset>;
}
