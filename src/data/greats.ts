/**
 * ONE MISSION — LEARN FROM THE GREATS (personal-development library).
 *
 * Masterclasses are ORIGINAL One Mission training built on the professional
 * concepts made famous by respected educators. We do NOT reproduce their books,
 * courses, or copyrighted material. "Original resource" links point to their own
 * official/free/public sources so members can buy or access the real thing.
 *
 * Every lesson teaches → then makes the member IMPLEMENT it in One Mission.
 * Ethics: no income claims, no guarantees, no pressure, no spam.
 *
 * Progress, notes, favorites, quiz results and workbook answers persist per
 * member (greats_* tables, RLS). Written at a 6th–8th-grade reading level.
 */

export interface QuizQ { q: string; options: string[]; correct: number; why: string }

export interface Five {
  bigIdea: string;
  principles: string[]; // 3 core principles
  wrong: string;        // what most people get wrong
  oneMission: string;   // how it applies to One Mission
  today: string;        // one action today
}

export interface Say { label: string; text: string }

export interface Roleplay { scenario: string; opener: string }

export interface GreatLesson {
  id: string;
  num: number;
  title: string;
  minutes: number;
  five: Five;                 // THE LESSON IN 5 MINUTES
  why: string;                // WHY THIS MATTERS
  principle: string;          // THE PRINCIPLE
  beginner: string;           // BEGINNER EXPLANATION
  example: string;            // REAL-LIFE EXAMPLE
  whatToSay?: Say[];          // WHAT TO SAY
  whatNotToSay?: string[];    // WHAT NOT TO SAY
  mistakes: string[];         // COMMON MISTAKES
  application: string;        // ONE MISSION APPLICATION
  practice: string;           // PRACTICE (exercise prompt)
  roleplay?: Roleplay;        // ROLE-PLAY (AI plays prospect)
  action: string;             // ACTION ASSIGNMENT (today)
  quiz: QuizQ[];              // QUIZ (practical, not trivia)
  resource?: { label: string; url: string; kind: string }[]; // ORIGINAL RESOURCE
}

export interface WField { id: string; label: string; hint?: string }
export interface WSection { title: string; fields: WField[] }
export interface Workbook { id: string; title: string; sections: WSection[] }

export interface Masterclass {
  id: string;
  teacher: string;
  book?: string;
  title: string;
  subtitle: string;
  category: string;   // Network Marketing | Personal Development | Money | Mindset | Leadership
  accent: string;     // hex accent for the cover
  overview: string;
  minutes: string;    // e.g. "45–90 min"
  lessons: GreatLesson[];
  workbook?: Workbook;
  original?: { label: string; url: string; kind: string }[]; // buy / access the real thing
}

const EW = { label: "Eric Worre — Network Marketing Pro (free videos)", url: "https://www.networkmarketingpro.com/videos/", kind: "watch" as const };
const EW_YT = { label: "Eric Worre — Official YouTube", url: "https://www.youtube.com/ericworre", kind: "watch" as const };
const GOPRO_BOOK = { label: "Get the book: Go Pro (Eric Worre) — official site", url: "https://www.networkmarketingpro.com/", kind: "buy" as const };

