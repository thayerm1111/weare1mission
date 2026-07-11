/**
 * EVENTS  —  edit featured, upcoming, and past events here.
 * Use ISO date strings (YYYY-MM-DDTHH:MM) for `startDate` so the countdown works.
 */
export type EventStatus = "Registration Open" | "Coming Soon" | "Sold Out" | "Completed";
export type EventType = "Online" | "Local" | "Leadership Retreat" | "Convention";

export interface CommunityEvent {
  id: string;
  name: string;
  startDate: string;   // ISO, e.g. "2026-09-12T09:00"
  displayDate: string; // human-friendly, e.g. "September 12–14, 2026"
  time: string;
  location: string;
  type: EventType;
  description: string;
  image: string;       // placeholder path; replace with real event image
  registrationLink?: string;
  status: EventStatus;
  speakers: string[];
  capacity?: string;
  featured?: boolean;
}

export const events: CommunityEvent[] = [
  {
    id: "fall-convention-2026",
    name: "1 Mission Fall Convention (placeholder)",
    startDate: "2026-10-17T09:00",
    displayDate: "October 17–18, 2026",
    time: "9:00 AM – 6:00 PM",
    location: "To be announced",
    type: "Convention",
    description:
      "Our flagship gathering of the community for two days of training, recognition, and connection. Details are placeholder until announced.",
    image: "/images/events/convention.jpg",
    registrationLink: "#",
    status: "Coming Soon",
    speakers: ["Leadership Team (placeholder)"],
    capacity: "TBA",
    featured: true,
  },
  {
    id: "weekly-overview",
    name: "Weekly Business Overview (placeholder)",
    startDate: "2026-07-16T20:00",
    displayDate: "Every Thursday",
    time: "8:00 PM ET",
    location: "Online (Zoom)",
    type: "Online",
    description: "A public overview call — perfect to invite a guest to. Recurring weekly.",
    image: "/images/events/overview.jpg",
    registrationLink: "#",
    status: "Registration Open",
    speakers: ["Rotating Host (placeholder)"],
  },
  {
    id: "leadership-retreat",
    name: "Leadership Retreat (placeholder)",
    startDate: "2026-09-05T10:00",
    displayDate: "September 5–7, 2026",
    time: "All day",
    location: "To be announced",
    type: "Leadership Retreat",
    description:
      "An invite-based retreat for developing leaders focused on growth, strategy, and connection.",
    image: "/images/events/retreat.jpg",
    registrationLink: "#",
    status: "Coming Soon",
    speakers: ["Senior Leadership (placeholder)"],
    capacity: "Limited",
  },
  {
    id: "local-meetup",
    name: "Local Community Meetup (placeholder)",
    startDate: "2026-08-02T18:00",
    displayDate: "August 2, 2026",
    time: "6:00 PM",
    location: "Your city (placeholder)",
    type: "Local",
    description: "In-person connection with members near you. Check the announcement channel for your area.",
    image: "/images/events/meetup.jpg",
    registrationLink: "#",
    status: "Registration Open",
    speakers: ["Local Leaders (placeholder)"],
  },
  {
    id: "spring-convention-2026",
    name: "Spring Kickoff (placeholder — past)",
    startDate: "2026-03-14T09:00",
    displayDate: "March 14, 2026",
    time: "9:00 AM – 5:00 PM",
    location: "Past event",
    type: "Convention",
    description: "A past event example. Replace with photos and a recap in the gallery below.",
    image: "/images/events/past-1.jpg",
    status: "Completed",
    speakers: ["Leadership Team (placeholder)"],
  },
];

// Past event gallery — swap in real photos (place files in /public/images/events/).
export const pastEventGallery: { id: string; caption: string; image: string }[] = [
  { id: "g1", caption: "Community gathering (placeholder)", image: "/images/events/gallery-1.jpg" },
  { id: "g2", caption: "Team training (placeholder)", image: "/images/events/gallery-2.jpg" },
  { id: "g3", caption: "Recognition night (placeholder)", image: "/images/events/gallery-3.jpg" },
  { id: "g4", caption: "Leadership session (placeholder)", image: "/images/events/gallery-4.jpg" },
  { id: "g5", caption: "Local meetup (placeholder)", image: "/images/events/gallery-5.jpg" },
  { id: "g6", caption: "Convention floor (placeholder)", image: "/images/events/gallery-6.jpg" },
];
