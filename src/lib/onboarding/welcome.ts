/** Shared welcome-video metadata. Final narration timing is applied by the media build. */
export const WELCOME_TUTORIAL = {
  "key": "one_mission_welcome_v1",
  "title": "Your first minutes in One Mission",
  "videoSrc": "/videos/welcome-v1.mp4",
  "posterSrc": "/videos/welcome-v1-poster.webp",
  "captionsSrc": "/videos/welcome-v1.vtt",
  "durationSeconds": 120,
  "chapters": [
    {
      "id": "floor",
      "title": "Start on The Floor",
      "start": 0,
      "end": 7,
      "narration": "Welcome to One Mission. The Floor brings your account, gold context, and AI tools together."
    },
    {
      "id": "atlas",
      "title": "Meet Atlas",
      "start": 7,
      "end": 19,
      "narration": "Tap Talk to Atlas to speak, or Type a question. Ask, “What’s happening with gold?” Your conversation and generated signals stay right here in the app."
    },
    {
      "id": "tools",
      "title": "Choose your AI tool",
      "start": 19,
      "end": 34,
      "narration": "OM AI Plays looks for setups in your chosen market. GENX focuses on gold. Pulse scans markets. Gold Command Center is Atlas’s dedicated gold workspace; the Atlas tab opens your in-app assistant."
    },
    {
      "id": "generate",
      "title": "Generate a read",
      "start": 34,
      "end": 45,
      "narration": "Choose a market and style, check the displayed cost, and tap Generate play. For GENX, pick Quick, Intraday, or Swing, then Analyze gold."
    },
    {
      "id": "review",
      "title": "Understand the setup",
      "start": 45,
      "end": 57,
      "narration": "Review the entry, stop, targets, and timeframe breakdown. Tap Explain this signal for help. Read any waiting or unconfirmed label before deciding what to do."
    },
    {
      "id": "flow",
      "title": "Connect with FLOW",
      "start": 57,
      "end": 79,
      "narration": "In FLOW, tap Connect account. Choose Demo or Live, then enter your broker’s Server and TradeLocker email and password. New accounts start with Trading on. Open Manage accounts to check Trading, Follow every GENX signal, risk, and Auto-run FLOW. Enabled automation can place trades without another prompt."
    },
    {
      "id": "execute",
      "title": "Review a manual trade",
      "start": 79,
      "end": 96,
      "narration": "For a manual trade, open Execute BUY or SELL on the signal. Review the receiving accounts, risk, and size. These tickets place at the current price. Tap Execute, then the final confirmation only when you’re ready."
    },
    {
      "id": "manage",
      "title": "Manage trades and view streaks",
      "start": 96,
      "end": 113,
      "narration": "Back on The Floor, Active trades shows running pips. Take partial, Breakeven, and Close trade each open a review. Winning streaks separate FLOW on your selected account from GENX community calls."
    },
    {
      "id": "next",
      "title": "Ask your first question",
      "start": 113,
      "end": 120,
      "narration": "AI helps you understand setups. Results aren’t guaranteed. Start by asking Atlas."
    }
  ]
} as const;
