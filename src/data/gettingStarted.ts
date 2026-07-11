/**
 * GET STARTED WIZARD CONTENT  —  edit your onboarding flow here.
 * ------------------------------------------------------------------
 * This drives the full-screen guided setup at /get-started.
 * Everything is editable: reorder steps, change copy, swap links/videos.
 *
 * PLACEHOLDERS to replace before launch:
 *   - `url: "#"`            → your real Telegram / app / signup links
 *   - `video: ""`          → paste a YouTube/Vimeo link to embed the walkthrough
 *   - handles / names in the "follow" + "form" blocks
 *
 * Block types you can use inside a step's `blocks: []`:
 *   { type: "paragraph", text }
 *   { type: "note", text }                         // gold tip callout
 *   { type: "numbered", items: [ ... ] }           // numbered instruction cards
 *   { type: "checklist", items: [{title,text}] }   // titled info cards
 *   { type: "video", label?, video? }              // walkthrough video block
 *   { type: "apps", apps: [{name, ios?, android?}] }
 *   { type: "cta", label, href? }                  // big gold action button
 *   { type: "form", kind: "sms" }                  // text-alert opt-in (UI only)
 *   { type: "follow", people: [{handle, tag?, url?}] }
 */

export type GsBlock =
  | { type: "paragraph"; text: string }
  | { type: "note"; text: string }
  | { type: "numbered"; items: string[] }
  | { type: "checklist"; items: { title: string; text: string }[] }
  | { type: "video"; label?: string; video?: string }
  | { type: "apps"; apps: { name: string; ios?: string; android?: string }[] }
  | { type: "cta"; label: string; href?: string }
  | { type: "form"; kind: "sms" }
  | { type: "follow"; people: { handle: string; tag?: string; url?: string }[] };

export interface GsStep {
  phase: string;
  title: string;
  accent?: string; // trailing words rendered in gold italic
  description: string;
  blocks: GsBlock[];
}

// The 5 phases, in order — used for the launcher chips + progress labels.
export const gsPhases = [
  "Getting Connected",
  "Set Up To Trade",
  "Learn To Trade",
  "Resource Hub & Calendar",
  "Get It Free",
] as const;

export const gsMeta = {
  minutes: "about 20 minutes",
  // Short welcome shown once per visit before the launcher.
  welcomeBody:
    "It is important that you complete every step on this page in order to have success inside 1 Mission. Please do not skip anything — every step builds on the last. Your leaders are here to support you, but you have to do the work.",
};

