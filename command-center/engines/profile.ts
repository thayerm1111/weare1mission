/**
 * THE BRAIN TRADING PROFILE — the boundaries the member sets once.
 *
 * The whole point of the product correction is that the member stops making a decision per trade and
 * starts setting a policy. This file is that policy: how much risk THE BRAIN may use, which kinds of
 * trade it may present, what it is permitted to do to an open position, and the daily limits that
 * protect a member from a bad DAY rather than a bad trade.
 *
 * Two deliberate choices:
 *
 * • Every permission defaults to the conservative answer. A profile that has never been touched allows
 *   THE BRAIN to talk and to protect, and nothing else: no automatic entry, no automatic management, no
 *   full closes. Consent is something a member gives, not something a default assumes on their behalf.
 *
 * • SWING is OFF by default. It is the style that holds risk overnight and through news, and a member who
 *   has not thought about that should not discover it from a position that is still open in the morning.
 */
import { db } from "../adapters/db";
import type { SetupProfile } from "./setup";
import { MAX_RISK_PCT } from "./validator";

export type TradingProfile = {
  riskPct: number;
  allowQuick: boolean;
  allowHold: boolean;
  allowSwing: boolean;
  minConfidence: number;
  allowBreakEven: boolean;
  allowPartials: boolean;
  allowProfitProtection: boolean;
  allowFullClose: boolean;
  autoManagement: boolean;
  autoEntry: boolean;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  maxOpenRiskPct: number;
  newsLockoutMinutes: number;
  /** False until the member has actually saved one — the UI says so rather than pretending. */
  configured: boolean;
};

export const DEFAULT_PROFILE: TradingProfile = {
  riskPct: 0.5,
  allowQuick: true,
  allowHold: true,
  allowSwing: false,
  minConfidence: 55,
  allowBreakEven: true,
  allowPartials: true,
  allowProfitProtection: true,
  allowFullClose: false,
  autoManagement: false,
  autoEntry: false,
  maxDailyLossPct: 3.0,
  maxConsecutiveLosses: 3,
  maxOpenRiskPct: 2.0,
  newsLockoutMinutes: 15,
  configured: false,
};

type Row = {
  risk_pct: number; allow_quick: boolean; allow_hold: boolean; allow_swing: boolean;
  min_confidence: number; allow_break_even: boolean; allow_partials: boolean;
  allow_profit_protection: boolean; allow_full_close: boolean; auto_management: boolean;
  auto_entry: boolean; max_daily_loss_pct: number; max_consecutive_losses: number;
  max_open_risk_pct: number; news_lockout_minutes: number;
};

const fromRow = (r: Row): TradingProfile => ({
  riskPct: Number(r.risk_pct),
  allowQuick: r.allow_quick,
  allowHold: r.allow_hold,
  allowSwing: r.allow_swing,
  minConfidence: Number(r.min_confidence),
  allowBreakEven: r.allow_break_even,
  allowPartials: r.allow_partials,
  allowProfitProtection: r.allow_profit_protection,
  allowFullClose: r.allow_full_close,
  autoManagement: r.auto_management,
  autoEntry: r.auto_entry,
  maxDailyLossPct: Number(r.max_daily_loss_pct),
  maxConsecutiveLosses: Number(r.max_consecutive_losses),
  maxOpenRiskPct: Number(r.max_open_risk_pct),
  newsLockoutMinutes: Number(r.news_lockout_minutes),
  configured: true,
});

export async function getProfile(userId: string): Promise<TradingProfile> {
  const c = db();
  if (!c) return { ...DEFAULT_PROFILE };
  const { data } = await c.from("cc_trading_profiles").select("*").eq("user_id", userId).maybeSingle();
  return data ? fromRow(data as Row) : { ...DEFAULT_PROFILE };
}

/** The slice of the profile the setup engine needs. Kept narrow so the engine stays pure and testable. */
export const asSetupProfile = (p: TradingProfile): SetupProfile => ({
  allowQuick: p.allowQuick,
  allowHold: p.allowHold,
  allowSwing: p.allowSwing,
  minConfidence: p.minConfidence,
});

export type ProfilePatch = Partial<Omit<TradingProfile, "configured">>;

/**
 * Save a change. Every numeric field is clamped here rather than trusted from the client, because this is
 * the boundary between a browser and a system that can send live orders.
 */
export async function saveProfile(userId: string, patch: ProfilePatch): Promise<TradingProfile> {
  const c = db();
  if (!c) return { ...DEFAULT_PROFILE, ...patch };
  const current = await getProfile(userId);
  const next: TradingProfile = { ...current, ...patch, configured: true };

  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const row = {
    user_id: userId,
    risk_pct: clamp(Number(next.riskPct) || 0.5, 0.05, MAX_RISK_PCT),
    allow_quick: !!next.allowQuick,
    allow_hold: !!next.allowHold,
    allow_swing: !!next.allowSwing,
    min_confidence: Math.round(clamp(Number(next.minConfidence) || 55, 0, 95)),
    allow_break_even: !!next.allowBreakEven,
    allow_partials: !!next.allowPartials,
    allow_profit_protection: !!next.allowProfitProtection,
    allow_full_close: !!next.allowFullClose,
    auto_management: !!next.autoManagement,
    auto_entry: !!next.autoEntry,
    max_daily_loss_pct: clamp(Number(next.maxDailyLossPct) || 3, 0.25, 20),
    max_consecutive_losses: Math.round(clamp(Number(next.maxConsecutiveLosses) || 3, 1, 20)),
    max_open_risk_pct: clamp(Number(next.maxOpenRiskPct) || 2, 0.1, 10),
    news_lockout_minutes: Math.round(clamp(Number(next.newsLockoutMinutes) || 0, 0, 120)),
    updated_at: new Date().toISOString(),
  };
  const { data } = await c.from("cc_trading_profiles").upsert(row, { onConflict: "user_id" }).select("*").single();
  return data ? fromRow(data as Row) : next;
}

/**
 * Which management actions THE BRAIN is permitted to take on its own, for one position.
 *
 * The account's own permissions and the position's override the profile, in that order — the narrower
 * consent always wins, and switching AI management off on a position turns everything off regardless of
 * what the profile says.
 */
export function managementPermissions(
  p: TradingProfile,
  account: Record<string, boolean> | null | undefined,
  position: Record<string, boolean> | null | undefined,
  aiManagementOn: boolean,
): Record<"break_even" | "partial" | "protect_stop" | "move_stop" | "close", boolean> {
  const merged = { ...(account ?? {}), ...(position ?? {}) };
  const allow = (key: string, fromProfile: boolean) =>
    aiManagementOn && (merged[key] !== undefined ? !!merged[key] : fromProfile);
  return {
    break_even: allow("break_even", p.allowBreakEven),
    partial: allow("partial", p.allowPartials),
    protect_stop: allow("protect_stop", p.allowProfitProtection),
    move_stop: allow("move_stop", p.allowProfitProtection),
    close: allow("close", p.allowFullClose),
  };
}
