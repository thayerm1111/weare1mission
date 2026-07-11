/**
 * CONTACT INFORMATION  —  PLACEHOLDER DATA.
 * Replace every value below with real team contact details before launch.
 */
export interface ContactCard {
  id: string;
  title: string;
  description: string;
  contactName: string; // PLACEHOLDER
  email: string;       // PLACEHOLDER
  phone: string;       // PLACEHOLDER
  telegram: string;    // PLACEHOLDER handle or link
  icon: "user" | "life-buoy" | "calendar" | "wrench";
}

export const contactCards: ContactCard[] = [
  {
    id: "mentor",
    title: "Contact Your Mentor",
    description:
      "Reach the person who invited you. Your mentor is your first point of contact for onboarding and questions.",
    contactName: "Your Mentor (placeholder)",
    email: "mentor@weare1mission.com",
    phone: "+1 (000) 000-0000",
    telegram: "@your_mentor",
    icon: "user",
  },
  {
    id: "support",
    title: "General Support",
    description: "Questions about the community, membership, or getting started.",
    contactName: "1 Mission Support (placeholder)",
    email: "support@weare1mission.com",
    phone: "+1 (000) 000-0000",
    telegram: "@onemission_support",
    icon: "life-buoy",
  },
  {
    id: "events",
    title: "Event Questions",
    description: "Registration, retreats, conventions, and local meetups.",
    contactName: "Events Team (placeholder)",
    email: "events@weare1mission.com",
    phone: "+1 (000) 000-0000",
    telegram: "@onemission_events",
    icon: "calendar",
  },
  {
    id: "tech",
    title: "Technical Support",
    description: "Trouble with tools, apps, links, or accessing training.",
    contactName: "Tech Support (placeholder)",
    email: "tech@weare1mission.com",
    phone: "+1 (000) 000-0000",
    telegram: "@onemission_tech",
    icon: "wrench",
  },
];

// Options for the contact form dropdowns.
export const preferredContactMethods = ["Email", "Phone", "Text", "Instagram", "Telegram"];
