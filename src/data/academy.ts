/**
 * ONE MISSION AFFILIATE ACADEMY — curriculum, tools, scripts, resources.
 *
 * Content is original to One Mission and written at a 6th–8th-grade reading level.
 * Principles are inspired by respected public educators (Eric Worre, Jim Rohn,
 * Ed Mylett, Napoleon Hill, Robert Kiyosaki, T. Harv Eker). We do NOT reproduce
 * their copyrighted material or attribute quotes to them — "Go Deeper" links point
 * to their own official, free, public resources.
 *
 * Ethics baked in everywhere: no income claims, no guarantees, no pressure, no
 * spam. We expose people to information and let them decide.
 *
 * Progress is tracked by lesson/module `id`. Keep ids stable once live.
 */

export type ToolKey = "why" | "list" | "launch" | "daily" | "activity" | "objections";

export interface Script {
  id: string;
  label: string;
  channel: string; // e.g. "Warm market", "Text", "Instagram DM"
  text: string;
}

export interface DeeperLink {
  label: string;
  url: string;
}

export interface Module {
  id: string;
  phase: PhaseId;
  num: number;
  title: string;
  blurb: string; // one line for the roadmap
  minutes: number;
  why: string; // WHY THIS MATTERS
  learn: string[]; // LEARN — short paragraphs
  example?: string; // EXAMPLE
  scripts?: Script[]; // WHAT TO SAY
  mistakes?: string[]; // COMMON MISTAKES
  action: string; // TAKE ACTION — one assignment
  deeper?: DeeperLink[]; // GO DEEPER — free public resources
  tool?: ToolKey; // optional embedded interactive tool
}

export type PhaseId = "foundation" | "core" | "builder" | "leadership";

export const PHASES: { id: PhaseId; label: string; sub: string }[] = [
  { id: "foundation", label: "Foundation", sub: "Get clear and get ready" },
  { id: "core", label: "Core Skills", sub: "The skills that build everything" },
  { id: "builder", label: "Builder", sub: "Turn skills into a team" },
  { id: "leadership", label: "Leadership", sub: "Become the leader others copy" },
];

// Level system — earned through education + activity, never by recruiting count alone.
export interface Level { n: number; name: string; need: number }
export const LEVELS: Level[] = [
  { n: 1, name: "Starter", need: 0 },
  { n: 2, name: "Connector", need: 3 },
  { n: 3, name: "Producer", need: 6 },
  { n: 4, name: "Builder", need: 9 },
  { n: 5, name: "Leader", need: 12 },
  { n: 6, name: "One Mission Leader", need: 14 },
];

export function levelForCompleted(completedCount: number): Level {
  let lvl = LEVELS[0];
  for (const l of LEVELS) if (completedCount >= l.need) lvl = l;
  return lvl;
}

// Principles woven through the Academy (One Mission voice — not attributed quotes).
export const PRINCIPLES = [
  "Your job isn't to convince everybody. Your job is to find the people who are looking.",
  "Don't drag people. Develop people.",
  "You don't build a big team by being the hero — you build it by developing more heroes.",
  "Simple duplicates. Complicated dies.",
  "Consistency beats intensity. A little every day wins.",
  "Expose people to information and let them decide. That's the whole game.",
];

// ───────────────────────────── CURRICULUM ─────────────────────────────

