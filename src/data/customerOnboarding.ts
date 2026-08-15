/**
 * CUSTOMER ONBOARDING  —  the "Start Here" guided flow for The Ones (customers).
 *
 * This is the trader/customer journey: get connected, get the app + Tap to Trade
 * set up, learn the rules, and plug into live sessions and the platform.
 *
 * Progress is tracked by `id`, so keep ids stable once members have started
 * (changing an id resets that step for everyone).
 *
 * Where a real link or exact detail isn't wired yet, use `placeholder: true` on
 * the link so the UI shows a tasteful "coming from your team" chip instead of a
 * dead button. Fill in the real `href` later and remove the placeholder flag.
 */
import type { LucideIcon } from "lucide-react";
import {
  Sparkles, MessageCircle, Smartphone, CalendarClock, ShieldAlert,
  GraduationCap, NotebookPen, Compass,
} from "lucide-react";

export interface OnboardLink {
  label: string;
  href: string;
  placeholder?: boolean; // true = detail not wired yet; render as "coming soon" chip
  external?: boolean;
}

export interface OnboardBlock {
  /** Optional sub-heading inside a step. */
  heading?: string;
  /** Body paragraphs. */
  body?: string[];
  /** A tight checklist / bullet list of concrete points. */
  points?: string[];
}

export interface CustomerStep {
  id: string;
  section: string;
  icon: LucideIcon;
  title: string;
  /** One-line summary shown collapsed. */
  summary: string;
  /** Rich, expandable content. */
  blocks: OnboardBlock[];
  links?: OnboardLink[];
  /** The concrete "done when" checklist that marks this step complete. */
  checklist: string[];
  /** Optional note rendered in a subtle callout. */
  note?: string;
}

export const customerSections = [
  "Welcome",
  "Get Connected",
  "Set Up Your Trading",
  "Go Live",
  "Trade Smart",
  "Know the Platform",
] as const;

