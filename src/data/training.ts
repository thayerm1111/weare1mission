/**
 * AFFILIATE TRAINING  —  edit training categories & modules here.
 * Progress is tracked by module `id`. Keep ids stable once live.
 * Each module supports a video, written lesson, action steps, downloads & links.
 */
export const trainingCategories = [
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
