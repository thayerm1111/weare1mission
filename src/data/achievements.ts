/**
 * ACHIEVEMENTS — milestone badges layered on top of the existing XP/streak
 * system and the member's real activity (plays generated, trades journaled,
 * onboarding progress). Purely derived on the client from data we already
 * store, so there's no new backend. Add/adjust freely.
 */
import {
  type LucideIcon, Compass, Rocket, Zap, Crosshair, Target, NotebookPen,
  ShieldCheck, Flame, Award, TrendingUp, Crown, Trophy,
} from "lucide-react";

export type StatKey = "onboard" | "plays" | "trades" | "streak" | "xp";

export interface Badge {
  id: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  metric: StatKey;
  goal: number;
}

export const BADGES: Badge[] = [
  { id: "first-steps", label: "First Steps",     desc: "Start your onboarding",        icon: Compass,     metric: "onboard", goal: 1 },
  { id: "all-set",     label: "All Set Up",       desc: "Finish the Start Here setup",  icon: Rocket,      metric: "onboard", goal: 8 },
  { id: "first-play",  label: "First Play",       desc: "Generate your first signal",   icon: Zap,         metric: "plays",   goal: 1 },
  { id: "analyst",     label: "Market Analyst",   desc: "Generate 10 plays",            icon: Crosshair,   metric: "plays",   goal: 10 },
  { id: "sharpshooter", label: "Sharpshooter",    desc: "Generate 25 plays",            icon: Target,      metric: "plays",   goal: 25 },
  { id: "journal",     label: "Journal Started",  desc: "Log your first trade",         icon: NotebookPen, metric: "trades",  goal: 1 },
  { id: "disciplined", label: "Disciplined",      desc: "Journal 10 trades",            icon: ShieldCheck, metric: "trades",  goal: 10 },
  { id: "on-a-roll",   label: "On a Roll",        desc: "Reach a 3-day streak",         icon: Flame,       metric: "streak",  goal: 3 },
  { id: "committed",   label: "Committed",        desc: "Reach a 7-day streak",         icon: Award,       metric: "streak",  goal: 7 },
  { id: "unstoppable", label: "Unstoppable",      desc: "Reach a 30-day streak",        icon: Flame,       metric: "streak",  goal: 30 },
  { id: "rising",      label: "Rising",           desc: "Earn 300 XP",                  icon: TrendingUp,  metric: "xp",      goal: 300 },
  { id: "pro",         label: "Pro",              desc: "Earn 1,050 XP",                icon: Crown,       metric: "xp",      goal: 1050 },
  { id: "legend",      label: "Legend",           desc: "Earn 5,600 XP",                icon: Trophy,      metric: "xp",      goal: 5600 },
];
