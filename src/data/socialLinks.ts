/**
 * SOCIAL LINKS  —  replace the "#" placeholders with your real profile URLs.
 * Set a value to "" to hide that icon everywhere it is used.
 */
export interface SocialLink {
  platform: "instagram" | "facebook" | "telegram" | "youtube" | "tiktok";
  label: string;
  href: string;
}

export const socialLinks: SocialLink[] = [
  { platform: "instagram", label: "Instagram", href: "#" }, // e.g. https://instagram.com/weare1mission
  { platform: "facebook", label: "Facebook", href: "#" },
  { platform: "telegram", label: "Telegram", href: "#" },
  { platform: "youtube", label: "YouTube", href: "#" },
  { platform: "tiktok", label: "TikTok", href: "#" },
];

// Official announcement channel referenced across the site.
export const announcementChannel = {
  label: "1 Mission Announcements (Telegram)",
  href: "#", // replace with your announcement channel invite link
};