export const customerOnboardingSteps: CustomerStep[] = [
  // ─────────────────────────────  WELCOME  ─────────────────────────────
  {
    id: "welcome-mission",
    section: "Welcome",
    icon: Sparkles,
    title: "Welcome — this is the Mission",
    summary: "You're in the right place. Here's what 1 Mission is and how to use it.",
    blocks: [
      {
        body: [
          "Welcome to 1 Mission. You just joined a community built around one idea: that with the right tools, the right people, and the right habits, anyone can learn to trade the markets with confidence.",
          "This page is your launchpad. Work through it top to bottom at your own pace — each step gets you a little more connected and a little more set up. Your progress saves automatically on this device, so you can leave and come back anytime.",
        ],
      },
      {
        heading: "How to use this portal",
        points: [
          "The Floor is where live trading, plays, and market updates happen.",
          "OM AI is your personal trading co-pilot — ask it anything, any time.",
          "OM AI Plays surfaces high-quality setups you can learn from.",
          "What's On has the live session calendar in your local time.",
          "The Inner Circle is the leadership and mentorship layer.",
        ],
      },
    ],
    checklist: ["Read the welcome", "Set aside 20–30 minutes to finish this Start Here page"],
    note: "There's no rush and no wrong pace. Consistency beats intensity — a little every day compounds fast.",
  },

  // ──────────────────────────  GET CONNECTED  ──────────────────────────
  {
    id: "join-telegram",
    section: "Get Connected",
    icon: MessageCircle,
    title: "Join the Telegram groups",
    summary: "Get into the community home base and turn on the channels that matter.",
    blocks: [
      {
        body: [
          "Telegram is where the community lives day to day — announcements, live-session links, encouragement, and quick questions. Getting into the right groups is the single most important connection step, so do this first.",
        ],
      },
      {
        heading: "The groups to join",
        points: [
          "Main community group — daily conversation, wins, and support.",
          "Announcements channel — the single source of truth for schedules and access links. Turn notifications ON.",
          "Signals / plays channel — where trade ideas and live calls are posted.",
        ],
      },
    ],
    links: [
      { label: "Join One Mission Community", href: "https://t.me/+c5QCPF8mlHo5MDcx", external: true },
      { label: "Join announcements", href: "#", placeholder: true },
      { label: "Join the plays channel", href: "#", placeholder: true },
    ],
    checklist: [
      "Join the main community group",
      "Join the announcements channel and enable notifications",
      "Join the plays channel",
      "Introduce yourself in the main group",
    ],
    note: "Don't have the links yet? Your mentor or the welcome message will share them — check the announcements channel for the current invites.",
  },

  // ─────────────────────  SET UP YOUR TRADING  ─────────────────────
  {
    id: "coneqtx-app",
    section: "Set Up Your Trading",
    icon: Smartphone,
    title: "Download the ConeqtX app & log in",
    summary: "Install ConeqtX, sign in, and get your account ready for Tap to Trade.",
    blocks: [
      {
        body: [
          "ConeqtX is the app you'll use to follow and place trades. Install it, sign in, and get comfortable moving around before your first live session.",
        ],
      },
      {
        heading: "Get the app",
        points: [
          "Get ConeqtX on Google Play (Android), or open the web app at app.coneqtx.com — the iPhone (App Store) version is coming soon.",
          "Open it and sign in with the account you created when you joined.",
          "If you haven't created your ConeqtX account yet, do that first — your mentor can walk you through it.",
          "Enable notifications so you never miss a live call or alert.",
        ],
      },
      {
        heading: "Log in & find your way around",
        points: [
          "Sign in and complete your profile.",
          "Locate the main areas: your dashboard, the signals/plays feed, and settings.",
          "Confirm your email and set up any security (like a passcode or 2FA) the app offers.",
        ],
      },
    ],
    links: [
      { label: "Get ConeqtX on Google Play", href: "https://play.google.com/store/apps/details?id=com.coneqtx.app", external: true },
      { label: "Open ConeqtX (web app)", href: "https://app.coneqtx.com", external: true },
      { label: "ConeqtX on the App Store", href: "#", placeholder: true, external: true },
    ],
    checklist: [
      "Download and install ConeqtX",
      "Sign in and confirm your email",
      "Complete your profile",
      "Turn on notifications",
    ],
    note: "Android and the web app are live now — use whichever suits you. The iPhone (App Store) version is coming soon.",
  },
  {
    id: "connect-broker",
    section: "Set Up Your Trading",
    icon: Smartphone,
    title: "Set up your broker",
    summary: "Open and connect a broker account so you can trade with real execution.",
    blocks: [
      {
        body: [
          "To place live trades you'll need a brokerage account connected to ConeqtX. A broker is simply the regulated company that holds your funds and executes your orders in the market.",
        ],
      },
      {
        heading: "What to do",
        points: [
          "Open an account with the broker your team recommends (details shared in the community).",
          "Complete the broker's identity verification (KYC) — this is standard and required by law.",
          "Fund the account only with money you can afford to risk. Start small while you learn.",
          "Connect the broker to ConeqtX so Tap to Trade can execute your orders.",
        ],
      },
    ],
    links: [{ label: "Recommended broker setup guide", href: "#", placeholder: true }],
    checklist: [
      "Open your broker account",
      "Complete identity verification",
      "Fund with an amount you're comfortable risking",
      "Connect the broker to ConeqtX",
    ],
    note: "Never deposit money you can't afford to lose. Trading involves real risk of loss — treat your early capital as tuition while you build skill.",
  },
  {
    id: "tap-to-trade",
    section: "Set Up Your Trading",
    icon: Smartphone,
    title: "Connect Tap to Trade & learn how it works",
    summary: "Get an alert, press Approve, and let the trader manage the rest.",
    blocks: [
      {
        body: [
          "Tap to Trade is the simplest way to act on a play. Once your broker is connected, you get an alert the moment a trader shares a setup — you press Approve, and the trade is placed in your own account. The educator/trader manages it from there.",
        ],
      },
      {
        heading: "It's this simple",
        points: [
          "Get a notification — a trader shares a live setup and it pops up in ConeqtX.",
          "Press Approve — glance at the setup, then tap Approve to place it in your account.",
          "The trader does the rest — they manage the trade (targets, break-even, exits) and post updates as it plays out.",
        ],
      },
      {
        heading: "One-time setup",
        points: [
          "Connect your broker in ConeqtX — you only do this once.",
          "Set your risk — pick your lot size / risk level so every approval sizes correctly for your account.",
        ],
      },
    ],
    checklist: [
      "Connect your broker in ConeqtX",
      "Set your lot size / risk level",
      "Approve your first trade when an alert comes in",
    ],
    note: "You approve every trade on your own account — nothing is placed without your tap. Tap to Trade makes execution fast; it doesn't remove market risk. Educational only, not financial advice.",
  },

  // ──────────────────────────────  GO LIVE  ──────────────────────────────
  {
    id: "mfx-sessions",
    section: "Go Live",
    icon: CalendarClock,
    title: "Live sessions with MFX",
    summary: "Know when the live trading sessions happen and how to join.",
    blocks: [
      {
        body: [
          "Live sessions with MFX are where a lot of the learning clicks — you watch the market get read in real time, hear the reasoning behind plays, and can ask questions as you go. Showing up live, consistently, is one of the fastest ways to improve.",
        ],
      },
      {
        heading: "Make it a habit",
        points: [
          "Check What's On for the live session times — they display in your local timezone automatically.",
          "Add 2–3 sessions a week to your calendar so they become routine.",
          "Join a few minutes early, and have ConeqtX open so you can follow along.",
          "Join the live sessions at MFXlive.com — the link is also posted in announcements before each session.",
        ],
      },
    ],
    links: [
      { label: "Join live on MFXlive.com", href: "https://mfxlive.com", external: true },
      { label: "See the live schedule (What's On)", href: "/portal/schedule" },
    ],
    checklist: [
      "Open What's On and view the schedule",
      "Add 2–3 live sessions to your calendar",
      "Attend your first live session with MFX",
    ],
  },

  // ────────────────────────────  TRADE SMART  ────────────────────────────
  {
    id: "risk-management",
    section: "Trade Smart",
    icon: ShieldAlert,
    title: "Risk management rules to follow",
    summary: "The rules that keep you in the game long enough to get good.",
    blocks: [
      {
        body: [
          "Risk management is the single biggest difference between traders who last and traders who blow up. Protecting your capital always comes before chasing profit. Internalize these rules before you size up.",
        ],
      },
      {
        heading: "The core rules",
        points: [
          "Risk a small, fixed percentage per trade — many traders use 1% or less of their account. Never risk money you can't afford to lose.",
          "Always use a stop-loss. Decide where you're wrong BEFORE you enter, and honor it.",
          "Know your risk-to-reward. Aim for setups where the potential reward is a multiple of the risk (e.g. 2:1 or better).",
          "Size your position from your stop distance and your risk %, not from how confident you feel.",
          "Don't add to losers and don't move your stop further away to avoid taking a loss.",
          "Cap your day. Set a max number of trades and a max daily loss — when you hit it, you're done.",
          "No revenge trading. After a loss, step away before the next decision.",
        ],
      },
    ],
    checklist: [
      "Decide your fixed risk % per trade",
      "Commit to always using a stop-loss",
      "Set a daily max-loss and max-trades limit",
    ],
    note: "This is education, not financial advice. Trading carries a real risk of loss and results vary from person to person.",
  },
  {
    id: "trading-basics",
    section: "Trade Smart",
    icon: GraduationCap,
    title: "Trading basics to know",
    summary: "The vocabulary and concepts that make everything else make sense.",
    blocks: [
      {
        body: [
          "You don't need to master everything at once, but a handful of basics will make live sessions and plays far easier to follow. Skim these now and revisit as you go.",
        ],
      },
      {
        heading: "The essentials",
        points: [
          "Pips & lots — how price movement and position size are measured.",
          "Long vs short — profiting when price rises (long) or falls (short).",
          "Entry, stop-loss, take-profit — where you get in, where you're wrong, where you take profit.",
          "Risk-to-reward (R) — measuring a trade in multiples of what you risked.",
          "Support & resistance — price levels where the market tends to react.",
          "Trend vs range — is the market moving directionally or chopping sideways?",
          "Sessions — Asia, London, and New York, and why timing matters (especially for forex & gold).",
          "Leverage & margin — how they amplify both gains AND losses. Respect them.",
        ],
      },
    ],
    links: [
      { label: "Ask OM AI to explain any term", href: "/portal/om-ai" },
      { label: "Browse the Creator Launchpad", href: "/portal/training" },
    ],
    checklist: [
      "Read through the essential terms",
      "Ask OM AI to explain anything that's unclear",
      "Pick one concept to go deeper on this week",
    ],
    note: "Stuck on a term? OM AI can explain any of these in plain language and give you examples — it's the fastest way to learn.",
  },
  {
    id: "trade-journal",
    section: "Trade Smart",
    icon: NotebookPen,
    title: "Journal every trade you take",
    summary: "Log your trades to see what's working — your edge lives in the data.",
    blocks: [
      {
        body: [
          "The traders who improve fastest are the ones who journal. Writing down every trade turns random results into a pattern you can actually learn from — you'll quickly see which setups, sessions, and habits make you money and which ones cost you.",
        ],
      },
      {
        heading: "What to log",
        points: [
          "The instrument, direction, and date.",
          "Your entry, stop, and target — and the setup/reason.",
          "The outcome and your R multiple (how many times your risk you won or lost).",
          "A quick note: what you did well, and what you'd change.",
        ],
      },
      {
        body: [
          "Use the built-in Trade Journal on this page (the Trade Journal tab at the top). It saves on this device and shows your win rate and average R as you go.",
        ],
      },
    ],
    checklist: [
      "Open the Trade Journal tab",
      "Log your first trade (even a practice one)",
      "Make journaling a habit — every trade, every time",
    ],
  },

  // ────────────────────────  KNOW THE PLATFORM  ────────────────────────
  {
    id: "platform-tour",
    section: "Know the Platform",
    icon: Compass,
    title: "Take the platform tour",
    summary: "A quick map of everything the portal gives you.",
    blocks: [
      {
        body: [
          "Here's the lay of the land so you always know where to go. Each of these is in your left-hand menu — explore them when you have a minute.",
        ],
      },
    ],
    checklist: ["Visit The Floor", "Open OM AI and ask it a question", "Check What's On for upcoming events"],
    note: "This is just the map — the walkthrough cards below link you straight into each area.",
  },
];

