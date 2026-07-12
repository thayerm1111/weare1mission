/**
 * WEEKLY SCHEDULE  —  edit your recurring calls here.
 * Times are 24h "HH:MM" in ONE source timezone (`sourceTimeZone`). The site
 * converts them to each visitor's local time automatically, figures out which
 * call is live right now, and builds "Save to Google Calendar" links.
 *
 * These are EDITABLE PLACEHOLDER events — update titles, days, times, hosts,
 * durations, and links to match your real schedule.
 */
export const sourceTimeZone = "America/New_York"; // your team's base timezone

export type ScheduleDay =
  | "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

export type AccessLevel = "Public" | "Members Only";
// The call types people can filter by.
export type ScheduleCategory =
  | "Business" | "Leadership" | "Overview" | "Comp Plan" | "Trading" | "Community";

export interface ScheduleEvent {
  id: string;
  title: string;
  day: ScheduleDay;
  time: string;          // 24h "HH:MM" in sourceTimeZone
  durationMin?: number;  // defaults to 60
  speaker: string;
  description: string;
  accessLevel: AccessLevel;
  category: ScheduleCategory;
  zoomLink?: string;     // the Zoom / join link
  telegramLink?: string;
  registrationLink?: string;
  isPlaceholder?: boolean;
}

export const scheduleEvents: ScheduleEvent[] = [
  {
    id: "mon-leadership",
    title: "Monday Leadership Call",
    day: "Monday", time: "20:00", durationMin: 60,
    speaker: "Leadership Team",
    description: "Weekly leadership focus: vision, culture, and setting the tone for the week.",
    accessLevel: "Members Only", category: "Leadership",
    zoomLink: "#", telegramLink: "#", isPlaceholder: true,
  },
  {
    id: "tue-getpaid",
    title: "Get Paid Session",
    day: "Tuesday", time: "20:00", durationMin: 60,
    speaker: "Rotating Host",
    description: "Action-focused working session on the activities that move the needle.",
    accessLevel: "Members Only", category: "Business",
    zoomLink: "#", telegramLink: "#", isPlaceholder: true,
  },
  {
    id: "wed-training",
    title: "Team Training",
    day: "Wednesday", time: "20:00", durationMin: 90,
    speaker: "Training Team",
    description: "Skill-building training on the fundamentals — invite a guest.",
    accessLevel: "Members Only", category: "Trading",
    zoomLink: "#", telegramLink: "#", isPlaceholder: true,
  },
  {
    id: "thu-overview",
    title: "Business Overview",
    day: "Thursday", time: "20:00", durationMin: 45,
    speaker: "Host",
    description: "Public overview of the 1 Mission community — a great call to invite guests to.",
    accessLevel: "Public", category: "Overview",
    zoomLink: "#", telegramLink: "#", isPlaceholder: true,
  },
  {
    id: "fri-compplan",
    title: "Comp Plan Breakdown",
    day: "Friday", time: "19:00", durationMin: 45,
    speaker: "Leadership Team",
    description: "How the compensation plan works, ranks, and how to maximize your payout.",
    accessLevel: "Members Only", category: "Comp Plan",
    zoomLink: "#", telegramLink: "#", isPlaceholder: true,
  },
  {
    id: "sat-community",
    title: "Community Session",
    day: "Saturday", time: "11:00", durationMin: 60,
    speaker: "Community Team",
    description: "Relaxed community connection, wins, and Q&A to close out the week.",
    accessLevel: "Public", category: "Community",
    zoomLink: "#", telegramLink: "#", isPlaceholder: true,
  },
];

// Filter chips on the "What's On" page.
export const whatsOnFilters = [
  "All", "Business", "Leadership", "Overview", "Comp Plan", "Trading",
] as const;

// (kept for the public /schedule page)
export const scheduleFilters = [
  "All Events", "Trading", "Business", "Leadership", "Public", "Members Only",
] as const;

export const scheduleNotice =
  "Schedules and access links may change. Always check the official 1 Mission Telegram announcement channel for the latest information.";