export const MODULES: Module[] = [
  // ══════════════ PHASE 1 — FOUNDATION ══════════════
  {
    id: "why",
    phase: "foundation",
    num: 1,
    title: "What's Your Why?",
    blurb: "Find the real reason you're building.",
    minutes: 6,
    tool: "why",
    why: "When it gets hard — and it will — your skills won't carry you. Your reason will. A strong why is the fuel that keeps you going after a 'no.'",
    learn: [
      "Most people quit not because the business is too hard, but because their reason was too small. If your only why is 'extra money,' you'll stop the first time someone tells you no.",
      "A strong why is specific and personal. \"Pay off $12,000 in debt so I can sleep at night\" beats \"make money.\" \"Be home when my kids get off the bus\" beats \"time freedom.\"",
      "You're not doing this for a number. You're doing it for a life. Get clear on that life, and the daily work stops feeling like a chore.",
    ],
    example:
      "Maria didn't say 'I want to be rich.' She said, 'I want to stop asking my husband before I buy my mom a birthday gift.' That sentence got her through her first 20 no's.",
    mistakes: [
      "Picking a why that sounds good instead of one that's actually true for you.",
      "Keeping it vague. 'Freedom' is a feeling; 'home by 5pm every day' is a why.",
      "Never writing it down, so it fades the moment things get hard.",
    ],
    action: "Use the Build Your Why tool below to write your One Mission Why Statement. Read it out loud once.",
    deeper: [
      { label: "Jim Rohn — Official YouTube (personal philosophy)", url: "https://www.youtube.com/channel/UCqlo0GJTw_g_m0rysXhPTtg" },
      { label: "Ed Mylett — YouTube (goals & belief)", url: "https://www.youtube.com/channel/UCIprGZAdzn3ZqgLmDuibYcw" },
    ],
  },
  {
    id: "list",
    phase: "foundation",
    num: 2,
    title: "Make Your List",
    blurb: "Write down who you know — don't prejudge.",
    minutes: 7,
    tool: "list",
    why: "You already know enough people to start. The mistake almost everyone makes is deciding for other people before you ever talk to them.",
    learn: [
      "The goal of your list is simple: identify people. That's it. You are not deciding who will join. You are not deciding who can afford it. You are just writing names.",
      "The moment you think 'they'd never do this,' stop — that's prejudging, and it's usually wrong. The busy person, the skeptical person, and the 'they have enough money' person say yes all the time.",
      "Write everyone. Family, friends, coworkers, old classmates, people you follow, people who follow you, the barista you like. A big list gives you options and takes the pressure off any one conversation.",
    ],
    example:
      "David almost didn't write his old coworker down — 'too successful, too busy.' That coworker became his first builder. He almost skipped him because of a story David made up in his own head.",
    mistakes: [
      "Prejudging — deciding someone's answer before you ask.",
      "Making a tiny list, so every conversation feels high-stakes.",
      "Waiting until the list is 'perfect' instead of just starting.",
    ],
    action: "Open the 100 Person List Builder below and add at least 25 names to start. Keep adding as people come to mind.",
    deeper: [
      { label: "Eric Worre — Network Marketing Pro (free videos)", url: "https://www.networkmarketingpro.com/videos/" },
    ],
  },
  {
    id: "source",
    phase: "foundation",
    num: 3,
    title: "Consider the Source",
    blurb: "Not every opinion deserves equal weight.",
    minutes: 6,
    why: "When you start, people will have opinions. Some will help you. Some will quietly talk you out of your own future. You need a filter.",
    learn: [
      "When someone says 'that won't work,' pause and ask: has this person done what I'm trying to do? Do they actually understand it? Or are they just reacting from their own fear?",
      "Here's the balanced version — don't ignore all criticism. Weigh it: Source + Experience + Evidence + Motive. A mentor who's built a team and warns you about a real mistake is worth listening to. An uncle who's never done it and just feels nervous is not.",
      "You get to decide whose voice gets a vote in your life. Advice from people living the results you want counts more than opinions from people who aren't.",
    ],
    example:
      "Two people tell Jasmine 'be careful.' One is a friend who tried, quit in a week, and never learned the skills. The other is a team leader who's built for three years and points out a specific error. Same words — very different weight.",
    mistakes: [
      "Treating a scared opinion as if it were expert advice.",
      "Swinging too far and ignoring real, useful feedback.",
      "Letting one negative person outweigh your own why.",
    ],
    action: "Write down the top 3 people whose opinion you tend to let steer you. Next to each, note: have they done what you want to do?",
  },

  // ══════════════ PHASE 2 — CORE SKILLS ══════════════
  {
    id: "invite",
    phase: "core",
    num: 4,
    title: "How to Invite",
    blurb: "Get people to look — don't explain everything.",
    minutes: 8,
    why: "The invitation is where most people fail, because they try to explain the whole opportunity on the spot. The invite has one job: get them to look at the information.",
    learn: [
      "You are not the presentation. A tool is the presentation — a video, a call, a leader, the website. Your job is just to get a curious person to press play.",
      "Stay in posture. You have something valuable; you're not begging. Be brief, be a little bit unattached, and respect their time. If it's not for them, that's fine — you're just seeing if they're open.",
      "Keep it curious and simple. Don't dump information. Ask if they're open to taking a look, then set a clear time to follow up.",
    ],
    scripts: [
      { id: "inv-warm", label: "Warm market", channel: "In person / call", text: "Hey, I'm working on something new and you came to mind. I'm not sure if it's for you, but would you be open to taking a quick look?" },
      { id: "inv-biz", label: "Business-minded person", channel: "In person / call", text: "I've always respected how you think about business. I'm working on something and I'd actually value your opinion. Would you be open to seeing it?" },
      { id: "inv-income", label: "Wants extra income", channel: "In person / call", text: "You mentioned wanting another income stream. I'm working on something that might be worth a look. If I sent you a quick overview, would you check it out?" },
      { id: "inv-text", label: "Text", channel: "Text", text: "Hey [name]! Random question — are you open to a side project right now, or nah? No worries either way, just thought of you." },
      { id: "inv-ig", label: "Instagram DM", channel: "Instagram", text: "Hey! Been seeing your posts 👀 Quick q — are you open to something outside of what you're doing now, or are you all-in on your current thing?" },
      { id: "inv-fb", label: "Facebook", channel: "Facebook", text: "Hey [name], good to reconnect! I'm working on something new that made me think of you. Open to a quick look, or not really your thing right now?" },
      { id: "inv-cold", label: "Warm social connection", channel: "Social", text: "Hey [name], I know we haven't talked in a bit! I'm building something and looking for a couple sharp people. Not sure it's a fit — would you be open to seeing what it is?" },
    ],
    mistakes: [
      "Explaining the whole business in the invite (information dump).",
      "Chasing and over-selling instead of staying in posture.",
      "No clear next step — leaving it at 'let me know' instead of setting a time.",
    ],
    action: "Copy one script above, personalize it, and send it to 3 people from your list today.",
    deeper: [
      { label: "Eric Worre — Go Pro & inviting (free videos)", url: "https://www.networkmarketingpro.com/videos/" },
    ],
  },
  {
    id: "present",
    phase: "core",
    num: 5,
    title: "How to Present",
    blurb: "Use tools and leaders — you don't do it alone.",
    minutes: 8,
    why: "You do not need to become a professional presenter to start. You need to know how to point people to the right tool and the right people.",
    learn: [
      "The most powerful move you have early is the 3-Way Exposure: you + your prospect + a tool or a leader. You connect the two; the tool or leader does the heavy lifting. This is also how you learn.",
      "Lean on what already exists: the overview video, a live call, a Zoom, the website, and experienced leaders. Every time you use a tool, you're teaching your future team to do the same — that's duplication.",
      "When you do talk, follow a simple frame: connect, ask questions, find what matters to them, show the solution, show the community, ask what they liked, and agree on a next step. Never overwhelm them.",
    ],
    example:
      "New affiliate Sam didn't 'present.' He texted his prospect the overview video, then hopped on a 10-minute 3-way call with his leader. His prospect joined — and Sam learned exactly what to say by watching.",
    mistakes: [
      "Trying to be the expert before you're ready, instead of using a tool or leader.",
      "Talking too much and burying the prospect in information.",
      "Skipping the questions — presenting before you know what they actually care about.",
    ],
    action: "Book one 3-way exposure this week: pick a prospect, pick a tool or leader, and set the time.",
  },
  {
    id: "close",
    phase: "core",
    num: 6,
    title: "How to Close",
    blurb: "Help someone make a decision — never pressure.",
    minutes: 7,
    why: "Closing is not pressure. Closing is helping a person make a clear decision. Good questions do almost all of the work.",
    learn: [
      "After someone sees the information, your job is to ask, not to push. Questions keep them in the driver's seat and show you what they actually need.",
      "Use simple questions: 'What did you like most?' 'On a scale of 1–10, how interested are you?' 'What would you need to know to get closer to a 10?' 'Do you see yourself more as a customer, or possibly building this?'",
      "Then follow the decision tree honestly. Interested → help them enroll. Has a question → answer it. Needs time → set a real follow-up. Not interested → respect it and stay friends. A clean no is better than a fake maybe.",
    ],
    scripts: [
      { id: "close-liked", label: "Open it up", channel: "Any", text: "So what did you like most about what you saw?" },
      { id: "close-scale", label: "Gauge interest", channel: "Any", text: "On a scale of 1 to 10, where 10 is 'let's go' — where are you right now?" },
      { id: "close-gap", label: "Find the gap", channel: "Any", text: "What would you need to know or see to get closer to a 10?" },
      { id: "close-role", label: "Customer or builder", channel: "Any", text: "Do you see yourself more as a customer using this, or possibly building it too?" },
    ],
    mistakes: [
      "Pushing for a yes instead of asking questions.",
      "Being afraid to ask for the decision at all.",
      "Turning a 'needs time' into a chase instead of a scheduled follow-up.",
    ],
    action: "Practice the four closing questions out loud once, then use them on your next exposure.",
  },
  {
    id: "objections",
    phase: "core",
    num: 7,
    title: "Objections",
    blurb: "Understand it before you answer it.",
    minutes: 9,
    tool: "objections",
    why: "Objections aren't rejection — they're requests for more information. Handled with respect, they build trust instead of tension.",
    learn: [
      "Use one simple framework every time: LISTEN → ACKNOWLEDGE → ASK → RESPOND → CONFIRM. Most people skip straight to 'respond' and argue. Don't.",
      "The magic is in ASK. Before you answer, find out what the objection actually means. 'No time' can mean 'I'm slammed' or 'I don't get how much this takes.' Those need totally different answers.",
      "Never argue, never pressure, never make someone feel dumb for asking. Acknowledge honestly, ask a clarifying question, give a short real answer, and confirm it landed.",
    ],
    example:
      "Prospect: 'I don't have time.' Weak reply: 'Everyone has time!' Strong reply: 'Totally fair — when you say no time, do you mean none at all right now, or you're just not sure how much this would take?' Now you can actually help.",
    scripts: [
      { id: "obj-time", label: "\"I don't have time\"", channel: "Any", text: "I completely get it — life's full. Quick question: do you mean there's no time at all right now, or you're just not sure how much this would take? Because a lot of our people build this in small pockets, not full days." },
      { id: "obj-money", label: "\"I don't have the money\"", channel: "Any", text: "Totally understand, and I'd never want you to stretch. Can I ask — is it that the timing's tight this month, or you'd want to see it make sense first? Both are fair, I just want to point you the right way." },
      { id: "obj-mlm", label: "\"Is this MLM / a pyramid?\"", channel: "Any", text: "Good question — you should ask that. A pyramid pays with no real product and is illegal. This is a real product people actually use, and you get paid on real usage. Want me to show you exactly how the product and the pay work so you can decide for yourself?" },
      { id: "obj-think", label: "\"I need to think about it\"", channel: "Any", text: "Of course — big decisions deserve thought. Just so I can help: what specifically do you want to think through? Sometimes it's one question, and I'd rather answer it than have you guessing." },
      { id: "obj-spouse", label: "\"I need to talk to my spouse\"", channel: "Any", text: "Love that you two decide together. Would it help if we did a quick call with both of you so they can hear it firsthand and ask questions directly? I don't want you stuck being the messenger." },
      { id: "obj-sales", label: "\"I'm not good at sales\"", channel: "Any", text: "Honestly? Good — we're not looking for salespeople. This is about sharing something you like and letting a tool do the explaining. If you can send a video and introduce two people, you can do this." },
    ],
    mistakes: [
      "Arguing or getting defensive.",
      "Answering the surface words before you understand the real concern.",
      "Making the person feel judged for having a question.",
    ],
    action: "Open the Objection Trainer below and practice the LISTEN → ACKNOWLEDGE → ASK → RESPOND → CONFIRM flow on two objections.",
  },

  // ══════════════ PHASE 3 — BUILDER ══════════════
  {
    id: "community",
    phase: "builder",
    num: 8,
    title: "Build a Community, Not a Downline",
    blurb: "People join for the opportunity — they stay for the people.",
    minutes: 6,
    why: "The opportunity gets people in the door. Community is what makes them stay, grow, and bring others. This is a One Mission core value.",
    learn: [
      "A downline is a chart. A community is a home. Your job is to make people feel four things: seen, valued, supported, and connected.",
      "Small things build culture: a welcome message, a shoutout, a group chat that's actually warm, a call where people are known by name. Recognition and belonging cost nothing and change everything.",
      "When someone's having a hard week, community carries them until their skills catch up. That's why people who feel connected quit far less often.",
    ],
    example:
      "Two new affiliates join the same week. One gets added to a warm group chat, gets a shoutout on day two, and feels known. The other gets a 'welcome!' and silence. Guess which one is still here in 90 days.",
    mistakes: [
      "Treating people like numbers on a chart.",
      "Only celebrating top earners and ignoring new effort.",
      "Building a group that's all announcements and no real connection.",
    ],
    action: "Send one genuine message today to a teammate — not about business, just checking in on them as a person.",
  },
  {
    id: "launch",
    phase: "builder",
    num: 9,
    title: "The First 48 Hours",
    blurb: "Create momentum fast — activity, not promises.",
    minutes: 8,
    tool: "launch",
    why: "The fastest way to help someone succeed is to help them feel momentum right away. The first 48 hours set the tone for everything.",
    learn: [
      "When someone joins, don't hand them a library — hand them a mission. The goal of the 48-Hour Launch is simple, productive wins: apps installed, why written, list built, first invites out, first exposure done.",
      "We never promise earnings. We promise activity, confidence, and momentum — the things that are actually in your control. Early wins build belief, and belief builds everything else.",
      "Run it as a checklist with a real leader beside them. Hours 0–2: welcome, apps, why. Hours 2–12: build 25–50 names, pick the top 10. Hours 12–24: first invites, get them near a leader. Hours 24–48: keep inviting, attend a call, do 3-way exposures.",
    ],
    example:
      "Nobody remembers the affiliate who 'thought about it for a week.' They remember the one who was on a live call 12 hours after joining, buzzing, telling three friends. Momentum is a feeling — create it early.",
    mistakes: [
      "Overwhelming a new person with everything at once.",
      "Promising money instead of focusing on actions.",
      "Letting the new person sit alone instead of getting them near a leader fast.",
    ],
    action: "Start your 48-Hour Launch below (or run it for someone you just enrolled). Check off each win as you go.",
  },
  {
    id: "taprooting",
    phase: "builder",
    num: 10,
    title: "Tap Rooting",
    blurb: "Go deep until you find leadership.",
    minutes: 6,
    why: "The person you personally enroll doesn't have to be the big leader. Sometimes your job is to keep supporting deeper until you find the person who really wants to run.",
    learn: [
      "Picture it: A enrolls B, B enrolls C, C enrolls D — and D is the one who's on fire. 'Tap rooting' means you work with the whole line, but you invest most in whoever is reaching up and doing the work.",
      "Go deep until you find leadership. But never abandon the people above them. You support the whole organization while you identify the serious builders — the ones asking questions, showing up, and taking action.",
      "Leaders aren't recruited, they're revealed. Your job is to keep planting and supporting until someone stands up and says, 'I want this.'",
    ],
    example:
      "Coach Ray's personal enrollee was casual about it. But three levels down, someone was hungry. Ray poured into that person — and that's where the team exploded. He didn't force it; he followed the effort.",
    mistakes: [
      "Assuming your personal enrollee must become the leader.",
      "Abandoning the people above a builder once you find one.",
      "Trying to appoint leaders instead of letting effort reveal them.",
    ],
    action: "Look at your team. Name one person — at any depth — who is showing effort, and reach out to support them this week.",
  },
  {
    id: "events",
    phase: "builder",
    num: 11,
    title: "The Power of Events",
    blurb: "Events compress time.",
    minutes: 6,
    why: "What takes you months to teach one-on-one, an event can do in one night. Events build belief, belonging, and vision faster than anything else.",
    learn: [
      "There's a hierarchy. Major events (conventions, company & leadership events) build vision and belief. Regional events (city trainings, opportunity meetings) build skills and momentum. Weekly events (Zooms, team trainings, community calls) build consistency. Small events (coffee, living-room, 1-on-1s) build relationships.",
      "Why they work: people hear stories, see social proof, feel the energy, and catch a vision they can't get from a text. Events compress months of belief-building into hours.",
      "Promote without being annoying: invite personally, give the why ('you'll get exactly this from it'), make it easy to say yes, and follow up once — not ten times. Bring people, don't drag them.",
    ],
    example:
      "A prospect who was a lukewarm '5' went to one live event, met real people with real stories, and left a '9.' Nothing you say one-on-one moves belief like a room full of proof.",
    mistakes: [
      "Underselling events as optional.",
      "Spamming invites instead of inviting personally with a clear why.",
      "Going to events but not bringing anyone.",
    ],
    action: "Find the next One Mission event on What's On and personally invite two people to it.",
    deeper: [
      { label: "One Mission — live sessions (MFXlive.com)", url: "https://mfxlive.com" },
    ],
  },

  // ══════════════ PHASE 4 — LEADERSHIP ══════════════
  {
    id: "personal-dev",
    phase: "leadership",
    num: 12,
    title: "Personal Development",
    blurb: "Your business grows as you grow.",
    minutes: 7,
    tool: "daily",
    why: "Your business will rarely outgrow you for long. The fastest way to grow your income is to grow yourself.",
    learn: [
      "Work harder on yourself than on your business. Discipline, mindset, communication, confidence, handling rejection, managing your time — these are the real skills, and they're all learnable.",
      "You don't need hours a day. Ten focused minutes of reading or listening, every day, compounds into a different person over a year. Small inputs, repeated, beat big inputs done once.",
      "Build a simple learning habit and protect it. Below is a 10-Minutes-a-Day challenge — mark each day you do it and watch the streak pull you forward.",
    ],
    example:
      "Two affiliates start together. One reads or listens 10 minutes a day. A year later they're not even in the same league — not because of talent, but because one kept feeding their mind.",
    mistakes: [
      "Trying to out-hustle a mindset problem.",
      "Consuming for hours occasionally instead of a little every day.",
      "Only 'learning' and never applying what you learn.",
    ],
    action: "Start your 10-Minutes-a-Day streak below. Pick one resource from Learn From The Greats and spend 10 minutes on it today.",
    deeper: [
      { label: "Jim Rohn — Official YouTube", url: "https://www.youtube.com/channel/UCqlo0GJTw_g_m0rysXhPTtg" },
      { label: "Napoleon Hill — Think and Grow Rich (free, 1937 public-domain)", url: "https://archive.org/details/thinkgrowrichori0000napo" },
      { label: "Ed Mylett — YouTube", url: "https://www.youtube.com/channel/UCIprGZAdzn3ZqgLmDuibYcw" },
    ],
  },
  {
    id: "recognition",
    phase: "leadership",
    num: 13,
    title: "Recognition",
    blurb: "What gets recognized gets repeated.",
    minutes: 5,
    why: "People will work harder for recognition than almost anything else. Recognition is one of the cheapest, most powerful tools a leader has.",
    learn: [
      "Recognize effort and growth, not just top earners. First customer, first affiliate, first presentation, first event, first rank, showing up consistently, helping a teammate — all of it deserves a shoutout.",
      "Public recognition teaches the whole team what to copy. When you celebrate someone's first invite, everyone learns that action matters.",
      "Make it specific and real, never fake. Name the person, name what they did, and name why it matters. Generic 'great job team!' means nothing; specific praise changes behavior.",
    ],
    example:
      "\"Shoutout to Sarah — she joined three days ago, finished her launch, showed up to her first training, and is already helping other people. That is exactly what One Mission is about.\" Specific. Real. Everyone now knows what to copy.",
    mistakes: [
      "Only celebrating money and rank.",
      "Vague praise that doesn't name the action.",
      "Fake or forced recognition that people can see through.",
    ],
    action: "Post one specific, genuine recognition of a teammate today — name them, name what they did, name why it matters.",
  },
  {
    id: "duplication",
    phase: "leadership",
    num: 14,
    title: "Duplication",
    blurb: "If it only works when you do it, it doesn't work.",
    minutes: 7,
    why: "Duplication is what turns effort into a real business. If your system needs you to personally do everything, you have a job, not a team.",
    learn: [
      "The whole Academy is one duplicable path: Why → List → Invite → Present → Follow Up → Close → 48-Hour Launch → Community → Events → Personal Development → Leadership → Duplication. Every new person learns the same simple steps.",
      "Simple duplicates; complicated dies. The fancier and more 'you' the system is, the less it copies. Teach people to use tools and leaders, not to become you.",
      "The real goal isn't to be the hero — it's to develop more heroes. You've truly duplicated when your people can teach someone else without you in the room.",
    ],
    example:
      "A leader who does everything has a ceiling — their own time. A leader who teaches a simple system that others teach again has no ceiling. Same effort, completely different outcome.",
    mistakes: [
      "Being the hero the whole team depends on.",
      "Making the system complicated so it can't be copied.",
      "Teaching people to lean on you instead of on the system.",
    ],
    action: "Pick one part of your process and simplify it into steps a brand-new person could follow without you.",
  },
];