// ═══════════════════════════════ GO PRO MASTERCLASS ═══════════════════════════════
const GO_PRO: Masterclass = {
  id: "go-pro",
  teacher: "Eric Worre",
  book: "Go Pro: 7 Steps to Becoming a Network Marketing Professional",
  title: "Go Pro Masterclass",
  subtitle: "Learn the professional skills required to build a network marketing organization.",
  category: "Network Marketing",
  accent: "#2563eb",
  minutes: "60–90 min",
  overview:
    "There are three kinds of people in this profession: posers who dabble, amateurs who hope, and professionals who master a few skills and do them consistently. This masterclass teaches the seven professional skills — the same seven every serious builder learns — as an original One Mission training. You'll learn each skill, see exactly what to say (and what not to say), practice it, then get an action to do today. Nobody is born good at this. It's learned. Let's go pro.",
  original: [EW, EW_YT, GOPRO_BOOK],
  lessons: [
    {
      id: "gp-prospects",
      num: 1,
      title: "Finding Prospects",
      minutes: 8,
      five: {
        bigIdea: "You already know enough people to start. The skill isn't finding strangers — it's never running out of names by making a list and always adding to it.",
        principles: [
          "Make a big list and don't prejudge who's 'right.'",
          "Your list is a living document — always be adding.",
          "You're identifying people to expose to information, not deciding who joins.",
        ],
        wrong: "Beginners decide in their own head who would 'never be interested,' cross those people off, and quietly run out of people to talk to.",
        oneMission: "Open the 100 Person List Builder in the Academy and make identifying names a daily habit — a few every day.",
        today: "Add 20 names to your One Mission list right now, without judging a single one.",
      },
      why: "Every skill after this one needs people to practice on. If your list is short, every conversation feels high-stakes and you get desperate. A long, growing list gives you options and takes the pressure off — which makes you better at everything else.",
      principle: "A professional builds and maintains a large 'candidate' list and keeps adding to it forever. The goal of the list is simply to identify people you could expose to information — nothing more. You are not deciding who will say yes.",
      beginner: "Imagine you're throwing a big party and you want to invite everyone you know. You'd write down family, friends, coworkers, old classmates, people you follow online, the people who follow you. That's your list. You're not deciding who will come — you're just writing names so you don't forget anyone.",
      example: "New builder Ana was sure her list was 'only about 15 people.' Her coach walked her through memory joggers — who she went to school with, worked with, does she have kids' sports friends, who cuts her hair, who she follows on Instagram. Twenty minutes later she had 90 names. Two of her first builders were people she almost never would have written down.",
      whatToSay: [
        { label: "Memory joggers to build the list", text: "Ask yourself: Who do I know from work (now and past)? School? Family? My neighborhood? My gym or church? Who's on my phone? Who do I follow online? Who follows me? Who's ambitious? Who's going through a change (new baby, new job, new city)? Write every name — judge none." },
      ],
      whatNotToSay: [
        "\"They'd never do this.\" (You don't know that — that's prejudging.)",
        "\"They have too much money / not enough money.\" (Both kinds join all the time.)",
        "\"They're too busy.\" (Busy, successful people are often the best builders.)",
      ],
      mistakes: [
        "Prejudging — deciding someone's answer before you ever ask.",
        "Making a small list, so every single conversation feels do-or-die.",
        "Building the list once and never adding to it again.",
      ],
      application: "In One Mission, your list is the fuel for your Daily Method. Professionals add new names every day — from real life and from social media — so they never wake up with 'nobody to talk to.' A shrinking list is the #1 quiet reason people stall.",
      practice: "Open the 100 Person List Builder and get to 30 names today. For any name you feel tempted to skip, write it down anyway and put a star next to it — those are often the ones who surprise you.",
      action: "Add 20+ names to your list today, and set a reminder to add 5 new names every day this week.",
      quiz: [
        {
          q: "You think of an old coworker who seems 'too successful and busy' to be interested. What's the professional move?",
          options: [
            "Skip them — they'd never do this.",
            "Write them down without judging, and let them decide for themselves later.",
            "Only add them if you're sure they'll say yes.",
          ],
          correct: 1,
          why: "Prejudging is guessing someone's answer for them. Your only job at the list stage is to identify people — the prospect decides, not you. Busy, successful people are often your best builders.",
        },
        {
          q: "What's the real purpose of your prospect list?",
          options: [
            "To decide who will definitely join.",
            "To identify people you could expose to information.",
            "To rank people by how much money they have.",
          ],
          correct: 1,
          why: "The list only identifies people. Whether they join is their decision after they see the information — not something you predict in advance.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
      roleplay: undefined,
    },
    {
      id: "gp-inviting",
      num: 2,
      title: "Inviting",
      minutes: 10,
      five: {
        bigIdea: "The purpose of an invitation is NOT to explain the whole business. It's to get someone to LOOK at the information.",
        principles: [
          "You are not the presentation — a tool or a leader is. Your job is just to get them to press play.",
          "Stay in posture: brief, curious, a little unattached. You have something valuable; you're not begging.",
          "Always set a clear next step (a time to follow up). Never leave it at 'let me know.'",
        ],
        wrong: "Beginners try to explain the entire opportunity on the spot, 'throw up' information, and either overwhelm the person or talk them out of looking.",
        oneMission: "Use the invitation scripts, send a tool (the overview video/website), and book a 3-way with your leader.",
        today: "Send one invitation to one person from your list using a script below.",
      },
      why: "Inviting is where most people fail — because they try to be the whole business in one text. When you learn that the invite has ONE job (get them to look), it gets simple, low-pressure, and repeatable. This is the skill that feeds your entire business.",
      principle: "A professional invites people to look at information — nothing more. Curiosity, brevity, and posture do the work. You're not convincing anyone; you're finding out if they're open to taking a look, then pointing them to a tool or a leader who presents.",
      beginner: "Think of it like this: a friend says, 'You've got to try this taco place.' They don't stand there describing every ingredient on the menu. They just say, 'Trust me, go check it out.' Inviting is the same — you're not explaining the whole thing, you're just getting them curious enough to look.",
      example: "New builder Marcus texted an old friend: 'Hey, I'm working on something new and you came to mind. Not sure it's for you, but would you be open to taking a quick look?' The friend said 'sure.' Marcus sent the overview video and set a time to talk. He didn't explain anything — the tool did. His friend joined two days later, and Marcus learned exactly what to say by watching his leader on the 3-way.",
      whatToSay: [
        { label: "Warm market", text: "Hey, I'm working on something new and you came to mind. I'm not sure if it's for you, but would you be open to taking a quick look?" },
        { label: "Friend", text: "Hey [name]! Random question — are you open to a side project right now, or nah? No worries either way, just thought of you." },
        { label: "Family member", text: "Hey, I started something I'm actually excited about. I'd love your honest take on it — would you watch a short overview and tell me what you think?" },
        { label: "Old coworker", text: "Hey [name], good to reconnect! I'm building something outside of [old job] that made me think of you. Open to a quick look, or not really your thing right now?" },
        { label: "Business owner", text: "I've always respected how you think about business. I'm working on something and I'd genuinely value your opinion. Would you be open to seeing it?" },
        { label: "Entrepreneur", text: "You're always building something — same here. I've got a project I think you'd find interesting. Want me to send you a quick overview?" },
        { label: "Wants extra income", text: "You mentioned wanting another income stream. I'm working on something that might be worth a look. If I sent you a quick overview, would you check it out?" },
        { label: "Instagram DM", text: "Hey! Been seeing your posts 👀 Quick q — are you open to something outside of what you're doing now, or all-in on your current thing?" },
        { label: "Facebook message", text: "Hey [name], good to reconnect! I'm working on something new that made me think of you. Open to a quick look, or not really your thing right now?" },
        { label: "Text", text: "Hey [name]! Are you open to a side project right now, or nah? Totally fine either way — just thought of you." },
        { label: "Phone call", text: "Hey, I've only got a minute but I wanted to run something by you. I'm working on something new and thought of you — would you be open to taking a look this week?" },
        { label: "Face-to-face", text: "Hey, can I ask you something? I'm working on a project I'm excited about. I don't know if it's for you, but would you be open to seeing what it is?" },
      ],
      whatNotToSay: [
        "\"It's this amazing company that sells [product] and you get paid when...\" (That's presenting, not inviting — you just did the tool's job, badly.)",
        "\"Please just hear me out, I really need this to work.\" (Desperation kills posture.)",
        "\"You HAVE to see this, it's going to make you rich.\" (Income claim + hype = instant distrust.)",
        "\"So... let me know I guess.\" (No next step means it dies.)",
      ],
      mistakes: [
        "Explaining the whole business in the invite (information dumping).",
        "Chasing and over-selling instead of staying in posture.",
        "No clear next step — leaving it at 'let me know' instead of setting a time.",
        "Making it about you needing them, instead of them being open to a look.",
      ],
      application: "In One Mission, the invite hands the prospect to a tool (the overview video, the website) and often a leader (a 3-way). That's the 3-Way Exposure, and it's how you build while you learn. Every time you invite with a tool, you're teaching your future team to do the exact same simple thing — that's duplication.",
      practice: "Pick 3 people from your list. For each, choose the script that fits and personalize the first line. Send all three today. Notice: your only goal is a 'yes, I'll look' — not a yes to joining.",
      roleplay: { scenario: "Inviting", opener: "Oh interesting... what is it though? Just tell me what it is." },
      action: "Send 3 invitations today using the scripts. Then practice once with the AI (Role-Play → Inviting) and get your coaching score.",
      quiz: [
        {
          q: "You're inviting your old coworker. Which is better?",
          options: [
            "\"Hey, I joined this company and here's the entire compensation plan and product line...\"",
            "\"I'm working on something and you came to mind. I'm not sure it's for you, but would you be open to taking a look?\"",
            "\"You have to do this with me, it's going to make us both rich.\"",
          ],
          correct: 1,
          why: "The invite's only job is to get them to LOOK. Option A dumps information (that's the tool's job). Option C makes an income claim and reeks of pressure. Option B is short, curious, low-pressure, and in posture.",
        },
        {
          q: "What is the single goal of an invitation?",
          options: [
            "Get them to join on the spot.",
            "Explain the whole opportunity clearly.",
            "Get them to look at the information.",
          ],
          correct: 2,
          why: "Inviting ≠ presenting ≠ closing. The invite gets a 'yes, I'll look.' The tool or leader presents. The decision comes later.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
    },
    {
      id: "gp-presenting",
      num: 3,
      title: "Presenting",
      minutes: 8,
      five: {
        bigIdea: "You don't have to be a great presenter. You have to be great at using tools and leaders to present for you.",
        principles: [
          "The tool is the presentation — a video, a call, the website, a leader. You connect the two.",
          "Third-party tools duplicate; your personality doesn't. If it only works when YOU do it, it won't grow.",
          "Keep it simple. Confused people don't join.",
        ],
        wrong: "Beginners think they must become a polished expert before they can share, so they stall for months 'getting ready.'",
        oneMission: "Do a 3-Way Exposure: you + prospect + a tool or leader. The tool teaches; you learn by watching.",
        today: "Book one 3-way exposure — pick a prospect, pick a tool or leader, set the time.",
      },
      why: "Fear of 'presenting' freezes more new people than anything else. The moment you realize you're not the presenter — the tool is — the fear disappears and you can start today, exactly as you are.",
      principle: "A professional leverages third-party tools and experienced leaders to present. This is the 3-Way Exposure: you bring the prospect, the tool or leader brings the message. It removes pressure from you, keeps the message consistent, and — most importantly — is simple enough that your future team can copy it.",
      beginner: "You don't need to be a chef to recommend a great restaurant. You just take your friend there and let the kitchen do the cooking. A tool (a short video, a live call, your leader on a 3-way) is the kitchen. Your job is just to bring your friend to the table.",
      example: "New builder Priya was terrified to 'present.' Her leader said, 'Don't. Just text the video, then get on a 10-minute 3-way with me.' Priya sent the overview, hopped on the call, and mostly listened while her leader answered questions. Her prospect joined — and Priya realized she'd just learned the presentation by watching it happen.",
      whatToSay: [
        { label: "Hand off to a tool", text: "I'm not the expert on all the details yet, so I'm going to send you a short overview that explains it way better than I could. Can you watch it before we talk [day/time]?" },
        { label: "Set up a 3-way", text: "I'd love for you to hear this from the person who brought me in — she's built this for a while and can answer anything. Can I get you two on a quick call [day/time]?" },
        { label: "Simple presentation frame", text: "Connect → ask what matters to them → show the overview → show the community → ask what they liked → agree on the next step. Never overwhelm — less is more." },
      ],
      whatNotToSay: [
        "\"Let me tell you EVERYTHING about the products, the science, the comp plan, the...\" (Overwhelm = no.)",
        "\"I need to learn everything before I can show anyone.\" (You don't — the tool knows it for you.)",
        "\"Ignore that part, it's complicated.\" (If it's confusing, simplify or let the tool handle it.)",
      ],
      mistakes: [
        "Trying to be the expert before you're ready, instead of using a tool or leader.",
        "Talking too much and burying the prospect in information.",
        "Skipping the questions — presenting before you know what they actually care about.",
      ],
      application: "In One Mission, your tools are the overview video, the live calls, the website, and your leaders. Using them isn't a crutch — it's the system. Every exposure you do with a tool teaches your new people that they can do this too, without being experts. That's how a team duplicates.",
      practice: "Set up one 3-Way Exposure this week. Write down: which prospect, which tool or leader, and the exact time. Then send the invite to make it real.",
      action: "Book one 3-way exposure today and put it on your calendar.",
      quiz: [
        {
          q: "A new prospect is ready to see the opportunity, but you feel like you don't know enough yet. Best move?",
          options: [
            "Wait a few months until you've memorized everything.",
            "Send the overview tool and set up a 3-way with your leader.",
            "Wing it and explain the whole comp plan from memory.",
          ],
          correct: 1,
          why: "You never have to be the expert. The tool presents and your leader supports — that's the 3-Way Exposure. It also teaches your prospect exactly how simple this is to copy.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
    },
    {
      id: "gp-followup",
      num: 4,
      title: "Following Up",
      minutes: 8,
      five: {
        bigIdea: "The fortune is in the follow-up. Almost nobody decides after one exposure — professionals simply follow up until there's a decision.",
        principles: [
          "The only reason to do an exposure is to set up the next exposure.",
          "Follow up when you say you will — being organized and reliable IS the skill.",
          "A clear 'no' is fine. A chased 'maybe' is what drains you.",
        ],
        wrong: "Beginners do one exposure, hear 'let me think about it,' and then never follow up — so the lead quietly dies.",
        oneMission: "Log follow-ups in your Activity tracker and schedule the next step on every open conversation.",
        today: "Do one follow-up you've been avoiding.",
      },
      why: "Most of your results live in the second, third, and fourth touch — not the first. If you get good at nothing else, get good at following up when you said you would. It's less about talent and more about being organized and unafraid.",
      principle: "A professional always sets up the next exposure and follows up on schedule. Follow-up isn't nagging — it's answering questions and helping a person reach a decision. You keep the conversation alive with respect until you get a real yes or a real no.",
      beginner: "Follow-up is just keeping your promise. You said, 'I'll check in Thursday,' so on Thursday you check in. That's it. Most people don't join on day one — not because they're not interested, but because life is busy. Your reliable follow-up is what carries them across the line.",
      example: "New builder Devon's prospect watched the video and said, 'Looks interesting, let me think.' Devon almost left it there. Instead he said, 'Totally — I'll call you Thursday at 6.' He called at 6. His prospect had two questions, Devon got them answered on a quick 3-way, and the prospect joined. The only difference between a dead lead and a new teammate was one kept promise.",
      whatToSay: [
        { label: "Set the next step", text: "Cool — the best next step is a quick call so you can ask questions. Does Thursday at 6 or Friday at 12 work better?" },
        { label: "The follow-up open", text: "Hey [name], following up like I promised — what did you like best about what you saw?" },
        { label: "Handle 'still thinking'", text: "Totally fair. Just so I can help — is there a specific question you're thinking through? I'd rather answer it than have you guessing." },
      ],
      whatNotToSay: [
        "\"Sooo did you decide yet??\" (Pressure with no value.)",
        "\"I'll just wait for you to reach out.\" (You won't set a next step, so it dies.)",
        "\"You're going to miss out forever if you don't act now!\" (Fake urgency erodes trust.)",
      ],
      mistakes: [
        "Doing an exposure with no scheduled next step.",
        "Not following up because you're afraid of a 'no.'",
        "Turning a 'needs time' into a chase instead of a booked follow-up.",
      ],
      application: "In One Mission, log every follow-up in your Weekly Activity and never end a conversation without the next step on the calendar. The members who quietly out-produce everyone aren't more charming — they just follow up when they said they would.",
      practice: "List every open conversation you have right now. Next to each, write the exact next step and time. Then send one follow-up message you've been putting off.",
      roleplay: { scenario: "Follow-Up", opener: "Hey, sorry — I've been meaning to get back to you." },
      action: "Book the next step on every open conversation today, and do one follow-up you've been avoiding.",
      quiz: [
        {
          q: "A prospect says 'let me think about it' after watching the overview. Best professional move?",
          options: [
            "Leave it and hope they reach out.",
            "Say 'I'll call you Thursday at 6' and actually call.",
            "Text 'did you decide yet?' every day until they answer.",
          ],
          correct: 1,
          why: "Follow-up is a scheduled, reliable next step — not hoping, and not nagging. Booking a specific time (and keeping it) is the entire skill.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
    },
    {
      id: "gp-decision",
      num: 5,
      title: "Helping People Make a Decision",
      minutes: 8,
      five: {
        bigIdea: "Closing isn't pressure — it's helping a person make a clear decision with good questions.",
        principles: [
          "Ask, don't push. Questions keep them in the driver's seat.",
          "A decision either way is a win — 'yes,' 'no,' or 'here's my one question.'",
          "Your posture: you're offering an opportunity, not begging for a favor.",
        ],
        wrong: "Beginners either pressure hard (and repel people) or never ask for a decision at all (and leave everyone in 'maybe' forever).",
        oneMission: "Use the decision questions, then follow the decision tree honestly.",
        today: "Ask one prospect the four decision questions.",
      },
      why: "People are actually relieved when someone helps them make a clear decision. Done right, closing builds trust instead of tension — and it turns all your exposures and follow-ups into actual teammates and customers.",
      principle: "A professional helps people make a decision by asking questions, not by applying pressure. Good questions reveal what the person needs and let them talk themselves toward a decision. Then you respect whatever they decide.",
      beginner: "Closing sounds scary, but it's just helping someone decide. Like a good waiter who asks, 'Did you want the steak or the salmon?' — they're not pressuring you, they're helping you choose. You ask simple questions and let the person decide what's right for them.",
      example: "New builder Lena finished an exposure and asked, 'So what did you like most?' Her prospect said, 'Honestly, the community.' Lena asked, 'On a scale of 1–10, how interested are you?' — 'Like a 7.' 'What would get you to a 10?' — 'Knowing how much time it takes.' Lena answered that one thing, and her prospect enrolled. No pressure — just questions.",
      whatToSay: [
        { label: "Open it up", text: "So what did you like most about what you saw?" },
        { label: "Gauge interest", text: "On a scale of 1 to 10, where 10 is 'let's go' — where are you right now?" },
        { label: "Find the gap", text: "What would you need to know or see to get closer to a 10?" },
        { label: "Customer or builder", text: "Do you see yourself more as a customer using this, or possibly building it too?" },
        { label: "The ask", text: "It sounds like this is a fit for you — want me to help you get started right now?" },
      ],
      whatNotToSay: [
        "\"You'd be crazy not to do this.\" (Insulting + pressure.)",
        "\"This is your last chance, the price goes up tonight.\" (Fake urgency.)",
        "\"Just trust me, you'll definitely make money.\" (Income guarantee — never.)",
      ],
      mistakes: [
        "Pushing for a yes instead of asking questions.",
        "Being afraid to ask for the decision at all, leaving everyone in 'maybe.'",
        "Arguing with a 'no' instead of respecting it and staying friends.",
      ],
      application: "In One Mission, follow the decision tree honestly: Interested → help them enroll. Has a question → answer it. Needs time → book a real follow-up. Not interested → respect it and keep the relationship. A clean 'no' is more valuable than a fake 'maybe' that wastes both of you.",
      practice: "Practice the four decision questions out loud once. On your next exposure, ask them in order and just listen — let the prospect tell you what they need.",
      roleplay: { scenario: "Closing", opener: "Yeah it was cool. I don't know though, I'd have to think about it." },
      action: "Use the four decision questions on one prospect today.",
      quiz: [
        {
          q: "After an exposure, what does 'closing' actually mean for a professional?",
          options: [
            "Pressuring the person until they say yes.",
            "Helping the person make a clear decision by asking questions.",
            "Talking until they run out of objections.",
          ],
          correct: 1,
          why: "Closing = helping someone decide. Questions ('What did you like most?', '1–10?', 'What would get you to a 10?') do the work and keep the person in control. Pressure repels; questions build trust.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
    },
    {
      id: "gp-getting-started",
      num: 6,
      title: "Getting People Started Right",
      minutes: 8,
      five: {
        bigIdea: "The fastest way to help a new person succeed is to help them feel momentum in the first 48 hours — through activity, never through promises.",
        principles: [
          "Get them a quick, simple win fast (apps on, why written, list started, first invites out).",
          "Get them around a leader and an event immediately.",
          "Set clear expectations: activity and consistency, not overnight results.",
        ],
        wrong: "Beginners either abandon their new person ('good luck!') or bury them in information so they freeze.",
        oneMission: "Run the 48-Hour Launch checklist with every new teammate.",
        today: "If you enrolled someone, start their 48-Hour Launch. If not, review it so you're ready.",
      },
      why: "How you start a new person predicts almost everything. A great first 48 hours creates belief and momentum; a slow, confusing start creates doubt. This is where leaders are made or lost.",
      principle: "A professional gets every new person started with a fast, simple, duplicable launch focused on productive activity and early wins — not income promises. Momentum is a feeling, and you create it on purpose in the first two days.",
      beginner: "When someone joins, don't hand them a giant manual. Hand them a short checklist and do it with them: get the app working, write their why, start their list, send the first few invites, and get them on a live call. Small wins early make people believe they can do this.",
      example: "Two people enroll the same week. One gets a warm welcome, is on a live call 12 hours later, and sends three invites with their sponsor's help. The other gets 'welcome, let me know if you have questions' and silence. Ninety days later, only one is still building — and it isn't the one who was left alone.",
      whatToSay: [
        { label: "The welcome", text: "So glad you're in! Here's all we're doing in the next 48 hours — it's simple and I'll be right there with you. First, let's get your apps set up and write your why." },
        { label: "Set expectations", text: "I can't promise you money — nobody honestly can. What I CAN promise is that if you do the simple activity consistently, you'll build real skill and momentum. Deal?" },
      ],
      whatNotToSay: [
        "\"You're going to make $10k your first month!\" (Income claim — never, ever.)",
        "\"Just watch all 40 of these trainings and you'll be set.\" (Overwhelm = paralysis.)",
        "\"Okay you're signed up, good luck!\" (Abandonment kills new people.)",
      ],
      mistakes: [
        "Overwhelming a new person with everything at once.",
        "Promising money instead of focusing on activity and momentum.",
        "Letting the new person sit alone instead of getting them near a leader and an event fast.",
      ],
      application: "In One Mission, the 48-Hour Launch IS this skill, systematized: welcome + apps + why (hours 0–2), build 25–50 names and pick the top 10 (hours 2–12), first invitations and get around a leader (hours 12–24), first 3-way and attend a call (hours 24–48). Run it with every person you enroll — and teach them to run it with theirs.",
      practice: "Open the 48-Hour Launch tool. If you've enrolled someone, start it with them today. If not, walk through it yourself so you can run it in your sleep when your first person joins.",
      action: "Start a 48-Hour Launch today — for a new teammate, or as a dry run for yourself.",
      quiz: [
        {
          q: "A new person just enrolled. What's the professional's first priority?",
          options: [
            "Send them every training video you have and check back in a month.",
            "Promise them how much money they'll make to keep them motivated.",
            "Run a simple 48-Hour Launch with them — quick wins and momentum, no income promises.",
          ],
          correct: 2,
          why: "Fast, simple, guided activity builds belief. Income promises are unethical and set people up to quit; dumping information causes paralysis; abandonment is the #1 reason new people fade.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
    },
    {
      id: "gp-events",
      num: 7,
      title: "Promoting Events",
      minutes: 8,
      five: {
        bigIdea: "Events compress time. What takes months to teach one-on-one, a room full of proof can do in one night.",
        principles: [
          "Belief and vision are 'caught' at events, not taught in texts.",
          "Promote personally with a clear why, then follow up once — not ten times.",
          "Bring people; don't drag them. A leader is always bringing guests.",
        ],
        wrong: "Beginners treat events as optional, undersell them, or attend without ever bringing anyone.",
        oneMission: "Personally invite people to the next One Mission event on What's On.",
        today: "Personally invite two people to the next event.",
      },
      why: "Nothing moves belief like an event. A lukewarm prospect can walk in a '5' and leave a '9' after hearing real stories from real people. Leaders learn early that events are the shortcut, not the extra.",
      principle: "A professional promotes and attends events consistently, and always brings guests. Events deliver belief, social proof, vision, and energy that one-on-one conversations can't. They compress months of belief-building into hours.",
      beginner: "An event is like a concert versus describing a concert. You can text someone all about how great the band is, or you can just bring them and let them feel it. Events let people experience the community and the vision firsthand — and that changes them faster than anything you could say.",
      example: "A prospect who was a lukewarm '5' on the phone came to one live event, met real people with real stories, felt the energy, and left a '9.' The builder didn't say anything new — the room did the work. That's why leaders never miss events and always bring someone.",
      whatToSay: [
        { label: "Personal event invite", text: "There's a live call [day/time] and I really want you there — you'll hear directly from people actually doing this, and it'll answer a lot of your questions. Can you make it?" },
        { label: "Give the why", text: "The reason I want you at this one specifically: you'll get to see the community and hear real stories, not just my version of it. It's the fastest way to know if this is for you." },
      ],
      whatNotToSay: [
        "\"It's just a little optional call if you're bored.\" (Underselling kills attendance.)",
        "\"You HAVE to come or you're not serious!\" (Pressure and guilt.)",
        "\"Come get rich with us!\" (Hype + income claim.)",
      ],
      mistakes: [
        "Treating events as optional instead of central.",
        "Spamming invites instead of inviting personally with a clear why.",
        "Attending events but never bringing anyone.",
      ],
      application: "In One Mission, check What's On for the next event, then personally invite guests with a specific why. Events are where your prospects catch belief and your team catches fire. A simple leadership habit: never attend an event empty-handed.",
      practice: "Find the next One Mission event on What's On. Personally invite two people to it today, each with a specific reason they'd get value from it.",
      action: "Personally invite two people to the next One Mission event today.",
      quiz: [
        {
          q: "Why do professionals prioritize getting prospects and new teammates to events?",
          options: [
            "Because attendance looks good to the upline.",
            "Because events compress time — belief, stories, and vision move people faster than one-on-one texts.",
            "Because it's a good place to pressure people to join.",
          ],
          correct: 1,
          why: "Events build belief and vision through real stories and social proof — something a single conversation can't replicate. They shorten months of belief-building into one night. Pressure is never the goal.",
        },
      ],
      resource: [EW, GOPRO_BOOK],
    },
  ],
  workbook: {
    id: "go-pro-workbook",
    title: "One Mission Go Pro Implementation Workbook",
    sections: [
      { title: "My Why", fields: [{ id: "why", label: "Why am I really building One Mission?", hint: "Be specific and personal." }] },
      { title: "My Prospect List", fields: [{ id: "list_status", label: "How many names are on my list right now, and my plan to keep adding?" }] },
      { title: "My Top 25", fields: [{ id: "top25", label: "My 25 strongest names (people I'd genuinely enjoy building with)" }] },
      { title: "My Invitation Script", fields: [{ id: "invite", label: "My go-to invitation, in my own words" }] },
      { title: "My Exposure Tool", fields: [{ id: "tool", label: "The tool I'll send / the leader I'll 3-way with" }] },
      { title: "My Follow-Up Plan", fields: [{ id: "followup", label: "How and when I follow up after every exposure" }] },
      { title: "My Common Objections", fields: [{ id: "objections", label: "The 2–3 objections I hear most, and my response to each" }] },
      { title: "My First 48-Hour Launch", fields: [{ id: "launch", label: "My plan to run a 48-Hour Launch with my next enrollee" }] },
      { title: "My Upcoming Events", fields: [{ id: "events", label: "The next event I'm attending and who I'm bringing" }] },
      { title: "My Leadership Goals", fields: [{ id: "leadership", label: "The kind of leader I'm becoming (and by when)" }] },
      { title: "My Daily Method", fields: [{ id: "daily", label: "My daily non-negotiable activity (conversations, invites, follow-ups, PD)" }] },
      { title: "My Weekly Scorecard", fields: [{ id: "scorecard", label: "The weekly activity numbers I'll hold myself to" }] },
    ],
  },
};

const JR = { label: "Jim Rohn — Official YouTube", url: "https://www.youtube.com/channel/UCqlo0GJTw_g_m0rysXhPTtg", kind: "watch" as const };

// ═══════════════════════════════ JIM ROHN FOUNDATION ═══════════════════════════════
const JIM_ROHN: Masterclass = {
  id: "jim-rohn",
  teacher: "Jim Rohn",
  title: "The Jim Rohn Foundation",
  subtitle: "The personal-development philosophy that shapes disciplined, valuable, respected builders.",
  category: "Personal Development",
  accent: "#0ea5e9",
  minutes: "70–100 min",
  overview:
    "Jim Rohn taught that success isn't something you pursue — it's something you attract by the person you become. This foundation turns his core ideas into a 12-lesson pathway you actually apply to building One Mission: take responsibility, sharpen your philosophy, set real goals, live by discipline, upgrade your associations, become more valuable, and lead. Work on yourself harder than you work on your business, and everything else follows.",
  original: [JR],
  lessons: [
    {
      id: "jr-responsibility", num: 1, title: "Personal Responsibility", minutes: 7,
      five: { bigIdea: "You can't change your circumstances until you take full ownership of them. Responsibility is where all growth begins.", principles: ["Blame keeps you stuck; ownership sets you free.", "You can't control everything that happens, but you own your response.", "The day you stop making excuses is the day you start making progress."], wrong: "People wait for conditions to be perfect — the right time, the right market, the right upline — instead of owning their part right now.", oneMission: "Own your Daily Method. Nobody can make you do your conversations and invites — that's yours.", today: "Name one result in your business you've been blaming on something external — and write down your part in it." },
      why: "If your results are someone else's fault, then your future is out of your hands — and that's a powerless place to build from. Responsibility hands you back the steering wheel.",
      principle: "Take full responsibility for your results. Not blame — responsibility. You may not control the economy, your sponsor, or who says no, but you fully control your effort, your attitude, your skill-building, and your consistency.",
      beginner: "Imagine two new builders. One says, 'My sponsor never helped me, that's why I quit.' The other says, 'My sponsor was busy, so I used the Academy and asked questions until I figured it out.' Same situation — completely different future. Responsibility just means focusing on your part.",
      example: "New builder Tomas kept saying the 'market was bad' for his invites. His mentor asked, 'How many invites did you send this week?' — 'Three.' The market wasn't the problem. Tomas owned it, sent 15 the next week, and got two exposures. Ownership changed the result.",
      mistakes: ["Blaming the upline, the timing, the market, or the company for your results.", "Waiting for perfect conditions instead of owning your effort now.", "Confusing responsibility with self-blame — it's ownership, not punishment."],
      application: "In One Mission, your activity is 100% yours. When a week is slow, a professional doesn't ask 'whose fault is this?' — they ask 'what's MY next action?' That single reframe is the difference between builders who last and builders who fade.",
      practice: "Write down one thing you've blamed for a slow result. Now rewrite it as: 'My part in this was ___, and my next action is ___.'",
      action: "Take ownership of one thing today — do the activity you've been blaming circumstances for avoiding.",
      quiz: [{ q: "A week goes slow and you didn't hit your activity. The responsible mindset is:", options: ["'The market/upline/timing is against me.'", "'What's my next action, and what will I do differently?'", "'I'm just bad at this, I should quit.'"], correct: 1, why: "Responsibility isn't blame (external) or self-blame (internal punishment). It's ownership pointed at your next action — the only thing you actually control." }],
      resource: [JR],
    },
    {
      id: "jr-philosophy", num: 2, title: "Your Personal Philosophy", minutes: 7,
      five: { bigIdea: "Your philosophy — how you think about life, money, work, and people — sets the direction of everything. Change the philosophy, change the life.", principles: ["Your choices come from your philosophy, and your results come from your choices.", "A small error in thinking, repeated daily, compounds into a big gap over years.", "You can upgrade your philosophy by what you read, hear, and who you're around."], wrong: "People try to change their results without changing the thinking that produced them.", oneMission: "Feed your philosophy daily — 10 minutes of the Academy or a book — so your thinking keeps leveling up.", today: "Write one belief about business or money you got from your upbringing. Is it still serving you?" },
      why: "Two people get the same opportunity; one builds an empire and one quits in a month. The difference usually isn't luck or talent — it's philosophy. It's what they believe is possible and what they're willing to do.",
      principle: "Your personal philosophy is the set of ideas that drives your daily choices. Because your choices create your results, upgrading your philosophy is the highest-leverage thing you can do. And philosophy is learnable — you build it with the inputs you choose.",
      beginner: "Philosophy just means 'the way you see things.' If you believe 'people like me don't succeed,' you'll act small and quit early. If you believe 'skills can be learned and I'm becoming better every day,' you'll act completely differently — and get different results.",
      example: "A builder who believed 'asking people is annoying' avoided invites and apologized constantly. After a month of feeding her mind different ideas, she believed 'I'm offering something valuable and letting people decide.' Her invites doubled — because her thinking changed first.",
      mistakes: ["Trying to fix results while keeping the same broken thinking.", "Never feeding your mind, so your philosophy stays wherever it was at 18.", "Blaming your personality instead of upgrading your inputs."],
      application: "In One Mission, your philosophy shows up in your posture. Do you believe you're bothering people, or offering them a look at something that could help? That belief leaks into every message you send. Personal development is how you upgrade it.",
      practice: "List two beliefs about money or business you absorbed growing up. For each, ask: is this helping me build, or holding me back? Write a better version.",
      action: "Spend 10 minutes today feeding your philosophy — one Academy lesson or a few pages of a great book.",
      quiz: [{ q: "Why does Jim Rohn say to work on your philosophy, not just your results?", options: ["Because thinking is more fun than working.", "Because your philosophy drives your choices, and your choices drive your results.", "Because results don't matter."], correct: 1, why: "Results are downstream of choices, and choices are downstream of philosophy. Change the root (thinking) and the fruit (results) changes." }],
      resource: [JR],
    },
    {
      id: "jr-goals", num: 3, title: "Goal Setting", minutes: 8,
      five: { bigIdea: "Goals give direction to your activity. Without a target, effort scatters; with one, it compounds.", principles: ["Set goals big enough to stretch you but clear enough to measure.", "Write them down — a goal in your head is just a wish.", "The value of a goal isn't only reaching it; it's who you become chasing it."], wrong: "People set vague goals ('do better') or no goals, then wonder why their effort feels random.", oneMission: "Set a 90-day activity goal in One Mission (conversations, invites, exposures) and track it weekly.", today: "Write one specific 90-day goal you can measure." },
      why: "Activity without a target is just busyness. A clear goal turns your Daily Method from 'stuff I do' into 'steps toward something I want' — and that changes how consistently you show up.",
      principle: "Set specific, written, measurable goals with deadlines. The best goals stretch you (they require you to grow) and are clear enough that you always know if you're on track. Chase the growth as much as the goal.",
      beginner: "A goal is just a clear picture of what you want and when. 'I want to do better' isn't a goal — you can't measure it. 'Have 20 exposures in the next 30 days' is a goal — you know exactly what to do and whether you did it.",
      example: "New builder Ray set a real target: '15 exposures in 30 days.' Suddenly his week had a point. Some days he didn't feel like inviting, but the goal pulled him. He hit 13 — missed the number, but built the skill and the habit. The goal did its job.",
      mistakes: ["Vague goals you can't measure ('grow my team').", "Goals with no deadline, so there's no urgency.", "Only caring about the outcome and ignoring the person you're becoming."],
      application: "In One Mission, set ACTIVITY goals you control (conversations, invites, exposures, follow-ups) rather than outcome goals you don't (enrollments). Track them in your Weekly Activity. Controllable goals keep you steady when results are lumpy — and results always come from consistent activity.",
      practice: "Write a 90-day goal in this format: 'By [date], I will have completed [measurable activity].' Then break it into a weekly number.",
      action: "Set one measurable 90-day activity goal today and put your weekly target in your Activity tracker.",
      quiz: [{ q: "Which is the strongest goal for a new builder?", options: ["'Get rich in network marketing.'", "'Do 15 exposures in the next 30 days.'", "'Be more successful this year.'"], correct: 1, why: "A strong goal is specific, measurable, time-bound, and based on activity you control. 'Get rich' is an outcome you can't directly control (and implies an income claim); 'be more successful' can't be measured." }],
      resource: [JR],
    },
    {
      id: "jr-discipline", num: 4, title: "Discipline", minutes: 7,
      five: { bigIdea: "Discipline is doing what needs to be done, whether you feel like it or not. Motivation gets you started; discipline keeps you going.", principles: ["Discipline weighs ounces; regret weighs tons.", "You don't rise to your goals — you fall to your habits.", "Every act of discipline makes the next one easier."], wrong: "People wait to 'feel motivated' — and since motivation is unreliable, their activity is too.", oneMission: "Do your Daily Method as a standard, not a mood. Complete it before entertainment.", today: "Do your Daily Method today even though you don't feel like it — that's the rep." },
      why: "Feelings are unreliable — some days you're fired up, most days you're not. Discipline is what makes you consistent regardless, and consistency is the entire game in this profession.",
      principle: "Discipline is the bridge between goals and results. Professionals don't depend on motivation; they build standards and keep them on the days they don't feel like it. Small daily disciplines, repeated, compound into large results.",
      beginner: "Discipline is just keeping a promise to yourself. You said you'd send 5 invites today. You don't feel like it. You do it anyway — that's discipline. It's not intense; it's small, boring, and done daily.",
      example: "Two builders start together. One only works when 'inspired' — so a few big days, then nothing. The other does 5 invites every single day no matter what. Three months later the disciplined one is far ahead — not because they're more talented, but because they showed up on the boring days.",
      mistakes: ["Waiting for motivation before doing the work.", "Going all-out for two days, then disappearing for two weeks.", "Treating your activity as optional based on mood."],
      application: "This is one of the most important One Mission ideas: you will NOT feel motivated every day, and professionals don't depend on it. Your Daily Method might be 5 conversations, 5 invites, 5 follow-ups, 10 minutes of personal development. You do it because it's your standard — not because you woke up excited. Today's mission: complete your Daily Method before you consume any entertainment.",
      practice: "Define your daily non-negotiable — the smallest activity you'll do every single day no matter what. Make it small enough that 'I don't feel like it' is never a valid excuse.",
      action: "Complete your Daily Method today before entertainment — feelings or not.",
      quiz: [{ q: "You planned to send invites today but you're not motivated. The disciplined professional:", options: ["Waits until they feel inspired.", "Does the activity anyway, because it's their standard.", "Skips today and doubles up 'later.'"], correct: 1, why: "Professionals don't depend on motivation. Discipline means doing the activity because it's your standard — the days you don't feel like it are exactly the reps that build the business." }],
      resource: [JR],
    },
    {
      id: "jr-associations", num: 5, title: "Your Associations", minutes: 7,
      five: { bigIdea: "You become the average of the people you spend the most time with. Proximity is power — choose it on purpose.", principles: ["Some people you associate with more, some less, some not at all.", "Get around people who are where you want to be.", "Their standards quietly become your standards."], wrong: "People let their circle happen by accident, then wonder why they can't rise above it.", oneMission: "Increase proximity to leaders — get on calls, attend events, join the group chats.", today: "Reach out to one person who's ahead of where you are and start a conversation." },
      why: "Your environment is stronger than your willpower over time. If everyone around you plays small, you'll drift small. If you're around builders and leaders, you rise — often without even trying.",
      principle: "Be intentional about your associations. Evaluate who lifts you and who limits you, and adjust your time accordingly — more time with those ahead of you, less with those who quietly hold you back. This isn't about abandoning people; it's about being deliberate with proximity.",
      beginner: "Think about it: if you spend all day with people who complain and quit, you'll start complaining and quitting. If you spend time with people who are building and growing, you'll start building and growing. You catch the habits of the people around you.",
      example: "A new builder was surrounded by friends who mocked her for 'doing that pyramid thing.' She kept building but felt heavy. She started getting on the team's daily call and going to events — and being around people who believed changed everything. Same person, different proximity, different results.",
      mistakes: ["Letting your circle form by accident instead of on purpose.", "Taking business advice from people who've never done it.", "Isolating from the team instead of increasing proximity to leaders."],
      application: "In One Mission, proximity is built in — daily calls, events, group chats, and leaders who show up. Use them. The members who plug into the community out-last the ones who try to build alone, because belief is contagious and you catch it from the room.",
      practice: "List the 5 people you spend the most time with. Honestly, are they pulling you up or holding you level? Then name 2 people ahead of you that you'll get more proximity to.",
      action: "Reach out to one person ahead of you today, and get on the next team call or event.",
      quiz: [{ q: "Jim Rohn's idea about associations means you should:", options: ["Cut everyone out who isn't rich.", "Be intentional about proximity — more time with those ahead of you, less with those who hold you back.", "Only talk to people in your company."], correct: 1, why: "It's about intentional proximity, not cutting people off. You spend more time with people who lift you and less with those who limit you — and you deliberately get near leaders." }],
      resource: [JR],
    },
    {
      id: "jr-value", num: 6, title: "Becoming More Valuable", minutes: 7,
      five: { bigIdea: "Don't wish it were easier; wish you were better. Your income and impact grow as your value grows.", principles: ["Work harder on yourself than you do on your job.", "Skills are the assets that pay you for life.", "The market pays for value, and value is learnable."], wrong: "People look for shortcuts and better conditions instead of becoming more skilled and more valuable.", oneMission: "Master the core skills — inviting, presenting, follow-up — so you're worth following.", today: "Pick one skill to improve this week and do one rep of it." },
      why: "You'll rarely earn more than you're worth for long. The fastest, most reliable way to grow your results is to grow your value — your skills, your character, your ability to help people.",
      principle: "Become more valuable by developing yourself. Instead of hunting for easier conditions, build harder skills. Value is what the market rewards, and value can always be increased through learning and practice.",
      beginner: "Imagine two employees. One does the bare minimum. The other keeps learning new skills. Over time, the second one gets promoted, trusted, and paid more — not by luck, but because they became more valuable. Same principle applies to building One Mission.",
      example: "A struggling builder kept wishing invites were 'easier.' His mentor said, 'Don't wish it were easier — get better at it.' He practiced inviting with the AI role-play for a week. His invites started landing. He didn't change the market; he increased his value.",
      mistakes: ["Looking for shortcuts instead of building skill.", "Blaming difficulty instead of improving ability.", "Never practicing — expecting to be good without reps."],
      application: "In One Mission, your value = your skills (inviting, presenting, follow-up, closing, leadership) + your character (reliability, work on yourself). The Academy exists to grow both. Every lesson you complete and every rep you practice makes you more worth following — which is how teams grow.",
      practice: "Pick the ONE skill that would most improve your results right now. Do one rep today — send the invite, practice with the AI, or complete the relevant Academy lesson.",
      action: "Choose one skill to sharpen this week and take one action on it today.",
      quiz: [{ q: "'Don't wish it were easier; wish you were ___.'", options: ["luckier", "better", "richer"], correct: 1, why: "Jim Rohn's principle: grow your value and skill rather than waiting for conditions to get easier. Better skills produce better results — reliably." }],
      resource: [JR],
    },
    {
      id: "jr-activity", num: 7, title: "Activity vs Results", minutes: 6,
      five: { bigIdea: "You control your activity, not your results. Focus on the inputs and let the outputs take care of themselves.", principles: ["Results are a lagging measure of past activity.", "Consistent activity produces results on a delay — keep going through the gap.", "Judge your week by what you did, not only by what happened."], wrong: "People obsess over outcomes they can't control and quit during the normal delay before results show up.", oneMission: "Track controllable activity in your Weekly Activity Score, not just enrollments.", today: "Log your activity numbers for the week honestly." },
      why: "Beginners quit because they judge themselves by results too early — before the activity has had time to pay off. Focusing on activity keeps you steady and honest through the delay where most people give up.",
      principle: "Separate activity (what you control) from results (what you don't). Professionals set standards for their activity and trust that consistent inputs produce outputs over time. Results always lag effort.",
      beginner: "Think of a farmer. They can't control the weather or make the seed grow faster — that's the 'result.' They CAN plant, water, and tend every day — that's the 'activity.' Focus on the farming, and the harvest comes in season.",
      example: "A builder did solid activity for three weeks with zero enrollments and almost quit. Her mentor showed her the numbers: 40 conversations, 18 invites, 6 exposures. 'You're not failing — you're planting. The harvest is coming.' Week four: two enrollments. The activity was working the whole time.",
      mistakes: ["Judging yourself by results before activity has had time to pay off.", "Obsessing over enrollments instead of tracking inputs.", "Quitting during the normal delay between effort and reward."],
      application: "In One Mission, your Weekly Activity Score tracks the things you control — conversations, invites, presentations, follow-ups. Win the activity and the results follow. When a week has effort but no enrollments, that's not failure — that's planting. Keep going.",
      practice: "Fill in your Weekly Activity honestly. Notice: did you win the activity even if results were quiet? That's the real scoreboard for a professional.",
      action: "Log your activity for the week and commit to next week's activity target.",
      quiz: [{ q: "You did strong activity this week but got zero enrollments. What's true?", options: ["You're failing and should reconsider.", "You're planting — consistent activity produces results on a delay.", "The activity was pointless."], correct: 1, why: "Results lag activity. Judging yourself only by outcomes during the normal delay is why people quit right before it works. Win the activity; trust the harvest." }],
      resource: [JR],
    },
    {
      id: "jr-communication", num: 8, title: "Communication", minutes: 7,
      five: { bigIdea: "Communication is a skill, not a talent. Learn to connect, ask, and listen — and you become someone people want to follow.", principles: ["Ask better questions; listen more than you talk.", "People don't care how much you know until they know how much you care.", "Clarity and stories move people more than facts and pressure."], wrong: "People try to be impressive instead of interested — they talk at people instead of connecting with them.", oneMission: "In every conversation, ask what matters to the person before you share anything.", today: "Have one conversation where you ask more than you tell." },
      why: "This is a people business. Your ability to connect, ask good questions, and truly listen is what turns cold contacts into relationships and prospects into teammates. And it's completely learnable.",
      principle: "Great communicators are made, not born. The core skills — connecting, asking questions, listening, and telling simple stories — can all be practiced. You lead with interest in the other person, not with information about yourself.",
      beginner: "The best communicators aren't the smoothest talkers — they're the best listeners. When you ask someone about themselves and actually listen, they feel valued, and they open up. That's more powerful than any perfect pitch.",
      example: "A nervous builder used to launch into facts the second someone showed interest. His mentor said, 'Ask them what they're looking for first.' He started asking, 'What would extra income change for you?' — then listened. Prospects opened up, and his exposures got far more powerful because he knew what mattered to them.",
      whatToSay: [{ label: "Lead with a question", text: "Before I share anything — what's got you open to looking at something new right now? What would it need to do for you to be worth your time?" }],
      mistakes: ["Talking more than listening.", "Trying to be impressive instead of interested.", "Sharing information before you know what the person cares about."],
      application: "In One Mission, connect → ask what matters → then share. When you know what a prospect actually wants (time, income, purpose, community), you can point them to the part of the opportunity that fits them — instead of dumping everything and hoping. Listening is your superpower.",
      practice: "In your next conversation, set a rule: ask at least 3 questions before you share anything about the business. Notice how much more they open up.",
      roleplay: { scenario: "Inviting", opener: "Oh interesting... what is it though? Just tell me what it is." },
      action: "Have one conversation today where you ask more than you tell.",
      quiz: [{ q: "The most powerful communication skill for a builder is usually:", options: ["Having the smoothest, most impressive pitch.", "Asking good questions and truly listening.", "Talking until the other person agrees."], correct: 1, why: "People feel valued when you're interested in them. Asking and listening reveals what they care about, so you can connect the opportunity to their real motivation — far more effective than an impressive monologue." }],
      resource: [JR],
    },
    {
      id: "jr-leadership", num: 9, title: "Leadership", minutes: 7,
      five: { bigIdea: "Leadership is not a title — it's who you are and how you make people better. You lead first by example.", principles: ["The speed of the leader sets the speed of the team.", "Lead yourself well before you try to lead others.", "You attract who you are, not what you want."], wrong: "People try to manage and push their team instead of leading by example and developing people.", oneMission: "Be the standard you want your team to copy — your activity, your attitude, your growth.", today: "Do one thing today that you'd want every person on your team to do." },
      why: "Your team will copy what you DO far more than what you SAY. If you want a team of consistent, positive, growing builders, you have to become that first. Leadership is the multiplier on everything.",
      principle: "Leadership starts with self-leadership and works through example. You don't drive people; you develop them. The team rises to the level of the leader — so the fastest way to grow your team is to grow yourself.",
      beginner: "A leader isn't the person with the biggest title — it's the person others want to follow. And people follow example. If you show up, stay positive, and keep growing, your team catches it. If you complain and slack, they catch that too.",
      example: "A builder wanted her team to attend events, but she skipped them herself. Nobody came. She started attending every event and bringing guests — and slowly her team started showing up too. She didn't lecture them into it; she led them into it.",
      mistakes: ["Pushing and managing instead of leading by example.", "Expecting your team to do what you won't do yourself.", "Trying to lead others before you can lead yourself."],
      application: "In One Mission, you are the thermostat for your team. Your activity, your event attendance, your attitude, your personal development — your people quietly copy all of it. Want a team that follows up and shows up? Be the person who follows up and shows up. Lead by example, then develop.",
      practice: "Ask yourself: 'If everyone on my team copied exactly what I did this week, would I have a strong team?' Write one behavior you'll model this week.",
      action: "Do one thing today you'd want your whole team to copy — an invite, an event RSVP, a personal-development rep.",
      quiz: [{ q: "The core of Jim Rohn's leadership idea is:", options: ["Manage and push your team harder.", "Lead by example and develop people — the team rises to the leader's level.", "Give the best speeches."], correct: 1, why: "Leadership is example and development, not pressure. Teams copy what the leader does, so self-leadership and modeling the standard come first." }],
      resource: [JR],
    },
    {
      id: "jr-longterm", num: 10, title: "Long-Term Thinking", minutes: 6,
      five: { bigIdea: "Most people overestimate what they can do in a month and underestimate what they can do in a few years. Play the long game.", principles: ["Compounding is quiet at first, then dramatic.", "Consistency over years beats intensity over weeks.", "Plant now for a harvest later — and don't dig up the seeds."], wrong: "People expect fast results, get discouraged by the slow start, and quit right before compounding kicks in.", oneMission: "Commit to a season of consistent activity, not a two-week sprint.", today: "Recommit to a realistic time horizon — decide how long you'll build before judging results." },
      why: "The biggest reason people fail isn't lack of ability — it's quitting too early. Long-term thinking keeps you in the game long enough for your skills and your team to compound.",
      principle: "Think in years, not weeks. Skills, relationships, and teams compound — slow at first, then fast. The people who win are usually just the ones who didn't quit during the slow, quiet early phase.",
      beginner: "Planting a fruit tree, you don't dig it up after two weeks because there's no fruit. You water it for seasons. Building One Mission is the same — the early effort looks like nothing, then one day the compounding shows up. Don't dig up your tree.",
      example: "A builder almost quit at month two — 'nothing's happening.' His mentor showed him builders who nearly quit at the same point and stuck it out. He committed to a full year of consistency. By month eight, his team had momentum he couldn't have imagined at month two.",
      mistakes: ["Expecting a big result in the first few weeks.", "Quitting during the slow early phase, right before compounding.", "Judging a long-term business by short-term results."],
      application: "In One Mission, decide your time horizon up front and protect it. Tell yourself: 'I'm building consistently for the next 12 months before I judge this.' That decision alone will carry you past the point where most people quit — and past the point is exactly where it starts to work.",
      practice: "Write down your honest time commitment: 'I will build One Mission consistently for ___ months before judging my results.' Make it long enough to let compounding work.",
      action: "Recommit today to a realistic long-term horizon, in writing.",
      quiz: [{ q: "Why do most people fail at a business like this?", options: ["They lack the ability.", "They quit too early — before consistent activity has time to compound.", "The business doesn't work."], correct: 1, why: "It's rarely ability. Compounding is slow at first, and most people quit during that quiet phase — right before it pays off. Long-term thinking keeps you in past that point." }],
      resource: [JR],
    },
    {
      id: "jr-seasons", num: 11, title: "The Seasons of Life & Business", minutes: 6,
      five: { bigIdea: "Life and business move in seasons. You can't change the seasons, but you can learn to handle each one wisely.", principles: ["Winters (hard times) always come — get stronger, don't wish them away.", "Spring (opportunity) doesn't last — take advantage while you can.", "Summer (growth) requires you to guard and nourish what you've built."], wrong: "People expect it to always be spring, then get crushed when winter comes and quit.", oneMission: "In a slow season, sharpen skills and stay consistent; in a hot season, go all-in.", today: "Name the season you're in — and the wise action for it." },
      why: "You will have hard seasons in this business — slow weeks, rejection, discouragement. Knowing that winters are normal (not a sign to quit) keeps you steady, and knowing springs are temporary keeps you moving when things are good.",
      principle: "Learn to handle the seasons. Winters (difficulty) build strength — you don't quit them, you get stronger through them. Springs (opportunity) are temporary — you act while you can. Summers (growth) must be protected. Handle each season with the right response.",
      beginner: "You know how the year has seasons? Business does too. Some months are cold and slow (winter). Some are full of opportunity (spring). The mistake is expecting it to always be sunny. When you know winter is normal and temporary, you don't panic — you just keep planting.",
      example: "A builder hit a brutal 'winter' — three weeks of no's and low energy. Instead of quitting, she treated it like winter: she used the time to sharpen her invite skills and stay consistent at a lower intensity. When 'spring' returned, she was better prepared than ever and her results jumped.",
      mistakes: ["Expecting it to always be a good season.", "Quitting during a hard season instead of getting stronger.", "Coasting during a good season instead of taking advantage."],
      application: "In One Mission, when you hit a slow season, don't quit — sharpen your skills, stay consistent at whatever level you can, and wait it out like winter. When you hit a hot season (a great event, momentum, a new leader), go all-in like spring. Wise season-handling is what separates lasting builders from quitters.",
      practice: "Identify the season you're in right now (hard/winter, opportunity/spring, growth/summer). Write the wise action for that specific season.",
      action: "Name your current season and take the season-appropriate action today.",
      quiz: [{ q: "You hit a hard, discouraging 'winter' stretch in your business. The wise response is:", options: ["Quit — it's a sign this isn't for you.", "Expect winters as normal, get stronger, and stay consistent until it passes.", "Wait around doing nothing until it feels easier."], correct: 1, why: "Winters are normal and temporary. Professionals don't quit them — they use them to build strength and skill, staying consistent until the season turns." }],
      resource: [JR],
    },
    {
      id: "jr-onemission", num: 12, title: "The One Mission Application", minutes: 6,
      five: { bigIdea: "Personal development is only powerful if you APPLY it. Turn Jim Rohn's philosophy into your daily standard.", principles: ["Learn → apply → track → repeat.", "Your philosophy shows up in your Daily Method.", "Become the leader others want to duplicate."], wrong: "People consume personal development like entertainment and never change a single behavior.", oneMission: "Turn each lesson into one concrete change in your daily activity.", today: "Pick the one Jim Rohn idea that hit hardest and apply it today." },
      why: "Knowledge that doesn't change behavior is just entertainment. This final lesson exists to make sure the philosophy actually moves into your daily building — because that's the only place it creates results.",
      principle: "Application is everything. Take responsibility, sharpen your philosophy, set goals, live by discipline, upgrade associations, become more valuable, focus on activity, communicate well, lead by example, think long-term, handle the seasons — and put all of it to work in One Mission, every day.",
      beginner: "It's simple: don't just learn this, live it. Pick one idea from this foundation and actually do it today. Then another tomorrow. Personal development only 'works' when it changes what you do.",
      example: "A builder finished this foundation and made one change: he did his Daily Method as a discipline (not a mood) before entertainment, every day. That single applied idea — discipline — quietly rebuilt his entire business over 90 days.",
      mistakes: ["Consuming personal development without changing any behavior.", "Trying to apply everything at once and doing none of it.", "Learning as entertainment instead of as a tool."],
      application: "In One Mission, close the loop: LEARN a principle → APPLY it to your Daily Method → TRACK it in your Activity → then TEACH it to your team. That progression — learn, apply, track, teach — is how personal development becomes a bigger paycheck and a bigger you.",
      practice: "Review this foundation and pick the ONE idea that hit hardest. Write exactly how you'll apply it to your building this week.",
      action: "Apply your single most important takeaway from Jim Rohn today.",
      quiz: [{ q: "What makes personal development actually change your business?", options: ["Consuming a lot of it.", "Applying it — turning a principle into a concrete change in your daily activity.", "Quoting it to others."], correct: 1, why: "Knowledge without application is entertainment. The value comes from turning a principle into a daily behavior — learn, apply, track, teach." }],
      resource: [JR],
    },
  ],
  workbook: {
    id: "jim-rohn-workbook",
    title: "One Mission Personal Development Playbook",
    sections: [
      { title: "My Personal Philosophy", fields: [{ id: "philosophy", label: "How I choose to think about business, money, people, and effort" }] },
      { title: "My Goals", fields: [{ id: "goals", label: "My 90-day and 12-month goals (measurable)" }] },
      { title: "My Standards", fields: [{ id: "standards", label: "The standards I hold regardless of how I feel" }] },
      { title: "My Daily Disciplines", fields: [{ id: "disciplines", label: "My daily non-negotiables" }] },
      { title: "My Associations", fields: [{ id: "associations", label: "Who lifts me, who limits me" }] },
      { title: "People I Need More Proximity To", fields: [{ id: "proximity", label: "Leaders I'll get closer to" }] },
      { title: "Habits I Need to Remove", fields: [{ id: "remove", label: "Habits holding me back" }] },
      { title: "Skills I Need to Develop", fields: [{ id: "skills", label: "The skills I'm building next" }] },
      { title: "Books I'm Studying", fields: [{ id: "books", label: "What I'm reading/listening to now" }] },
      { title: "30-Day Discipline Challenge", fields: [{ id: "challenge30", label: "My daily discipline for the next 30 days" }] },
      { title: "90-Day Personal Development Plan", fields: [{ id: "plan90", label: "My growth plan for the next 90 days" }] },
    ],
  },
};

const HE = { label: "T. Harv Eker — Official Site & Free Trainings", url: "https://www.harveker.com/", kind: "site" as const };

// ═══════════════════════════════ MILLIONAIRE MIND (T. HARV EKER) ═══════════════════════════════
const MILLIONAIRE_MIND: Masterclass = {
  id: "millionaire-mind",
  teacher: "T. Harv Eker",
  book: "Secrets of the Millionaire Mind",
  title: "Secrets of the Millionaire Mind — Money Mindset Study",
  subtitle: "Rewire the quiet money beliefs that drive your behavior in business.",
  category: "Money",
  accent: "#059669",
  minutes: "60–80 min",
  overview:
    "Most people's results with money are set long before they ever start a business — by a 'money blueprint' they absorbed growing up. This study helps you find your blueprint, keep the beliefs that serve you, rewrite the ones that don't, and connect it all to how you actually behave building One Mission. Explained in original One Mission language — no book reproduced.",
  original: [HE],
  lessons: [
    {
      id: "mm-blueprint", num: 1, title: "Your Money Blueprint", minutes: 8,
      five: { bigIdea: "You have a money 'thermostat' set in childhood. If your beliefs are set to 'struggle,' your behavior quietly keeps you there — no matter how good the opportunity.", principles: ["Your money beliefs came from what you saw and heard growing up.", "Behavior follows belief — you act out your blueprint automatically.", "You can identify and reset your blueprint on purpose."], wrong: "People try to change their income without changing the beliefs that control their behavior around money.", oneMission: "Notice how your money beliefs show up in your building — do you avoid talking about the opportunity, apologize, or shrink?", today: "Write down 3 money phrases you heard growing up." },
      why: "Your beliefs about money silently drive whether you take action, how you talk about the opportunity, and whether you follow up. Fix the belief and the behavior changes — often without willpower.",
      principle: "Your 'money blueprint' is the set of beliefs about money you absorbed early in life. It acts like a thermostat: no matter what happens, your behavior tends to return you to the level your blueprint is set to. The first step to change is awareness — seeing your blueprint clearly.",
      beginner: "Think of a thermostat set to 68°. Open a window, it heats back up; turn on the AC, it cools back down — it always returns to 68. Your money mind works the same. If it's 'set' to struggle, you'll unconsciously return there. Awareness lets you reset the dial.",
      example: "A builder grew up hearing 'money is hard' and 'don't talk about money — it's rude.' As an adult, she avoided ever mentioning the opportunity and apologized when she did. She wasn't lazy — she was running an old blueprint. Once she SAW it, she could start rewriting it.",
      mistakes: ["Trying to change income while ignoring the beliefs driving your behavior.", "Assuming your struggle is about effort when it's often about belief.", "Never examining where your money beliefs came from."],
      application: "In One Mission, your blueprint shows up as behavior: Do you confidently share the opportunity, or hide it? Do you follow up, or avoid it because 'I don't want to bother people about money'? This whole study exists to find those hidden beliefs and rewrite the ones sabotaging your building.",
      practice: "Use the interactive Money Blueprint exercise below: write the money phrases and beliefs you heard growing up, then we'll examine whether each one is helping or hurting your building.",
      action: "Write down 3 things you heard about money growing up, and one way each might be affecting your business today.",
      quiz: [{ q: "What is a 'money blueprint'?", options: ["Your bank balance.", "The set of money beliefs from childhood that quietly drives your behavior.", "A budgeting spreadsheet."], correct: 1, why: "It's your inner beliefs about money, mostly set early in life, that act like a thermostat controlling your behavior around money — including how you build a business." }],
      resource: [HE],
    },
    {
      id: "mm-responsibility", num: 2, title: "Responsibility vs Victim", minutes: 7,
      five: { bigIdea: "Rich-minded people take responsibility for their financial life; victim-minded people blame, justify, and complain.", principles: ["Blame, justify, complain = the three habits of a stuck money mind.", "You can't fix what you won't own.", "Responsibility is power over your financial future."], wrong: "People blame the economy, their job, or their upline instead of owning their financial results.", oneMission: "Own your income-producing activity — it's the part you control.", today: "Catch yourself blaming, justifying, or complaining once — and replace it with ownership." },
      why: "If your money situation is always someone else's fault, you're powerless to change it. Responsibility puts you back in control — and control is where change starts.",
      principle: "A wealthy mindset takes responsibility; a poor mindset plays victim through blaming, justifying, and complaining. Owning your financial results — even the uncomfortable ones — is what gives you the power to change them.",
      beginner: "A victim mindset says 'it's not my fault' about money — the economy, the boss, bad luck. A responsible mindset says 'what can I do about it?' The first feels safe but keeps you stuck. The second feels harder but sets you free.",
      example: "A builder complained the 'economy' was why nobody joined. His mentor asked what HE could control: his activity, his skill, his follow-up. He stopped blaming and started owning — sent more invites, sharpened his approach — and his results moved. The economy didn't change; his ownership did.",
      mistakes: ["Blaming outside forces for your financial results.", "Justifying why you can't (instead of asking how you could).", "Complaining, which attracts more to complain about."],
      application: "In One Mission, notice the three victim habits — blame, justify, complain — and replace them with ownership: 'What's my next income-producing action?' You control your activity, your skill, your consistency. Own those and your financial results follow.",
      practice: "For the next day, catch every time you blame, justify, or complain about money or results. Each time, replace it with: 'What can I own and do here?'",
      action: "Replace one blame/justify/complain moment with an ownership action today.",
      quiz: [{ q: "The three habits of a victim money mindset are:", options: ["Save, invest, budget.", "Blame, justify, complain.", "Learn, apply, grow."], correct: 1, why: "Blaming, justifying, and complaining keep you powerless. Taking responsibility for your financial results is what puts change back in your hands." }],
      resource: [HE],
    },
    {
      id: "mm-bigger", num: 3, title: "Think Bigger & Create Value", minutes: 7,
      five: { bigIdea: "Your income grows in proportion to the value you deliver to the number of people you serve. Think bigger about who you can help.", principles: ["Focus on serving and solving, not just earning.", "Reach more people with more value.", "The size of your problem you solve = the size of your reward."], wrong: "People focus on getting instead of giving, and stay small by only thinking about themselves.", oneMission: "Ask 'how many people can I help?' not just 'how much can I make?'", today: "Reframe your goal around value and people served." },
      why: "A money mind stuck on 'getting' stays small. When you shift to 'how many people can I genuinely help, and how well?', both your impact and your income have room to grow.",
      principle: "Wealth follows value delivered at scale. Instead of focusing only on what you can get, focus on the value you create and the number of people you serve. Bigger thinking about service leads to bigger results.",
      beginner: "Imagine two food trucks. One thinks, 'How do I squeeze more money from each customer?' The other thinks, 'How do I serve more people something they love?' Over time, the second one wins — bigger value, more people, more reward.",
      example: "A builder focused only on his own commission and stayed stuck. He shifted to 'how many people can I actually help build a better life?' He started genuinely serving his prospects and team — and ironically, focusing on value grew his results more than focusing on money ever did.",
      mistakes: ["Focusing on getting instead of giving.", "Thinking small about who you could help.", "Making it about your commission instead of their outcome."],
      application: "In One Mission, reframe from 'how much can I make?' to 'how many people can I genuinely help — as customers who love the product and builders who want more?' Serve at scale, ethically, and the income follows the value. Never with hype or income promises — with real help.",
      practice: "Rewrite your goal in terms of value and people: 'I want to help ___ people get ___.' Notice how it changes your energy and your posture.",
      action: "Reframe one goal today around people served and value delivered.",
      quiz: [{ q: "According to a millionaire mindset, income tends to grow with:", options: ["How little you can give while getting the most.", "The value you deliver and the number of people you serve.", "How much you talk about money."], correct: 1, why: "Wealth follows value delivered at scale. Focusing on serving more people with more value — not just getting — is what creates bigger, lasting results." }],
      resource: [HE],
    },
    {
      id: "mm-reframe", num: 4, title: "Rewrite a Limiting Money Belief", minutes: 8,
      five: { bigIdea: "You can consciously replace a limiting money belief with an empowering one — and change the behavior it was driving.", principles: ["Old belief → new belief → new action.", "Beliefs aren't facts; they're just thoughts you've repeated.", "New action, repeated, installs the new belief."], wrong: "People try to force new behavior while still believing the old thing — so they snap back.", oneMission: "Reframe the belief 'I'm bothering people' into 'I'm offering a look and letting them decide.'", today: "Complete one full belief-reframe below." },
      why: "This is where the money mindset work turns into real behavior change. When you rewrite the belief underneath a bad habit, the new habit becomes natural instead of forced.",
      principle: "Beliefs drive behavior, and beliefs can be changed. The process: identify the old belief, decide if it's helping you, write a truer/empowering belief, and choose a new action that proves it. Repeat the action until the new belief sticks.",
      beginner: "A belief is just a thought you've thought so many times it feels like a fact. 'I'm bothering people when I talk about my business' isn't a fact — it's a thought. You can swap it for 'I'm offering people a look and letting them decide,' then act on the new one until it feels true.",
      example: "A builder believed 'I'm bothering people.' Result: she avoided invites, apologized in presentations, never followed up. She reframed it: 'I'm sharing something valuable and respecting their choice.' New action: send 5 invites with confidence. After two weeks of the new action, the new belief felt normal — and her business moved.",
      whatToSay: [{ label: "The reframe, applied", text: "Instead of 'Sorry to bother you with this...' → 'Hey, I'm working on something and thought of you — no pressure at all, but would you be open to a quick look?'" }],
      mistakes: ["Trying to change behavior without changing the belief underneath it.", "Treating beliefs as unchangeable facts.", "Not repeating the new action long enough for the belief to stick."],
      application: "Here's a classic One Mission example: the belief 'I'm bothering people when I talk about business' leads to avoiding invitations, apologizing during presentations, never following up, and hiding your business. Rewrite it to 'I'm offering people a look at something that could help, and letting them decide' — then take the confident action until it's true.",
      practice: "Complete the interactive reframe: OLD BELIEF (what you tell yourself) → IS IT HELPING YOU? → NEW BELIEF (truer, empowering) → NEW ACTION (what you'll do to prove it). Do this for your biggest money/business belief.",
      action: "Complete one full belief-reframe today and take the new action.",
      quiz: [{ q: "A builder believes 'I'm bothering people when I talk about my business.' This most likely causes them to:", options: ["Confidently invite and follow up.", "Avoid invitations, apologize, and never follow up.", "Become a great closer."], correct: 1, why: "Beliefs drive behavior. That limiting belief produces avoidance, apologizing, and no follow-up. Rewriting it to an empowering belief — and acting on it — changes the behavior." }],
      resource: [HE],
    },
    {
      id: "mm-manage", num: 5, title: "Manage & Grow", minutes: 7,
      five: { bigIdea: "It's not just how much you make — it's how you manage it and how you keep growing. Wealthy habits are learnable.", principles: ["Manage the money you have well, at any level.", "Keep learning and growing your financial skills.", "Successful people admire success and learn from it."], wrong: "People wait to manage money 'once they make more,' and resent successful people instead of learning from them.", oneMission: "Reinvest in your skills (the Academy, events) — you are your best asset.", today: "Name one financial skill you'll grow, and one successful person you'll learn from." },
      why: "A bigger income won't help a mindset that resents wealth or can't manage money. Building wealthy habits — managing well and always learning — makes whatever you earn go further and grow.",
      principle: "Wealthy behavior includes managing money well at every level, continuously growing your financial education, and admiring (rather than resenting) success so you can learn from it. These are habits, not personality traits — you can build them starting now.",
      beginner: "You don't wait until you're rich to act wealthy-minded. You manage the money you have now, keep learning, and instead of being jealous of successful people, you study them. Those habits are what create wealth in the first place.",
      example: "A builder used to resent 'rich people.' His mentor pointed out that resenting what you want pushes it away. He started admiring and studying successful builders instead — their habits, their consistency — and adopting them. His mindset (and results) shifted.",
      mistakes: ["Waiting to manage money until you 'make more.'", "Resenting successful people instead of learning from them.", "Stopping your financial education."],
      application: "In One Mission, your #1 asset is YOU. Reinvest in your skills — the Academy, events, personal development. Admire and study the leaders ahead of you instead of envying them. And build the habit of managing well now, at whatever level you're at, so growth has somewhere to land.",
      practice: "Name one financial or business skill you'll grow this month, and one successful person (in or out of One Mission) whose habits you'll study.",
      action: "Take one action today to grow your value — a lesson, an event RSVP, or reinvesting in a skill.",
      quiz: [{ q: "A healthy money mindset toward successful people is to:", options: ["Resent them for having what you want.", "Admire and study them to learn their habits.", "Ignore them completely."], correct: 1, why: "Resenting what you want repels it. Admiring and learning from successful people lets you adopt the habits that created their results — a core wealthy-mind behavior." }],
      resource: [HE],
    },
  ],
  workbook: {
    id: "millionaire-mind-workbook",
    title: "One Mission Money Mindset Workbook",
    sections: [
      { title: "My Money Story", fields: [{ id: "story", label: "How money was talked about and handled in my home growing up" }] },
      { title: "My Current Money Beliefs", fields: [{ id: "beliefs", label: "What I currently believe about money and earning" }] },
      { title: "Where They Came From", fields: [{ id: "origins", label: "The people/experiences that shaped these beliefs" }] },
      { title: "Beliefs That Help Me", fields: [{ id: "helping", label: "Beliefs worth keeping" }] },
      { title: "Beliefs That Hurt Me", fields: [{ id: "hurting", label: "Beliefs to rewrite" }] },
      { title: "My New Money Rules", fields: [{ id: "rules", label: "The empowering beliefs I'm choosing" }] },
      { title: "Income Goals", fields: [{ id: "income", label: "My income goals (and the value/activity behind them)" }] },
      { title: "Skill Development Goals", fields: [{ id: "skills", label: "The skills I'll grow to increase my value" }] },
      { title: "Value I Can Create", fields: [{ id: "value", label: "The value I can deliver to customers and builders" }] },
      { title: "My Financial Education Plan", fields: [{ id: "education", label: "How I'll keep learning about money and business" }] },
      { title: "My 30-Day Money Mindset Challenge", fields: [{ id: "challenge", label: "My daily money-mindset practice for 30 days" }] },
    ],
  },
};


// ═══════════════════════════════ RICHDAD ═══════════════════════════════
const RD_YT = { label: "The Rich Dad Channel — Official YouTube", url: "https://www.youtube.com/@TheRichDadChannel", kind: "watch" as const };
const RD_SITE = { label: "Rich Dad — Official Site (books & free resources)", url: "https://www.richdad.com/", kind: "site" as const };

// ═══════════════════════════════ RICH DAD POOR DAD ═══════════════════════════════
const RICH_DAD: Masterclass = {
  id: "rich-dad",
  teacher: "Robert Kiyosaki",
  book: "Rich Dad Poor Dad",
  title: "Rich Dad Poor Dad — Money & Assets Study",
  subtitle: "Learn how the wealthy think about money, assets, and building income.",
  category: "Money",
  accent: "#d97706",
  minutes: "50–75 min",
  overview:
    "Robert Kiyosaki made a simple idea famous: most people are taught to work hard for money, but very few are ever taught how money actually works. This is original One Mission training built on those professional concepts — it is not the book reproduced. Over seven lessons you'll learn to tell an asset from a liability, understand where income really comes from, and treat your One Mission business as something you build and own. Nothing here is investment advice or a promise of results — it is financial education you apply to the way you think and work.",
  original: [RD_YT, RD_SITE],
  lessons: [
    {
      id: "rd-assets",
      num: 1,
      title: "Assets vs Liabilities",
      minutes: 10,
      five: {
        bigIdea: "There is one distinction that changes everything: an asset puts money in your pocket, and a liability takes money out. The rich buy and build assets; most people buy liabilities they think are assets.",
        principles: [
          "An asset feeds you; a liability eats you.",
          "It's not what you buy — it's which direction the money flows.",
          "The path to freedom is simple: keep growing the asset column.",
        ],
        wrong: "Most people call things like a new car, the latest phone, or a bigger monthly payment 'assets' — but if it takes money out of their pocket every month, it's a liability wearing a nicer name.",
        oneMission: "See your One Mission skills and your growing customer/team activity as assets you're building — things that can keep producing — not a one-time purchase.",
        today: "Write two columns — Assets and Liabilities — and honestly place five things you own or pay for in the right column.",
      },
      why: "This matters because you can earn a good income your whole life and still feel broke if every dollar flows straight back out. When you finally see the difference between something that pays you and something that bills you, money stops being a mystery. You stop feeling guilty about money and start making calmer, clearer decisions — because you have a rule to measure every choice against.",
      principle: "An asset is anything that puts money into your pocket. A liability is anything that takes money out of your pocket. The rich focus their energy on the asset column — they acquire or build things that produce income — while keeping liabilities low. Wealth isn't about how much you make; it's about how much you keep and how many things you own that keep producing without you.",
      beginner: "Think of your money like a bucket of water. An asset is a hose that pours water into the bucket. A liability is a small hole in the bottom that lets water drain out. It doesn't matter how much you pour in the top if there are ten holes in the bottom — you'll always feel empty. Rich thinking means adding more hoses and patching the holes, not just pouring faster.",
      example: "New builder Ana felt like she was 'bad with money.' Her coach had her list everything she paid for each month. She'd always called her financed car an 'asset,' but once she saw it drained money every single month, she moved it to the liability column. Then she noticed something small in the asset column: a skill she was learning that could actually produce income over time. Nothing about her paycheck changed that day — but the way she saw her money changed completely, and she started making choices that grew the left column instead of the right.",
      whatToSay: [
        { label: "Explaining the idea simply", text: "The way I think about money now is really simple — does this thing put money in my pocket or take it out? That one question changed how I make decisions." },
        { label: "Framing it as education", text: "This isn't about get-rich-quick — it's just financial education. It's learning the difference between something that pays you and something that costs you." },
      ],
      whatNotToSay: [
        "\"Do this and you'll be rich.\" (That's an income claim and a promise nobody can make.)",
        "\"Your house/car is definitely an asset.\" (If it drains money monthly, calling it an asset just hides the truth.)",
        "\"Money problems mean you're bad with money.\" (Usually it just means nobody taught you how money flows.)",
      ],
      mistakes: [
        "Calling liabilities 'assets' because they feel valuable or look impressive.",
        "Focusing only on earning more while ignoring how much drains out each month.",
        "Buying liabilities first and hoping to buy assets 'someday' with what's left.",
      ],
      application: "In One Mission, the temptation is to spend on things that look like progress but drain money. Rich Dad thinking says: put your energy into the asset column. Your growing skills, your consistent daily activity, and the relationships you build are the things that can keep producing. Treat your business as an asset you're building patiently, not a slot machine you feed and hope pays out.",
      practice: "Draw two columns on a page: Assets (puts money in) and Liabilities (takes money out). List everything you can think of that you own or pay for. For anything you're unsure about, ask the one question: which direction does the money flow? Be honest, especially about the things that felt like assets.",
      action: "Complete your two-column list today and circle one liability you could reduce and one asset you could grow.",
      quiz: [
        {
          q: "You're deciding whether something is an asset or a liability. What's the single best question to ask?",
          options: [
            "How much did it cost when I bought it?",
            "Does it put money in my pocket, or take money out?",
            "Does it look valuable to other people?",
          ],
          correct: 1,
          why: "The whole distinction comes down to cash flow direction. Cost and appearance don't decide it — an expensive, impressive thing that drains money every month is still a liability.",
        },
        {
          q: "Which of these best reflects Rich Dad thinking about building wealth?",
          options: [
            "Earn as much as possible and spend it on nicer things.",
            "Keep growing the asset column — things that can keep producing.",
            "Avoid ever spending money on anything.",
          ],
          correct: 1,
          why: "Wealth comes from steadily building the asset column, not just earning more or refusing to spend. The focus is on owning things that produce.",
        },
      ],
      resource: [RD_SITE],
    },
    {
      id: "rd-cashflow",
      num: 2,
      title: "The Cashflow Quadrant (E/S/B/I)",
      minutes: 11,
      five: {
        bigIdea: "There are four places income comes from: Employee, Self-employed, Business owner, and Investor. The left side (E and S) trades time for money; the right side (B and I) builds things that produce money — and that's where income can scale beyond your own hours.",
        principles: [
          "E and S get paid for their time; B and I get paid for what they build and own.",
          "Moving right isn't about working less — it's about building something that keeps working.",
          "You can start on the left and build toward the right at the same time.",
        ],
        wrong: "Most people believe the only way to earn more is to work more hours or get a raise — so they stay trapped on the left side, where income always has a ceiling set by their own time.",
        oneMission: "A One Mission builder is learning to move from 'E' (a job that pays for hours) toward 'B' (building a business system) — while keeping their job as a foundation.",
        today: "Circle which quadrant most of your income comes from today, and write which quadrant you're moving toward.",
      },
      why: "This matters because knowing where your income comes from tells you why you feel the way you do about money. If all your income is from trading hours, stopping means the money stops — that's stressful, and it's normal. Understanding the quadrants gives you a map. You stop feeling stuck and start seeing that there's a direction you can move, patiently, over time — without quitting anything or gambling anything.",
      principle: "Income comes from four quadrants. Employees have a job and earn a wage. The Self-employed own a job — they still get paid mainly for their own effort. Business owners build a system and a team that produces whether or not they personally show up. Investors put money to work so it produces income. The left side (E, S) is limited by your own time and energy; the right side (B, I) can scale because it's built on systems and ownership rather than hours.",
      beginner: "Imagine four people cutting lawns. The Employee gets paid by the hour to push the mower. The Self-employed owns the mower and keeps the profit, but if they don't push it, nothing happens. The Business owner builds a crew and a system so lawns get cut even when they're home sick. The Investor owns a share of the lawn company and earns from it without touching a mower. Same industry — four completely different relationships with time and money.",
      example: "New builder Marcus worked a full-time job (the Employee quadrant) and felt like his income would only ever grow by begging for raises. When he learned the quadrant map, nothing about his job changed — but his thinking did. He kept his paycheck as a foundation and started, in his spare time, learning to build something with a system behind it. He wasn't quitting or gambling; he was simply beginning to move to the right, one small skill at a time.",
      whatToSay: [
        { label: "Explaining the map", text: "There's a simple way to look at where income comes from — a job, working for yourself, building a business, or investing. I've just been learning to move a little toward the 'build a business' side, without quitting anything." },
        { label: "Keeping it grounded", text: "This isn't about ditching your job. It's about understanding that some income comes from your hours and some comes from what you build — and slowly building the second kind." },
      ],
      whatNotToSay: [
        "\"Quit your job, it's the only way.\" (Reckless and untrue — you can build alongside a job.)",
        "\"The business side means easy money.\" (Building a system is real work; there are no guarantees.)",
        "\"Employees are losers.\" (A job is a smart, honest foundation many builders keep.)",
      ],
      mistakes: [
        "Believing the only path to more income is more hours.",
        "Thinking you must quit the left side before building on the right.",
        "Assuming the 'B' quadrant means no work — it means different work, building systems.",
      ],
      application: "One Mission is a way to practice moving from E toward B. You keep your job as a stable base while you learn to build a business with systems and duplication behind it. You're not trading your paycheck for a gamble — you're adding a new skill set that, over time, is built on what you create rather than only the hours you sell. That's the quadrant shift in real life.",
      practice: "Draw the four quadrants (E, S, B, I). Mark where each source of your income comes from today with an X. Then draw an arrow to the quadrant you'd like to move toward, and write one small skill that would help you move that direction this month.",
      roleplay: { scenario: "Explaining the opportunity as building an asset", opener: "Wait, so is this just another job? Because I already have one of those." },
      action: "Map your income onto the four quadrants today and write down the one quadrant you're moving toward.",
      quiz: [
        {
          q: "A friend says the only way they can earn more is to work more overtime. Which quadrant thinking is this, and what would you gently offer?",
          options: [
            "Business-owner thinking — they've already got a system.",
            "Left-side (E) thinking — income tied to hours; they could also start building something on the right side over time.",
            "Investor thinking — their money is working for them.",
          ],
          correct: 1,
          why: "Trading more hours for more pay is classic left-side (Employee) thinking, where income is capped by time. The Rich Dad idea is that you can begin building toward the right side without quitting anything.",
        },
      ],
      resource: [RD_YT],
    },
    {
      id: "rd-financial-education",
      num: 3,
      title: "Financial Education (Financial IQ)",
      minutes: 10,
      five: {
        bigIdea: "Schools mostly teach you to be a good employee — to work for money. Very few teach you how money actually works. Financial IQ is a skill you can build, and choosing to learn it is the real head start.",
        principles: [
          "Working for money is taught everywhere; making money work is taught almost nowhere.",
          "Financial IQ is learned, not inherited — anyone can start.",
          "The best investment is in your own financial education first.",
        ],
        wrong: "Most people assume that being smart in school or good at their job means they're good with money — but those are different skills, and no one ever taught them the second one.",
        oneMission: "Use every lesson, book, and mentor around your One Mission journey to raise your financial IQ — treat learning as the first asset you build.",
        today: "Choose one book, channel, or lesson on how money works and spend 15 minutes with it today.",
      },
      why: "This matters because it removes shame and replaces it with responsibility. If you've ever felt behind with money, it's usually not because you're dumb — it's because this subject simply wasn't taught. The moment you realize financial IQ is a skill you can build, you stop feeling stuck and start feeling capable. Learning becomes the one thing fully in your control, no matter your starting point.",
      principle: "Traditional education is excellent at preparing people to work for money — to be reliable employees — but it rarely teaches how money works: how income, expenses, assets, and liabilities interact, and how the wealthy think. Financial IQ is a learnable skill. Committing to your own financial education, a little at a time, is the foundation every other money skill is built on. You invest in your mind before anything else.",
      beginner: "Think about learning to drive. Nobody expects to get in a car and just know how — you take lessons, you practice, you get better. Money is the same. Feeling lost with money doesn't mean you're incapable; it means you haven't had the lessons yet. Financial education is simply signing up for the lessons nobody gave you in school.",
      example: "New builder Ana used to avoid anything about money because it made her feel dumb. Her coach reframed it: 'You were never taught this — that's not your fault, but learning it now is your choice.' Ana committed to fifteen minutes a day — a chapter, a video, a lesson. Within a few weeks she wasn't an expert, but she understood words that used to scare her, and for the first time money felt like a subject she could actually learn rather than a wall she kept hitting.",
      whatToSay: [
        { label: "Removing the shame", text: "Honestly, most of us were never taught how money works — it's just not in the school curriculum. I've started treating it like any other skill I can learn." },
        { label: "Inviting someone to learn with you", text: "I've been learning about how money actually works — not a program or a pitch, just education. Want me to send you something I found helpful?" },
      ],
      whatNotToSay: [
        "\"If you were smart you'd already know this.\" (Shaming — this simply wasn't taught to most people.)",
        "\"Learn this one trick and you'll never worry about money.\" (There are no tricks or guarantees.)",
        "\"You need to buy an expensive course right now.\" (Plenty of great financial education is free.)",
      ],
      mistakes: [
        "Assuming being good at your job means being good with money.",
        "Avoiding the subject because it feels intimidating or shameful.",
        "Waiting to 'have money' before learning about money — the learning comes first.",
      ],
      application: "One Mission gives you a built-in reason to raise your financial IQ. Every masterclass, book recommendation, and mentor is a chance to learn how money and business actually work. Treat that learning as the first asset you're building. A builder who commits fifteen minutes a day to financial education makes calmer, wiser decisions in every other part of the journey — and can teach what they learn to the people they help.",
      practice: "Pick one trustworthy source about how money works — a book, an official channel, or a lesson. Set a daily fifteen-minute learning window for the next week. Each day, write down one sentence you learned in your own words. At the end of the week, read your seven sentences back.",
      action: "Choose your one financial-education source and complete your first 15-minute session today.",
      quiz: [
        {
          q: "Someone says, 'I'm just bad with money — I've always been.' What's the most helpful Rich Dad response?",
          options: [
            "\"Yeah, some people just aren't money people.\"",
            "\"Financial IQ is a skill almost no one was taught — it can be learned, starting now.\"",
            "\"Buy this expensive course and you'll be fixed.\"",
          ],
          correct: 1,
          why: "The core idea is that financial intelligence is learnable, not something you're born with or without. Reframing it as a skill removes shame and puts the person back in control — without any pressure or false promises.",
        },
      ],
      resource: [RD_YT],
    },
    {
      id: "rd-fear",
      num: 4,
      title: "Overcoming Fear & Doubt",
      minutes: 10,
      five: {
        bigIdea: "Fear and self-doubt are the real reasons most people stay exactly where they are. Everyone feels them — the difference is that some people act anyway, in small steps, instead of waiting for the fear to disappear.",
        principles: [
          "Fear is normal and permanent — courage is acting while you still feel it.",
          "The fear of losing or looking foolish keeps most people from ever starting.",
          "Small, repeated actions shrink fear faster than thinking about it does.",
        ],
        wrong: "Most people wait to 'feel ready' or 'feel confident' before they act — but confidence comes from doing the thing, so waiting for it guarantees they never start.",
        oneMission: "Use One Mission's roleplays and low-stakes practice to act despite fear — reps, not readiness, build your courage.",
        today: "Name the one fear that's holding you back in writing, then take one two-minute action in its direction.",
      },
      why: "This matters because fear disguises itself as logic. It whispers 'be practical,' 'wait until later,' 'you're not ready' — and it sounds so reasonable that people obey it for years. When you learn to recognize fear for what it is, you stop letting it make your decisions in disguise. You'll still feel it. But you'll know that the feeling is not a stop sign — it's just a feeling, and you're allowed to move anyway.",
      principle: "Fear of losing money, fear of failing, and fear of looking foolish keep most people from ever building anything. The rich feel the same fears — they simply don't let fear be the final word. Courage isn't the absence of fear; it's taking a small, sensible action while the fear is still present. And because confidence is a result of action rather than a prerequisite for it, the only way past fear is through repeated, manageable steps.",
      beginner: "Think about the first time you swam in the deep end. Standing at the edge, the fear felt huge. But you didn't wait until you weren't scared — you jumped, and after a few times it barely registered. Fear shrinks when you move toward it and grows when you sit still and stare at it. Action is the only thing that ever actually made the deep end feel smaller.",
      example: "New builder Marcus froze every time he thought about reaching out to someone. His fear told him a very believable story: 'You'll bother them, you'll look stupid, wait until you know more.' His coach didn't try to remove the fear — she gave him a two-minute action: send one simple message to one friendly person. He did it, hands shaking. Nothing bad happened. The next one was easier. The fear never fully vanished, but it stopped being in charge.",
      whatToSay: [
        { label: "Being honest about fear", text: "I felt nervous starting this too — that's normal. I just decided not to wait until the nerves were gone, because they never fully go." },
        { label: "Encouraging someone stuck", text: "You don't have to feel ready. Just take one tiny step — the confidence shows up after you move, not before." },
      ],
      whatNotToSay: [
        "\"Just don't be scared.\" (Unhelpful — fear doesn't work that way.)",
        "\"There's zero risk, you literally can't lose.\" (False reassurance and a claim you can't make.)",
        "\"If you were braver you'd already be rich.\" (Shaming and an income claim in one.)",
      ],
      mistakes: [
        "Waiting to 'feel ready' or confident before taking any action.",
        "Mistaking fear's excuses for logical, practical reasons.",
        "Taking one scary leap and quitting, instead of many small, repeatable steps.",
      ],
      application: "One Mission is built for acting despite fear in low-stakes ways. The roleplays let you practice a nervous conversation with no real risk. Your first outreach can be to a friendly, easy person. Every small rep tells your brain 'that wasn't so bad,' and the fear loosens its grip. You don't conquer fear before you start building — you build, in small steps, and the courage grows as you go.",
      practice: "Write down the single fear most in your way right now (looking foolish, being rejected, losing time). Under it, write the smallest possible action that moves toward it — something you could do in two minutes. Then do that action today and write one sentence about how you actually felt afterward versus how you feared you'd feel.",
      roleplay: { scenario: "Explaining the opportunity as building an asset", opener: "I don't know... I'm not really the type who's good at this kind of thing. What if I fail?" },
      action: "Name your biggest fear on paper and take one two-minute action toward it today.",
      quiz: [
        {
          q: "You feel afraid to make your first outreach and keep telling yourself you'll do it 'once you feel ready.' What does Rich Dad thinking suggest?",
          options: [
            "Wait until the fear is completely gone, then act.",
            "Take one small action now — confidence comes from doing, not from waiting.",
            "Accept that some people just aren't cut out for it.",
          ],
          correct: 1,
          why: "Confidence is a result of action, not a requirement for it. Waiting to feel ready means waiting forever. A small, manageable step taken while still afraid is exactly how courage is built.",
        },
      ],
      resource: [RD_YT],
    },
    {
      id: "rd-mind-your-business",
      num: 5,
      title: "Mind Your Own Business",
      minutes: 10,
      five: {
        bigIdea: "Most people spend their whole lives minding someone else's business — building an employer's dream. 'Mind your own business' means building or acquiring income-producing assets of your own, alongside your job, even while you earn a wage.",
        principles: [
          "Your profession pays the bills; your business is what you build on the side.",
          "Keep your day job — and quietly grow your own asset column too.",
          "Reinvest a little from your wage into building something you own.",
        ],
        wrong: "People confuse their profession with their business — they think their job is their business, so all their building energy goes into making someone else wealthier.",
        oneMission: "Treat your One Mission activity as your 'own business' you build beside your job — steadily, without quitting your paycheck.",
        today: "Write one specific thing you'll do this week to build your own business, separate from your job.",
      },
      why: "This matters because it's easy to spend forty hours a week making someone else's dream bigger and never spend a single focused hour on your own. There's nothing wrong with a job — it's a smart foundation. But if you never mind your own business too, you'll always be building only the employer's asset column. Learning this frees you to keep your paycheck and still build something that's yours, on the side, patiently.",
      principle: "There's a difference between your profession (what you do for a paycheck) and your business (what you build and own). Minding your own business means keeping your day job for stability while you build or acquire income-producing assets of your own on the side. You don't have to quit or gamble — you simply stop pouring one hundred percent of your building energy into someone else's asset column and start directing some of it into your own.",
      beginner: "Imagine two employees at the same company. One goes home and watches TV every night, building nothing of their own. The other keeps the same job but spends a little time each evening learning a skill and building a small side project they own. Ten years later they've had the same paycheck — but only one of them also owns something. Minding your own business is just choosing to be the second employee.",
      example: "New builder Ana kept her full-time job — she needed the stability and there was nothing wrong with that. But instead of pouring all her energy into only her employer, she carved out a small, steady window each week to build her own thing through One Mission. She wasn't reckless; she wasn't quitting. She was simply making sure that, alongside building her employer's business, she was finally building a little of her own too.",
      whatToSay: [
        { label: "Explaining the idea", text: "I still have my job — I'm not quitting anything. I've just started building a little something of my own on the side, so all my effort isn't going into only one place." },
        { label: "Framing it as an asset", text: "Think of it like this: my job pays the bills, and this is a business I'm building alongside it — something that could keep producing over time." },
      ],
      whatNotToSay: [
        "\"Quit your job and go all in.\" (Reckless — the whole point is to build alongside your paycheck.)",
        "\"This replaces your income fast.\" (An earnings claim no one can make.)",
        "\"Your job is a waste of time.\" (It's a smart, stabilizing foundation.)",
      ],
      mistakes: [
        "Confusing your profession (the job) with your business (what you own).",
        "Putting one hundred percent of your building energy into an employer and none into yourself.",
        "Thinking you must quit your job to start minding your own business.",
      ],
      application: "One Mission is designed to be the 'own business' you build beside your job. You keep the stability of your paycheck and, in the margins, you build skills, relationships, and activity that are yours. Reinvest a little of your time and, sensibly, a little of your resources into growing it. You're not betting your security — you're making sure some of your effort each week finally goes into your own asset column, not only someone else's.",
      practice: "List where your building energy currently goes each week — job, chores, entertainment, and so on. Estimate the hours. Then find one small, realistic window (even two hours) you could redirect into building your own business through One Mission. Write down exactly when that window is on your calendar.",
      action: "Block one specific time this week to work on your own business, and write down what you'll do in it.",
      quiz: [
        {
          q: "What does 'mind your own business' actually mean in Rich Dad thinking?",
          options: [
            "Quit your job immediately and go all-in on something new.",
            "Keep your job for stability while you build income-producing assets of your own on the side.",
            "Stop caring about your employer and coast at work.",
          ],
          correct: 1,
          why: "The idea is to keep the stability of your profession while deliberately building your own asset column alongside it — not to quit, gamble, or slack off. Your business is what you build and own, in addition to your job.",
        },
      ],
      resource: [RD_SITE],
    },
    {
      id: "rd-systems",
      num: 6,
      title: "Systems & Leverage",
      minutes: 11,
      five: {
        bigIdea: "The rich build or buy systems that keep working without them. A system plus other people's effort is called leverage — it's how a small amount of your time can produce far more than your own two hands ever could.",
        principles: [
          "A system is a repeatable process that works whether or not you're present.",
          "Leverage means results grow through duplication, not just harder personal effort.",
          "Build it once, then teach it — so it runs and multiplies.",
        ],
        wrong: "Most people try to do everything themselves by hand, so their results are always capped by their own time and energy — when they stop, everything stops.",
        oneMission: "Follow One Mission's proven systems and teach them simply, so your team can duplicate what you do instead of depending on you.",
        today: "Write down one repeatable task you do and how you could turn it into a simple system others could copy.",
      },
      why: "This matters because personal effort has a hard ceiling. There are only twenty-four hours in a day, and you can only push so hard. If everything depends on you personally, you've built a job, not a business — and you can never rest. Systems and leverage lift that ceiling. When you learn to build something repeatable and teachable, your results stop being limited to what your own two hands can do in a day.",
      principle: "A system is a repeatable process that produces a result reliably, whether or not the founder is personally involved. Leverage is using systems and other people's coordinated effort to multiply results beyond your own capacity. The rich either build systems (like a business owner) or buy into them (like a franchise or an investment), then duplicate them. The goal is a process that works without you — one you can teach so it multiplies through others.",
      beginner: "Think of a good pizza chain. Any location makes the same pizza the same way because there's a system — a recipe and a set of steps anyone can follow. The owner doesn't stand in every kitchen. They built the system once, wrote it down, and now it runs in a hundred places at the same time. That's leverage: one process, duplicated, working everywhere without the owner personally present.",
      example: "New builder Marcus tried to do everything from scratch and by memory, so his results rose and fell with his energy and he burned out fast. His coach pointed him to One Mission's existing systems — the scripts, the tools, the simple steps. Instead of reinventing everything, Marcus followed the proven process and then taught it to his first teammate exactly as written. For the first time, something he built kept moving even on the days he was tired — because it wasn't only him doing it.",
      whatToSay: [
        { label: "Explaining duplication", text: "The whole idea is that I follow a simple system and then teach it, so you could do the exact same thing without needing me there every step. That's how it grows." },
        { label: "Keeping it honest", text: "There's a proven process to follow — it's not magic and it's not effortless, but it means you're not figuring everything out alone from scratch." },
      ],
      whatNotToSay: [
        "\"Set it up once and the money rolls in on autopilot.\" (A hype claim — systems still take real work and give no guarantees.)",
        "\"You'll get rich off other people's work.\" (Wrong framing and an income claim.)",
        "\"Don't bother learning it, just wing it.\" (The opposite of building a duplicable system.)",
      ],
      mistakes: [
        "Trying to do everything personally, so results are capped by your own hours.",
        "Reinventing a process from scratch instead of using a proven system.",
        "Building something only you understand, so it can't be duplicated or taught.",
      ],
      application: "One Mission already gives you systems — the scripts, tools, and step-by-step methods. Rich Dad thinking says: don't reinvent them and don't hoard them. Follow the proven process, then teach it to your team simply and exactly, so they can duplicate it without depending on you. That duplication is your leverage. A builder who teaches a system that runs without them has built something far bigger than their own two hands.",
      practice: "Pick one task you repeat in your One Mission activity (like a follow-up message or a first conversation). Write it out as a simple, numbered set of steps a brand-new person could follow. That written process is a small system. Notice how much easier it would be to teach than to keep doing it all from memory yourself.",
      action: "Turn one repeatable task into a simple written step-by-step system today.",
      quiz: [
        {
          q: "You've found a follow-up approach that works well for you. What's the most leveraged next move?",
          options: [
            "Keep it in your head and do every follow-up personally forever.",
            "Write it as simple steps and teach it, so your team can duplicate it without you.",
            "Change it constantly so no one else can copy it.",
          ],
          correct: 1,
          why: "Leverage comes from turning what works into a repeatable, teachable system that others can duplicate. Keeping it in your head caps results at your own capacity; teaching it lets the process run and multiply beyond you.",
        },
        {
          q: "What best describes a 'system' in Rich Dad thinking?",
          options: [
            "A one-time trick that makes money by itself with no effort.",
            "A repeatable process that produces a result whether or not you're personally present.",
            "Something only the founder can ever operate.",
          ],
          correct: 1,
          why: "A system is a repeatable, teachable process that works without depending on any one person. That's what makes it duplicable — and duplication is the source of leverage.",
        },
      ],
      resource: [RD_YT],
    },
    {
      id: "rd-onemission",
      num: 7,
      title: "Rich Dad Thinking, Applied to One Mission",
      minutes: 12,
      five: {
        bigIdea: "Everything comes together here: treat your One Mission business as an asset you build and own. Reinvest in your skills, follow the systems, think like an owner rather than an employee, and be patient with the asset column.",
        principles: [
          "Own it — think like a builder of an asset, not a worker trading hours.",
          "Reinvest in yourself first: skills and financial IQ compound.",
          "Be patient and consistent — assets grow over time, not overnight.",
        ],
        wrong: "People treat a business like a lottery ticket — they want a fast payout, get discouraged when it doesn't come, and quit before the asset ever had time to grow.",
        oneMission: "Run your One Mission activity with an owner's mindset: build the asset column daily, follow the system, and keep learning.",
        today: "Write one sentence describing the asset you're building in One Mission and one skill you'll reinvest in this month.",
      },
      why: "This matters because mindset decides whether you build something lasting or give up early. If you show up like an employee waiting to be paid for today's hours, you'll quit the moment a day feels unrewarded. If you show up like an owner building an asset, the slow days make sense — you're planting, not harvesting yet. This lesson turns every idea in this masterclass into the way you actually work, day to day, with patience and ownership.",
      principle: "An owner builds and reinvests in an asset; an employee trades hours for immediate pay. Applied to One Mission, this means treating your business as an asset you're building patiently: you follow the proven systems (leverage), keep raising your financial IQ (education), act despite fear (courage), and build alongside your job (mind your own business). You reinvest in your own skills first, because a more capable owner builds a more valuable asset. You measure progress in consistency and growth, not instant results.",
      beginner: "Think of planting a fruit tree. An employee-minded person waters it once, sees no fruit that afternoon, and walks away disappointed. An owner-minded person knows the tree needs consistent care over seasons before it produces — so they water it steadily, protect it, and trust the process. Your One Mission business is the tree. Ownership thinking is what keeps you watering on the days there's no fruit yet.",
      example: "New builder Ana pulled every idea together. She stopped asking 'what did I get paid today?' and started asking 'what did I build today?' She treated her One Mission activity as an asset: she followed the systems instead of winging it, reinvested time into one skill each month, kept her job as a foundation, and acted through her nerves. Some days felt slow. But because she thought like an owner planting a tree — not an employee waiting for a paycheck — she kept watering, and the asset kept quietly growing.",
      whatToSay: [
        { label: "Owner framing", text: "I look at this as something I'm building and own — an asset — not a quick paycheck. So I show up consistently, even on the slow days, because that's how anything worth having gets built." },
        { label: "Inviting with honesty", text: "This isn't a get-rich-quick thing and I'd never pitch it that way. It's a business you build patiently, with real systems and support. If that sounds interesting, I'll show you how it works." },
      ],
      whatNotToSay: [
        "\"Join and you'll be financially free.\" (A guarantee and income claim — never say this.)",
        "\"It basically runs itself once you start.\" (Hype; building an asset takes consistent work.)",
        "\"You'll see big results in your first week.\" (A results promise no one can make.)",
      ],
      mistakes: [
        "Treating the business like a lottery ticket and quitting when there's no fast payout.",
        "Skipping reinvestment in your own skills and financial education.",
        "Thinking like an employee (waiting to be paid for hours) instead of an owner (building an asset).",
      ],
      application: "This is where One Mission becomes your asset. Show up as an owner: build your asset column with consistent daily activity, follow the systems so your work is duplicable, keep your job as a foundation while you build, act through fear using the roleplays, and reinvest in one skill or one piece of financial education every month. Judge your progress by whether you're building and growing — not by whether today handed you an immediate reward. Patience plus consistency is how an owner builds something real.",
      practice: "Write a short 'owner's statement' for your One Mission business. Include: the asset you're building (in one sentence), the system you'll follow, the one skill you'll reinvest in this month, and how you'll stay consistent on the slow days. Keep it somewhere you'll see it each morning as a reminder of the mindset you're choosing.",
      roleplay: { scenario: "Explaining the opportunity as building an asset", opener: "So how fast does this actually pay off? Give me the real numbers." },
      action: "Write your one-sentence 'asset I'm building' statement and name one skill to reinvest in this month.",
      quiz: [
        {
          q: "A prospect asks, 'How fast will this make me money?' What's the most honest, Rich-Dad-aligned answer?",
          options: [
            "\"Really fast — you'll see big money in your first few weeks.\"",
            "\"I can't promise any income — this is a business you build patiently as an asset, with real systems and effort over time.\"",
            "\"It basically pays for itself, you barely have to do anything.\"",
          ],
          correct: 1,
          why: "There are no income promises or guarantees, ever. The owner's mindset is honest: it's an asset you build with consistent effort over time, using proven systems. Options A and C make claims no one can ethically make.",
        },
        {
          q: "Which mindset best matches building your One Mission business as an asset?",
          options: [
            "Employee thinking: 'What did I get paid for today's hours?'",
            "Owner thinking: 'What did I build today, and is the asset growing over time?'",
            "Lottery thinking: 'When's my big payout coming?'",
          ],
          correct: 1,
          why: "An owner measures progress by what's being built and whether the asset is growing, staying consistent through slow days. Employee and lottery thinking both expect an immediate reward and lead people to quit early.",
        },
      ],
      resource: [RD_SITE],
    },
  ],
  workbook: {
    id: "rich-dad-workbook",
    title: "One Mission Money & Assets Workbook",
    sections: [
      { title: "My Money Story", fields: [{ id: "money_story", label: "What was I taught about money growing up, and how does it still affect me?", hint: "Be honest — naming it is the first step to changing it." }] },
      { title: "My Assets vs Liabilities", fields: [{ id: "asset_liability", label: "My two columns: what puts money in my pocket, and what takes it out?", hint: "Use the one question: which direction does the money flow?" }] },
      { title: "My Cashflow Quadrant", fields: [{ id: "quadrant", label: "Which quadrant (E/S/B/I) is most of my income from today, and which am I moving toward?" }] },
      { title: "My Financial Education Plan", fields: [{ id: "fin_ed", label: "My source for raising my financial IQ and my daily learning window", hint: "Even 15 minutes a day compounds." }] },
      { title: "My Biggest Fear", fields: [{ id: "fear", label: "The one fear holding me back, and the two-minute action I'll take toward it" }] },
      { title: "My Own Business", fields: [{ id: "own_business", label: "How I'll build my own business alongside my job (my weekly time window)" }] },
      { title: "My System to Follow", fields: [{ id: "system", label: "The One Mission system I'll follow and the one task I'll turn into simple written steps" }] },
      { title: "My Leverage & Duplication", fields: [{ id: "leverage", label: "What I'll teach my team so it can be duplicated without depending on me" }] },
      { title: "My Owner's Statement", fields: [{ id: "owner", label: "The asset I'm building in one sentence, and how I'll stay consistent on slow days" }] },
      { title: "My Reinvestment", fields: [{ id: "reinvest", label: "The one skill or piece of financial education I'll reinvest in this month" }] },
      { title: "My Ethics Check", fields: [{ id: "ethics", label: "How I'll talk about this honestly — no income claims, no guarantees, no hype", hint: "Write the exact honest words I'll use." }] },
      { title: "My 30-Day Money-Education Challenge", fields: [{ id: "challenge", label: "My 30-day plan: 15 minutes of financial education daily, one asset-column action daily, and a weekly review", hint: "Write start date, daily commitment, and how I'll track it for 30 days." }] },
    ],
  },
};

// ═══════════════════════════════ THINK ═══════════════════════════════
const TGR_TEXT = { label: "Think and Grow Rich — full text (archive.org)", url: "https://archive.org/details/thinkgrowrichori0000napo", kind: "read" as const };
const TGR_AUDIO = { label: "Think and Grow Rich — audiobook (archive.org)", url: "https://archive.org/details/ThinkGrowRich", kind: "listen" as const };

// ═══════════════════════════════ THINK AND GROW RICH ═══════════════════════════════
const THINK_GROW_RICH: Masterclass = {
  id: "think-grow-rich",
  teacher: "Napoleon Hill",
  book: "Think and Grow Rich",
  title: "Think and Grow Rich — Success Principles Study",
  subtitle: "The timeless principles of achievement, in plain One Mission language.",
  category: "Mindset",
  accent: "#7c3aed",
  minutes: "70–100 min",
  overview:
    "Napoleon Hill spent decades studying people who achieved great things, and he noticed they all thought in the same handful of ways long before they had any proof it would work. This study turns those patterns — a clear aim, real belief, a plan, decision, and stubborn persistence — into a 12-lesson pathway you actually apply to building One Mission. Here \"grow rich\" means growing as a person: richer in focus, confidence, character, and results. The original book is in the public domain and free to read; we teach the principles in our own words and put them straight to work in your business.",
  original: [TGR_TEXT, TGR_AUDIO],
  lessons: [
    {
      id: "tgr-desire",
      num: 1,
      title: "Desire: A Definite Chief Aim",
      minutes: 9,
      five: {
        bigIdea: "A wish is vague and easy to drop. A definite chief aim is one clear, specific goal you want so badly you refuse to quit — and that burning clarity is where all achievement starts.",
        principles: [
          "Pick ONE definite aim and make it specific — an exact outcome, not \"someday, somehow.\"",
          "Attach a strong personal reason so the desire actually burns, not just flickers.",
          "Write it down and read it out loud daily so it stays in front of you.",
        ],
        wrong: "Most people keep their goal fuzzy — \"I'd like to do better\" — which never commands enough focus to survive a hard week.",
        oneMission: "Write a definite chief aim for your One Mission business in the Academy: what you're building, why, and the specific milestone you're aiming at first.",
        today: "Write one sentence: exactly what you want from One Mission and the specific date you're aiming for.",
      },
      why: "Nothing else in this study works without this. Faith, plans, and persistence all need a target to point at — and a vague target gives you nothing to hold onto when things get hard. When your goal is clear and you want it badly for reasons that are truly yours, you stop drifting. You wake up with something to move toward, and small daily actions finally add up because they're all aimed at the same place.",
      principle: "A definite chief aim is one clearly defined objective, backed by a burning desire to reach it. It is specific (you'd know the moment you hit it), personal (the reason is yours, not borrowed), and written (so it lives outside your head). Desire here isn't a lazy wish — it's a decision you keep making, on purpose, every day.",
      beginner: "Think about the difference between saying \"I'd like to get in shape\" and \"I'm going to walk 30 minutes every morning before work.\" The first is a hope. The second tells you exactly what to do tomorrow. A definite chief aim does the same thing for your whole life — it turns a foggy wish into a target you can actually walk toward.",
      example: "New builder Ana first told her coach, \"I just want things to be better.\" Her coach asked her to get specific. After some digging, Ana wrote: \"I'm building One Mission so I can be home when my kids get off the bus, and my first milestone is helping 3 people get started in the next 90 days.\" Suddenly her mornings had a point. On the days she didn't feel like it, that picture of the bus stop got her to send the message anyway.",
      whatNotToSay: [
        "\"I just want to be successful.\" (Too vague to guide a single action.)",
        "\"I'll figure out my goal once things start working.\" (Backwards — the goal is what makes things start working.)",
        "\"My goal is to get rich.\" (Money alone isn't a definite aim, and it's not a promise anyone can make you — name the real why behind it.)",
      ],
      mistakes: [
        "Keeping the goal vague so it never demands real commitment.",
        "Choosing five goals at once, so none of them get true focus.",
        "Picking a goal you think you 'should' want instead of one you actually burn for.",
        "Writing it once and never looking at it again.",
      ],
      application: "In One Mission, your definite chief aim becomes the anchor for your Daily Method. When you know exactly what you're building and why, deciding what to do each day gets simple — every conversation and every follow-up either moves you toward the aim or it doesn't. Builders without a clear aim tend to drift, get busy with nothing, and quietly fade. Your written aim is the thing you return to when motivation dips.",
      practice: "Write your definite chief aim in three parts: (1) the specific outcome you want, (2) the honest personal reason it matters to you, and (3) the first measurable milestone with a date. Read it out loud. If it doesn't give you even a small spark, dig deeper on part 2 until it does.",
      action: "Write your one-sentence definite chief aim today and put it somewhere you'll see it every morning — phone lock screen, mirror, or the top of your Academy notes.",
      quiz: [
        {
          q: "Which of these is a real definite chief aim, not just a wish?",
          options: [
            "\"I want to do better this year.\"",
            "\"I'm helping 3 people get started in One Mission in the next 90 days so I can be home for my kids.\"",
            "\"I hope things pick up eventually.\"",
          ],
          correct: 1,
          why: "A definite chief aim is specific (3 people, 90 days), personal (home for the kids), and measurable. The other two are vague hopes with nothing to act on tomorrow.",
        },
        {
          q: "Why does Hill insist your aim be written down and read daily?",
          options: [
            "Because writing it once guarantees it will happen.",
            "Because a goal kept only in your head fades, while one you see daily keeps directing your actions.",
            "Because it impresses your team.",
          ],
          correct: 1,
          why: "Writing and re-reading keeps the aim in front of you so it actually guides daily choices. There's no guarantee — the point is staying focused, not magic.",
        },
      ],
      resource: [TGR_TEXT],
    },
    {
      id: "tgr-faith",
      num: 2,
      title: "Faith & Belief",
      minutes: 8,
      five: {
        bigIdea: "Faith here means genuinely believing your aim is possible for you — before there's any proof — because you'll never work hard for something you secretly think can't happen.",
        principles: [
          "Belief comes first; the results follow the belief, not the other way around.",
          "You build faith on purpose by repeating a truthful, encouraging message to yourself.",
          "Self-confidence grows from small kept promises, not from waiting to 'feel ready.'",
        ],
        wrong: "People wait to believe until they see results — but they rarely take the action that produces results while they still doubt.",
        oneMission: "Pair your definite chief aim with a short belief statement you can read before every prospecting session in One Mission.",
        today: "Write one honest sentence of belief about your goal and say it out loud before your next work block.",
      },
      why: "Doubt leaks into everything. If part of you doesn't believe your goal is possible, you'll hold back in conversations, quit early, and read every 'no' as final proof you were right to doubt. Faith isn't pretending — it's deciding to give your goal a real chance by acting as if it can work. That belief is what lets you show up steady, sound confident, and keep going long enough to actually get good.",
      principle: "Faith is a state of mind you develop on purpose by repeatedly affirming your aim and feeding your mind belief instead of doubt. It's not blind hope and it's not a guarantee of any outcome — it's the confidence that lets you take consistent action. Self-confidence, its close cousin, is built by keeping small promises to yourself until you trust your own word.",
      beginner: "Imagine learning to ride a bike. If you're sure you'll fall, you tense up and wobble and, sure enough, you fall. If you believe you can do it, you relax, keep pedaling, and you learn. Belief doesn't skip the practice — it just lets you stay on the bike long enough to get good. Faith in your goal works the same way.",
      example: "New builder Marcus almost didn't start because he thought, \"People like me don't do well at this.\" His coach had him write a small belief statement — \"I'm coachable, I show up daily, and I get a little better every week\" — and read it before each session. Nothing magic happened. But he stopped apologizing in his messages, his tone got steadier, and within a month he'd had his first two people say yes. The belief came before the proof.",
      whatToSay: [
        { label: "Daily belief statement", text: "I have a clear aim, I'm coachable, and I take action every day. I don't have to be perfect — I just have to keep showing up and improving. Every conversation makes me better." },
      ],
      whatNotToSay: [
        "\"I'll believe it when I see it.\" (You usually have to believe it enough to act before you'll see it.)",
        "\"I'm just not a confident person.\" (Confidence is built by kept promises, not a fixed trait you're born with.)",
        "\"This is guaranteed to work for me.\" (Faith fuels action — it doesn't promise a result, and honest belief never needs a guarantee.)",
      ],
      mistakes: [
        "Waiting to feel confident before taking action, instead of building confidence through action.",
        "Confusing faith with false promises or hype.",
        "Feeding your mind constant doubt and then wondering why you hold back.",
        "Breaking small promises to yourself until you stop trusting your own word.",
      ],
      application: "In One Mission, your prospects can feel your belief — or your doubt — through the screen. When you genuinely believe in what you're building, you invite from a steady, unattached place instead of begging. Build your faith the practical way: keep your daily commitments, track your small wins in the Academy, and read your belief statement before you reach out. Confidence you've earned through action is contagious and impossible to fake for long.",
      practice: "Write a belief statement that is true and encouraging — no hype, no income claims. It should describe the kind of builder you're becoming, not promise an outcome. Read it out loud before your next three work sessions and notice how your tone changes.",
      action: "Write your belief statement today and keep one small promise to yourself — a single specific action you said you'd do — to add a real brick to your confidence.",
      quiz: [
        {
          q: "A prospect says no and you feel like quitting. What's the faith-based response?",
          options: [
            "Take it as proof you were never cut out for this.",
            "Remember your belief statement, treat the no as one data point, and take your next action anyway.",
            "Tell the next prospect this is guaranteed to work so they'll say yes.",
          ],
          correct: 1,
          why: "Faith keeps you acting through the no's without lying to anyone. Quitting confirms the doubt; a guarantee is a false claim. Steady belief plus the next action is the professional move.",
        },
      ],
      resource: [TGR_AUDIO],
    },
    {
      id: "tgr-autosuggestion",
      num: 3,
      title: "Autosuggestion",
      minutes: 8,
      five: {
        bigIdea: "Autosuggestion is the self-talk that quietly programs your mind — you're always feeding yourself messages, so the skill is choosing them on purpose instead of letting fear and comparison pick them for you.",
        principles: [
          "You're already running self-talk all day; make it intentional instead of accidental.",
          "Repetition with feeling is what sinks a message in — dull words don't stick.",
          "Replace each self-attack with a truthful, useful statement rather than empty positivity.",
        ],
        wrong: "People let their inner voice run wild with worst-case stories, then treat those stories as facts about who they are.",
        oneMission: "Turn your definite chief aim and belief statement into a short script you read morning and night in the Academy habit tracker.",
        today: "Catch one negative thought today, write it down, and rewrite it into something true and useful.",
      },
      why: "The voice in your head sets the tone for your whole day. If it's constantly saying \"you'll mess this up\" or \"everyone can tell you don't know what you're doing,\" you'll shrink, avoid the hard actions, and call it 'not being in the mood.' Autosuggestion matters because you can't stop the voice — but you can decide what it says. Repeat the right message enough and it becomes your default, which changes how you show up.",
      principle: "Autosuggestion is the practice of deliberately repeating chosen thoughts, with emotion, until they influence your habits and self-image. Your subconscious doesn't fact-check — it accepts what you feed it most often. So you feed it, on purpose, a truthful and constructive message that supports your aim, rather than leaving it to absorb whatever fear says.",
      beginner: "Think about a song you didn't even like but heard so many times you now know every word. That's autosuggestion — repetition writes it in whether you chose it or not. Your self-talk is the same. Say \"I'm terrible at this\" a hundred times a week and your mind memorizes it. So pick the words that get repeated, the way you'd pick a better song.",
      example: "New builder Priya realized that every time she opened her messages she was thinking, \"I'm bothering people.\" Her coach had her write a replacement — \"I'm offering something valuable to people who are free to say no\" — and read it before each session and again at night. She didn't fake confidence; she just stopped rehearsing the thought that made her freeze. Within two weeks reaching out felt normal instead of shameful.",
      whatToSay: [
        { label: "Morning script", text: "I know exactly what I'm building and why. I take action before I feel ready, and I improve every single day. I offer something valuable, and I let people decide freely." },
        { label: "Reframe on the spot", text: "Instead of 'I'm bothering people,' say: 'I'm reaching out to people I care about with something worth a look. Their answer is theirs to give.'" },
      ],
      whatNotToSay: [
        "\"I always screw this up.\" (You're rehearsing failure and teaching your mind to expect it.)",
        "\"Everyone can tell I'm new and bad at this.\" (A guess dressed up as a fact.)",
        "\"I'll be a millionaire by summer\" as an affirmation. (Hype and income claims aren't autosuggestion — a false statement doesn't build real belief.)",
      ],
      mistakes: [
        "Repeating vague affirmations with no emotion, so nothing sinks in.",
        "Using autosuggestion to make false claims instead of truthful, useful ones.",
        "Letting negative self-talk run unchecked all day, then wondering why you avoid the work.",
        "Doing it once and expecting a personality change — repetition is the whole mechanism.",
      ],
      application: "In One Mission, your inner script decides whether you send the message or stall. Build the habit: read your aim and belief statement out loud each morning, and reframe the specific negative thoughts that stop you — usually some version of \"I'm bothering people\" or \"I'll look foolish.\" The Academy habit tracker is there to keep the repetition going, because repetition, not intensity, is what makes the new script stick.",
      practice: "Track your self-talk for one day. Every time you catch a discouraging thought before prospecting, write it in one column and a truthful reframe in the next. Pick the reframe you need most and turn it into a line you read morning and night for a week.",
      action: "Write your morning script today (aim + belief, in your own words) and read it out loud before you do any One Mission activity.",
      quiz: [
        {
          q: "Which is a healthy use of autosuggestion for a One Mission builder?",
          options: [
            "\"I'll definitely earn a huge income this month.\"",
            "\"I take action before I feel ready and I get a little better every day.\"",
            "\"I'm probably going to embarrass myself again.\"",
          ],
          correct: 1,
          why: "Good autosuggestion is truthful and about your behavior and growth, not a promised outcome. The income line is a false claim; the last line rehearses failure. The middle one builds the builder.",
        },
      ],
      resource: [TGR_TEXT],
    },
    {
      id: "tgr-knowledge",
      num: 4,
      title: "Specialized Knowledge",
      minutes: 9,
      five: {
        bigIdea: "You don't need to know everything — you need the RIGHT knowledge for your goal and the willingness to use it. Knowing where to find answers and organizing them into action beats trying to master it all yourself.",
        principles: [
          "General knowledge is nice; specialized knowledge aimed at your goal is what pays off.",
          "You don't have to hold every skill — you can plug into a team and a system that already do.",
          "Knowledge only counts when it's organized into a plan and put into action.",
        ],
        wrong: "People either wait until they 'know enough' to start, or collect information endlessly without ever applying any of it.",
        oneMission: "Use the Academy as your source of specialized knowledge — follow the training path in order and apply each piece before moving on.",
        today: "Complete one specific Academy lesson and do the action it recommends the same day.",
      },
      why: "This lesson frees you from a trap that stops thousands of people: the belief that you must become an expert before you're allowed to start. That's not true, and waiting for it guarantees you never begin. What actually matters is getting the specific knowledge your goal requires — and knowing you can lean on a system and a team for the rest. It turns \"I don't know enough\" into \"I know where to get what I need.\"",
      principle: "Specialized knowledge is knowledge organized and directed toward a definite aim. Hill's key insight: you don't have to personally possess all of it. Achievers assemble knowledge through teams, mentors, and systems, then organize it into plans. What separates achievers from collectors is application — knowledge that never becomes action is just trivia.",
      beginner: "Think about a great coach. They don't have to be the fastest player on the field — they know how to get the right knowledge to the right player at the right time. You can build the same way. You don't need every answer memorized; you need to know where the answers live (your Academy, your team) and how to put them to work.",
      example: "New builder Ana kept saying she'd start \"once she really understood everything.\" Her coach pointed out she'd been 'studying' for three weeks and hadn't talked to a single person. They made a rule: one Academy lesson, then immediately do the action it suggests, that same day. Ana learned faster in one week of applying than three weeks of collecting — because now the knowledge had somewhere to go.",
      whatToSay: [
        { label: "When a prospect asks something you don't know", text: "Great question — I don't want to guess, so let me get you the exact answer. I'll connect you with someone on my team who knows it cold, or send you the resource that covers it." },
      ],
      whatNotToSay: [
        "\"I can't start until I know everything.\" (No one knows everything; that's what the team and system are for.)",
        "\"Let me make something up so I sound smart.\" (Guessing costs you trust — get the real answer.)",
        "\"I've watched 40 trainings\" (as a substitute for action). (Learning without applying is just busywork.)",
      ],
      mistakes: [
        "Waiting to feel like an expert before starting.",
        "Hoarding information and calling it progress while taking no action.",
        "Trying to personally master every skill instead of leaning on the team and system.",
        "Learning a concept and never doing the action it points to.",
      ],
      application: "In One Mission, the Academy IS your specialized knowledge — organized, in order, aimed at building your business. You don't have to know everything to start; you have to follow the path and apply each piece. When a prospect asks something beyond you, that's what a 3-way with your leader is for. Learn-then-do, one lesson at a time, and you'll grow faster than anyone trying to swallow it all first.",
      practice: "Pick the very next lesson in your Academy path. Watch or read it, write down the single action it recommends, and do that action before the day ends. Repeat tomorrow. The rule is simple: never take in a new lesson until you've applied the last one.",
      action: "Finish one Academy lesson today and complete its recommended action the same day — no collecting without applying.",
      quiz: [
        {
          q: "A prospect asks a detailed question you can't answer yet. Best move?",
          options: [
            "Make up an answer so you look knowledgeable.",
            "Tell them you'll get the exact answer and connect them with a knowledgeable teammate or resource.",
            "Tell them you can't start helping anyone until you know everything.",
          ],
          correct: 1,
          why: "Specialized knowledge includes knowing where to get answers. Guessing breaks trust; freezing helps no one. Pointing to the right resource or a 3-way is exactly how achievers use team knowledge.",
        },
        {
          q: "What turns knowledge into an asset, according to this principle?",
          options: [
            "Collecting as much of it as possible.",
            "Organizing it toward your aim and putting it into action.",
            "Keeping it to yourself so you have an edge.",
          ],
          correct: 1,
          why: "Knowledge only has value when it's organized toward a definite aim and applied. Endless collecting without action is just trivia.",
        },
      ],
      resource: [TGR_AUDIO],
    },
    {
      id: "tgr-imagination",
      num: 5,
      title: "Imagination",
      minutes: 8,
      five: {
        bigIdea: "Imagination is the workshop where plans and ideas are formed — before anything gets built in the real world, it gets built in your mind. Achievers use it on purpose to picture solutions and design their path.",
        principles: [
          "Every real thing was first imagined; picture the outcome before you build it.",
          "Use imagination to rearrange what already exists into a new plan — you don't need brand-new inventions.",
          "A vivid mental picture of your aim pulls your daily actions into line with it.",
        ],
        wrong: "People use imagination against themselves — vividly picturing everything that could go wrong instead of designing what could go right.",
        oneMission: "Use your imagination to map your ideal week and your prospect approach before you act, then bring the plan into the Academy tools.",
        today: "Spend five minutes vividly picturing yourself confidently doing one One Mission activity you usually avoid.",
      },
      why: "Your imagination is running whether you steer it or not — and most people let it run scared, rehearsing rejection and disaster. That's imagination working against you. When you take the wheel, you can picture solutions, rehearse conversations, and design a plan before you spend real time and energy. Seeing yourself succeed at a specific task makes it far easier to actually do it, because your mind has already walked the path once.",
      principle: "Imagination is the mental workshop where desire and knowledge are shaped into plans. Hill distinguishes 'synthetic' imagination — rearranging existing ideas into new combinations — from 'creative' imagination — fresh insight. Most achievement uses the synthetic kind: taking known pieces and assembling them into your own plan. You direct it deliberately toward your aim instead of letting it drift toward fear.",
      beginner: "Think about how you plan a road trip. Before you turn the key, you picture the route, imagine where you'll stop, and see yourself arriving. That mental rehearsal makes the real drive smoother. Building your goal works the same way — you picture the path first, and the picture makes the real steps clearer and less scary.",
      example: "New builder Marcus dreaded inviting people because he kept imagining them laughing at him. His coach flipped the exercise: spend five minutes picturing an invite going well — the calm message, the curious reply, the easy next step. He rehearsed it in his mind a few times, then sent a real one. It didn't go perfectly, but it went nothing like the disaster he'd been imagining, and the next one was easier.",
      mistakes: [
        "Letting imagination rehearse disaster instead of designing success.",
        "Thinking you need a brand-new invention when rearranging known pieces is enough.",
        "Dreaming vividly but never turning the picture into a written plan or an action.",
        "Skipping mental rehearsal before hard conversations, then going in cold and tense.",
      ],
      application: "In One Mission, imagination is how you design before you do. Picture your ideal week and then build it into your schedule. Rehearse an invite or a follow-up in your mind before you send it, so you show up calm instead of tense. And use imagination to picture your definite chief aim already reached — not as a fantasy that replaces work, but as a target vivid enough to keep your daily actions pointed the right way.",
      practice: "Take one One Mission activity you avoid — inviting, following up, going live. Spend five minutes picturing it going smoothly in detail: what you say, how you feel, how the other person responds reasonably. Then go do the real thing within the hour while the rehearsal is fresh.",
      action: "Spend five minutes today vividly rehearsing one activity you usually dread, then do it for real.",
      quiz: [
        {
          q: "You keep imagining prospects rejecting and mocking you. What's the better use of imagination?",
          options: [
            "Keep picturing the worst so you're 'prepared' for it.",
            "Rehearse the conversation going reasonably well, then take the real action while it's fresh.",
            "Stop imagining anything and just wing it cold.",
          ],
          correct: 1,
          why: "Imagination runs either way — rehearsing disaster makes you tense and avoidant. Deliberately picturing a reasonable, successful version calms you and makes the real action easier.",
        },
      ],
      resource: [TGR_TEXT],
    },
    {
      id: "tgr-planning",
      num: 6,
      title: "Organized Planning",
      minutes: 9,
      five: {
        bigIdea: "Desire without a plan is just a daydream. Organized planning turns your aim into concrete steps and puts them into action — and when a plan fails, you don't quit, you build a better plan.",
        principles: [
          "Break your aim into specific, doable steps with dates attached.",
          "A failed plan is feedback, not the end — replace it and keep moving.",
          "Plans only matter once you act on them, so build action into the plan itself.",
        ],
        wrong: "People either never make a plan, or make one, hit a snag, and treat the snag as proof the whole goal was impossible.",
        oneMission: "Turn your definite chief aim into a weekly Daily Method plan in the Academy: specific activities, specific numbers, specific days.",
        today: "Write your plan for this week — the exact One Mission actions you'll take and on which days.",
      },
      why: "A goal with no plan lives permanently in 'someday.' Planning is what drops your big aim down to the level of things you can actually do tomorrow morning. It also protects you from a common quitting point: the first plan rarely works perfectly, and people who don't understand planning read that first stumble as failure. When you know that adjusting the plan IS the process, setbacks stop feeling fatal and start feeling normal.",
      principle: "Organized planning is the process of building a definite, practical plan of action for your aim, executing it, and revising it whenever it falls short. Hill is blunt: temporary defeat usually means the plan was faulty, not that the goal was wrong. Achievers build a plan, act, learn, and rebuild — as many times as it takes — without abandoning the aim itself.",
      beginner: "Think about following a recipe. You don't just stare at a photo of the finished cake and hope — you follow steps in order. And if it comes out flat, you don't decide cake is impossible; you tweak the recipe and bake again. Organized planning is the recipe for your goal: clear steps, and a willingness to adjust when something doesn't rise.",
      example: "New builder Priya's first plan was \"post online and hope people reach out.\" A week of silence made her feel like a failure. Her coach helped her see the plan was weak, not her. They rebuilt it: reach out to five people a day directly, follow up within 48 hours, invite to one event a week. The new plan wasn't magic, but it gave her real actions and real feedback — and her results finally started to move.",
      whatToSay: [
        { label: "Talking yourself through a setback", text: "This plan didn't work — okay, that's information, not a verdict. What specifically fell short, and what's one change I can test this week? The goal stays; the plan gets an upgrade." },
      ],
      mistakes: [
        "Having a goal but no written plan of specific actions.",
        "Treating the first failed plan as proof the whole goal is impossible.",
        "Planning endlessly but never executing.",
        "Making the plan vague ('do more, try harder') instead of specific and measurable.",
      ],
      application: "In One Mission, organized planning is your Daily Method of Operation. Take your definite chief aim and break it into a weekly plan: how many people you'll reach out to, how you'll follow up, which event you'll attend and who you'll invite. Then work the plan and check it weekly. When a week underperforms, you don't scrap your aim — you adjust the plan (a different approach, a better script, more consistency) and run it again. Building is a series of upgraded plans.",
      practice: "Write this week's plan on one page: the specific One Mission activities, the numbers you're committing to (e.g., reach-outs, follow-ups, invites), and which days you'll do them. At week's end, review what worked, change one thing, and write next week's plan.",
      action: "Write your specific weekly One Mission plan today — activities, numbers, and days — and put the first action on today's schedule.",
      quiz: [
        {
          q: "Your first plan produces almost no results after a week. What does this principle say to do?",
          options: [
            "Accept that the goal was never realistic and stop.",
            "Keep the aim, figure out what was weak in the plan, and run an improved plan.",
            "Keep repeating the exact same plan and hope it turns around.",
          ],
          correct: 1,
          why: "Temporary defeat usually means a faulty plan, not an impossible goal. Achievers keep the aim, diagnose the weak plan, and rebuild — not quit, and not blindly repeat.",
        },
      ],
      resource: [TGR_AUDIO],
    },
    {
      id: "tgr-decision",
      num: 7,
      title: "Decision",
      minutes: 8,
      five: {
        bigIdea: "Successful people decide quickly and change their minds slowly; strugglers decide slowly and change quickly. Decisiveness beats procrastination — and the habit of deciding is a skill you can build.",
        principles: [
          "Decide promptly once you have enough to go on; endless deliberation is a decision to stall.",
          "Once you decide, stick with it unless real new facts appear — don't rethink it hourly.",
          "Stop outsourcing your decisions to everyone else's opinions.",
        ],
        wrong: "People wait for perfect certainty before deciding, so they either never decide or let others decide for them.",
        oneMission: "Decide your commitment to One Mission clearly — your aim, your Daily Method, your start date — and stop renegotiating it every morning.",
        today: "Make one decision you've been avoiding and act on it before the day ends.",
      },
      why: "Procrastination is where goals go to die, and it usually wears the mask of 'thinking it over.' The truth is that most of the time you don't need more information — you need to decide. People who achieve things get comfortable deciding with reasonable (not perfect) information and then committing. When you keep re-deciding whether you're 'really' going to build, you burn all your energy on the decision and have none left for the work.",
      principle: "Decision is the habit of reaching conclusions promptly and definitely, then holding to them unless genuine new facts require a change. Hill found that achievers decide fast and reverse slowly, while strugglers do the opposite — dithering, then flip-flopping at the first opinion or obstacle. Indecision is itself a decision: the decision to stay stuck.",
      beginner: "Think about ordering at a restaurant. Some people scan the menu, pick something that sounds good, and enjoy their meal. Others agonize, ask everyone's opinion, change their order twice, and still feel unsure. The food is the same — the difference is the habit of deciding. That habit, not the menu, is what makes the meal (or the goal) enjoyable and actually happen.",
      example: "New builder Marcus spent a month 'deciding' whether to fully commit to One Mission — asking opinions, reading reviews, waiting to feel 100% sure. Nothing moved. His coach asked one question: \"Do you have enough information to decide, or are you just scared?\" Marcus admitted it was fear. He decided that afternoon, set his start date, and committed to his Daily Method. He'd wasted a month on a decision that took ten honest minutes.",
      whatToSay: [
        { label: "When you're stalling on a decision", text: "Do I actually need more information, or am I just afraid? If I have enough to decide, I decide now and adjust later. Waiting isn't neutral — it's choosing to stay stuck." },
      ],
      whatNotToSay: [
        "\"Let me think about it\" for the tenth time. (At some point that's avoidance, not diligence.)",
        "\"I'll decide once I'm completely sure.\" (Complete certainty rarely comes; you'll wait forever.)",
        "\"What do you all think I should do?\" asked to twenty people. (Collecting opinions until you're paralyzed is outsourcing your decision.)",
      ],
      mistakes: [
        "Waiting for perfect certainty that never arrives.",
        "Deciding slowly, then reversing at the first obstacle or opinion.",
        "Letting other people's doubts make your decisions for you.",
        "Confusing endless 'thinking about it' with actual progress.",
      ],
      application: "In One Mission, decisiveness is a builder's edge. Decide your aim, decide your Daily Method, decide your start date — and then stop renegotiating the decision every morning. The builders who struggle most are often the ones who re-decide whether they're 'really doing this' each day, which drains the energy the work needs. Make the big decision once, firmly, and let your daily choices be about action, not re-litigating the commitment.",
      practice: "List the decisions you've been avoiding in your business (start date, who to invite next, whether to go to the event). For each, ask honestly: do I need more facts, or am I just afraid? Decide the fear-based ones now, in writing, and put the first action on your calendar.",
      action: "Pick one decision you've been putting off and make it today — then take one action on it before the day ends.",
      quiz: [
        {
          q: "You've spent three weeks 'deciding' whether to commit, gathering opinions but not moving. What does this lesson suggest?",
          options: [
            "Keep gathering opinions until everyone agrees it's a good idea.",
            "Ask yourself honestly whether you need facts or are just afraid, then decide and set a start date.",
            "Wait until you feel 100% certain before doing anything.",
          ],
          correct: 1,
          why: "Indecision is a decision to stay stuck. Achievers decide promptly with reasonable information — endless opinion-gathering and waiting for total certainty are procrastination in disguise.",
        },
      ],
      resource: [TGR_TEXT],
    },
    {
      id: "tgr-persistence",
      num: 8,
      title: "Persistence",
      minutes: 9,
      five: {
        bigIdea: "Persistence is the steady effort that outlasts temporary defeat. Most people quit right before the breakthrough — the ones who make it are simply the ones who kept going a little longer.",
        principles: [
          "Temporary defeat is normal and expected, not a signal to stop.",
          "Persistence is built by systems and habits, not by waiting for motivation.",
          "The willingness to continue after others quit is what separates achievers from the crowd.",
        ],
        wrong: "People treat the first few setbacks as final and quit — often right before the effort would have paid off.",
        oneMission: "Commit to a Daily Method you can sustain on low-motivation days, and lean on your One Mission community to keep you going.",
        today: "Do your core One Mission activity today even if you don't feel like it — that's the rep that builds persistence.",
      },
      why: "This might be the most important lesson in the whole study, because talent and plans mean nothing if you stop too soon. Almost everyone who fails does so not because they couldn't have succeeded, but because they gave up while the goal was still reachable. Persistence matters because results in building are lumpy and delayed — you put in effort now and see the payoff later, which fools quitters into thinking it isn't working when it actually is.",
      principle: "Persistence is sustained, consistent effort toward your aim in the face of setbacks. Hill's central observation: the difference between those who achieve and those who don't is rarely talent — it's the willingness to keep going through temporary defeat, which most people mistake for permanent failure. Persistence isn't a feeling; it's a habit you can build with systems.",
      beginner: "Think about a kettle heating up. For a long time it looks like nothing's happening — no bubbles, no steam. Then it boils. If you turned off the heat at minute two because 'it wasn't working,' you'd never get there. Building a goal is the same: a lot of quiet effort with no visible bubbles, and then things start to move. Persistence is leaving the heat on.",
      example: "New builder Ana had a rough stretch — several no's in a row, a person who ghosted her, a slow month. She was ready to quit and told her coach so. Her coach reminded her that almost everyone who quits does it in exactly this kind of stretch. Ana decided to keep her Daily Method going for 30 more days no matter what. Two of the people who'd gone quiet came back, and a fresh conversation turned into her strongest teammate yet. The breakthrough was just past the point she'd wanted to stop.",
      whatToSay: [
        { label: "On a low-motivation day", text: "I don't have to feel motivated — I just have to do my Daily Method. Small action today, small action tomorrow. I keep the heat on and let the results catch up." },
      ],
      whatNotToSay: [
        "\"It's not working, so I'm done.\" (You often can't see the breakthrough that's close.)",
        "\"Everyone else is getting results faster, so I must not be cut out for this.\" (Comparison is a quitting trap.)",
        "\"I'll pick it back up when I feel motivated.\" (Motivation follows action, not the other way around.)",
      ],
      mistakes: [
        "Reading temporary defeat as permanent failure and quitting.",
        "Relying on motivation instead of a repeatable daily system.",
        "Quitting during the quiet stretch right before results show up.",
        "Comparing your early days to someone else's chapter twenty.",
      ],
      application: "In One Mission, persistence is the whole game. Results are delayed and uneven, which means the builders who win are the ones who keep their Daily Method going through slow stretches. Make your daily commitment small enough that you can do it on your worst day, and lean on your community and your written aim when motivation dips. Nearly every big story in this community includes a stretch where the person almost quit — and didn't.",
      practice: "Design a 'minimum day' — the smallest version of your Daily Method you could do even on your busiest, lowest-energy day (for example, three reach-outs and one follow-up). Commit to never dropping below it. On good days you do more; on hard days you protect the streak.",
      action: "Do your core One Mission activity today even though you may not feel like it, and text one teammate to keep each other accountable this week.",
      quiz: [
        {
          q: "After several no's and a slow month, you feel like quitting. What does the persistence principle say?",
          options: [
            "The no's prove it won't work for you, so stop.",
            "Slow stretches are normal and often come right before a breakthrough — keep your minimum daily action going.",
            "Only push forward on days you feel motivated.",
          ],
          correct: 1,
          why: "Most quitting happens in exactly these stretches, often just before results appear. Persistence means protecting a sustainable daily action regardless of motivation or a rough patch.",
        },
        {
          q: "What's the most reliable foundation for persistence?",
          options: [
            "Waiting until you feel motivated each day.",
            "A small, repeatable daily system you can do even on bad days.",
            "Comparing yourself to top builders for inspiration.",
          ],
          correct: 1,
          why: "Motivation is unreliable and comparison usually discourages. A sustainable daily system carries you through the low days, which is exactly when persistence is tested.",
        },
      ],
      resource: [TGR_AUDIO],
    },
    {
      id: "tgr-mastermind",
      num: 9,
      title: "The Mastermind",
      minutes: 8,
      five: {
        bigIdea: "A mastermind is a supportive, driven group working in harmony toward growth. Who you surround yourself with quietly shapes what you believe is possible — so choose that circle on purpose.",
        principles: [
          "You rise or sink toward the standard of the people around you.",
          "A mastermind multiplies knowledge, encouragement, and accountability beyond what you have alone.",
          "Give value to the group, don't just take — harmony and contribution make it work.",
        ],
        wrong: "People try to build alone, surrounded by doubters, and let the loudest discouragers set the ceiling on their belief.",
        oneMission: "Plug fully into your One Mission team and community — your built-in mastermind of people chasing growth.",
        today: "Reach out to two people in your One Mission community and engage with the group today.",
      },
      why: "You become like the people you spend the most time with — their beliefs, habits, and standards rub off whether you notice or not. If everyone around you is cynical and stuck, that becomes your normal and your ceiling. A mastermind flips this in your favor: surround yourself with people who are growing, and their momentum, ideas, and belief lift you. It's one of the fastest ways to change your trajectory without changing anything else about yourself.",
      principle: "A mastermind is a group of people coordinated in a spirit of harmony toward a definite purpose. Hill argued that when minds cooperate, the group produces more than the sum of its parts — shared knowledge, accountability, and encouraged belief. The key conditions are harmony and mutual contribution: you bring value and support, not just needs.",
      beginner: "Think about how much easier it is to run when you've got a running buddy. On the mornings you'd have skipped, they're at the door — and you show up for them too. A mastermind is a running buddy for your goals: people who expect you, encourage you, share what's working, and make the hard mornings easier because you're not doing it alone.",
      example: "New builder Marcus was the only person in his household who believed in what he was doing, and the doubt at home was wearing him down. His coach encouraged him to get active in the One Mission team chats and show up to the weekly calls. Being around people who were growing changed his whole outlook — he picked up scripts that worked, celebrated small wins with people who got it, and stopped letting the doubters at home set his ceiling.",
      whatToSay: [
        { label: "Contributing to your mastermind", text: "Here's something that worked for me this week — sharing in case it helps someone. And if anyone's in a slow stretch, I've been there; happy to jump on a quick call." },
      ],
      whatNotToSay: [
        "\"I'll just build this on my own, I don't need anyone.\" (Going it alone forfeits the biggest advantage available to you.)",
        "\"I'll only take from the group and never give.\" (A mastermind runs on contribution and harmony, not one-way taking.)",
        "\"My family thinks it's silly, so maybe they're right.\" (Don't let the loudest doubters set your ceiling.)",
      ],
      mistakes: [
        "Trying to build entirely alone.",
        "Letting cynical or discouraging voices become your main influence.",
        "Only taking from the group and never contributing value.",
        "Skipping the calls and community, then wondering why belief feels hard to hold.",
      ],
      application: "In One Mission, your team and community ARE your mastermind — a group of people all working toward growth, already gathered for you. Plug in fully: show up to the calls, join the conversations, share what's working, and support people in slow stretches. You'll absorb belief and skill faster around driven people than you ever could alone, and your own contribution strengthens the group that carries you. Guard your inputs — spend more time with the builders than the doubters.",
      practice: "Take an honest look at your five biggest influences right now. Are they growing or stuck? You can't cut everyone off, but you can add: commit to showing up to your next One Mission call and to contributing something useful in the community this week. Track how it affects your belief.",
      action: "Reach out to two people in your One Mission community today, and commit to attending the next team call.",
      quiz: [
        {
          q: "The people closest to you are mostly discouraging about your goal. What's the mastermind-minded response?",
          options: [
            "Assume the loudest doubters are probably right and lower your goal.",
            "Deliberately add driven, supportive people (like your One Mission community) to your influences and contribute there.",
            "Build completely alone so no one can discourage you.",
          ],
          correct: 1,
          why: "You rise toward your influences. You can't always remove doubters, but you can add a mastermind of growing people and contribute to it — that's the practical fix, better than lowering your goal or isolating.",
        },
      ],
      resource: [TGR_TEXT],
    },
    {
      id: "tgr-subconscious",
      num: 10,
      title: "The Subconscious & Emotions",
      minutes: 8,
      five: {
        bigIdea: "Your subconscious mind acts on whatever thoughts and feelings dominate it most. You can't leave it empty, so the skill is deliberately feeding it positive, purposeful thoughts instead of letting fear move in.",
        principles: [
          "Whatever thought dominates gets acted on — so choose the dominant one.",
          "Emotion is the fuel; a thought felt strongly sinks in deeper than a flat one.",
          "You crowd out negative thoughts by filling the space with positive ones, not by fighting them head-on.",
        ],
        wrong: "People let worry and fear become their dominant feelings, then act out of exactly those feelings without realizing why.",
        oneMission: "Feed your mind daily positive inputs — your aim, wins, good associations, uplifting content — so your dominant thoughts support building.",
        today: "Replace one negative input today with a positive one and end the day writing down a single win.",
      },
      why: "Your dominant emotions steer your behavior more than your logic does. If fear and worry are what you feel most, you'll act cautious, avoidant, and small — even if you 'know better.' This lesson matters because you can't just delete negative feelings, but you can decide what dominates by controlling your inputs. Fill your mind with the right thoughts and emotions, and the confident, consistent actions follow much more naturally.",
      principle: "The subconscious acts on the thoughts and emotions that dominate the conscious mind, especially those charged with strong feeling. Hill's practical takeaway: you cannot leave the subconscious idle, and you can't win by fighting negative thoughts directly — you displace them by making positive, purposeful thoughts dominant through repetition and emotion.",
      beginner: "Think about a garden. If you don't plant anything, weeds grow on their own — you don't have to do a thing. The only way to have flowers is to plant them and tend them. Your mind is the same: leave it alone and worry grows like weeds. Feed it good thoughts on purpose, repeatedly, and those crowd the weeds out.",
      example: "New builder Priya noticed she felt anxious and defeated most days, and it showed in how timidly she reached out. Her coach helped her audit her inputs: doom-scrolling the news at breakfast, cynical group chats, comparing herself online at night. She swapped the morning scroll for her aim and one uplifting lesson, muted the cynical chat, and ended each day writing one win. Within two weeks her dominant mood shifted, and her outreach got noticeably braver.",
      whatNotToSay: [
        "\"I can't help how I feel.\" (You can't force a feeling, but you strongly influence it through your inputs.)",
        "\"I'll just try to stop thinking negative thoughts.\" (Fighting them head-on rarely works — displace them instead.)",
        "\"A little constant worry keeps me sharp.\" (Dominant worry mostly makes you cautious and small.)",
      ],
      mistakes: [
        "Letting fear and worry become the dominant feelings by default.",
        "Trying to fight negative thoughts directly instead of crowding them out.",
        "Feeding the mind constant negative inputs, then wondering why motivation is low.",
        "Thinking positive thoughts once and expecting them to stick without repetition or emotion.",
      ],
      application: "In One Mission, your dominant emotional state shapes how you show up — brave and warm, or anxious and small. Manage it like a pro: start the day with your aim and one positive input, keep good company in the community, celebrate small wins so your mind has positives to dominate on, and limit the inputs that leave you cynical or comparing. You're not faking happiness — you're deciding what gets the most airtime in your head, because that's what your actions will follow.",
      practice: "Audit your inputs for one day: what you watch, read, scroll, and who you talk to. Mark each as feeding you fuel or draining you. Cut or reduce one draining input and add one fueling one (your aim, an uplifting lesson, a supportive teammate). End the day by writing one win, however small.",
      action: "Swap one negative daily input for a positive one today, and write down one win before bed.",
      quiz: [
        {
          q: "You feel anxious and small most days, and it's making your outreach timid. What does this principle recommend?",
          options: [
            "Just force yourself to stop feeling anxious through willpower.",
            "Deliberately manage your inputs and add positive, purposeful thoughts so they become dominant.",
            "Accept that your feelings are fixed and work around them forever.",
          ],
          correct: 1,
          why: "You can't win by fighting feelings head-on or by forcing them off, and they aren't fixed. You displace fear by making positive, purposeful thoughts dominant through better inputs and repetition.",
        },
      ],
      resource: [TGR_AUDIO],
    },
    {
      id: "tgr-fears",
      num: 11,
      title: "The Six Ghosts of Fear",
      minutes: 9,
      five: {
        bigIdea: "Six common fears — poverty, criticism, ill health, lost love, old age, and death — sabotage action from the shadows. Naming them robs them of power, and for most builders the biggest one is the fear of criticism: what people will think.",
        principles: [
          "Fears operate in the dark; naming the exact fear shrinks it.",
          "Fear of criticism — worrying what people think — stops more action than any real risk.",
          "Courage isn't the absence of fear; it's taking the action while the fear is present.",
        ],
        wrong: "People let unnamed fear masquerade as 'being realistic' and quietly avoid the very actions that would move them forward.",
        oneMission: "Name the specific fear that stops you from inviting, and use the scripts and community to act anyway.",
        today: "Name the one fear that most holds you back in One Mission, write it down, and take one action in spite of it.",
      },
      why: "Fear is the invisible hand behind most avoidance. You tell yourself you're 'not in the mood' or 'being realistic,' but underneath is usually one of these six ghosts — and for people building a business, it's most often the fear of criticism: what will my friends think, what if people judge me, what if I look foolish. This lesson matters because you can't beat an enemy you won't name. Once you can say exactly what you're afraid of, it loses its grip and you can choose to act anyway.",
      principle: "Hill named six basic fears — poverty, criticism, ill health, loss of love, old age, and death — that undermine achievement, usually operating below conscious awareness. The remedy isn't to feel no fear (that's not possible) but to identify the specific fear, see it clearly for what it is, and take purposeful action despite it. Fear of criticism, in particular, is what keeps most people small and quiet.",
      beginner: "Think about a shadow on the wall that scares a kid at night. The moment the light comes on and they see it's just a coat on a chair, the fear drains away. Naming a fear is turning the light on. \"I'm scared people will judge me for building this\" — said out loud — is a coat on a chair, not a monster. And you can walk right past a coat.",
      example: "New builder Marcus kept 'planning' to invite people but never did. When his coach gently pressed, the truth came out: he was terrified his old friends would think he'd 'joined something weird' and laugh at him. That's fear of criticism. Naming it out loud made it smaller. His coach gave him low-pressure scripts and reminded him that a few people's opinions don't get to run his life. He sent five invites that week — nervous, but he did it anyway.",
      whatToSay: [
        { label: "Reframing fear of what people think", text: "I'm reaching out to people I care about with something worth a look. If someone judges me for trying to build a better life, that's about them, not me. Their opinion doesn't get a vote in my future." },
        { label: "A low-pressure invite when you're scared of judgment", text: "Hey, I'm working on something new and you came to mind. Not sure it's for you, but would you be open to taking a quick look? Totally fine either way." },
      ],
      whatNotToSay: [
        "\"I'm just being realistic\" (when you're actually avoiding out of fear). (Name the fear honestly instead.)",
        "\"If even one person judges me, I can't do this.\" (A few opinions don't get to run your life.)",
        "\"I'll invite people once I'm not nervous anymore.\" (Courage is acting while nervous — the nerves may never fully leave.)",
      ],
      mistakes: [
        "Letting unnamed fear disguise itself as 'being realistic' or 'not in the mood.'",
        "Letting fear of criticism — what people think — silence you completely.",
        "Waiting to feel fearless before acting, instead of acting while afraid.",
        "Giving a handful of potential critics veto power over your whole future.",
      ],
      application: "In One Mission, the fear of criticism is the number-one silent killer of activity. It shows up as not posting, not inviting, not going live — all rationalized as something else. Beat it the professional way: name it out loud, use the low-pressure invitation scripts so you're offering a look rather than 'selling,' and lean on your community of people who've felt the exact same fear. You'll rarely feel zero fear; the win is inviting anyway. A few people's opinions are a poor reason to abandon your definite chief aim.",
      practice: "Write down the specific fear that most stops you in your business — be honest; it's often 'I'm afraid people will judge me.' Underneath it, write the truthful reframe (whose opinion actually gets to run your life?). Then pick one small action that fear has been blocking and do it today, nervous and all.",
      roleplay: { scenario: "Handling fear of what people think when inviting", opener: "Wait, is this one of those things? What are your other friends going to say when they see you posting about this?" },
      action: "Name your biggest fear in One Mission today, write its reframe, and take one action you've been avoiding because of it.",
      quiz: [
        {
          q: "You keep 'planning' to invite people but never do, telling yourself you're 'just being realistic.' What's likely really happening?",
          options: [
            "You've made a sound, fear-free strategic choice to wait.",
            "An unnamed fear — probably fear of criticism — is disguised as being realistic, and naming it plus acting anyway is the fix.",
            "You simply need more training before you're allowed to invite anyone.",
          ],
          correct: 1,
          why: "'Being realistic' is a common mask for fear of criticism. The remedy is to name the specific fear so it shrinks, then take the action anyway — courage is acting while afraid, not waiting to feel fearless.",
        },
        {
          q: "A prospect hints your friends might judge you for building this. What's the grounded response?",
          options: [
            "Agree that their judgment would be unbearable and back off.",
            "Remember a few people's opinions don't get to run your future, and keep offering a low-pressure look.",
            "Insist loudly that no one will ever judge you.",
          ],
          correct: 1,
          why: "Fear of criticism loses its grip when you recognize that other people's opinions don't get a vote in your life. You stay in posture and keep offering a look — not defensive, not backing off.",
        },
      ],
      resource: [TGR_TEXT],
    },
    {
      id: "tgr-onemission",
      num: 12,
      title: "The Principles, Applied to One Mission",
      minutes: 10,
      five: {
        bigIdea: "The principles only matter when they're stacked together and lived daily. Put all twelve to work on building One Mission and they stop being ideas and become the way you operate.",
        principles: [
          "Stack the principles: aim, faith, plan, decision, and persistence work as one system.",
          "Turn each principle into a repeatable daily habit inside your Daily Method.",
          "Apply it ethically — real growth and honest offers, never hype or promises.",
        ],
        wrong: "People treat these principles as inspiring reading, nod along, and never convert a single one into a daily habit.",
        oneMission: "Build your One Mission operating system: a written aim, a belief statement, a weekly plan, a firm decision, and a persistence commitment — all tracked in the Academy.",
        today: "Combine your aim, plan, and persistence commitment into one written One-Page One Mission plan today.",
      },
      why: "A study like this is worthless if it stays in your head. The whole point of these lessons is a changed life, and change only comes from application. This final lesson matters because it's where you stop learning and start operating — where the abstract ideas of desire, faith, and persistence become the concrete, boring, powerful things you actually do every day to build One Mission. The people who transform their lives aren't the ones who read the most; they're the ones who apply what they read.",
      principle: "The principles are a system, and their power is cumulative: a definite chief aim gives you direction, faith and autosuggestion give you belief, specialized knowledge and imagination give you a plan, decision and organized planning get you moving, and persistence, your mastermind, a managed mind, and conquered fears keep you moving. Applied together and daily — and always ethically — they become an operating system for building. Read alone, they change nothing.",
      beginner: "Think about ingredients versus a meal. Flour, eggs, and sugar sitting separately on the counter don't feed anyone. Combined and baked, they become a cake. These twelve principles are ingredients — inspiring on their own, but nourishing only when you combine them and 'bake' them into daily action. This lesson is about actually making the meal.",
      example: "New builder Ana finished this study and, instead of just feeling motivated, spent one hour building her operating system: her definite chief aim at the top, a short belief statement, a weekly plan with real numbers, a firm decision with a start date, and a 30-day persistence commitment. She pinned it where she'd see it daily and plugged into her One Mission mastermind. Ninety days later she wasn't a different person — she was the same person, finally operating on purpose, with her first small team to show for it.",
      whatToSay: [
        { label: "Sharing the mindset with a teammate (ethically)", text: "The biggest shift for me was treating this like a system, not a mood: a clear aim, a real plan, and just not quitting through the slow parts. No hype, no promises — just showing up and getting a little better. Want to build our One-Page plans together this week?" },
      ],
      whatNotToSay: [
        "\"Just think positive and the money will come.\" (That's magical thinking and an income claim — not what any of this teaches.)",
        "\"I read the whole thing, so I'm basically there.\" (Reading isn't applying; the habits are the point.)",
        "\"Follow this and you're guaranteed to get rich.\" (No guarantees, ever — 'grow rich' means grow as a person and a builder.)",
      ],
      mistakes: [
        "Treating the principles as inspiration to feel, not habits to build.",
        "Applying one principle in isolation instead of stacking them into a system.",
        "Slipping into hype or income claims when sharing the mindset with others.",
        "Finishing the study and never writing your One-Page operating plan.",
      ],
      application: "This is where One Mission becomes your proving ground for everything you've learned. Build your operating system on one page: your definite chief aim (Lesson 1), a belief statement (Lessons 2–3), your specialized-knowledge path and imagined plan (Lessons 4–6), a firm decision with a start date (Lesson 7), a persistence commitment (Lesson 8), your mastermind plug-in (Lesson 9), a mind-management routine (Lesson 10), and your named fear with its reframe (Lesson 11). Then live it daily and track it in the Academy. Always ethically: you're offering people a genuine look and honest growth, never promises of money.",
      practice: "Build your One-Page One Mission operating plan now, pulling one line from each lesson in this study. Keep it to a single page so you'll actually read it daily. Pin it where you start your day, and review it every morning for the next 30 days.",
      action: "Create your One-Page One Mission operating plan today and read it first thing tomorrow morning.",
      quiz: [
        {
          q: "You've finished all twelve lessons and feel inspired. What actually determines whether your life changes?",
          options: [
            "Having read and understood every principle.",
            "Converting the principles into a daily operating system you actually live and track.",
            "Feeling motivated for the next few days.",
          ],
          correct: 1,
          why: "Understanding and motivation fade. Change comes only from application — turning the principles into daily habits you live and track. Reading alone changes nothing.",
        },
        {
          q: "A teammate asks how to share this mindset with prospects. What's the ethical guidance?",
          options: [
            "Promise them they'll get rich if they follow the principles.",
            "Frame it as honest personal growth and an invitation to look — no hype, no income guarantees.",
            "Tell them to just think positive and the money will appear.",
          ],
          correct: 1,
          why: "'Grow rich' here means growing as a person and builder. Ethical application means honest growth and a genuine offer to look — never income claims, guarantees, or magical thinking.",
        },
      ],
      resource: [TGR_AUDIO],
    },
  ],
  workbook: {
    id: "tgr-workbook",
    title: "One Mission Success Principles Workbook",
    sections: [
      { title: "My Definite Chief Aim", fields: [{ id: "aim", label: "My one definite chief aim for One Mission (specific outcome + first milestone + date)", hint: "One clear sentence you'd know the moment you hit it." }] },
      { title: "My Burning Desire", fields: [{ id: "desire", label: "The honest, personal reason I want this badly enough to keep going", hint: "The real why behind the aim — make it yours, not borrowed." }] },
      { title: "My Belief Statement", fields: [{ id: "belief", label: "A true, encouraging statement about the builder I'm becoming (no hype, no income claims)" }] },
      { title: "My Daily Autosuggestion Script", fields: [{ id: "autosuggestion", label: "The short script I'll read out loud every morning and night" }] },
      { title: "My Specialized Knowledge Path", fields: [{ id: "knowledge", label: "The next Academy lessons I'll complete, and how I'll apply each one the same day" }] },
      { title: "My Imagined Plan", fields: [{ id: "imagination", label: "My ideal building week, pictured in detail — days, activities, and how it feels" }] },
      { title: "My Organized Weekly Plan", fields: [{ id: "plan", label: "This week's specific One Mission activities, numbers, and days", hint: "Reach-outs, follow-ups, invites, events — with real numbers." }] },
      { title: "My Decision & Start Date", fields: [{ id: "decision", label: "The commitment I'm deciding now, and the date I start (and stop renegotiating it)" }] },
      { title: "My Mastermind", fields: [{ id: "mastermind", label: "The One Mission people and community I'll plug into, and how I'll contribute value" }] },
      { title: "My Mind Management", fields: [{ id: "mind", label: "The negative input I'm cutting, the positive input I'm adding, and where I'll log daily wins" }] },
      { title: "Fears to Overcome", fields: [{ id: "fears", label: "My biggest fear that blocks action (often fear of criticism), and its truthful reframe" }] },
      { title: "My 30-Day Persistence Challenge", fields: [{ id: "persistence", label: "My 'minimum day' Daily Method I promise to do for 30 straight days no matter what, and my accountability partner", hint: "Make it small enough to do on your worst, busiest day — then never drop below it." }] },
    ],
  },
};

// ═══════════════════════════════ STRANGEST ═══════════════════════════════
const SS_AUDIO = { label: "The Strangest Secret — original recording (archive.org)", url: "https://archive.org/details/lp_the-strangest-secret_earl-nightingale_4", kind: "listen" as const };

// ═══════════════════════════════ THE STRANGEST SECRET ═══════════════════════════════
const STRANGEST_SECRET: Masterclass = {
  id: "strangest-secret",
  teacher: "Earl Nightingale",
  book: "The Strangest Secret",
  title: "The Strangest Secret — Become What You Think About",
  subtitle: "The one idea that quietly shapes your whole life — and a 30-day challenge to prove it.",
  category: "Mindset",
  accent: "#0891b2",
  minutes: "40–60 min",
  overview:
    "Earl Nightingale spent years asking why a few people succeed while most drift — and landed on one plain idea: we become what we think about most of the time. This masterclass turns that idea into something you can actually use, not something vague you nod at. You will learn how your dominant thoughts steer your goals, your attitude, and your daily actions, and then you will run Nightingale's built-in 30-day challenge to test it on your own One Mission building. No magic, no wishing on the universe — just directed thinking that pulls real action out of you.",
  original: [SS_AUDIO],
  lessons: [
    {
      id: "ss-secret",
      num: 1,
      title: "The Secret: We Become What We Think About",
      minutes: 9,
      five: {
        bigIdea: "Your mind grows whatever you plant in it most often. The thought you return to again and again quietly becomes the direction of your life.",
        principles: [
          "You become what you think about most of the time — for better or worse.",
          "The mind is like fertile soil: it grows any seed you keep planting, weeds or crops alike.",
          "You can't stop thinking, so the only real choice is what you deliberately feed your mind.",
        ],
        wrong: "Most people believe their circumstances create their thoughts, so they wait for life to change before they'll think differently — and stay stuck.",
        oneMission: "Decide the one dominant thought you want to hold about your One Mission building, and start feeding it on purpose today.",
        today: "Write one sentence describing the builder you intend to become, and read it out loud three times.",
      },
      why: "This is the idea everything else rests on. If your dominant thoughts are worry, doubt, and 'this probably won't work,' you'll quietly act that way — you'll skip the follow-up, avoid the invite, and call it 'being realistic.' When you understand that your steady thoughts are actually steering the wheel, you stop leaving that steering to accident. It matters because you're already thinking about something all day long; you might as well aim it.",
      principle: "Nightingale's core teaching is that a human being literally becomes what they think about most of the time. Not what they think about once, and not what they wish for — what occupies their mind day after day. Because the mind will always be busy with something, the disciplined person chooses that 'something' deliberately and returns to it on purpose, instead of letting fear and random noise choose it for them.",
      beginner: "Think of your mind as a garden with rich, ready soil. That soil doesn't judge what you plant — it will grow tomatoes if you plant tomato seeds, and it will grow weeds just as eagerly if that's what falls in. Your dominant thoughts are the seeds. If you keep dropping in 'I'm not good at this,' the soil grows that. If you keep planting 'I'm becoming a steady builder,' it grows that instead. The gardener's only job is choosing the seeds and pulling the weeds.",
      example: "New builder Ana kept telling herself, 'I'm just not a salesperson, I'll probably quit like everyone does.' Without noticing, she acted like it — she let messages sit, skipped the team call, and treated every 'no' as proof. Her coach had her swap that seed for one line she repeated each morning: 'I'm becoming someone people trust to follow through.' Nothing magic happened overnight, but within two weeks she noticed she was actually answering messages, because the thought she was feeding now expected it of her.",
      whatToSay: [
        { label: "Your dominant-thought sentence", text: "I am becoming a builder who shows up every day, tells the truth, and helps people take a look — and I get a little better at it each week." },
        { label: "When a doubt shows up", text: "That's an old weed, not a fact. Here's what I'm actually planting: I follow through and I keep going." },
      ],
      whatNotToSay: [
        "\"I'll start thinking positive once I actually get results.\" (Backwards — the thinking comes first and pulls the action.)",
        "\"I'm just being realistic about how bad I am at this.\" (Repeating that is planting the weed on purpose.)",
        "\"Positive thinking is nonsense.\" (This isn't wishing — it's choosing the thought that drives your next action.)",
      ],
      mistakes: [
        "Waiting for circumstances to improve before changing your thinking.",
        "Confusing this with magic — expecting thoughts alone to deliver results without any action.",
        "Planting a great thought once and never returning to it, so the old weeds grow back.",
      ],
      application: "In One Mission, your dominant thought about building is the quiet setting behind every daily choice — whether you send the invite, make the follow-up, or hide. Pick one clear thought about the builder you're becoming and plant it every morning before you open the app. That single habit shapes the Daily Method more than any script, because it decides whether you even show up to run it.",
      practice: "Write down the thought you've actually been feeding yourself about building (be honest — is it a crop or a weed?). Then write the thought you want to grow instead, in one plain sentence. Put the new sentence somewhere you'll see it first thing tomorrow.",
      action: "Write your one dominant-thought sentence today and read it out loud three times, morning and night.",
      quiz: [
        {
          q: "You catch yourself thinking 'I'll never be good at inviting people.' Based on this lesson, what's the professional move?",
          options: [
            "Accept it as an honest fact about yourself and lower your goals.",
            "Notice it as a weed, and deliberately replace it with the thought you actually want to grow.",
            "Wait until you get a few yeses, then start thinking positively.",
          ],
          correct: 1,
          why: "The mind grows whatever you keep planting. Repeating 'I'll never be good' plants that seed. You can't stop thinking, so you replace the weed on purpose with the thought that drives the action you want.",
        },
        {
          q: "What does 'we become what we think about' actually mean here?",
          options: [
            "If you wish hard enough, things appear without any effort.",
            "Your dominant, repeated thoughts steer your daily actions, which shape your results over time.",
            "You only need to think a good thought once for it to work.",
          ],
          correct: 1,
          why: "This is directed thinking, not magic. The thought you return to most often quietly guides what you do each day — and the actions, not the wish, produce the results.",
        },
      ],
      resource: [SS_AUDIO],
    },
    {
      id: "ss-goal",
      num: 2,
      title: "Think Toward a Goal",
      minutes: 9,
      five: {
        bigIdea: "A person who knows exactly where they're going succeeds because their mind has a target to organize around. Without a goal, thinking just drifts.",
        principles: [
          "Success is the steady progress toward a goal you've chosen — not a lucky arrival.",
          "A clear goal gives your dominant thoughts a direction to point.",
          "Drifting thinking reacts to whatever shows up; directed thinking moves toward something on purpose.",
        ],
        wrong: "Most people never set a real goal, so their thinking drifts from distraction to distraction and they wonder why they never get anywhere.",
        oneMission: "Choose one clear, specific One Mission goal and write it where your dominant thoughts can lock onto it.",
        today: "Write down one specific goal for the next 90 days in a single, concrete sentence.",
      },
      why: "A goal turns 'become what you think about' from a nice phrase into a working tool, because now your thoughts have somewhere to go. Without a goal, even good thinking wanders — you're busy but not moving. With one, your mind starts quietly noticing the people, ideas, and next steps that fit it. It matters because directed thinking feels completely different from drifting: one pulls you forward, the other just fills the day.",
      principle: "Nightingale defined success as the progressive realization of a worthy goal — meaning the successful person is simply someone deliberately moving toward something they chose. The power isn't in the goal being big; it's in the goal being clear enough that your dominant thoughts can organize around it. A mind with a target sorts everything it meets by 'does this move me closer or not,' while a mind without one just reacts.",
      beginner: "Imagine getting in a car with no destination. You'd start the engine, drive around, turn when you felt like it, and end up wherever — probably close to where you began. Now imagine you have a real address typed in. Every turn has a reason, and you can tell if you're getting closer. A goal is that address for your thinking. Same engine, same roads — but now the driving actually takes you somewhere.",
      example: "New builder Marcus 'wanted to do well' but couldn't say what that meant, so his effort scattered — some days all-in, most days nothing. His coach had him write one concrete goal: 'Help five people take a look each week for the next 90 days.' Suddenly his thinking had a filter. When he met someone new, part of his mind quietly asked, 'Could this be one of my five this week?' He wasn't working harder — his thoughts were finally pointed at something.",
      whatToSay: [
        { label: "Writing a clear goal", text: "In the next 90 days I will personally help [number] people take a look, and I'll show up for my Daily Method [number] days a week — and I'll know I'm on track by checking it every week." },
        { label: "Reminding yourself of the target", text: "Does this move me toward my goal or away from it? If it doesn't move me closer, it can wait." },
      ],
      whatNotToSay: [
        "\"I just want to be successful someday.\" (Too vague for your mind to aim at — no address typed in.)",
        "\"I'll figure out my goal once things get going.\" (The goal is what gets things going.)",
        "\"My goal is to get rich.\" (That's a wish about an outcome, not a clear, directed target you can act on this week.)",
      ],
      mistakes: [
        "Setting no goal at all and calling constant busyness 'progress.'",
        "Making the goal so vague ('do well,' 'be successful') that thinking can't organize around it.",
        "Setting the goal once and never looking at it, so your thoughts drift back to reacting.",
      ],
      application: "In One Mission, a clear goal is what makes the Daily Method feel like it's going somewhere instead of a chore. Write a specific building goal — how many people you'll help take a look each week, how many days you'll show up — and keep it in front of you. When your dominant thought is aimed at that target, you naturally start noticing prospects and next steps that fit it, and you stop drifting between random tasks.",
      practice: "Write one specific 90-day building goal in a single sentence, using real numbers. Then ask: could I honestly tell each week whether I'm getting closer? If not, sharpen it until you could.",
      action: "Write your one specific goal today and put it somewhere you'll read it every morning this week.",
      quiz: [
        {
          q: "Two builders both 'want to succeed.' One writes 'help five people take a look each week for 90 days'; the other keeps it as 'do well.' Why does the first tend to move faster?",
          options: [
            "Because writing goals is a lucky ritual that attracts success.",
            "Because a clear, specific goal gives their dominant thoughts a target to organize daily actions around.",
            "Because five is a magic number.",
          ],
          correct: 1,
          why: "A specific goal turns drifting thinking into directed thinking. The mind starts sorting people and choices by whether they move it closer — vague wishes give it nothing to aim at.",
        },
      ],
      resource: [SS_AUDIO],
    },
    {
      id: "ss-attitude",
      num: 3,
      title: "Attitude Is Everything",
      minutes: 9,
      five: {
        bigIdea: "Your attitude toward your work and the people in it quietly decides your results — and your attitude is one of the few things you fully control.",
        principles: [
          "Your attitude toward your business and people shapes how they respond to you.",
          "Attitude isn't handed to you by circumstances — you choose and feed it, like any dominant thought.",
          "The attitude you carry into a conversation usually comes back to you from it.",
        ],
        wrong: "Most people treat their attitude as a weather report caused by events, instead of a choice they're responsible for.",
        oneMission: "Choose the attitude you'll bring to every One Mission conversation before it starts, instead of letting the last 'no' set it for you.",
        today: "Before your next conversation, decide on purpose: 'I'm bringing genuine warmth and belief into this,' and notice what changes.",
      },
      why: "Attitude matters because it's contagious and it shows, even through a text. If you approach people as if you're bothering them or as if it won't work, they feel it and mirror it back. If you carry genuine belief and care, that comes back too. This is 'become what you think about' pointed straight at people: the dominant thought you hold about your business becomes the energy you hand to everyone you talk to.",
      principle: "Nightingale taught that our attitude toward life determines life's attitude toward us — we tend to get back the spirit we put out. Attitude is not a reaction you're stuck with; it's a dominant thought you choose and maintain. The professional decides in advance what attitude they'll carry into their work and their conversations, rather than letting the last setback or a rough morning decide it for them.",
      beginner: "Think about walking into a room and smiling warmly at someone — most of the time, they smile back. Now picture walking in with a scowl; you tend to get a cold response. People reflect what you bring. Your attitude is like that smile, except it's running all day, in every message and call. If you bring 'glad to talk to you, I believe in this,' people feel it. If you bring 'sorry to bother you, this probably won't work,' they feel that too — and hand it right back.",
      example: "New builder Ana had three people not reply, and by the fourth message she was radiating 'you probably don't want this either.' Her prospect felt the flatness and said no. Her coach pointed out the attitude was leaking into the words. Ana reset before the next one — she reminded herself she genuinely liked this person and believed a look could help them — and wrote from that. Same script, completely different tone. The reply that time was warm and curious, because the attitude she brought is what she got back.",
      whatToSay: [
        { label: "Attitude reset before a conversation", text: "I like this person, I believe a look could genuinely help them, and I'm glad to reach out. Whatever they decide is fine." },
        { label: "After a string of no-replies", text: "The last three don't get to set my attitude for this one. I'm bringing fresh warmth to this person — they deserve my best, not my leftovers." },
      ],
      whatNotToSay: [
        "\"Sorry to bug you with this, you probably don't want it...\" (You just handed them your low attitude to reflect back.)",
        "\"Everyone keeps saying no, but whatever, here it is.\" (Your dominant thought is leaking straight into the message.)",
        "\"They ruined my whole day by not answering.\" (That hands your attitude to someone else to control.)",
      ],
      mistakes: [
        "Treating attitude as something events do to you, instead of something you choose.",
        "Letting the last rejection set the tone for the next fresh conversation.",
        "Faking enthusiasm on the surface while the real dominant thought underneath is doubt — people feel the mismatch.",
      ],
      application: "In One Mission, you're in a people business, and your attitude travels through every invite, follow-up, and 3-way. Decide before you open the app what attitude you're bringing — genuine belief and care — so the last 'no' doesn't quietly poison the next conversation. When you control your attitude on purpose, your Daily Method stops swinging with your mood, and the people you talk to feel someone steady and warm, which is exactly what makes them open to a look.",
      practice: "Think of your last three conversations. For each, name the attitude you actually brought and how the person responded. Then write the attitude you'll deliberately bring to your next three, before they happen.",
      action: "Before your very next One Mission conversation today, decide your attitude out loud, then notice how the person responds to it.",
      roleplay: {
        scenario: "Resetting your attitude before reaching out after several no-replies",
        opener: "Ugh, three people ignored me already. Why would this next person be any different?",
      },
      quiz: [
        {
          q: "You've had four people not reply and you're about to message a fifth. What does this lesson say to do?",
          options: [
            "Send it with your current frustrated attitude — they'll never know.",
            "Deliberately reset to genuine warmth and belief before you write, since the attitude you bring tends to come back to you.",
            "Skip it for the day; your attitude doesn't affect a text.",
          ],
          correct: 1,
          why: "Attitude is contagious and shows even in writing. You get back the spirit you put out, so you choose the attitude on purpose instead of letting the last four no-replies set it.",
        },
      ],
      resource: [SS_AUDIO],
    },
    {
      id: "ss-action",
      num: 4,
      title: "Act As If & Take Action",
      minutes: 9,
      five: {
        bigIdea: "Thoughts only become results when they're paired with action. You behave your way into becoming the builder you're thinking about.",
        principles: [
          "A dominant thought without action is just a daydream — action is what makes it real.",
          "Act as if you're already the builder you intend to become, and let the behavior lead.",
          "Small daily actions, repeated, are how a thought turns into a person.",
        ],
        wrong: "Most people think this idea means 'just think about it hard enough,' so they wait and wish instead of doing — and nothing changes.",
        oneMission: "Take the one action today that the builder you're becoming would take, even before you feel like that person.",
        today: "Do one concrete building action right now that matches your dominant thought — one invite, one follow-up.",
      },
      why: "This is the guardrail that keeps 'become what you think about' honest. The idea is powerful and easy to twist into lazy wishing, but Nightingale never meant thought replaces work — he meant thought directs work. Action matters because it's the bridge; the thought sets the direction and the action carries you there. And there's a bonus: acting like the builder you want to be actually reinforces the thought, so behavior and belief pull each other forward.",
      principle: "Directed thinking has to be paired with directed action, or it produces nothing. Nightingale's point is that the person who thinks toward a goal will be moved to act toward it — the thought stirs the doing. You don't wait to feel confident before you behave like a builder; you act as if you already are one, and the actions build the very identity your thoughts described. Belief and behavior reinforce each other in a loop.",
      beginner: "Picture wanting to get fit. You can think about being fit all day, picture yourself strong, feel great about it — and change nothing, because thinking about push-ups builds zero muscle. The thought only matters when it gets you onto the floor doing one. But here's the good part: after you do a few, you start to feel like 'someone who works out,' which makes the next session easier. The action feeds the identity, and the identity feeds the next action.",
      example: "New builder Marcus loved thinking about being a top builder — he'd picture the team, the recognition, all of it. Weeks passed and his numbers were zero, because the thought never left his head. His coach gave him one rule: 'Do one thing today the builder you're imagining would do.' That day it was a single invite. It felt awkward, but afterward he genuinely felt more like a builder, so the next day two invites felt normal. The thought only started changing his life once it walked out of his head as action.",
      whatToSay: [
        { label: "Prompt to yourself before acting", text: "What would the builder I'm becoming do right now? Okay — I'll do that one thing, even though I don't fully feel like that person yet." },
        { label: "Acting as if, in a real invite", text: "Hey, I'm building something I believe in and you came to mind — would you be open to taking a quick look?" },
      ],
      whatNotToSay: [
        "\"I'll take action once I feel confident and ready.\" (The action is what builds the confidence — waiting keeps you stuck.)",
        "\"If I just visualize it enough, it'll happen.\" (That's the lazy twist of the idea — thought directs work, it doesn't replace it.)",
        "\"I thought about my goal all day, so I basically worked on my business.\" (Thinking isn't doing — no invite went out.)",
      ],
      mistakes: [
        "Treating visualization as a substitute for action instead of a prompt for it.",
        "Waiting to feel like the builder before behaving like one — it's backwards.",
        "Taking one big burst of action, then stopping, instead of small repeated actions that compound.",
      ],
      application: "In One Mission, the whole game is turning your dominant thought into a Daily Method you actually run. Each day, ask what the builder you're becoming would do, then do that one concrete thing — an invite, a follow-up, a 3-way — before you feel ready. Acting as if isn't pretending; it's letting your behavior catch up to your thinking. Every rep both moves your business and strengthens the identity, so tomorrow's action comes easier.",
      practice: "Write the one dominant thought you're growing about yourself as a builder. Underneath it, list three specific actions that a person with that thought would take this week. Circle the smallest one and do it today.",
      action: "Do one concrete building action today — one invite or one follow-up — that matches the builder you're becoming, even before you feel like that person.",
      roleplay: {
        scenario: "Acting as if you're already a steady builder while sending a first invite you feel nervous about",
        opener: "I don't know, I don't really feel like the kind of person who does this yet — what do I even say?",
      },
      quiz: [
        {
          q: "A builder spends every day picturing success but takes no action and sees no results. What went wrong, according to this lesson?",
          options: [
            "They didn't visualize hard enough or in enough detail.",
            "They treated thinking as a replacement for action, when the thought is meant to direct action.",
            "Nothing — results just take longer for some people.",
          ],
          correct: 1,
          why: "Nightingale's idea is directed thinking paired with directed action. The thought sets the direction, but only the action carries you there. Visualizing without doing is the lazy twist of the idea.",
        },
        {
          q: "You don't yet feel like a confident builder. What's the move?",
          options: [
            "Wait until the confidence shows up, then start acting.",
            "Act as if you're already that builder — take the small action now — and let the behavior build the confidence.",
            "Only act on days you happen to feel motivated.",
          ],
          correct: 1,
          why: "Confidence follows action, not the other way around. Acting as if lets your behavior build the identity your thoughts are describing, so each rep makes the next one easier.",
        },
      ],
      resource: [SS_AUDIO],
    },
    {
      id: "ss-30day",
      num: 5,
      title: "The 30-Day Challenge (The Test)",
      minutes: 10,
      five: {
        bigIdea: "Nightingale's challenge is a 30-day test: hold one goal in mind, act on it daily, and replace every fearful thought with your goal — and see what changes.",
        principles: [
          "For 30 days, keep one chosen goal in front of your mind every single day.",
          "Each day, take at least one action toward that goal, and swap any negative or fearful thought for the goal the moment it appears.",
          "If you slip and forget or fall into worry, don't quit — just start the count fresh and keep going.",
        ],
        wrong: "Most people treat this as a mood challenge ('feel positive for 30 days') instead of a discipline of replacing thoughts and acting daily.",
        oneMission: "Run the 30-day test on one One Mission goal, letting the app track your day counter and streak.",
        today: "Choose your one goal for the challenge, write it on a card, and begin Day 1 today.",
      },
      why: "Ideas mean nothing until you test them on yourself, and that's exactly what this challenge is for. Thirty days is long enough to prove to you — not to anyone else — that directed thinking pulls real action out of you and changes your results. It matters because belief built from your own experiment is unshakable. After you've done it once, 'we become what we think about' stops being a quote and becomes something you've watched happen in your own building.",
      principle: "The test is a simple, strict discipline run for 30 days. You choose one clear goal and keep it in the front of your mind daily — writing it down and reading it helps. You take at least one action toward it every day, so thought stays married to action. And whenever a negative, doubtful, or fearful thought shows up, you replace it right away with the picture of your goal instead of feeding it. The rule that makes it work is the recovery rule: if you slip — a day of worry, a day you forgot — you don't declare failure, you simply start the 30-day count over and continue. The point isn't a perfect streak; it's training your dominant thought until directed thinking becomes your default.",
      beginner: "Think of it like starting a daily workout streak, but for your thinking. Each morning you look at your one goal — that's stretching before the run. Each day you do one action toward it — that's the workout. And every time a 'this won't work' thought sneaks in, you swap it for your goal — that's catching bad form before it causes an injury. If you miss a day, you don't throw out the whole plan; you just start counting again from Day 1. Thirty clean days in a row is the target, and the restarting is part of the training, not a sign you failed.",
      example: "New builder Ana started her 30 days with the goal 'I'm becoming a builder who helps five people take a look each week.' She wrote it on a card, read it each morning, and did one building action daily. On Day 9 she spiraled into 'nobody's going to say yes' and skipped her follow-ups. Old Ana would have quit. Instead she used the recovery rule: reset to Day 1 the next morning, no shame, and kept going. By her second run past Day 20, catching and swapping the fearful thoughts had become automatic — and so had opening the app. She'd proven the secret to herself.",
      whatToSay: [
        { label: "Your daily goal card", text: "For the next 30 days I am becoming a builder who [your goal]. I hold this in mind, I act on it daily, and I trade every fearful thought for this picture." },
        { label: "The instant-replace move", text: "Stop — that's a fear thought. Here's the picture I'm holding instead: I'm becoming a builder who follows through and helps people take a look." },
        { label: "The recovery rule after a slip", text: "I slipped yesterday, and that's part of the training, not the end of it. Today is Day 1 again. Keep going." },
      ],
      whatNotToSay: [
        "\"I broke my streak, so the whole thing is ruined and I quit.\" (The recovery rule exists precisely for this — reset and continue.)",
        "\"I'll just try to feel positive for a month.\" (This is a discipline of replacing thoughts and acting daily, not a mood.)",
        "\"I don't need to write the goal down, I'll remember it.\" (Writing and re-reading is how you keep it in front of your mind.)",
      ],
      mistakes: [
        "Treating it as a feelings challenge instead of a daily thought-replacement plus one action.",
        "Quitting entirely after a slip instead of using the recovery rule to reset the count.",
        "Choosing a fuzzy goal you can't picture clearly, so there's nothing solid to replace the fear thoughts with.",
        "Keeping the goal only in your head, so it fades and the old thoughts quietly move back in.",
      ],
      application: "In One Mission, this challenge is tailor-made for how you build, and the app is built to support it — it tracks your day counter and your streak so you can see the 30 days add up. Pick one building goal, run the test, and each day the app helps you check in: Did I hold my goal in mind? Did I take one action? Did I replace the fear thoughts? If you slip, the counter resets and you begin again — no shame, just discipline. Thirty days of this is often the exact stretch where a wobbly new builder becomes a steady one.",
      practice: "Write the single goal you'll hold for your 30 days, in a sentence you can picture clearly. Then write the two fear-thoughts most likely to show up for you, and the goal-picture you'll swap in each time. Keep all of it on one card where you'll see it every morning.",
      action: "Choose your one goal, write your goal card, and start Day 1 of your 30-day challenge today.",
      quiz: [
        {
          q: "It's Day 12 of your challenge and you have a rough day — you skip your action and spend the evening worrying. What does Nightingale's test say to do?",
          options: [
            "Admit you failed and give up on the challenge.",
            "Use the recovery rule: don't quit, reset the count to Day 1, and keep going.",
            "Pretend it didn't happen and keep your streak at Day 13 tomorrow.",
          ],
          correct: 1,
          why: "The recovery rule is what makes the challenge work. Slipping isn't failure — it's expected. You simply start the 30-day count fresh and continue, because the goal is training your dominant thought, not protecting a perfect streak.",
        },
        {
          q: "Which best describes what you actually do each day during the 30-day test?",
          options: [
            "Try to feel happy and hope good things come to you.",
            "Hold your one goal in mind, take at least one action toward it, and replace any fearful thought with your goal.",
            "Think about your goal once on Day 1 and then just wait for results.",
          ],
          correct: 1,
          why: "The test is a daily discipline: keep the goal in front of your mind, marry it to at least one action, and swap fear thoughts for the goal the moment they appear. It's directed thinking and doing, not passive hoping.",
        },
      ],
      resource: [SS_AUDIO],
    },
    {
      id: "ss-onemission",
      num: 6,
      title: "The Secret, Applied to One Mission",
      minutes: 10,
      five: {
        bigIdea: "Plant the right dominant thought about your building, feed it daily, and pair it with the Daily Method — that's the whole secret aimed at One Mission.",
        principles: [
          "Choose one clear dominant thought about the builder you're becoming, and keep planting it.",
          "Attach it to a specific building goal and a daily action, so thought and work move together.",
          "Guard the soil: replace fear-thoughts fast, and protect what you feed your mind each day.",
        ],
        wrong: "Most people let random doubt and other people's negativity be their dominant thought about building, then wonder why they can't stay consistent.",
        oneMission: "Write your One Mission dominant thought, tie it to your goal and Daily Method, and run it as your ongoing operating system.",
        today: "Write your one-line dominant thought for building One Mission and commit to feeding it every morning.",
      },
      why: "This lesson pulls the whole masterclass into one place so it actually runs your building instead of sitting in your notes. It matters because you already have a dominant thought about One Mission — the only question is whether you chose it or it chose you. When you deliberately set that thought, aim it with a goal, and feed it daily action, consistency stops being a battle of willpower and starts being the natural output of what you think about all day.",
      principle: "Everything so far combines into one operating system: your dominant thought sets the direction, a clear goal gives it a target, your attitude carries it into every conversation, and daily action makes it real — with the 30-day discipline as the training method. Applied to a specific mission, the secret becomes: decide who you're becoming as a builder, plant that thought relentlessly, protect it from the weeds of doubt and outside negativity, and let it pull you into your Daily Method day after day.",
      beginner: "Think of your One Mission building like tending one specific garden bed. First you decide what you're growing — that's your dominant thought about the builder you're becoming. You plant that seed every morning by reading it. You water it with daily action. You pull weeds fast whenever doubt sprouts. And you're careful about what you let blow into the bed — the negative voices and doomscrolling that plant weeds for you. Do that steadily, and the bed grows the builder you pictured. Neglect it, and whatever blows in takes over.",
      example: "New builder Marcus pulled it all together on one card: dominant thought — 'I'm becoming a builder people trust to follow through'; goal — 'help five people take a look each week for 90 days'; daily action — 'run my Daily Method before noon.' He read the card each morning, swapped fear-thoughts for it during the day, and stopped starting his mornings with negative videos that used to set his mood. He wasn't relying on motivation anymore. The thought he fed on purpose kept pulling him back to the work, and after a month, showing up simply felt like who he was.",
      whatToSay: [
        { label: "Your One Mission operating card", text: "Dominant thought: I'm becoming a builder people trust to follow through. Goal: help [number] people take a look each week. Daily action: run my Daily Method before [time]. I feed this every morning and trade fear-thoughts for it all day." },
        { label: "Protecting the soil", text: "That negativity — from a video, a doubter, or my own head — is a weed. I'm not planting it. Back to the thought I chose." },
      ],
      whatNotToSay: [
        "\"I'll just push through on willpower and motivation.\" (Motivation fades; a fed dominant thought is what keeps you consistent.)",
        "\"It's fine to start my day with the doom-scroll, it doesn't affect my building.\" (Whatever you feed your mind first is a seed — choose it.)",
        "\"I can't help what I think about all day.\" (You can choose the dominant one and replace the weeds — that's the entire secret.)",
      ],
      mistakes: [
        "Leaving your dominant thought about building to chance, then blaming willpower for inconsistency.",
        "Setting the thought but never tying it to a concrete goal and daily action.",
        "Feeding your mind negativity each morning, then wondering why doubt keeps winning.",
        "Doing it for a few days and stopping, so the old weeds grow back over the bed.",
      ],
      application: "This is your One Mission operating system, and it's how you make everything else in the community stick. Put your dominant thought, your goal, and your daily action on one card. Read it before you open the app. Run your Daily Method as the action that feeds it. Replace fear-thoughts as they come, and guard what you let into your mind each morning. Then run the 30-day challenge on top of it so the app can track your day counter and streak. Do this, and consistency stops being something you force and becomes something you've grown.",
      practice: "Build your One Mission operating card now: one dominant thought about the builder you're becoming, one specific goal, one daily action, and the one negative input you'll stop feeding your mind each morning. Put it where you'll read it before you build.",
      action: "Write your One Mission operating card today and read it out loud before you run your Daily Method.",
      roleplay: {
        scenario: "A teammate says positive thinking is nonsense and asks why you bother with a 'thought card'",
        opener: "Come on, a card with a thought on it? That's not going to build a business. Isn't this just wishful thinking?",
      },
      quiz: [
        {
          q: "You want to build One Mission consistently. Which approach matches this masterclass?",
          options: [
            "Rely on motivation and willpower to force yourself each day.",
            "Choose a dominant thought about the builder you're becoming, tie it to a goal and a daily action, feed it every morning, and guard against negativity.",
            "Think positively once in a while and hope consistency follows.",
          ],
          correct: 1,
          why: "Consistency is the natural output of a dominant thought you feed daily and pair with action — not a willpower battle. You choose the thought, aim it with a goal, run your Daily Method as the action, and protect the soil from weeds.",
        },
        {
          q: "A teammate says the whole idea is just wishful thinking. What's the honest, on-message response?",
          options: [
            "They're right — it's mostly hoping for luck.",
            "It's the opposite of wishing: you choose a thought, aim it at a real goal, and it pulls you into daily action — the results come from the action, not the wish.",
            "It works by magic, so you don't need to do the Daily Method.",
          ],
          correct: 1,
          why: "This is directed thinking, not magic or wishing. The thought sets direction and pulls you into daily action; the action produces the results. That framing keeps it honest and ethical — no guarantees, just discipline.",
        },
      ],
      resource: [SS_AUDIO],
    },
  ],
  workbook: {
    id: "strangest-secret-workbook",
    title: "One Mission 30-Day Mindset Challenge Workbook",
    sections: [
      { title: "My Dominant Thought", fields: [{ id: "dominant_thought", label: "The one thought about the builder I'm becoming that I'll plant every day", hint: "One clear sentence, in your own words." }] },
      { title: "What I've Been Feeding My Mind", fields: [{ id: "current_thought", label: "The thought I've honestly been feeding myself about building (crop or weed?)", hint: "Be honest — you can't replace a weed you won't name." }] },
      { title: "My One Goal for the Challenge", fields: [{ id: "challenge_goal", label: "The single, specific goal I'll hold in mind for all 30 days", hint: "Make it concrete enough that you can picture it and check your progress weekly." }] },
      { title: "My Daily Practice", fields: [{ id: "daily_practice", label: "Exactly what I'll do each day: hold the goal in mind, take one action, replace fear-thoughts", hint: "Name the time of day and the one building action (invite, follow-up, 3-way)." }] },
      { title: "Thoughts I'll Replace", fields: [{ id: "replace_thoughts", label: "My most common negative/fearful thoughts, and the goal-thought I'll swap in each time", hint: "List 2–3 fear-thoughts and the exact picture you'll replace each with." }] },
      { title: "Guarding My Soil", fields: [{ id: "guard_soil", label: "The negative inputs I'll stop feeding my mind, and what I'll feed it instead each morning", hint: "e.g., doom-scroll first thing vs. reading my goal card." }] },
      { title: "My Attitude Commitment", fields: [{ id: "attitude", label: "The attitude I'll deliberately bring to every conversation, no matter the last 'no'" }] },
      { title: "My Recovery Rule", fields: [{ id: "recovery", label: "What I'll do the moment I slip, so I reset to Day 1 instead of quitting", hint: "Write the exact words you'll tell yourself." }] },
      { title: "Weekly Check-In (Days 7/14/21/30)", fields: [{ id: "weekly_checkin", label: "At each checkpoint: Did I hold my goal daily? Take action daily? Replace fear-thoughts? What did I notice?", hint: "Fill this in on Day 7, 14, 21, and 30." }] },
      { title: "My One Mission Operating Card", fields: [{ id: "operating_card", label: "My dominant thought + goal + daily action + the input I'm cutting, all in one place" }] },
      { title: "My 30-Day Challenge Tracker", fields: [{ id: "tracker", label: "How I'll use the app's day counter and streak to track my 30 days", hint: "Note your start date and how you'll check in each day." }] },
      { title: "My Commitment & What Changed", fields: [{ id: "commitment", label: "My signed commitment to the 30 days, and — after Day 30 — what actually changed in me and my building", hint: "Sign and date it now; complete the reflection at the end." }] },
    ],
  },
};

// ═══════════════════════════════ MYLETT ═══════════════════════════════
const EM_YT = { label: "Ed Mylett — Official YouTube", url: "https://www.youtube.com/@EdMylett", kind: "watch" as const };
const EM_SITE = { label: "Ed Mylett — Official Site & Podcast", url: "https://www.edmylett.com/", kind: "site" as const };

// ═══════════════════════════════ ED MYLETT LEADERSHIP COLLECTION ═══════════════════════════════
const ED_MYLETT: Masterclass = {
  id: "ed-mylett",
  teacher: "Ed Mylett",
  book: "The Power of One More",
  title: "Ed Mylett — Identity, Standards & Leadership",
  subtitle: "Raise your identity, your standards, and your leadership to build something bigger.",
  category: "Leadership",
  accent: "#dc2626",
  minutes: "60–90 min",
  overview:
    "You don't rise to the level of your goals — you fall to the level of your self-image. Ed Mylett teaches that the person you believe you are acts like a thermostat: it quietly sets the temperature of your effort, your standards, and what you'll allow yourself to keep. This collection turns that idea into a practical pathway for building One Mission — you'll raise your identity, set real non-negotiables, build confidence by keeping small promises, choose your rooms and your people on purpose, and lead your team the only way that actually duplicates: by example and by service. Nothing here is hype. Leadership is framed as adding value to people, not pressuring them — and everything is something you can practice today.",
  original: [EM_YT, EM_SITE],
  lessons: [
    {
      id: "em-identity",
      num: 1,
      title: "Your Identity Is Your Thermostat",
      minutes: 10,
      five: {
        bigIdea: "You don't rise to your goals — you fall to your self-image. Your identity sets the temperature for everything you do, so if you want a different result, you have to raise the identity first.",
        principles: [
          "A goal is a target; your identity is the thermostat that decides what you'll actually allow to stick.",
          "You behave in line with the person you believe you are, not the person you wish you were.",
          "Identity is chosen and built on purpose — it isn't fixed, and it isn't your past.",
        ],
        wrong: "Most people set big goals while keeping a small self-image, then wonder why they self-sabotage right back down to their old 'set point.'",
        oneMission: "Write a short identity statement for the builder you're becoming, and put it where you'll see it before you do your One Mission activity each day.",
        today: "Finish this sentence in writing: 'I am the kind of person who ______,' three times, describing the builder you're becoming.",
      },
      why: "This matters because you can learn every script and tactic in the world, but if you secretly see yourself as 'not really the kind of person who leads,' you'll quietly pull yourself back down every time you start to succeed. It's not a discipline problem — it's an identity problem. When you raise the picture you hold of yourself, your standards, your effort, and your follow-through rise with it almost automatically. That's why identity is the first lesson: it's the setting under all the other settings.",
      principle: "Ed Mylett describes your self-image as a thermostat. A thermostat doesn't care what temperature you WANT — it holds the temperature it's SET to. If the room heats up past the setting, it cools it back down; if it drops below, it warms it back up. Your identity works the same way. When your results climb above your self-image, you unconsciously 'cool' yourself back to your set point through procrastination, avoidance, or self-sabotage. When they fall below it, you fight to climb back up. So the real work isn't chasing a hotter result — it's resetting the thermostat by deliberately raising who you believe you are.",
      beginner: "Think about the thermostat on your wall. If it's set to 68 degrees and a heat wave pushes the room to 80, the air conditioner kicks on and drags it back to 68. If a cold snap drops it to 55, the heater fires up and brings it back to 68. It always returns to the setting. Your self-image is that setting. If deep down you're 'set' to being a person who starts strong and fizzles, then every time you get hot — a big week, a new signup — something in you cools it back down. The fix isn't to force the room hotter. It's to change the number on the dial.",
      example: "New builder Ana kept having the same pattern: a great week, then a week where she 'somehow' didn't do her activity. Her coach asked her to describe herself in one sentence. She said, 'I'm someone who's kind of flaky with big projects.' That was her thermostat setting — 68 degrees of flaky. Her coach had her rewrite it: 'I'm someone who keeps small promises to myself, every day, even when it's boring.' She wrote it on a sticky note above her laptop and read it before her daily activity. Nothing about her schedule changed — but the picture of herself did, and within a month the 'fizzle week' stopped showing up.",
      whatToSay: [
        { label: "New identity self-talk (morning)", text: "I am the kind of person who does the work I said I'd do, whether or not I feel like it. That's just who I am now." },
        { label: "New identity self-talk (after a win)", text: "This isn't luck or a fluke — this is what someone with my standards produces. I'm allowed to keep this." },
        { label: "New identity self-talk (after a hard day)", text: "One rough day doesn't lower my thermostat. I'm the person who resets and shows up again tomorrow." },
      ],
      whatNotToSay: [
        "\"That's just not who I am.\" (That sentence IS the thermostat — it holds you at the old setting.)",
        "\"I'll believe I'm a leader once the results show up.\" (Backwards — the identity comes first, then the results follow it.)",
        "\"I've always been bad at finishing things.\" (You're describing your past, not deciding your identity.)",
      ],
      mistakes: [
        "Setting huge goals while keeping a small, unchanged self-image.",
        "Treating identity as fixed — 'that's just how I am' — instead of chosen.",
        "Waiting for results to prove you're a leader before you'll act like one.",
        "Only working on tactics and never touching the picture you hold of yourself.",
      ],
      application: "In One Mission, your identity is the quiet reason you do — or skip — your Daily Method. A builder who sees themselves as 'a professional who serves people' opens the app and starts conversations without drama. A builder who secretly sees themselves as 'someone trying this out' negotiates with themselves every single day. Write a one-line identity statement for the builder you're becoming, keep it where you start your daily activity, and let it reset your thermostat before you touch a single task.",
      practice: "Write your current self-image honestly in one sentence ('I'm someone who...'). Then write the upgraded version you're choosing. Circle the exact words that changed. For the next 7 days, read the upgraded version out loud before your One Mission activity and notice which version you actually behaved like.",
      action: "Write your one-line identity statement today and put it where you'll see it before your daily activity tomorrow morning.",
      quiz: [
        {
          q: "You have a huge week in One Mission — and then quietly skip your activity for three days. What does the thermostat idea say is really happening?",
          options: [
            "You earned a break and there's nothing to look at.",
            "Your results climbed above your self-image, so you unconsciously 'cooled' back to your set point — the fix is raising your identity, not just trying harder.",
            "You need a bigger, more exciting goal to chase.",
          ],
          correct: 1,
          why: "A bigger goal doesn't move the thermostat. When results rise above your self-image, self-sabotage pulls them back to the set point. Raising the identity itself is what makes the new level feel normal enough to keep.",
        },
        {
          q: "Which statement is actually working ON your identity rather than against it?",
          options: [
            "\"I'll act like a leader once I have a big team to prove it.\"",
            "\"That's just not the kind of person I am.\"",
            "\"I am the kind of person who keeps the promises I make to myself.\"",
          ],
          correct: 2,
          why: "The first waits for results before allowing the identity (backwards). The second is the old thermostat setting spoken out loud. The third chooses and states the upgraded identity now — which is what actually resets the dial.",
        },
      ],
      resource: [EM_SITE],
    },
    {
      id: "em-onemore",
      num: 2,
      title: "The Power of One More",
      minutes: 9,
      five: {
        bigIdea: "You are almost always one more — one more call, one more rep, one more day — away from a breakthrough. The 'one more' mentality is what separates people who compound from people who quit right before it works.",
        principles: [
          "The last effort — the 'one more' you almost skipped — is usually where the disproportionate reward lives.",
          "One more done consistently compounds; it's small on any single day and enormous over months.",
          "You don't need a dramatic overhaul — you need to add one more to what you're already doing.",
        ],
        wrong: "Beginners quit at the point of average — right where everyone else stops — never knowing the breakthrough was one more attempt away.",
        oneMission: "Add exactly one more to your Daily Method — one more conversation, one more follow-up, one more piece of personal development — every day this week.",
        today: "After you finish your planned activity today, do one more of the thing that matters most.",
      },
      why: "This matters because most people don't fail from lack of talent — they fail from stopping at 'good enough,' which is usually the exact spot right before the payoff. The 'one more' mentality reframes effort: instead of needing a heroic, unsustainable push, you just add a single extra rep to what you're already doing. That one more is small enough to always be possible and, repeated daily, it's the thing that quietly builds a completely different result over time.",
      principle: "Ed Mylett's 'power of one more' says the difference between an ordinary life and an extraordinary one is often a single additional effort applied consistently. The reward for effort isn't linear — the final push, the 'one more' rep you almost skipped, frequently carries the biggest return, because it's the one almost nobody else is willing to do. And because 'one more' is tiny, it sidesteps the burnout of trying to double everything. You keep your normal activity and add one — one more call, one more follow-up, one more page, one more day of not quitting. Stacked over weeks and months, those single extras compound into an outcome that looks, from the outside, like luck.",
      beginner: "Imagine you're heating a pot of water and you turn off the stove at 211 degrees because you're tired. Nothing happens — no steam, no boil. Water boils at 212. That one more degree is the whole difference between 'warm water' and 'steam that can move an engine.' The 'one more' mentality is refusing to quit at 211. You're not asked to boil ten pots at once — just to give the one you're already heating a single degree more.",
      example: "New builder Marcus set a goal of five new conversations a day. Most days he hit five and stopped, relieved. His coach challenged him to a simple rule for two weeks: after conversation number five, always do one more. Just one. It felt trivial. But that sixth conversation — number six on a Thursday, the one he almost skipped because he was tired — was the person who became his most active builder. Marcus didn't work twice as hard. He added one more, and one more found the person the first five missed.",
      whatToSay: [
        { label: "The one-more nudge to yourself", text: "I'm tired and I already hit my number — which is exactly why one more matters. Just one. Then I'm done." },
        { label: "Reframing a slow day", text: "Today was quiet. That's not a reason to quit — it's a reason to do one more, because the breakthrough is usually hiding in the rep I almost skip." },
      ],
      whatNotToSay: [
        "\"I did enough for today.\" (Maybe — but 'enough' is often 211 degrees, one short of the boil.)",
        "\"I'll make up for it by doing a giant push this weekend.\" (One more daily compounds; heroic weekend binges burn you out and don't.)",
        "\"If it didn't work by now, it's not going to.\" (That's quitting at the point of average, right before the payoff.)",
      ],
      mistakes: [
        "Stopping at 'good enough' — the exact point where most people quit.",
        "Confusing 'one more' with 'do everything twice' and burning out.",
        "Judging the result of one more by a single day instead of by the month it compounds into.",
        "Skipping the extra rep on the tired days — which are the ones that matter most.",
      ],
      application: "In One Mission, 'one more' plugs directly into your Daily Method. Keep your normal activity, then add one: one more invite, one more follow-up, one more three-way, one more lesson of personal development. On the days you're tired and want to close the laptop, that's the highest-leverage 'one more' there is. And when you teach your team to add one more instead of chasing dramatic overhauls, you've given them something sustainable and duplicatable — a habit, not a heroic sprint.",
      practice: "For the next 7 days, write your normal daily activity number at the top of a page. Each day, after you hit it, do one more and put a checkmark. At the end of the week, count the checkmarks — that's the extra activity that existed nowhere in your plan, created entirely by 'one more.'",
      action: "After you complete your planned activity today, do one more of the single most important action — then stop.",
      quiz: [
        {
          q: "You've hit your five planned conversations and you're tired. The 'power of one more' says to do what?",
          options: [
            "Stop — you hit your number, and pushing more risks burnout.",
            "Do one more conversation, because the tired-day extra rep is exactly where breakthroughs tend to hide.",
            "Skip today and plan a huge catch-up session this weekend.",
          ],
          correct: 1,
          why: "One more isn't 'do everything twice' — it's a single extra rep, especially on the tired days. It's sustainable, it compounds, and it's usually the rep almost no one else is willing to do.",
        },
      ],
      resource: [EM_YT],
    },
    {
      id: "em-standards",
      num: 3,
      title: "Raise Your Standards",
      minutes: 9,
      five: {
        bigIdea: "You don't get what you WANT in life — you get what you'll TOLERATE. Your standards, not your desires, set the floor of your results.",
        principles: [
          "Wants are wishes; standards are the non-negotiables you refuse to drop below.",
          "Raising a standard means making something automatic, not optional or motivation-dependent.",
          "You rise to your standards on your worst days, not your best — so the floor is what matters.",
        ],
        wrong: "Beginners set exciting goals but keep low personal standards, so on hard days everything slides — and hard days are most days.",
        oneMission: "Turn one One Mission activity from a 'when I feel like it' want into a written, daily non-negotiable with a clear minimum.",
        today: "Name one standard you're raising today, write the exact minimum, and do it before you sleep.",
      },
      why: "This matters because goals live in the future and standards live in today. A goal says 'I want to build a big team someday.' A standard says 'I have five real conversations every day, no matter what.' On your best days, everyone performs. It's the tired, busy, discouraged days that decide your trajectory — and on those days you don't rise to your wants, you fall to your standards. Raising your standards is how you protect your results from your moods.",
      principle: "Ed Mylett teaches that you get your standards, not your wants. A want is negotiable — you'll do it if you're inspired, if it's convenient, if nothing better comes up. A standard is non-negotiable — it's just what you do, like brushing your teeth. The move isn't to want harder; it's to convert the few activities that matter into standards with a defined, non-negotiable minimum. Because you perform to your floor on your worst days, raising that floor even slightly changes everything the low days used to drag down.",
      beginner: "Think about brushing your teeth. You don't wake up and check whether you 'feel motivated' to brush — you just do it, even exhausted, even traveling, even when you don't want to. It's a standard, not a want. Now imagine your most important One Mission activity had that same status: not a decision you re-make every day, just something you do like brushing your teeth. That's what raising a standard means — moving an action out of the 'maybe' pile and into the 'always' pile.",
      example: "New builder Priya 'wanted' to do personal development daily and 'wanted' to follow up with prospects. On good days she did both; on hard days she did neither — and hard days won more often. Her coach helped her set two standards with exact minimums: 'I read or listen to 10 minutes of personal development every day' and 'I send every follow-up I promised, same day, no exceptions.' They were small on purpose. But because they were non-negotiable floors instead of hopeful wants, they held on the bad days too — and the bad days were exactly where she used to lose all her momentum.",
      whatToSay: [
        { label: "Setting the standard out loud", text: "This isn't a goal I'm hoping to hit. It's a standard. It's just what I do now, every day, like brushing my teeth." },
        { label: "Holding the standard on a hard day", text: "I don't feel like it — and that's irrelevant. Standards aren't a mood. I hit the minimum, then I'm free." },
      ],
      whatNotToSay: [
        "\"I'll do it if I have time / energy today.\" (That's a want, and it will lose to every hard day.)",
        "\"My goal is to be more consistent.\" (A goal without a defined daily minimum has no floor to protect you.)",
        "\"I'll raise all ten of my standards starting today.\" (Too many at once collapses — raise one or two and make them stick.)",
      ],
      mistakes: [
        "Confusing wants (negotiable wishes) with standards (non-negotiable floors).",
        "Setting a standard with no exact minimum, so it quietly erodes.",
        "Trying to raise ten standards at once and holding none.",
        "Only performing to your standards on good days and ignoring the bad ones.",
      ],
      application: "In One Mission, your standards are your Daily Method with the negotiation removed. Pick the one or two activities that drive everything — conversations, follow-ups, personal development — and write each as a non-negotiable with an exact minimum ('five conversations, every day'). Then protect the floor on the days you least feel like it. When you lead a team, model this: teach them to set a small, honest standard they can hold daily, never a giant one they'll abandon by Wednesday. A held standard duplicates; a broken one teaches quitting.",
      practice: "List three One Mission activities you currently treat as 'wants.' Pick ONE. Rewrite it as a standard with an exact daily minimum you could hit even on a rough day. Post it where you'll see it, and hold it for 7 straight days — including the day you least want to.",
      action: "Convert one 'want' into a written standard today, define its exact minimum, and hit that minimum before you sleep.",
      quiz: [
        {
          q: "Which of these is an actual STANDARD rather than a want?",
          options: [
            "\"I really want to be more consistent with follow-ups.\"",
            "\"I send every follow-up I promised the same day, no exceptions — like brushing my teeth.\"",
            "\"I'll follow up when I've got the energy for it.\"",
          ],
          correct: 1,
          why: "A standard is a non-negotiable with a defined minimum that holds regardless of mood. The other two are wants — negotiable wishes that will lose to your first hard day.",
        },
        {
          q: "Why does Mylett say your standards matter more than your goals for your actual results?",
          options: [
            "Because goals are pointless and you shouldn't set them.",
            "Because you perform to your standards on your worst days — and your worst days, not your best, decide your trajectory.",
            "Because standards are easier and require nothing of you.",
          ],
          correct: 1,
          why: "Goals live in the future; standards live in today's floor. On hard days you don't rise to your wants — you fall to your standards. Raising that floor is what protects your results from your moods.",
        },
      ],
      resource: [EM_SITE],
    },
    {
      id: "em-confidence",
      num: 4,
      title: "Confidence Through Kept Promises",
      minutes: 9,
      five: {
        bigIdea: "Confidence isn't a feeling you're born with — it's the reputation you build with yourself by keeping the promises you make to yourself.",
        principles: [
          "Every promise you keep to yourself is a deposit in your self-trust; every broken one is a withdrawal.",
          "Small kept promises build more real confidence than big broken ones ever could.",
          "Confidence is earned by evidence, not manufactured by hype or affirmations alone.",
        ],
        wrong: "Beginners wait to 'feel confident' before acting, and break so many small promises to themselves that they quietly stop believing their own word.",
        oneMission: "Make one small, specific promise about your One Mission activity today — and keep it exactly, to build the evidence that you do what you say.",
        today: "Make one tiny promise to yourself right now, small enough that you're certain to keep it, and keep it today.",
      },
      why: "This matters because confidence is the fuel behind every hard conversation, invite, and follow-up — and most people have the cause and effect backwards. They think they need to feel confident before they act, but confidence isn't a mood you wait for; it's a track record you build. Every time you tell yourself you'll do something and then do it, you gather evidence that your word is good. Every time you don't, you teach yourself that your word means nothing. Over time, that self-trust — or lack of it — shows up in how boldly you're willing to act.",
      principle: "Ed Mylett frames confidence as the byproduct of promises kept to yourself. Think of your self-trust as a relationship. In any relationship, trust is built when someone does what they said they'd do, over and over. You have that exact relationship with yourself. When you promise 'I'll do my activity at 8am' and you do, you make a deposit. When you skip it, you make a withdrawal — and you were watching. Confidence is simply the balance in that account. That's why chasing a confident feeling doesn't work: you build the balance through kept promises, and the feeling follows the evidence.",
      beginner: "Imagine a friend who cancels on you every single time. Eventually you stop believing anything they say — not because they're a bad person, but because their word and their actions don't match. Now imagine that friend is you, and the person you keep canceling on is yourself. Every broken promise to yourself works exactly like that flaky friend, teaching you not to trust your own word. And every kept promise, even a tiny one, is you showing up when you said you would — rebuilding the trust one appointment at a time.",
      example: "New builder Sam wanted to feel confident on invites but felt shaky, so he kept waiting for the confidence to arrive. His coach flipped it: 'Stop trying to feel it — start earning it.' She had him make one absurdly small promise each morning — 'I will send exactly one message before 9am' — and keep it precisely. Small enough that failure was almost impossible. After two weeks of kept promises, Sam noticed something: he trusted himself more. He'd built a short but real track record of doing what he said, and that evidence — not a pep talk — was what let him send the harder messages.",
      whatToSay: [
        { label: "Making the promise", text: "Here's my promise to myself for today, and it's small on purpose: ______. I keep my word to myself." },
        { label: "After keeping it", text: "I said I'd do it and I did. That's another deposit in the account. This is what confidence is actually made of." },
        { label: "When tempted to break it", text: "This is small — which is exactly why I'm keeping it. I don't break promises to myself over something this easy." },
      ],
      whatNotToSay: [
        "\"I'll act once I finally feel confident.\" (Backwards — the action builds the confidence, not the other way around.)",
        "\"It was just a small thing, skipping it doesn't matter.\" (Small broken promises are still withdrawals, and you noticed.)",
        "\"I'll promise myself something big to prove I'm serious.\" (Oversized promises you break do more damage than tiny ones you keep.)",
      ],
      mistakes: [
        "Waiting to feel confident before acting, instead of acting to build confidence.",
        "Making promises too big to keep, then eroding your own self-trust when they break.",
        "Treating broken small promises as harmless — they're quiet withdrawals from self-trust.",
        "Relying on hype and affirmations with no kept-promise evidence underneath them.",
      ],
      application: "In One Mission, confidence is what carries you into the invite, the three-way, the follow-up you're nervous about. Build it on purpose: each morning make one small, specific promise about your activity — small enough you're sure to keep it — and keep it exactly. Stack those kept promises and your self-trust grows, which is what lets you take the bolder actions later. When you coach a nervous new builder, don't tell them to 'be more confident.' Give them one tiny promise to keep today, and let the evidence do the work.",
      practice: "Each morning for 7 days, write one small, specific promise to yourself about your One Mission activity — deliberately small enough that you're confident you'll keep it. Keep it, then check it off. At the end of the week, look at the row of checkmarks: that's the exact evidence your confidence is built from.",
      action: "Make one small, specific promise to yourself today — small enough you're sure to keep it — and keep it before the day ends.",
      quiz: [
        {
          q: "A new builder tells you, 'I'll start inviting people once I feel more confident.' What's the most accurate coaching?",
          options: [
            "\"Makes sense — wait until the confidence shows up, then start.\"",
            "\"Confidence comes from evidence, not waiting. Make one tiny promise about your activity today and keep it — the confidence is built by kept promises, not felt in advance.\"",
            "\"Just fake it and repeat affirmations until you believe them.\"",
          ],
          correct: 1,
          why: "Confidence is the balance in your self-trust account, built by keeping promises to yourself. Waiting for the feeling reverses cause and effect; affirmations without kept-promise evidence underneath ring hollow. Small kept promises are the actual mechanism.",
        },
      ],
      resource: [EM_SITE],
    },
    {
      id: "em-proximity",
      num: 5,
      title: "Proximity Is Power",
      minutes: 9,
      five: {
        bigIdea: "Who you're around shapes who you become. The rooms you're in and the people you spend time with quietly set your standards, your beliefs, and your ceiling.",
        principles: [
          "You become the average of the standards, habits, and beliefs of the people closest to you.",
          "Proximity works whether you choose it or not — so choose your rooms on purpose.",
          "You don't have to cut people off; you decide who gets the most access and influence.",
        ],
        wrong: "Beginners try to grow surrounded only by people who reinforce their old ceiling, and can't understand why they keep sliding back.",
        oneMission: "Get into a One Mission room on purpose this week — a call, an event, a mentor conversation — and add one person to the front of your circle who's already where you want to be.",
        today: "Identify one room, call, or person that raises your standards, and put yourself in proximity to it this week.",
      },
      why: "This matters because you are absorbing the people around you whether you mean to or not — their normal becomes your normal. If everyone near you treats big goals as delusional, showing up daily as optional, and quitting as reasonable, that becomes the temperature of your own thermostat. Proximity is one of the most powerful and most underrated forces in growth: the fastest way to raise your standards is to spend real time around people whose standards are already higher than yours. You rise toward the room you're in.",
      principle: "Ed Mylett teaches that proximity is power — that closeness to the right people, environments, and information accelerates who you become, because you unconsciously calibrate to your surroundings. You adopt the beliefs, habits, vocabulary, and standards of the people you're near most. This isn't about abandoning anyone or judging your friends; it's about being intentional with access and influence. You decide which rooms you deliberately enter and who gets the front-row seats in your life. Put yourself in proximity to people already living at the level you're growing toward, and their normal starts pulling your normal upward.",
      beginner: "Think about walking into a room where a bread is baking. You don't have to do anything — you walk out smelling like the room. You absorbed it just by being there. People work the same way. Spend real time around people who show up daily, keep their word, and think big, and you start to smell like that room — their standards rub off on you. Spend it around people who treat effort as foolish and quitting as normal, and you absorb that instead. You're always catching the scent of whatever room you're standing in.",
      example: "New builder Leo felt like he was pushing a boulder uphill. Everyone in his day-to-day thought his goals were unrealistic, so every conversation slowly talked him back down. His coach didn't tell him to cut anyone off — just to add proximity. Leo started joining the weekly One Mission team call, listening to a mentor's content on his commute, and texting one builder who was a season ahead of him. Within weeks, his 'normal' shifted. Not because anyone lectured him, but because he was finally in rooms where his goals were the baseline instead of the punchline.",
      whatToSay: [
        { label: "Reaching out to someone ahead of you", text: "I really respect how you've built this. Would you be open to me joining a call or asking you a question here and there? I'm trying to be around people doing it at your level." },
        { label: "Protecting your rooms", text: "I'm being intentional right now about the rooms and voices I give the most access to. This call and these people are one of them." },
      ],
      whatNotToSay: [
        "\"I can grow fine on my own, I don't need to be around anyone.\" (Proximity is happening anyway — isolation just leaves your old ceiling in charge.)",
        "\"I have to cut off everyone who isn't ambitious.\" (It's about access and influence, not cutting people off or judging them.)",
        "\"I'll join the rooms once I've already made it.\" (Backwards — the rooms are how you get there, not a reward for arriving.)",
      ],
      mistakes: [
        "Trying to grow while spending all your time in rooms that reinforce your old ceiling.",
        "Treating proximity as optional instead of a force that's shaping you either way.",
        "Confusing 'be intentional about access' with 'cut everyone off' or judging people.",
        "Waiting until you've 'made it' to enter the rooms that would get you there.",
      ],
      application: "In One Mission, your rooms are right there: the team calls, the events, the mentors, the builders a season ahead of you. Get into them on purpose — don't wait to be invited or to feel worthy. Give those voices real access to your week, and let your normal recalibrate upward. Then become a good room for others: when you lead, the standard you hold and the belief you carry become the temperature new builders absorb. You can raise a team's ceiling just by being the room they walk into.",
      practice: "Draw two columns. On the left, list the five people and voices you spend the most time around; next to each, note whether they raise or lower your standards. On the right, list three rooms, calls, or people already at the level you're growing toward. This week, deliberately add proximity to at least one from the right column.",
      action: "Put yourself in one high-standard room this week — a One Mission call, event, or mentor conversation — and schedule it today.",
      quiz: [
        {
          q: "You're growing but keep sliding back, and almost everyone around you thinks your goals are unrealistic. What does 'proximity is power' suggest?",
          options: [
            "Cut off everyone who isn't ambitious — that's the only fix.",
            "Intentionally add proximity to rooms and people already at the level you want, and give those voices more access — your normal recalibrates to the room you're in.",
            "Just try harder on your own and ignore who you're around.",
          ],
          correct: 1,
          why: "Proximity shapes you whether you choose it or not, so the move is to deliberately enter higher-standard rooms and give them access — not to isolate, and not to cut people off. You rise toward the room you spend real time in.",
        },
      ],
      resource: [EM_YT],
    },
    {
      id: "em-time",
      num: 6,
      title: "Max Out & Bookend Your Days",
      minutes: 9,
      five: {
        bigIdea: "You don't manage time by cramming more in — you win the day by winning its two ends. Own your morning and your evening, and be fully present in between.",
        principles: [
          "Bookend the day: a intentional start and a deliberate close protect everything in the middle.",
          "Presence beats hours — being fully where you are makes your time count more than adding more of it.",
          "How you win your morning and evening sets the standard for the whole day between them.",
        ],
        wrong: "Beginners let the day happen to them — a reactive morning and a numb, scrolling evening — then wonder where their time and energy went.",
        oneMission: "Design a short One Mission morning bookend (before the world starts) and an evening bookend (a quick review and plan) and run both this week.",
        today: "Write your morning bookend and evening bookend for tomorrow — even three lines each — and follow them.",
      },
      why: "This matters because most people never actually decide how their day goes — they react to notifications, other people's demands, and whatever grabs their attention. That reactive drift is where builders quietly lose their most important activity: it just never gets a time slot, because the day filled up on its own. When you deliberately own the two ends of your day and stay present in the middle, you stop leaking time and energy. You don't need more hours — you need to be intentional with the ones bookending everything else.",
      principle: "Ed Mylett teaches maxing out your day by bookending it — winning the morning and the evening — and being fully present in the moments between. The morning bookend sets the intention, standard, and identity for the day before the outside world starts making demands. The evening bookend closes the loop: a short review of how you did and a deliberate plan for tomorrow, so you wake up already aimed. And the multiplier on the middle isn't more hours — it's presence. Time spent half-distracted counts for far less than time spent fully in it. Win the ends, be present in the middle, and an ordinary day produces extraordinary output.",
      beginner: "Think of your day like a book. If the first and last pages are strong, they hold the whole story together. If they're a mess, the middle tends to fall apart too. Your morning is page one — set before anyone else grabs the pen. Your evening is the last page — where you close the day well and set up tomorrow. And being present in the middle is like actually reading the book instead of scrolling your phone with it open in your lap. Same amount of time; completely different result.",
      example: "New builder Dana kept 'running out of time' for her One Mission activity. Her coach had her look at two windows: the first 30 minutes after waking and the last 20 before bed. In the mornings Dana had been grabbing her phone and reacting to everyone else's world; in the evenings she'd been scrolling until she fell asleep. They built two tiny bookends: a morning of reading her identity statement and doing her most important activity first, and an evening of a two-minute review plus writing tomorrow's top three. Nothing else in her schedule changed — but her activity stopped being the thing that never happened, because she'd stopped letting the ends of her day run on autopilot.",
      whatToSay: [
        { label: "Morning bookend (to yourself)", text: "Before the world gets a vote, here's who I am today and the one thing that matters most: ______. I do that first." },
        { label: "Evening bookend (to yourself)", text: "How did I actually do today — honestly? And what are the top three things that make tomorrow a win? I'm setting them now so I wake up aimed." },
        { label: "Being present with someone", text: "Give me one second to put this down — I want to actually be here with you, not half-here." },
      ],
      whatNotToSay: [
        "\"I'll just fit my activity in whenever there's a gap.\" (There's never a gap — the reactive day fills itself.)",
        "\"I don't have time.\" (Usually it's not a time problem, it's an unowned-morning-and-evening problem.)",
        "\"I can do my activity while half-watching TV and scrolling.\" (Divided presence quietly kills the quality of the work.)",
      ],
      mistakes: [
        "Starting the day reactively — phone first — and handing the pen to everyone else.",
        "Ending the day numb and scrolling, with no review and no plan for tomorrow.",
        "Believing the fix is cramming more in, rather than owning the two ends and being present.",
        "Treating presence as optional and letting distraction hollow out the hours you do spend.",
      ],
      application: "In One Mission, your bookends protect your Daily Method. Build a short morning routine that includes your identity statement and your most important activity done first — before the world starts pulling — and an evening routine that reviews how the day went and sets tomorrow's top three. Then be genuinely present: when you're doing your activity, do only that; when you're with your family, be all the way there. Present builders have better conversations, and present leaders make people feel seen — which is its own form of leadership.",
      practice: "Write your morning bookend (3–5 lines: identity statement, most important activity first) and your evening bookend (a two-minute honest review plus tomorrow's top three). Run both for 5 days. Each evening, rate your presence in the middle of the day from 1–10 and note one distraction to remove tomorrow.",
      action: "Write tomorrow's morning bookend and evening bookend today — even three lines each — and follow both tomorrow.",
      quiz: [
        {
          q: "A builder says, 'I just never have time for my One Mission activity.' Their mornings start with the phone and their evenings end with scrolling. What's the highest-leverage fix?",
          options: [
            "Add more hours by waking up drastically earlier and cramming more tasks in.",
            "Own the two ends of the day — a morning bookend that does the most important activity first and an evening bookend that reviews and plans tomorrow — and be present in between.",
            "Accept that some people just don't have enough time and move on.",
          ],
          correct: 1,
          why: "The problem is usually a reactive, unowned day, not a shortage of hours. Bookending the morning and evening protects the important activity and being present makes the middle count — that beats simply cramming in more.",
        },
      ],
      resource: [EM_SITE],
    },
    {
      id: "em-leadership",
      num: 7,
      title: "Lead By Example & Duplicate",
      minutes: 10,
      five: {
        bigIdea: "Leaders are made by what they DO, not what they say. You can't ask of your team what you're not willing to do yourself — and whatever you actually do is what duplicates.",
        principles: [
          "Your example is the real instruction — people copy what you do, not what you tell them.",
          "You can't ask your team to do what you won't do; your activity sets the ceiling for theirs.",
          "Simple, repeatable behavior duplicates; heroics and complexity do not.",
        ],
        wrong: "Beginners try to lead by talking — pep talks and pressure — while their own activity is invisible, so nothing duplicates.",
        oneMission: "Do your own Daily Method visibly and consistently, then teach it as a simple pattern your team can copy exactly.",
        today: "Do one core activity yourself today that you'd want every future team member to do — and make it the example.",
      },
      why: "This matters because in a build-with-people business, your team becomes a copy of you — not the version of you that gives speeches, but the version that shows up and does the work (or doesn't). If you invite people to do activity you're not doing yourself, they feel it instantly, and it doesn't stick. But when your own example is clear, consistent, and simple enough to copy, you give your team something they can actually duplicate. Leadership here isn't about being the loudest voice; it's about being the clearest example.",
      principle: "Ed Mylett teaches that leaders are forged by their actions, and that real leadership means never asking of your people what you're unwilling to do yourself. In a duplicating business this is doubly true: whatever you actually do — your standards, your consistency, your activity — is what your team copies, because example is the true curriculum. You lead from the front by doing the core activities visibly and consistently, and you keep them simple enough that a brand-new person could repeat them. Complexity and heroics don't duplicate; a clear, copyable pattern does. Your job as a leader is to be the example worth copying and then make copying it easy.",
      beginner: "Think about how kids learn. You can tell a child to be kind all day long, but what actually shapes them is watching how you treat the server at a restaurant. They copy what you do, not what you say. A team is the same. If you tell them to do daily activity while your own is invisible, they copy the invisible part. If they see you doing simple, consistent activity, that's what they repeat. You're always teaching by example — the only question is whether it's an example worth copying.",
      example: "New leader Marco had a small team that kept stalling. He was giving motivating pep talks on every call, but his own activity had quietly dropped off — and the team felt it. His mentor gave him one instruction: 'Stop talking about it and go do it, out loud.' Marco went back to doing his own Daily Method visibly — sharing that he'd done his five conversations, his follow-ups, his personal development — and taught it as a dead-simple pattern anyone could copy. He asked nothing of the team he wasn't doing himself. Within a few weeks the team's activity picked up, not because of a better speech, but because they finally had a clear example to duplicate.",
      whatToSay: [
        { label: "Leading from the front", text: "Here's exactly what I did today — five conversations, my follow-ups, and ten minutes of personal development. That's the pattern. If you copy just that, you've got it." },
        { label: "Teaching the simple pattern", text: "Let's keep this simple enough to duplicate: a few conversations, follow up on what you promised, a little personal development. Small, daily, copyable. That's the whole thing." },
        { label: "Encouraging without pressure", text: "I'm not going to push you — I'm going to show you. Watch what I do, copy the parts that fit, and ask me anything. You set your own pace." },
      ],
      whatNotToSay: [
        "\"Do as I say, not as I do.\" (Your team copies what you do — this guarantees the wrong thing duplicates.)",
        "\"You need to work way harder than me to make this happen.\" (You can't ask of them what you won't do yourself.)",
        "\"Just push through, you have to want it more.\" (Pressure isn't leadership — a clear, copyable example is.)",
      ],
      mistakes: [
        "Leading by talking while your own activity is invisible or dropped off.",
        "Asking your team to do activity you're not doing yourself.",
        "Teaching a complicated system that's impossible for a new person to duplicate.",
        "Confusing pressure and pep talks with actual leadership.",
      ],
      application: "In One Mission, the whole business is duplication, so your example is the product. Do your own Daily Method visibly and consistently — let your team see the activity, not just hear the encouragement — and teach it as a pattern simple enough for a brand-new person to copy on day one. Never ask a team member to do something you've stopped doing yourself. When you lead from the front with a clear, copyable example and zero pressure, you give people something they can actually repeat — and repeatable is what grows a team.",
      practice: "Write out your core Daily Method as a pattern simple enough for a total beginner to copy exactly (aim for three or four steps, no more). For the next 5 days, do it yourself visibly and share what you did with your team or your coach. At the end, ask: could a brand-new person duplicate this from watching me?",
      roleplay: undefined,
      action: "Do one core activity today that you'd want every future team member to do, and share it with your team or coach as the example.",
      quiz: [
        {
          q: "Your team is stalling, so you've been giving motivating pep talks — but your own daily activity has quietly dropped off. What's the leadership move?",
          options: [
            "Give bigger, more emotional pep talks until they get motivated.",
            "Resume doing your own Daily Method visibly and teach it as a simple, copyable pattern — never asking of them what you're not doing yourself.",
            "Add pressure and remind them how badly they should want it.",
          ],
          correct: 1,
          why: "Teams duplicate what you do, not what you say. Pep talks and pressure aren't leadership; a clear, consistent, simple example that a beginner can copy is. You lead from the front, not the megaphone.",
        },
        {
          q: "Why does simplicity matter so much when you lead a duplicating team?",
          options: [
            "Because complicated systems make you look more impressive.",
            "Because simple, repeatable behavior can actually be copied by a brand-new person, while complexity and heroics don't duplicate.",
            "Because simple means you can ask your team to do more than you do.",
          ],
          correct: 1,
          why: "Duplication only works if the pattern is easy enough for a beginner to repeat. Heroics and complex systems break the chain; a clear, simple, copyable example is what actually spreads through a team.",
        },
      ],
      resource: [EM_YT],
    },
    {
      id: "em-service",
      num: 8,
      title: "Serve & Add Value First",
      minutes: 10,
      five: {
        bigIdea: "The most influential people are the ones who serve the most. You lead and grow by adding value first — giving before getting — not by taking or pressuring.",
        principles: [
          "Influence is a byproduct of service — you earn it by genuinely helping people.",
          "Give value first, without keeping score, and trust follows.",
          "Serving is the opposite of pressuring — you're adding to someone's life, not taking from it.",
        ],
        wrong: "Beginners lead with what they want FROM people, so every interaction feels like being sold to, and trust never forms.",
        oneMission: "Before you ask anything of a prospect or team member, add real value first — help, encouragement, a useful resource, genuine attention.",
        today: "Add value to one person today with zero agenda — help or encourage them expecting nothing back.",
      },
      why: "This matters because people can feel the difference between being served and being used, instantly. If every message you send is really about what you want from someone, they put up walls — and they should. But when you consistently add value first, with no scoreboard, you become the person people trust, listen to, and want to work with. Service isn't a soft add-on to leadership; it's the engine of it. The most influential builders aren't the ones taking the most — they're the ones giving the most.",
      principle: "Ed Mylett teaches that the highest form of leadership is service, and that influence flows to those who add the most value to others. Giving before getting isn't a manipulation tactic — done as a tactic, people smell it. It's a genuine orientation: you look for how to help, encourage, and add to people's lives before you ever ask anything of them, and you do it without keeping score. This is the opposite of pressure. Pressure takes from people; service adds to them. And over time, the trust you build by genuinely serving is what makes people open to what you offer — not because you pushed, but because you'd already given.",
      beginner: "Think about the difference between two neighbors. One only knocks on your door when they need to borrow something. The other brings your trash cans up, checks in when you're sick, and never seems to be keeping a tally. Which one do you trust? Which one, if they mentioned something they were excited about, would you actually want to hear about? Serving first is being the second neighbor. You add to people's lives, no scoreboard — and that's exactly why, when you do have something to share, they lean in instead of backing away.",
      example: "New builder Nadia used to open every message with what she wanted — 'would you take a look at this?' — and kept hitting walls. Her coach suggested a different orientation for two weeks: add value first, no agenda. So Nadia started genuinely helping people — sharing a resource a friend actually needed, encouraging someone having a rough week, connecting two people who should know each other — expecting nothing back. She wasn't doing it to manipulate; she just stopped leading with the ask. The walls came down. People started trusting her, and when she did eventually share what she was building, they were open — because she'd already shown them who she was.",
      whatToSay: [
        { label: "Adding value first (no agenda)", text: "Hey — no ask here at all. I saw this and thought of you, figured it might actually help. Hope things are going well." },
        { label: "Serving a team member", text: "What's the one thing you're stuck on right now? Let me help you with that first — I'm not worried about anything else today." },
        { label: "Genuine encouragement", text: "I just wanted you to know I noticed how hard you've been showing up. That's not nothing. Proud of you." },
      ],
      whatNotToSay: [
        "\"I'll help you, but first you need to take a look at my thing.\" (That's a trade with a price tag, not service.)",
        "\"I did all this for you, so now you owe me.\" (Keeping score turns a gift into a debt and kills the trust.)",
        "\"Let me add value real quick so they'll feel like they have to say yes.\" (Service as a manipulation tactic — people feel it, and it backfires.)",
      ],
      mistakes: [
        "Leading every interaction with what you want FROM the person.",
        "Keeping score — treating help as a debt the other person now owes.",
        "Using 'add value' as a manipulation tactic instead of a genuine orientation.",
        "Confusing serving with pressuring, when they're opposites.",
      ],
      application: "In One Mission, serving first is how you build trust with prospects and lead your team well. Before you ask a prospect to look at anything, add value — help, attention, a useful resource, genuine care. Before you ask a team member to do their activity, serve them: solve the thing they're stuck on, encourage the effort you see. Do it with no scoreboard. This is the ethical core of the whole business — you grow by adding to people's lives, never by pressuring them. The most influential leaders in One Mission are simply the ones serving the most.",
      practice: "For the next 5 days, add value to one person each day with zero agenda — help, encourage, connect, or share something genuinely useful, expecting nothing back. Keep no scoreboard. At the end of the week, notice how those relationships feel compared to any interaction where you led with an ask.",
      roleplay: {
        scenario: "Encouraging a discouraged team member",
        opener: "Honestly, I'm thinking about quitting. I've been showing up and nothing's happening. I don't think I'm cut out for this.",
      },
      action: "Add value to one person today with no agenda — help or encourage them expecting nothing in return.",
      quiz: [
        {
          q: "A prospect keeps putting up walls because every message you send is really about what you want from them. What's the shift Mylett would point to?",
          options: [
            "Push harder and ask more directly until they say yes.",
            "Lead by adding genuine value first — help, encourage, be useful with no agenda and no scoreboard — and let trust make them open to what you offer.",
            "Offer to help them, but only if they agree to look at your thing first.",
          ],
          correct: 1,
          why: "Influence is a byproduct of service. Leading with the ask (or trading help for a look) feels like being used. Genuinely giving value first, with no scoreboard, builds the trust that makes people open — the opposite of pressure.",
        },
        {
          q: "Which of these is real service rather than disguised taking?",
          options: [
            "\"I did all this for you, so now you owe me a look at my business.\"",
            "\"No ask here — I saw this and thought it might genuinely help you.\"",
            "\"Let me add value quick so they'll feel obligated to say yes.\"",
          ],
          correct: 1,
          why: "Service is giving without a scoreboard. Keeping a debt or using 'value' as a manipulation tactic are both taking in disguise — and people feel the difference. Genuine, no-agenda help is what actually builds trust.",
        },
      ],
      resource: [EM_SITE],
    },
    {
      id: "em-onemission",
      num: 9,
      title: "The One-More Mentality, Applied to One Mission",
      minutes: 11,
      five: {
        bigIdea: "Put it all together: raise your identity, hold your standards, keep your promises, choose your rooms, own your days, lead by example, and serve — then apply the 'one more' mentality to building One Mission, one day at a time.",
        principles: [
          "The pieces reinforce each other — identity feeds standards, standards feed confidence, service feeds leadership.",
          "You build One Mission the same way you build everything: one more, consistently, from the right identity.",
          "A written plan you actually run beats a perfect plan you only admire.",
        ],
        wrong: "Beginners collect the ideas and never assemble them, so the concepts stay inspiring instead of becoming a build.",
        oneMission: "Assemble your identity, standards, promises, proximity, bookends, leadership example, and service into one written One Mission plan and run it daily.",
        today: "Write your one-page One Mission plan pulling all eight lessons together, and do your first 'one more' against it today.",
      },
      why: "This matters because ideas don't change anything until they're assembled into a build. You now have the pieces — a raised identity, real standards, confidence from kept promises, intentional proximity, owned days, leadership by example, and a service-first orientation. On their own they're inspiring; assembled into a daily practice aimed at One Mission, they become a life. This final lesson is where you stop studying and start building — putting it all together into one plan you actually run, and applying the 'one more' mentality to it every single day.",
      principle: "Ed Mylett's ideas aren't separate tips — they're a reinforcing system, and the 'one more' mentality is the engine that runs it. Your identity sets your standards; your standards, held daily, generate kept promises; kept promises build confidence; the right proximity keeps your thermostat high; owned days protect the activity; leading by example and serving first grow the team ethically. Applied to One Mission, this becomes simple: from the right identity, hold your standards, and do one more, one day at a time, in service of the people you're building with. A written plan you run daily beats a perfect plan you only admire. This is where the collection becomes a build.",
      beginner: "Think about building anything — a house, a meal, a team. You can own every ingredient and tool and still have nothing until you actually assemble them in order. All eight of these lessons are ingredients. This last one is the recipe card: it puts them in order and tells you to start cooking. And the 'one more' mentality is what keeps you at the stove — one more day, one more conversation, one more rep — until what you assembled becomes real.",
      example: "New builder Ana had gone through all eight lessons and felt inspired but scattered. Her coach had her write one page: her identity statement at the top, her two non-negotiable standards, the small daily promise she'd keep, the room she'd stay in, her morning and evening bookends, the simple activity she'd model for her team, and one way she'd serve someone daily. Then one rule underneath it all: after her planned activity, do one more. She stopped treating the lessons as separate ideas and started running them as a single daily practice. Nothing about the plan was fancy — but because she actually ran it, and added one more each day, it became the way she built.",
      whatToSay: [
        { label: "Committing to the assembled plan", text: "I'm done collecting ideas. Here's my one-page plan — my identity, my standards, my promise, my rooms, my bookends, how I lead, how I serve — and I run it daily, one more at a time." },
        { label: "Coaching a team member to assemble theirs", text: "Let's put your pieces together on one page — who you're becoming, your two standards, one promise you'll keep, and one 'one more' a day. Simple enough to run, strong enough to build on." },
      ],
      whatNotToSay: [
        "\"I'll start once I've perfected the whole plan.\" (A plan you run beats a perfect plan you admire — start and refine.)",
        "\"These were great ideas.\" (Ideas you don't assemble stay inspiring and change nothing.)",
        "\"I'll do a massive overhaul this weekend to catch up.\" (This is a one-more-a-day build, not a heroic binge.)",
      ],
      mistakes: [
        "Collecting the lessons without ever assembling them into one plan.",
        "Waiting for the plan to be perfect before running it.",
        "Treating the pieces as separate tips instead of a reinforcing system.",
        "Reaching for a heroic weekend push instead of one more, daily.",
      ],
      application: "In One Mission, this is your operating system. On one page, write your identity statement, your two non-negotiable standards, the small daily promise you'll keep, the room you'll stay in, your morning and evening bookends, the simple activity you'll model for your team, and one way you'll serve someone each day. Under all of it, one rule: after your planned activity, do one more. Run that page daily. Coach your team to build their own. This is the whole collection assembled into a build — from the right identity, holding your standards, doing one more, in service of the people you're building with.",
      practice: "Write your one-page One Mission plan pulling all eight lessons together: identity statement, two standards, one daily promise, your room, your two bookends, your simple team-modeling activity, and one daily act of service — with 'do one more' underneath. Run it for 7 days, checking off each element daily, and refine one line at the end of the week.",
      action: "Write your one-page One Mission plan today, then do your first 'one more' against it before the day ends.",
      quiz: [
        {
          q: "You've finished all eight lessons and feel inspired but scattered. What's the move that actually turns this into a build?",
          options: [
            "Wait until you've perfected a detailed master plan before doing anything.",
            "Assemble the pieces into one simple written plan — identity, standards, a daily promise, your room, bookends, how you lead and serve — and run it daily, doing one more against it.",
            "Do a single huge weekend push to catch up on everything at once.",
          ],
          correct: 1,
          why: "Ideas only become a build once assembled and run. A simple one-page plan you actually execute daily — with the 'one more' engine underneath — beats a perfect plan you admire or a heroic one-time binge.",
        },
      ],
      resource: [EM_SITE],
    },
  ],
  workbook: {
    id: "ed-mylett-workbook",
    title: "One Mission Identity & Leadership Workbook",
    sections: [
      {
        title: "My Current vs. Desired Identity",
        fields: [
          { id: "identity_now", label: "Who do I currently believe I am? ('I'm someone who...')", hint: "Be honest — this is your current thermostat setting." },
          { id: "identity_next", label: "Who am I choosing to become? ('I am the kind of person who...')", hint: "This is the upgraded setting you'll read daily." },
        ],
      },
      {
        title: "My New Standards & Non-Negotiables",
        fields: [{ id: "standards", label: "My 1–2 daily standards, each with an exact minimum I hit even on hard days", hint: "e.g. 'Five conversations every day — like brushing my teeth.'" }],
      },
      {
        title: "Promises I'll Keep to Myself",
        fields: [{ id: "promises", label: "The small, specific daily promise I'll make and keep to build self-trust", hint: "Small enough that you're certain you'll keep it." }],
      },
      {
        title: "My One-More Commitment",
        fields: [{ id: "one_more", label: "After my planned activity each day, the 'one more' I'll always do", hint: "One more conversation, follow-up, or lesson — especially on tired days." }],
      },
      {
        title: "My Proximity Plan",
        fields: [
          { id: "rooms", label: "The rooms, calls, and people already at my level that I'll get into on purpose", hint: "Team calls, events, mentors, a builder a season ahead." },
          { id: "access", label: "Who currently gets the most access to me, and one change I'm making", hint: "About access and influence — not cutting people off." },
        ],
      },
      {
        title: "My Morning & Evening Bookends",
        fields: [
          { id: "morning", label: "My morning bookend (before the world starts): identity + most important activity first", hint: "Even 3–5 lines is enough." },
          { id: "evening", label: "My evening bookend: honest review of today + tomorrow's top three", hint: "So you wake up already aimed." },
        ],
      },
      {
        title: "Being Present",
        fields: [{ id: "presence", label: "The main distraction hollowing out my time, and how I'll be fully present instead", hint: "Presence beats hours." }],
      },
      {
        title: "How I'll Lead by Example",
        fields: [{ id: "example", label: "The simple, copyable Daily Method pattern I'll model visibly for my team", hint: "Simple enough for a brand-new person to duplicate — no pressure, just example." }],
      },
      {
        title: "Who I'll Serve",
        fields: [{ id: "serve", label: "How I'll add value first each day — for prospects and team — with no scoreboard", hint: "Give before getting; serving is the opposite of pressuring." }],
      },
      {
        title: "My Confidence Ledger",
        fields: [{ id: "ledger", label: "The kept-promise evidence I'm stacking this week that proves my word is good", hint: "Confidence is built by kept promises, not felt in advance." }],
      },
      {
        title: "My One-Page One Mission Plan",
        fields: [{ id: "plan", label: "All the pieces assembled on one page: identity, standards, promise, room, bookends, how I lead, how I serve — with 'do one more' underneath", hint: "A plan you run beats a perfect plan you admire." }],
      },
      {
        title: "My 30-Day Identity Challenge",
        fields: [
          { id: "challenge", label: "My commitment: for 30 days, I'll read my identity statement, hold my standards, keep my daily promise, and do one more — daily", hint: "Small, daily, non-negotiable." },
          { id: "checkin", label: "How I'll track it and who I'll check in with, and how I'll know the thermostat has moved", hint: "Proximity + accountability keep the standard high." },
        ],
      },
    ],
  },
};

// Registry — all 7 masterclasses complete.
export const MASTERCLASSES: Masterclass[] = [GO_PRO, JIM_ROHN, MILLIONAIRE_MIND, RICH_DAD, THINK_GROW_RICH, STRANGEST_SECRET, ED_MYLETT];

// Learning tracks (curated paths) — reference masterclass/lesson ids.
export const TRACKS = [
  { id: "new-affiliate", label: "New Affiliate", steps: ["Go Pro Foundations", "Jim Rohn Personal Development", "The Strangest Secret"] },
  { id: "nm-pro", label: "Network Marketing Pro", steps: ["Go Pro Masterclass", "Inviting", "Presenting", "Follow-Up", "Objections", "Events", "Duplication"] },
  { id: "confidence", label: "Building Confidence", steps: ["Ed Mylett Identity", "Jim Rohn Philosophy", "Think and Grow Rich", "The Strangest Secret"] },
  { id: "money", label: "Money Mindset", steps: ["Secrets of the Millionaire Mind", "Rich Dad Poor Dad", "Think and Grow Rich"] },
  { id: "leader", label: "Becoming a Leader", steps: ["Jim Rohn Leadership", "Ed Mylett Leadership", "Eric Worre", "Recognition", "Duplication", "Events"] },
];

