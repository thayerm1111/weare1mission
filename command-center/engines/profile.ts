/**
 * ATLAS TRADING PROFILE — the boundaries the member sets once.
 *
 * The whole point of the product correction is that the member stops making a decision per trade and
 * starts setting a policy. This file is that policy: how much risk ATLAS may use, which kinds of
 * trade it may present, what it is permitted to do to an open position, and the daily limits that
 * protect a member from a bad DAY rather than a bad trade.
 *
 * Two deliberate choices:
 *
 * • Every permission defaults to the conservative answer. A profile that has never been touched allows
 *   ATLAS to talk and to protect, and nothing else: no automatic entry, no automatic management, no
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
  /**
   * 09-22 (owner: "I just want the toggle for Gen X and for the break-even profit guard AI Pips").
   * ONE switch for what ATLAS may do to an open trade: break-even, profit guard and the trail. Off
   * means the trade rides the stop and target it was opened with. Partials and full closes are not
   * part of it.
   */
  aiPips: boolean;
  /** conservative | aggressive. The only difference: conservative stops for 2 hours after 2 losses in a row. */
  riskMode: "conservative" | "aggressive";
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
  aiPips: true,
  riskMode: "conservative",
  // 09-22: every horizon is on for everyone — ATLAS takes what it sees, and the member no longer
  // picks kinds of trade. The three fields stay so nothing downstream has to change shape.
  allowQuick: true,
  allowHold: true,
  allowSwing: true,
  minConfidence: 55,
  allowBreakEven: true,
  allowPartials: false,
  allowProfitProtection: true,
  allowFullClose: false,
  autoManagement: true,
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
  ai_pips?: boolean | null; risk_mode?: string | null;
};

/*
 * 09-22: the saved row still has the old permission columns, and they are no longer read. Everything
 * ATLAS may do to an open trade comes from ONE switch (ai_pips), every horizon is allowed, and
 * partials and full closes are off for everybody. Leaving the columns in place means a future owner
 * can bring the fine-grained permissions back without a migration.
 */
const fromRow = (r: Row): TradingProfile => {
  const aiPips = r.ai_pips !== false;
  return {
  riskPct: Number(r.risk_pct),
  aiPips,
  riskMode: String(r.risk_mode ?? "conservative").toLowerCase() === "aggressive" ? "aggressive" : "conservative",
  allowQuick: true,
  allowHold: true,
  allowSwing: true,
  minConfidence: Number(r.min_confidence),
  allowBreakEven: aiPips,
  allowPartials: false,
  allowProfitProtection: aiPips,
  allowFullClose: false,
  autoManagement: aiPips,
  autoEntry: r.auto_entry,
  maxDailyLossPct: Number(r.max_daily_loss_pct),
  maxConsecutiveLosses: Number(r.max_consecutive_losses),
  maxOpenRiskPct: Number(r.max_open_risk_pct),
  newsLockoutMinutes: Number(r.news_lockout_minutes),
  configured: true,
  };
};

export async function getProfile(userId: string): Promise<TradingProfile> {
  const c = db();
  if (!c) return { ...DEFAULT_PROFILE };
  const { data } = await c.from("cc_trading_profiles").select("*").eq("user_id", userId).maybeSingle();
  return data ? fromRow(data as Row) : { ...DEFAULT_PROFILE };
}

/** The slice of the profile the setup engine needs. Kept narrow so the engine stays pure and testable. */
export const asSetupProfile = (p: TradingProfile): SetupProfile => ({
  allowQuick: true,   // 09-22: ATLAS takes every horizon it sees
  allowHold: true,
  allowSwing: true,
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
    ai_pips: next.aiPips !== false,
    risk_mode: next.riskMode === "aggressive" ? "aggressive" : "conservative",
    allow_quick: true,
    allow_hold: true,
    allow_swing: true,
    min_confidence: Math.round(clamp(Number(next.minConfidence) || 55, 0, 95)),
    allow_break_even: next.aiPips !== false,
    allow_partials: false,
    allow_profit_protection: next.aiPips !== false,
    allow_full_close: false,
    auto_management: next.aiPips !== false,
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

/** 2 losses in a row on a conservative account → two hours off (09-22). */
export const CONSERVATIVE_STREAK = 2;
export const CONSERVATIVE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/**
 * The account limits this member's safety mode implies — the ONLY thing conservative and aggressive
 * change. Conservative stops for two hours after two losses in a row; aggressive has no streak cap.
 */
export function limitsForMode(p: TradingProfile): { maxConsecutiveLosses: number | null; streakWindowMs: number | null } {
  return p.riskMode === "aggressive"
    ? { maxConsecutiveLosses: null, streakWindowMs: null }
    : { maxConsecutiveLosses: CONSERVATIVE_STREAK, streakWindowMs: CONSERVATIVE_COOLDOWN_MS };
}

/**
 * Which management actions ATLAS is permitted to take on its own, for one position.
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
