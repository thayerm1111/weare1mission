/**
 * RESOURCES  —  edit the resource library here.
 * Each resource is a card. Set `download` for downloadable files and/or
 * `externalLink` for links. `membersOnly` shows a members badge.
 */
export const resourceCategories = [
  "New Member Resources",
  "Affiliate Resources",
  "Trading Education Resources",
  "Presentation Videos",
  "Scripts",
  "Prospect Trackers",
  "Social Media Materials",
  "Downloads",
  "Applications",
  "Important Links",
] as const;

export type ResourceCategory = (typeof resourceCategories)[number];

export type ResourceType =
  | "Document" | "Video" | "Link" | "Template" | "Tracker" | "App" | "Script" | "Image";

export interface ResourceItem {
  id: string;
  title: string;
  description: string;
  category: ResourceCategory;
  type: ResourceType;
  externalLink?: string;
  download?: string;      // path to a file in /public
  featured?: boolean;
  membersOnly?: boolean;
  recentlyAdded?: boolean;
}

export const resources: ResourceItem[] = [
  {
    id: "welcome-guide",
    title: "New Member Welcome Guide",
    description: "Everything you need in your first week, in one place.",
    category: "New Member Resources",
    type: "Document",
    download: "#",
    featured: true,
    recentlyAdded: true,
  },
  {
    id: "start-here-checklist",
    title: "Start Here Onboarding Checklist",
    description: "A printable version of the onboarding steps.",
    category: "New Member Resources",
    type: "Template",
    download: "#",
  },
  {
    id: "affiliate-playbook",
    title: "Affiliate Playbook",
    description: "Core fundamentals for building the right way.",
    category: "Affiliate Resources",
    type: "Document",
    download: "#",
    featured: true,
    membersOnly: true,
  },
  {
    id: "trading-basics",
    title: "Trading Education Basics",
    description: "Educational overview of core concepts. Education only — not financial advice.",
    category: "Trading Education Resources",
    type: "Document",
    download: "#",
    membersOnly: true,
  },
  {
    id: "presentation-main",
    title: "Official Community Presentation",
    description: "The main presentation to share with guests.",
    category: "Presentation Videos",
    type: "Video",
    externalLink: "#",
    featured: true,
  },
  {
    id: "invite-scripts",
    title: "Invite & Follow-Up Scripts",
    description: "Simple, duplicable scripts. Adapt them to your own voice.",
    category: "Scripts",
    type: "Script",
    download: "#",
    recentlyAdded: true,
  },
  {
    id: "prospect-tracker",
    title: "Prospect Tracker",
    description: "Stay organized with your contacts and follow-ups.",
    category: "Prospect Trackers",
    type: "Tracker",
    download: "#",
  },
  {
    id: "social-templates",
    title: "Social Media Templates",
    description: "Value-first templates. Never make income or results claims.",
    category: "Social Media Materials",
    type: "Image",
    download: "#",
  },
  {
    id: "brand-assets",
    title: "1 Mission Brand Assets",
    description: "Logos and graphics for members (placeholder).",
    category: "Downloads",
    type: "Image",
    download: "#",
  },
  {
    id: "required-app",
    title: "Required Application",
    description: "Download the app used for day-to-day communication.",
    category: "Applications",
    type: "App",
    externalLink: "#",
  },
  {
    id: "telegram-main",
    title: "Main Telegram Group",
    description: "The community home base.",
    category: "Important Links",
    type: "Link",
    externalLink: "#",
    featured: true,
  },
  {
    id: "announcement-channel",
    title: "Announcement Channel",
    description: "The single source of truth for schedules and links.",
    category: "Important Links",
    type: "Link",
    externalLink: "#",
    recentlyAdded: true,
  },
];
