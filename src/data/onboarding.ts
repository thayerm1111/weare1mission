/**
 * ONBOARDING  —  edit the "Start Here" guided onboarding here.
 * Add / remove / reorder steps freely. Progress is tracked by `id`, so keep
 * ids stable once members have started (changing an id resets that step).
 *
 * Each step supports an optional video, image, external link, and checklist.
 * Leave optional fields as "" or [] to hide them.
 */
export const onboardingPhases = [
  "Welcome to 1 Mission",
  "Get Connected",
  "Create Your Accounts",
  "Set Up Your Tools",
  "Learn the Basics",
  "Plug Into the Community",
  "Begin Your First 30 Days",
] as const;

export type OnboardingPhase = (typeof onboardingPhases)[number];

export interface OnboardingStepData {
  id: string;
  step: number;
  phase: OnboardingPhase;
  title: string;
  description: string;
  videoUrl?: string;      // e.g. "https://www.youtube.com/embed/XXXX"
  imageUrl?: string;      // e.g. "/images/onboarding/step-1.jpg"
  externalLink?: { label: string; href: string };
  checklist?: string[];
}

export const onboardingSteps: OnboardingStepData[] = [
  {
    id: "welcome",
    step: 1,
    phase: "Welcome to 1 Mission",
    title: "Welcome to 1 Mission",
    description:
      "You are in the right place. This short onboarding walks you through everything you need to get connected and started with confidence. Take it one step at a time — there is no rush.",
    checklist: ["Read the welcome message", "Bookmark this page for easy access"],
  },
  {
    id: "orientation-video",
    step: 2,
    phase: "Welcome to 1 Mission",
    title: "Watch the orientation video",
    description:
      "Get the big-picture overview of who we are, what we value, and how the community works.",
    videoUrl: "", // paste your orientation video embed URL here
    checklist: ["Watch the full video", "Write down one thing you're excited about"],
  },
  {
    id: "save-mentor",
    step: 3,
    phase: "Get Connected",
    title: "Save your mentor's contact information",
    description:
      "The person who invited you is your first point of contact. Save their number and message them to say hello.",
    externalLink: { label: "Contact your mentor", href: "/contact" },
    checklist: ["Save mentor's phone number", "Send a quick hello message"],
  },
  {
    id: "join-telegram",
    step: 4,
    phase: "Get Connected",
    title: "Join the main Telegram group",
    description:
      "This is our home base for daily communication, encouragement, and quick questions.",
    externalLink: { label: "Join the group", href: "#" },
    checklist: ["Tap the invite link", "Introduce yourself in the group"],
  },
  {
    id: "join-announcements",
    step: 5,
    phase: "Get Connected",
    title: "Join the announcement channel",
    description:
      "Schedules and access links change. The announcement channel is the single source of truth — turn notifications on.",
    externalLink: { label: "Join announcements", href: "#" },
    checklist: ["Join the channel", "Enable notifications"],
  },
  {
    id: "follow-socials",
    step: 6,
    phase: "Get Connected",
    title: "Follow the 1 Mission social accounts",
    description:
      "Following our accounts keeps you plugged into the culture and makes it easy to share when you're ready.",
    externalLink: { label: "See our socials", href: "#" },
    checklist: ["Follow Instagram", "Follow Facebook", "Follow YouTube / TikTok"],
  },
  {
    id: "create-company-account",
    step: 7,
    phase: "Create Your Accounts",
    title: "Create your company account",
    description:
      "Follow your mentor's walkthrough to create your account correctly the first time. Reach out if anything is unclear.",
    externalLink: { label: "Ask your mentor for the current link", href: "/contact" },
    checklist: ["Complete sign-up", "Confirm your email", "Save your login somewhere safe"],
  },
  {
    id: "download-app",
    step: 8,
    phase: "Create Your Accounts",
    title: "Download the required application",
    description:
      "Install the app you'll use day to day so notifications and access work smoothly.",
    checklist: ["Download the app", "Log in", "Enable notifications"],
  },
  {
    id: "complete-profile",
    step: 9,
    phase: "Create Your Accounts",
    title: "Complete your account profile",
    description:
      "A complete profile helps the team support you and makes you look professional.",
    checklist: ["Add a clear profile photo", "Fill in your details", "Double-check spelling"],
  },
  {
    id: "trading-tools",
    step: 10,
    phase: "Set Up Your Tools",
    title: "Set up your trading education tools",
    description:
      "Set up the education tools the team uses so you can follow along in live sessions. Education only — review the risk disclosure first.",
    externalLink: { label: "Read the risk disclosure", href: "/legal#trading-risk-disclosure" },
    checklist: ["Install / access the tools", "Complete any required setup"],
  },
  {
    id: "review-schedule",
    step: 11,
    phase: "Set Up Your Tools",
    title: "Review the weekly schedule",
    description:
      "See when calls happen and which ones fit your goals. Times display in your local timezone automatically.",
    externalLink: { label: "View the weekly schedule", href: "/schedule" },
    checklist: ["Open the schedule", "Add 2–3 calls to your calendar"],
  },
  {
    id: "access-live",
    step: 12,
    phase: "Set Up Your Tools",
    title: "Learn how to access live sessions",
    description:
      "Know exactly how to join Zoom rooms and live calls before your first one so you never miss out.",
    checklist: ["Test the Zoom link", "Know how to unmute and rename yourself"],
  },
  {
    id: "risk-disclosure",
    step: 13,
    phase: "Learn the Basics",
    title: "Review the risk disclosure",
    description:
      "Understand that trading involves risk, results vary, and our content is education — not individualized financial advice.",
    externalLink: { label: "Read all disclosures", href: "/legal" },
    checklist: ["Read the risk disclosure", "Acknowledge you understand the risks"],
  },
  {
    id: "getting-started-training",
    step: 14,
    phase: "Learn the Basics",
    title: "Watch the getting-started training",
    description:
      "Begin the foundational training so you understand the system and your first actions.",
    externalLink: { label: "Go to Affiliate Training", href: "/training" },
    videoUrl: "",
    checklist: ["Watch the foundation module", "Take notes"],
  },
  {
    id: "contact-list",
    step: 15,
    phase: "Learn the Basics",
    title: "Create your initial contact list",
    description:
      "Write down people you know without prejudging. This is a private brainstorm — quantity first, quality later.",
    checklist: ["List at least 25 names", "Add phone numbers where you have them"],
  },
  {
    id: "first-team-call",
    step: 16,
    phase: "Plug Into the Community",
    title: "Attend your first team call",
    description:
      "Show up, listen, and introduce yourself. Being in the room is the fastest way to learn the culture.",
    externalLink: { label: "Find the next call", href: "/schedule" },
    checklist: ["Attend one live call", "Say hello or drop a message in chat"],
  },
  {
    id: "launch-call",
    step: 17,
    phase: "Plug Into the Community",
    title: "Schedule a launch call with your mentor",
    description:
      "A launch call is a focused 1-on-1 to set your goals and map your first steps. Book it this week.",
    externalLink: { label: "Message your mentor", href: "/contact" },
    checklist: ["Pick a time", "Confirm with your mentor"],
  },
  {
    id: "30-day-plan",
    step: 18,
    phase: "Begin Your First 30 Days",
    title: "Build your first 30-day action plan",
    description:
      "Write simple, consistent daily actions. Consistency beats intensity — small daily reps compound.",
    checklist: [
      "Define your 'why'",
      "Set 2–3 daily actions",
      "Choose which calls you'll attend weekly",
      "Share the plan with your mentor",
    ],
  },
];