// ─────────────────────── DAILY METHOD ("ONE MISSION DAILY") ───────────────────────
export interface DailyBlock { minutes: number; label: string }
export interface DailyPlan { id: string; name: string; total: string; blocks: DailyBlock[] }

export const DAILY_PLANS: DailyPlan[] = [
  {
    id: "power-hour",
    name: "60-Minute Power Hour",
    total: "60 min",
    blocks: [
      { minutes: 10, label: "Personal Development" },
      { minutes: 15, label: "New Conversations" },
      { minutes: 15, label: "Invitations" },
      { minutes: 10, label: "Follow-Ups" },
      { minutes: 10, label: "Team Support / Recognition" },
    ],
  },
  {
    id: "builder",
    name: "2-Hour Builder Mode",
    total: "120 min",
    blocks: [
      { minutes: 15, label: "Personal Development" },
      { minutes: 30, label: "New Conversations" },
      { minutes: 30, label: "Invitations & Exposures" },
      { minutes: 25, label: "Follow-Ups" },
      { minutes: 20, label: "Team Support / Recognition" },
    ],
  },
  {
    id: "fulltime",
    name: "Full-Time Builder Mode",
    total: "4+ hrs",
    blocks: [
      { minutes: 30, label: "Personal Development & Planning" },
      { minutes: 60, label: "New Conversations" },
      { minutes: 60, label: "Invitations & Exposures" },
      { minutes: 45, label: "Follow-Ups" },
      { minutes: 45, label: "Presentations & 3-Ways" },
      { minutes: 30, label: "Team Support, Recognition & Events" },
    ],
  },
];

