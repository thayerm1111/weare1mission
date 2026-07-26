/**
 * AFFILIATE TRAINING  —  edit training categories & modules here.
 * Progress is tracked by module `id`. Keep ids stable once live.
 * Each module supports a video, written lesson, action steps, downloads & links.
 */
export const trainingCategories = [
  "Launch Roadmap",
  "Foundation",
  "Mindset",
  "Building Your List",
  "Inviting",
  "Presenting",
  "Following Up",
  "Enrolling",
  "Launching",
  "Duplication",
  "Leadership",
  "Social Media",
  "Daily Method of Operation",
] as const;

export type TrainingCategory = (typeof trainingCategories)[number];

export interface TrainingResource {
  label: string;
  href: string;
  type: "download" | "link";
}

export interface TrainingModuleData {
  id: string;
  category: TrainingCategory;
  title: string;
  description: string;
  estimatedTime: string; // e.g. "12 min"
  videoUrl?: string;
  lesson: string;        // written lesson (supports plain paragraphs, split on \n\n)
  actionSteps: string[];
  resources?: TrainingResource[];
}

export const trainingModules: TrainingModuleData[] = [
  // ── LAUNCH ROADMAP ─────────────────────────────────────────────────────────
  // A simple, generic, step-by-step system for launching your business.
  // Written playbook (no video required) — edit the wording to match your team.
  {
    id: "launch-1-foundation",
    category: "Launch Roadmap",
    title: "Step 1 — Set Your Foundation & Goals",
    description: "Get clear on your why, your commitment, and a schedule you can actually keep.",
    estimatedTime: "10 min",
    lesson:
      "Every strong business starts with a clear reason and a realistic plan. Before you talk to anyone, get honest about why you're doing this and what you want it to change in your life. Your 'why' is the fuel that keeps you going when it gets hard.\n\nThen decide how much time you can consistently give this each week — and protect it. Consistency beats intensity every time. A person who does a little every day will out-build someone who does a lot once a month.",
    actionSteps: [
      "Write your 'why' in one or two sentences",
      "Decide how many hours per week you'll commit",
      "Block those hours into your calendar now",
      "Set one simple 90-day goal you can measure",
    ],
  },
  {
    id: "launch-2-list",
    category: "Launch Roadmap",
    title: "Step 2 — Build Your Contact List",
    description: "Write down everyone you know — no prejudging. Quantity first, quality later.",
    estimatedTime: "15 min",
    lesson:
      "Your list is the raw material of your business. The biggest mistake new builders make is deciding for other people whether they'd be interested. Your job is to make the list, not to judge it — you'll be wrong about who says yes more often than you think.\n\nStart with the people you know best and work outward. Use your phone contacts, social media friends, and memory joggers (people you work with, went to school with, know from the gym, etc.). Aim for at least 50 names to begin.",
    actionSteps: [
      "List at least 50 names without prejudging",
      "Add phone numbers or social handles where you have them",
      "Star 5–10 people you'll reach out to first",
      "Keep the list somewhere you'll update it weekly",
    ],
  },
  {
    id: "launch-3-story",
    category: "Launch Roadmap",
    title: "Step 3 — Craft Your Story & Message",
    description: "Learn to share what you're doing in a way that's natural, short, and genuine.",
    estimatedTime: "12 min",
    lesson:
      "People connect with stories, not sales pitches. You don't need to be an expert — you need to be authentic. Your story is simply: where you were, what you found, and why you're excited about it.\n\nKeep it short and honest. You're not trying to convince anyone; you're inviting them to take a look. The goal of your message is to create curiosity, not to close a deal on the spot.",
    actionSteps: [
      "Write your story in under 60 seconds of speaking",
      "Practice saying it out loud until it feels natural",
      "Write one simple, non-hyped invite message",
      "Remove any income or results claims from your wording",
    ],
  },
  {
    id: "launch-4-invite",
    category: "Launch Roadmap",
    title: "Step 4 — Invite With Confidence",
    description: "A simple framework to invite people to take a look — and handle 'what is it?'",
    estimatedTime: "12 min",
    lesson:
      "Inviting is the skill that drives everything. The framework is simple: be brief, be friendly, and point them to a tool or a call rather than trying to explain everything yourself. Your job is to open the door, not to deliver the whole presentation.\n\nWhen someone asks 'what is it?', you don't have to have the perfect answer. A calm, confident 'the best way to understand it is to see it — can I send you a quick overview?' works better than a nervous explanation. Let the tools and the team do the heavy lifting.",
    actionSteps: [
      "Reach out to your first 5 starred contacts",
      "Use a tool or call to explain — don't wing the whole thing",
      "Practice a calm answer to 'what is it?'",
      "Aim to invite, not to convince",
    ],
  },
  {
    id: "launch-5-present",
    category: "Launch Roadmap",
    title: "Step 5 — Present & Share the Opportunity",
    description: "Let the tools and the team tell the story. Your role is to edify and connect.",
    estimatedTime: "10 min",
    lesson:
      "You don't have to be the expert in the room. The most duplicable way to present is to use a proven tool — a video, a live call, or a three-way conversation with your mentor — and let it carry the message. This keeps things simple and shows new people that they can do it too.\n\nYour job during a presentation is to edify: speak well of your mentor and the community, stay positive, and let the third party build credibility. Then simply ask what they liked best.",
    actionSteps: [
      "Pick one presentation tool to share consistently",
      "Set up a three-way intro with your mentor when you can",
      "Edify your mentor and the community before the call",
      "After they watch, ask: 'what did you like best?'",
    ],
  },
  {
    id: "launch-6-followup",
    category: "Launch Roadmap",
    title: "Step 6 — Follow Up & Help Them Decide",
    description: "The fortune is in the follow-up. Learn a simple, respectful cadence.",
    estimatedTime: "10 min",
    lesson:
      "Most people won't make a decision the first time — and that's normal. Following up isn't pestering; it's professional. A simple, friendly cadence over a few days shows you're serious and reliable.\n\nWhen you follow up, your goal is to answer questions and help them reach a clear yes or no. A 'not right now' is fine — keep the relationship warm and move on. Never chase or pressure; confidence is more attractive than desperation.",
    actionSteps: [
      "Follow up within 24–48 hours of them looking",
      "Answer questions honestly; point to the tools",
      "Help them reach a clear yes or no",
      "Keep every 'not now' as a warm future contact",
    ],
  },
  {
    id: "launch-7-duplicate",
    category: "Launch Roadmap",
    title: "Step 7 — Launch & Duplicate",
    description: "Get your new partner started fast and teach them to do the same.",
    estimatedTime: "12 min",
    lesson:
      "When someone joins you, the first 72 hours matter most. Get them plugged in quickly: walk them through onboarding, get them into the group chats, and help them make their first list. A fast, guided start builds belief and momentum.\n\nDuplication is the whole game. Instead of doing everything for your team, teach them this same simple system so they can teach it to others. When your people can launch new people without you, your business becomes real.",
    actionSteps: [
      "Walk every new partner through the Start Here onboarding",
      "Help them build their list in the first 72 hours",
      "Teach them these 7 steps — don't just do it for them",
      "Celebrate their first win publicly",
    ],
  },
  // ── SKILL LIBRARY (deeper training by topic) ───────────────────────────────
  {
    id: "becoming-a-professional",
    category: "Foundation",
    title: "Becoming a Professional",
    description: "What it means to treat this like a real skill and a real business.",
    estimatedTime: "10 min",
    lesson:
      "Professionals are made, not born. The difference between a hobby and a craft is consistency, coachability, and a willingness to learn the fundamentals before chasing shortcuts.\n\nIn this module we define what 'professional' looks like inside 1 Mission: showing up on time, doing what you say you'll do, staying teachable, and representing the community with integrity.",
    actionSteps: [
      "Write your definition of a professional",
      "Commit to a weekly schedule you can keep",
      "Choose one habit to improve this week",
    ],
    resources: [{ label: "Professional standards checklist (placeholder)", href: "#", type: "download" }],
  },
  {
    id: "understanding-the-vision",
    category: "Foundation",
    title: "Understanding the 1 Mission Vision",
    description: "Why we exist and where we're going.",
    estimatedTime: "8 min",
    lesson:
      "Vision creates staying power. When you understand where the community is headed and why it matters, day-to-day work becomes purposeful.\n\nThis module covers our core belief: build the person and the results follow. Health, wealth, relationships, and purpose grow together.",
    actionSteps: ["Write your personal 'why'", "Share your why with your mentor"],
  },
  {
    id: "developing-the-right-mindset",
    category: "Mindset",
    title: "Developing the Right Mindset",
    description: "Ownership, patience, and the long game.",
    estimatedTime: "12 min",
    lesson:
      "Skills can be taught quickly; mindset is the multiplier. This module focuses on ownership (results are your responsibility), patience (skills compound), and resilience (rejection is redirection).\n\nYou'll learn simple mental frameworks to stay steady when motivation dips.",
    actionSteps: ["Identify one limiting belief", "Replace it with an empowering statement", "Read it daily for a week"],
  },
  {
    id: "building-your-list",
    category: "Building Your List",
    title: "Building Your Contact List",
    description: "Create a strong, judgment-free list of people you know.",
    estimatedTime: "15 min",
    lesson:
      "Your network is your starting capital. The mistake most people make is prejudging who would be interested. Your job is to make the list — not the decision for other people.\n\nUse memory joggers: family, friends, coworkers, hobbies, neighbors, old classmates.",
    actionSteps: ["List 50+ names", "Add contact info", "Do not prejudge anyone"],
    resources: [{ label: "Memory jogger worksheet (placeholder)", href: "#", type: "download" }],
  },
  {
    id: "how-to-invite",
    category: "Inviting",
    title: "How to Invite",
    description: "Invite with confidence, curiosity, and respect.",
    estimatedTime: "14 min",
    lesson:
      "Inviting is about starting a genuine conversation, not pitching. Keep it short, be posture-strong, and point people to a tool (a video, a call, or a presentation) rather than trying to explain everything yourself.",
    actionSteps: ["Learn one simple invite framework", "Practice it out loud 10 times", "Send 3 invites this week"],
    resources: [{ label: "Invite scripts (placeholder)", href: "/resources", type: "link" }],
  },
  {
    id: "how-to-present",
    category: "Presenting",
    title: "How to Share the Presentation",
    description: "Let the tools do the talking.",
    estimatedTime: "11 min",
    lesson:
      "A good presentation is simple and duplicable. Your role is to set it up, stay out of the way, and confirm understanding at the end. The goal is not to impress — it's to inform clearly.",
    actionSteps: ["Watch the official presentation", "Practice your intro and close", "Share it with one person"],
  },
  {
    id: "how-to-follow-up",
    category: "Following Up",
    title: "How to Follow Up",
    description: "The fortune is in the follow-up.",
    estimatedTime: "10 min",
    lesson:
      "Most decisions happen in the follow-up, not the first exposure. Follow up promptly, ask good questions, and help people get their questions answered without pressure.",
    actionSteps: ["Follow up within 24–48 hours", "Ask: 'What did you like best?'", "Point to the next step"],
  },
  {
    id: "handling-questions",
    category: "Following Up",
    title: "Handling Common Questions",
    description: "Answer with honesty and simplicity.",
    estimatedTime: "13 min",
    lesson:
      "Questions are buying signals. Stay calm, be honest, and never overpromise. When you don't know, say so and bring in your mentor or a tool. Never make income or results guarantees.",
    actionSteps: ["List the 5 questions you hear most", "Write honest, simple answers", "Review them with your mentor"],
  },
  {
    id: "helping-someone-enroll",
    category: "Enrolling",
    title: "Helping Someone Enroll",
    description: "Guide a confident, informed decision.",
    estimatedTime: "9 min",
    lesson:
      "Enrolling is helping someone make a decision that's right for them. Confirm they understand what they're joining, walk them through setup, and set expectations honestly — including the risks and the effort required.",
    actionSteps: ["Confirm understanding", "Walk through sign-up together", "Set clear next steps"],
  },
  {
    id: "first-48-hours",
    category: "Launching",
    title: "The First 48 Hours",
    description: "Momentum starts immediately.",
    estimatedTime: "8 min",
    lesson:
      "The first 48 hours shape a new member's experience. Get them connected, welcomed, and into their onboarding fast. Early wins build belief.",
    actionSteps: ["Welcome them personally", "Get them into the groups", "Start their onboarding together"],
  },
  {
    id: "launching-a-new-member",
    category: "Launching",
    title: "Launching a New Member",
    description: "Run a simple, repeatable launch.",
    estimatedTime: "12 min",
    lesson:
      "A launch is a focused conversation to set goals and map first steps. Keep it simple and duplicable so your new member can do the same for others.",
    actionSteps: ["Book a launch call", "Set 30-day goals together", "Schedule the first check-in"],
    resources: [{ label: "Launch call outline (placeholder)", href: "#", type: "download" }],
  },
  {
    id: "training-and-duplication",
    category: "Duplication",
    title: "Training and Duplication",
    description: "Do it simply so others can copy it.",
    estimatedTime: "11 min",
    lesson:
      "Duplication is doing things in a way others can repeat. If your process is complicated, it stops with you. Teach the system, not your personality.",
    actionSteps: ["Simplify your process", "Teach one person your exact steps", "Let them teach it back"],
  },
  {
    id: "daily-method-of-operation",
    category: "Daily Method of Operation",
    title: "Creating a Daily Method of Operation",
    description: "Small daily actions, done consistently.",
    estimatedTime: "10 min",
    lesson:
      "A Daily Method of Operation (DMO) is a short list of income-and-growth-producing actions you do every day. Consistency beats intensity. Define it, track it, and protect it.",
    actionSteps: ["Define 3 daily actions", "Track them for 30 days", "Review weekly with your mentor"],
    resources: [{ label: "DMO tracker (placeholder)", href: "#", type: "download" }],
  },
  {
    id: "building-depth",
    category: "Duplication",
    title: "Building Depth",
    description: "Work with people who are working.",
    estimatedTime: "9 min",
    lesson:
      "Depth creates stability. Instead of always starting new, invest in helping active members succeed and duplicate. Depth is where long-term consistency is built.",
    actionSteps: ["Identify your active members", "Support their next launch", "Go a level deeper"],
  },
  {
    id: "developing-leaders",
    category: "Leadership",
    title: "Developing Leaders",
    description: "Multiply yourself through others.",
    estimatedTime: "14 min",
    lesson:
      "Leadership is developed, not appointed. Look for the coachable and consistent, give them responsibility, and let them grow through real reps. Your job is to build people.",
    actionSteps: ["Spot emerging leaders", "Delegate a real responsibility", "Coach, don't rescue"],
  },
  {
    id: "using-social-media",
    category: "Social Media",
    title: "Using Social Media Correctly",
    description: "Attraction over promotion.",
    estimatedTime: "12 min",
    lesson:
      "Social media works when you lead with value and story, not hype. Share your journey honestly, avoid income or results claims, and follow all platform and compliance guidelines.",
    actionSteps: ["Clean up your profile", "Post value 3x this week", "Never make income claims"],
  },
  {
    id: "event-promotion",
    category: "Social Media",
    title: "Event Promotion",
    description: "Fill the room the right way.",
    estimatedTime: "8 min",
    lesson:
      "Events accelerate growth. Promote early, personally invite, and follow up. Personal invitations outperform mass blasts every time.",
    actionSteps: ["Invite personally", "Confirm attendees", "Follow up after the event"],
  },
  {
    id: "long-term-consistency",
    category: "Daily Method of Operation",
    title: "Long-Term Consistency",
    description: "Play the long game.",
    estimatedTime: "10 min",
    lesson:
      "Results come from staying in the game long enough for skills and relationships to compound. Protect your energy, celebrate small wins, and keep showing up.",
    actionSteps: ["Set a 90-day commitment", "Track your consistency", "Review and reset monthly"],
  },
];