export const gsSteps: GsStep[] = [
  // ───────────────────────── PHASE 1 · GETTING CONNECTED
  {
    phase: "Getting Connected",
    title: "Download",
    accent: "Telegram",
    description:
      "Telegram is our main communication app. It is where the entire team talks every day, where trade alerts come through, and where all the support lives. Check it as often as you check your social apps.",
    blocks: [
      { type: "apps", apps: [{ name: "Telegram", ios: "#", android: "#" }] },
      {
        type: "numbered",
        items: [
          "Open the App Store (iPhone) or Google Play (Android).",
          "Search for “Telegram” and install it.",
          "Create your account with your phone number.",
          "Set a username so teammates can find you.",
        ],
      },
    ],
  },
  {
    phase: "Getting Connected",
    title: "Join the",
    accent: "team chats",
    description:
      "Tap each button below to join the main 1 Mission group chats. This is where daily goals, trade alerts, and support all happen.",
    blocks: [
      { type: "cta", label: "Join · Updates", href: "#" },
      { type: "cta", label: "Join · Building", href: "#" },
      { type: "cta", label: "Join · Trading", href: "#" },
      { type: "note", text: "Turn notifications ON for these chats so you never miss a live call." },
    ],
  },
  {
    phase: "Getting Connected",
    title: "Welcome to the",
    accent: "community",
    description:
      "Now that you are in the group chats, take a moment for this. Watch the short video first, then read the points underneath it.",
    blocks: [
      { type: "video", label: "Team Expectations · Watch First", video: "" },
      {
        type: "checklist",
        items: [
          {
            title: "Your success is yours",
            text: "We all have the same markets, tools, and resources. The difference is effort — go through the whole system, not just one or two steps.",
          },
          {
            title: "In business for yourself, not by yourself",
            text: "You keep your own account and your own profits, but we grow together as a team.",
          },
          {
            title: "Consistency beats intensity",
            text: "Show up daily. Small, steady action compounds into real results over time.",
          },
        ],
      },
    ],
  },
  {
    phase: "Getting Connected",
    title: "What each",
    accent: "group chat is for",
    description:
      "A quick breakdown of the main chats you just joined. Every morning the team posts a daily message with your goals, the day's live sessions, and the nightly presentation.",
    blocks: [
      {
        type: "checklist",
        items: [
          { title: "UPDATES", text: "New content and important team updates — fresh training, replays, and anything you need to stay current." },
          { title: "BUILDING", text: "Your home base for building the business: daily goals, announcements, rank shoutouts, and leader support." },
          { title: "TRADING", text: "Where the team talks trading — wins, questions, chart breakdowns, and answers from experienced members." },
          { title: "TESTIMONIALS", text: "Real payouts and withdrawals from the community. Proof it works, and great to share with people you talk to." },
        ],
      },
    ],
  },
  {
    phase: "Getting Connected",
    title: "Turn on",
    accent: "text alerts",
    description:
      "Opt in to team SMS alerts so you never miss a live call, promo, or update. Fill out the quick form below. (US only for now.)",
    blocks: [
      {
        type: "numbered",
        items: [
          "Enter your first name, last name, email, and mobile number below.",
          "Tap Sign Up to join the team text list.",
          "You're subscribed — we'll text you about live calls, promos, and updates.",
          "You can reply STOP anytime to opt out.",
        ],
      },
      { type: "form", kind: "sms" },
    ],
  },
  {
    phase: "Getting Connected",
    title: "Follow the",
    accent: "team leaders",
    description:
      "Get connected with the leaders on the team. Follow each of them to see how they show up, what they post, and what is possible here.",
    blocks: [
      {
        type: "follow",
        people: [
          { handle: "@leader_one", tag: "Team Leader", url: "#" },
          { handle: "@leader_two", tag: "Team Leader", url: "#" },
          { handle: "@leader_three", tag: "Mentor", url: "#" },
          { handle: "@matthewthayer", tag: "Founder", url: "#" },
        ],
      },
      { type: "note", text: "Replace these handles with your real team leaders in src/data/gettingStarted.ts." },
    ],
  },

  // ───────────────────────── PHASE 2 · SET UP TO TRADE
  {
    phase: "Set Up To Trade",
    title: "Download your",
    accent: "trading apps",
    description:
      "Now let's get your phone set up for trading. Download the apps below, then make two folders on your phone to stay organized. The more organized you are, the easier this gets.",
    blocks: [
      {
        type: "numbered",
        items: [
          "Download the apps using the buttons below.",
          "Make a folder called “Trading” with Akashx, TradeLocker, Coinbase, and Cash App inside it.",
          "Make a folder called “Google” with Chrome, Google Calendar, and Gmail inside it.",
          "Keep Telegram on your home screen.",
        ],
      },
      {
        type: "apps",
        apps: [
          { name: "Akashx", ios: "#", android: "#" },
          { name: "TradeLocker", ios: "#", android: "#" },
          { name: "Cash App", ios: "#", android: "#" },
        ],
      },
    ],
  },
  {
    phase: "Set Up To Trade",
    title: "Open your",
    accent: "trading account",
    description:
      "The broker we use is Crucial Markets, which runs on the TradeLocker platform. This video walks you through opening and verifying your account, then depositing and withdrawing. Tap the button below the video to open your account, then follow along.",
    blocks: [
      { type: "video", label: "Crucial Markets · Verify, Deposit & Withdraw", video: "" },
      { type: "cta", label: "Open Your Trading Account", href: "#" },
      {
        type: "numbered",
        items: [
          "Tap the button above and sign up with your email.",
          "Verify your identity (have your ID ready).",
          "Fund your account when you're ready — start small.",
        ],
      },
    ],
  },
  {
    phase: "Set Up To Trade",
    title: "Connect to",
    accent: "TradeLocker",
    description:
      "Now connect your Crucial Markets account to TradeLocker so you can actually trade. After creating your account, Crucial Markets emailed you your login credentials. Watch the walkthrough, then follow the steps.",
    blocks: [
      { type: "video", label: "Connect to TradeLocker", video: "" },
      {
        type: "numbered",
        items: [
          "Open TradeLocker and choose “Live”.",
          "Find Crucial Markets in the broker list.",
          "Log in with the credentials from your email.",
          "You're connected and ready to trade.",
        ],
      },
    ],
  },
  {
    phase: "Set Up To Trade",
    title: "Connect",
    accent: "Tap-To-Trade",
    description:
      "Last setup step. Connect that same trading account to Tap-To-Trade inside the Akashx app so you can approve trades from the educators with one tap.",
    blocks: [
      {
        type: "numbered",
        items: [
          "Open Akashx and go to Tap-To-Trade.",
          "Select TradeLocker as your platform.",
          "Enter your account email and Trader Account ID.",
          "Enter your password, choose your broker, and save.",
        ],
      },
      { type: "note", text: "Never share your password with anyone — you enter it yourself, directly in the app." },
    ],
  },

  // ───────────────────────── PHASE 3 · LEARN TO TRADE
  {
    phase: "Learn To Trade",
    title: "How to take a",
    accent: "Tap-To-Trade",
    description:
      "Tap-To-Trade is the easiest way to trade with us. When an educator takes a trade, you get a notification and approve it with one tap. It copies straight to your account, hands free.",
    blocks: [{ type: "video", label: "How To Take A Tap-To-Trade", video: "" }],
  },
  {
    phase: "Learn To Trade",
    title: "How to take a",
    accent: "trade alert",
    description:
      "Trade alerts (pulse signals) are different from Tap-To-Trades — these you copy in manually. The educator gives you the numbers (entry, stop loss, take profits) and you enter them into TradeLocker yourself.",
    blocks: [
      {
        type: "numbered",
        items: [
          "Open the alert in Akashx and read the entry, stop loss, and take-profit levels.",
          "Open TradeLocker and create the same order.",
          "Set your position size based on your risk plan.",
          "Confirm the trade and manage it to your plan.",
        ],
      },
    ],
  },
  {
    phase: "Learn To Trade",
    title: "Join the",
    accent: "live sessions",
    description:
      "Educators trade their real accounts live, calling out their entries, stop losses, and take profits in real time. It is one of the best ways to learn and grow your account. If you miss one, every session is recorded.",
    blocks: [
      { type: "video", label: "How To Access Live Trading Sessions", video: "" },
      {
        type: "numbered",
        items: [
          "In the Akashx app, open the Live Sessions tab.",
          "Filter by language, educator, or time zone to find sessions that fit your schedule.",
          "Join live, or watch the recording later.",
        ],
      },
    ],
  },
  {
    phase: "Learn To Trade",
    title: "Go through the",
    accent: "Academy",
    description:
      "Tap-To-Trade and copying alerts are awesome, but our goal is to make you independent. The Academy teaches you the skill itself, A to Z. The people who go through it and take notes are the ones who win long term.",
    blocks: [
      { type: "video", label: "How To Access The Academy", video: "" },
      { type: "note", text: "Take notes as you go. The habit of studying is what separates the members who last." },
    ],
  },

  // ───────────────────────── PHASE 4 · RESOURCE HUB & CALENDAR
  {
    phase: "Resource Hub & Calendar",
    title: "Add the",
    accent: "team calendar",
    description:
      "We keep a shared calendar with every team call on it. Add it to your own calendar in one tap so you never miss a session. You are not required to attend every call, but make as many as you can.",
    blocks: [
      {
        type: "numbered",
        items: [
          "Make sure you have the Google Calendar app (download below if needed).",
          "Tap the Add Team Calendar button below.",
          "When it asks, tap Add to import all the team calls.",
          "Every team session will now show up automatically.",
        ],
      },
      { type: "cta", label: "Add Team Calendar", href: "#" },
      { type: "apps", apps: [{ name: "Google Calendar", ios: "#", android: "#" }] },
      { type: "note", text: "I don't know a single successful person who doesn't live by their calendar. Get this on yours." },
    ],
  },

  // ───────────────────────── PHASE 5 · GET IT FREE
  {
    phase: "Get It Free",
    title: "Get your membership",
    accent: "for free",
    description:
      "Love what you're building? Share 1 Mission with people who are ready for more. When they join through your personal link, they're added to your team — and you can earn your membership back.",
    blocks: [
      { type: "cta", label: "Create Your Account & Get Your Link", href: "/signup" },
      {
        type: "numbered",
        items: [
          "Create your member account to unlock your personal invite link.",
          "Share your link with people who want to grow.",
          "Everyone who joins through it is added to your team.",
          "Track your team and referrals right from your portal.",
        ],
      },
    ],
  },
];