// ─────────────────────── 48-HOUR LAUNCH CHECKLIST ───────────────────────
export interface LaunchItem { id: string; window: string; label: string }
export const LAUNCH_ITEMS: LaunchItem[] = [
  { id: "l-welcome", window: "Hour 0–2", label: "Get welcomed & added to the community" },
  { id: "l-apps", window: "Hour 0–2", label: "Install the apps and confirm your account works" },
  { id: "l-academy", window: "Hour 0–2", label: "Open the Academy and read Start Here" },
  { id: "l-why", window: "Hour 0–2", label: "Write your Why Statement" },
  { id: "l-list", window: "Hour 2–12", label: "Build a list of 25–50 names" },
  { id: "l-top10", window: "Hour 2–12", label: "Circle your top 10" },
  { id: "l-invites", window: "Hour 12–24", label: "Send your first invitations" },
  { id: "l-leader", window: "Hour 12–24", label: "Get around an experienced leader (call/3-way)" },
  { id: "l-exposure", window: "Hour 24–48", label: "Do your first 3-way exposure" },
  { id: "l-event", window: "Hour 24–48", label: "Attend or schedule a live call/event" },
  { id: "l-followup", window: "Hour 24–48", label: "Do your first follow-up" },
];

// ─────────────────────── "I NEED HELP RIGHT NOW" ───────────────────────
// target: { type: "module"|"tool"|"coach"|"roleplay", id } — resolved by the UI.
export interface HelpItem { label: string; type: "module" | "tool" | "coach" | "roleplay"; id: string }
export const HELP_NOW: HelpItem[] = [
  { label: "Invite Someone", type: "module", id: "invite" },
  { label: "Follow Up", type: "coach", id: "followup" },
  { label: "Close Someone", type: "module", id: "close" },
  { label: "Answer an Objection", type: "module", id: "objections" },
  { label: "Launch a New Affiliate", type: "tool", id: "launch" },
  { label: "Make My List", type: "tool", id: "list" },
  { label: "Prepare for a Presentation", type: "module", id: "present" },
  { label: "Build My Team", type: "module", id: "community" },
  { label: "Get Someone to an Event", type: "module", id: "events" },
  { label: "Stay Motivated", type: "module", id: "why" },
];

