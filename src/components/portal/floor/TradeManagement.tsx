"use client";

/*
 * HOW THE AI LOOKS AFTER A TRADE — one account's three settings on the FLOW page (owner 10-08: "change
 * from AI PIPs to picking breakeven, AI management (follow price and taking partials)"). Replaces the
 * single "AI Pips" switch. The rules are in lib/flow/manageSettings.ts, the words in lib/flow/manageCopy.ts.
 *
 * One change at a time per account: while one is saving, the account's buttons wait, so two quick taps
 * can never be saved out of order. A refused or failed save puts the buttons back and says why.
 */
import { ShieldCheck, Loader2 } from "lucide-react";
import { BE_PIPS_CHOICES, FOLLOW_MODES, PARTIAL_CHOICES, type FollowMode, type PartialPct } from "@/lib/flow/manageSettings";
import { MGMT_TITLE, MGMT_APPLIES, MGMT_UNREAD, BE_LABEL, FOLLOW_LABEL, PARTIALS_LABEL, FOLLOW_NAMES, beLine, followLine, PARTIAL_LINES } from "@/lib/flow/manageCopy";

export type MgmtFields = {
  manageTrades?: boolean;
  beEnabled?: boolean;
  breakEvenPips?: number;
  goldBePips?: number | null;
  followPrice?: FollowMode;
  followActive?: boolean;
  partialPct?: number;
  partialsEnabled?: boolean;
  profitGuard?: boolean;
  /** The server could not read this account's settings just now. */
  settingsUnread?: boolean;
};
export type MgmtChange = { breakEven?: "off" | number; followPrice?: FollowMode; partials?: PartialPct };

/** The account as it will look once a change is saved — shown at once, put back if the save fails. */
export function optimisticMgmt<T extends MgmtFields>(a: T, c: MgmtChange): T {
  const be = c.breakEven === undefined ? a.beEnabled !== false : c.breakEven !== "off";
  const pips = typeof c.breakEven === "number" ? c.breakEven : a.breakEvenPips;
  const follow = c.followPrice ?? a.followPrice ?? "normal";
  const partial = c.partials ?? (a.partialPct === 25 || a.partialPct === 50 ? a.partialPct : 0);
  return {
    ...a,
    beEnabled: be,
    breakEvenPips: pips,
    goldBePips: typeof c.breakEven === "number" ? c.breakEven : a.goldBePips,
    followPrice: follow,
    followActive: be && follow !== "off",
    profitGuard: be && follow !== "off",
    partialPct: partial,
    partialsEnabled: partial > 0,
    manageTrades: be || partial > 0,
  };
}

function Chip({ on, disabled, onClick, children, label }: { on: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      className={`min-w-[2.5rem] rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors disabled:cursor-not-allowed ${
        on ? "border-emerald-500/60 bg-emerald-500/[0.10] text-emerald-600" : "border-ice bg-white text-navy hover:border-charcoal/25"
      } ${disabled && !on ? "opacity-40" : ""}`}
    >
      {children}
    </button>
  );
}

export function TradeManagement({ a, busy, error, onChange, tour }: {
  a: MgmtFields;
  busy: boolean;
  error: string;
  onChange: (c: MgmtChange) => void;
  tour?: (name: string) => Record<string, string | undefined>;
}) {
  const t = tour ?? (() => ({}));
  if (a.settingsUnread) {
    return (
      <div className="mt-2 border-t border-ice/70 pt-2.5">
        <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-charcoal/55"><ShieldCheck className="h-3.5 w-3.5" /> {MGMT_TITLE}</p>
        <p role="status" className="mt-1 text-[10.5px] font-semibold text-amber-700">{MGMT_UNREAD}</p>
      </div>
    );
  }
  const beOn = a.beEnabled !== false;
  const pips = a.breakEvenPips ?? 30;
  // An account's own older distance (10, 15, 35…) shows as its own button until another is picked.
  const ownPips = beOn && !BE_PIPS_CHOICES.includes(pips) ? pips : null;
  const follow: FollowMode = a.followPrice ?? "normal";
  const partial: PartialPct = a.partialPct === 25 || a.partialPct === 50 ? a.partialPct : 0;

  return (
    <div className="mt-2 border-t border-ice/70 pt-2.5">
      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-charcoal/55">
        <ShieldCheck className="h-3.5 w-3.5" /> {MGMT_TITLE}
        {busy && <Loader2 className="ml-1 h-3 w-3 animate-spin text-navy" aria-label="Saving" />}
      </p>

      <div {...t("ft-be")} className="mt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-full flex-shrink-0 text-[11px] font-semibold text-navy sm:w-[5.5rem]">{BE_LABEL}</span>
          <Chip on={!beOn} disabled={busy} label="Break-even off" onClick={() => beOn && onChange({ breakEven: "off" })}>Off</Chip>
          {ownPips != null && (
            <Chip on disabled={busy} label={`Break-even ${ownPips} pips (your current setting)`} onClick={() => {}}>{ownPips}</Chip>
          )}
          {BE_PIPS_CHOICES.map((p) => {
            const sel = beOn && pips === p;
            return <Chip key={p} on={sel} disabled={busy} label={`Break-even ${p} pips`} onClick={() => !sel && onChange({ breakEven: p })}>{p}</Chip>;
          })}
          <span className="text-[10px] font-semibold text-charcoal/40">pips</span>
        </div>
        <p className="mt-1 text-[10px] leading-tight text-charcoal/40">{beLine(beOn, pips)}</p>
      </div>

      <div {...t("ft-follow")} className="mt-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-full flex-shrink-0 text-[11px] font-semibold text-navy sm:w-[5.5rem]">{FOLLOW_LABEL}</span>
          {FOLLOW_MODES.map((m) => {
            const sel = follow === m;
            return <Chip key={m} on={sel} disabled={busy || !beOn} label={`Follow price ${FOLLOW_NAMES[m]}`} onClick={() => !sel && onChange({ followPrice: m })}>{FOLLOW_NAMES[m]}</Chip>;
          })}
        </div>
        <p className={`mt-1 text-[10px] leading-tight ${beOn ? "text-charcoal/40" : "font-semibold text-amber-700"}`}>{followLine(follow, beOn)}</p>
      </div>

      <div {...t("ft-partials")} className="mt-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-full flex-shrink-0 text-[11px] font-semibold text-navy sm:w-[5.5rem]">{PARTIALS_LABEL}</span>
          {PARTIAL_CHOICES.map((p) => {
            const sel = partial === p;
            return <Chip key={p} on={sel} disabled={busy} label={p === 0 ? "Partials off" : `Bank ${p}% halfway to target`} onClick={() => !sel && onChange({ partials: p })}>{p === 0 ? "Off" : `${p}%`}</Chip>;
          })}
        </div>
        <p className="mt-1 text-[10px] leading-tight text-charcoal/40">{PARTIAL_LINES[partial]}</p>
      </div>

      {error ? (
        <p role="status" className="mt-2 text-[10.5px] font-semibold text-red-600">{error}</p>
      ) : (
        <p className="mt-2 text-[10px] leading-tight text-charcoal/35">{MGMT_APPLIES}</p>
      )}
    </div>
  );
}