/** Platform tour cards — shown at the end, linking into the real portal areas. */
export interface TourCard {
  label: string;
  href: string;
  icon: LucideIcon;
  blurb: string;
}

export const platformTour: TourCard[] = [
  {
    label: "The Floor",
    href: "/portal/trading",
    icon: Compass,
    blurb: "Live trading, plays, market pulse, and trade sync — the heart of the action.",
  },
  {
    label: "OM AI",
    href: "/portal/om-ai",
    icon: Sparkles,
    blurb: "Your personal trading co-pilot. Ask questions, get setups explained, attach charts for feedback.",
  },
  {
    label: "OM AI Plays",
    href: "/portal/signals",
    icon: Sparkles,
    blurb: "High-quality setups to study and learn from, with the reasoning behind each one.",
  },
  {
    label: "What's On",
    href: "/portal/schedule",
    icon: CalendarClock,
    blurb: "The full live-session and events calendar, shown in your local time.",
  },
  {
    label: "The Inner Circle",
    href: "/portal/leadership",
    icon: GraduationCap,
    blurb: "The mentorship and leadership layer — the people here to help you grow.",
  },
  {
    label: "Creator Launchpad",
    href: "/portal/training",
    icon: GraduationCap,
    blurb: "Step-by-step training to build your skills from the ground up.",
  },
];
