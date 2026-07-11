/**
 * WEEKLY SCHEDULE  —  edit recurring calls here.
 * IMPORTANT: times are stored in 24h format in ONE source timezone
 * (`sourceTimeZone`). The site converts them to each visitor's local time
 * automatically. Set the correct IANA timezone below (e.g. "America/New_York").
 *
 * These are EDITABLE PLACEHOLDER events — update titles, times, speakers,
 * and links to match your real schedule.
 */
export const sourceTimeZone = "America/New_York"; // change to your team's base timezone

export type ScheduleDay =
  | "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

export type AccessLevel = "Public" | "Members Only";
export type ScheduleCategory = "Trading" | "Business" | "Leadership" | "Community";

export interface ScheduleEvent {
  id: string;
  title: string;
  day: ScheduleDay;
  time: string;          // 24h "HH:MM" in sourceTimeZone
  speaker: string;
  description: string;
  accessLevel: AccessLevel;
  category: ScheduleCategory;
  zoomLink?: string;
  telegramLink?: string;
  registrationLink?: string;
  isPlaceholder?: boolean; // shown with an "editable placeholder" tag
}

export const scheduleEvents: ScheduleEvent[] = [
  {
    id: "mon-leadership",
    title: "Monday Leadership Call",
    day: "Monday",
    time: "20:00",
    speaker: "Leadership Team (placeholder)",
    description: "Weekly leadership focus: vision, culture, and setting the tone for the week.",
    accessLevel: "Members Only",
    category: "Leadership",
    zoomLink: "#",
    telegramLink: "#",
    isPlaceholder: true,
  },
  {
    id: "tue-getpaid",
    title: "Tuesday Get Paid Session",
    day: "Tuesday",
    time: "20:00",
    speaker: "Rotating Host (placeholder)",
    description: "Action-focused working session on the activities that move the needle.",
    accessLevel: "Members Only",
    category: "Business",
    zoomLink: "#",
    telegramLink: "#",
    isPlaceholder: true,
  },
  {
    id: "wed-training",
    title: "Wednesday Team Training",
    day: "Wednesday",
    time: "20:00",
    speaker: "Training Team (placeholder)",
    description: "Skill-building training on the fundamentals — invite a guest.",
    accessLevel: "Members Only",
    category: "Trading",
    zoomLink: "#",
    telegramLink: "#",
    isPlaceholder: true,
  },
  {
    id: "thu-overview",
    title: "Thursday Business Overview",
    day: "Thursday",
    time: "20:00",
    speaker: "Host (placeholder)",
    description: "Public overview of the 1 Mission community — a great call to invite guests to.",
    accessLevel: "Public",
    category: "Business",
    zoomLink: "#",
    registrationLink: "#",
    isPlaceholder: true,
  },
  {
    id: "sat-community",
    title: "Saturday Community Session",
    day: "Saturday",
    time: "11:00",
    speaker: "Community Team (placeholder)",
    description: "Relaxed community connection, wins, and Q&A to close out the week.",
    accessLevel: "Public",
    category: "Community",
    zoomLink: "#",
    telegramLink: "#",
    isPlaceholder: true,
  },
];

export const scheduleFilters = [
  "All Events",
  "Trading",
  "Business",
  "Leadership",
  "Public",
  "Members Only",
] as const;

export const scheduleNotice =
  "Schedules and access links may change. Always check the official 1 Mission Telegram announcement channel for the latest information.";