// ─────────────────────── ROLE-PLAY SCENARIOS ───────────────────────
export const ROLEPLAY_SCENARIOS = [
  { id: "inviting", label: "Inviting", opener: "Oh interesting... what is it though? Just tell me what it is." },
  { id: "presenting", label: "Presenting", opener: "Okay I watched a bit of it. Seems kinda complicated, honestly." },
  { id: "followup", label: "Follow-Up", opener: "Hey, sorry — I've been meaning to get back to you." },
  { id: "closing", label: "Closing", opener: "Yeah it was cool. I don't know though, I'd have to think about it." },
  { id: "objections", label: "Objections", opener: "Wait, is this one of those pyramid things?" },
  { id: "recruiting", label: "Recruiting a builder", opener: "I like it, but I'm not really a salesperson type." },
  { id: "leadership", label: "Leadership (coach a teammate)", opener: "I sent 5 invites and everyone said no. I think I'm just bad at this." },
] as const;

// ─────────────────────── LEARN FROM THE GREATS (verified public resources) ───────────────────────
export interface GreatResource {
  teacher: string;
  topic: string;
  title: string;
  url: string;
  length?: string;
  why: string;
  kind: "channel" | "video" | "book" | "site" | "podcast";
}

export const GREATS: GreatResource[] = [
  {
    teacher: "Eric Worre",
    topic: "Network Marketing Skills",
    title: "Network Marketing Pro — Free Training Videos",
    url: "https://www.networkmarketingpro.com/videos/",
    why: "The clearest free library on inviting, presenting, and going pro as a professional (not a pest).",
    kind: "site",
  },
  {
    teacher: "Eric Worre",
    topic: "Network Marketing Skills",
    title: "Eric Worre — Official YouTube",
    url: "https://www.youtube.com/@ericworre",
    why: "Short, practical videos on the exact skills this Academy teaches.",
    kind: "channel",
  },
  {
    teacher: "Jim Rohn",
    topic: "Personal Development & Philosophy",
    title: "Jim Rohn — Official YouTube",
    url: "https://www.youtube.com/channel/UCqlo0GJTw_g_m0rysXhPTtg",
    why: "Timeless wisdom on discipline, your why, and working harder on yourself than on your job.",
    kind: "channel",
  },
  {
    teacher: "Ed Mylett",
    topic: "Leadership, Confidence & Goals",
    title: "Ed Mylett — Official YouTube",
    url: "https://www.youtube.com/channel/UCIprGZAdzn3ZqgLmDuibYcw",
    why: "High-energy interviews and talks on belief, performance, and leadership.",
    kind: "channel",
  },
  {
    teacher: "Ed Mylett",
    topic: "Leadership & Mindset",
    title: "THE ED MYLETT SHOW — Podcast",
    url: "https://podcasts.apple.com/us/podcast/the-ed-mylett-show/id1181233130",
    why: "Long-form interviews with top performers — great for your 10-minutes-a-day habit.",
    kind: "podcast",
  },
  {
    teacher: "Napoleon Hill",
    topic: "Mindset, Goals & Persistence",
    title: "Think and Grow Rich (1937, free public-domain edition)",
    url: "https://archive.org/details/thinkgrowrichori0000napo",
    why: "The classic on desire, decision, and persistence — free and legal to read here.",
    kind: "book",
  },
  {
    teacher: "Robert Kiyosaki",
    topic: "Entrepreneurship & Financial Education",
    title: "The Rich Dad Channel — YouTube",
    url: "https://www.youtube.com/@TheRichDadChannel",
    why: "How the wealthy think about assets, income, and building something you own.",
    kind: "channel",
  },
  {
    teacher: "T. Harv Eker",
    topic: "Money Mindset",
    title: "Harv Eker — Official Site & Free Trainings",
    url: "https://www.harveker.com/",
    why: "On the inner money 'blueprint' that quietly drives your results.",
    kind: "site",
  },
];
