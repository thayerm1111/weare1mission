/**
 * SITE SETTINGS  —  edit global site info here.
 * Owner: update the values below. Nothing else needs to change.
 */
export const siteSettings = {
  brandName: "1 Mission",
  // Text logo shown until you add a real transparent PNG.
  // To use an image logo: drop your file at /public/images/logo.png and set
  // `logoImage` to "/images/logo.png". The Header will render it automatically.
  logoImage: "" as string, // e.g. "/images/logo.png"
  logoText: "1 MISSION",
  tagline: "One Mission. One Community. One Movement.",
  domain: "weare1mission.com",
  url: "https://weare1mission.com",
  shortMission:
    "A community built for people ready to grow in business, leadership, trading education, personal development, and life.",
  // Primary call-to-action used in header + hero. Point this at your team
  // application form, Telegram invite, or onboarding link.
  joinUrl: "/start-here",
  ogImage: "/images/og-default.png", // 1200x630 placeholder — replace before launch
  supportEmail: "support@weare1mission.com",
};

export type SiteSettings = typeof siteSettings;
