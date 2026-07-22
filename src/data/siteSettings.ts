/**
 * SITE SETTINGS  —  edit global site info here.
 * Owner: update the values below. Nothing else needs to change.
 */
export const siteSettings = {
  brandName: "1 Mission",
  // Text logo shown until you add a real transparent PNG.
  // To use an image logo: drop your file at /public/images/logo.png and set
  // `logoImage` to "/images/logo.png". The Header will render it automatically.
  // Empty = use the adaptive inline OM vector mark (inks on light, bone on dark).
  // To use the distressed-texture PNG, set this to e.g. "/images/om-logo.png".
  logoImage: "" as string,
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
  // Community explainer video shown on personal referral links (/username).
  // Use a direct MP4 file (e.g. "/videos/community.mp4" or an .mp4 URL) for the
  // most accurate watch tracking, or a Vimeo link (https://vimeo.com/123456789).
  communityVideoUrl: "https://vimeo.com/1209000647" as string,
  supportEmail: "support@weare1mission.com",
  // Year the community started — shown in the hero pill + member card.
  established: "2012",
  // Eyebrow pill text in the hero (before "· Est. {established}").
  heroPill: "An Invitation-Only Community",
  // Short serif tagline under the hero headline (editable).
  heroTagline: "For the called.",
  // Headline stats shown on the hero "member card". Edit freely.
  heroStats: [
    { value: "100,000+", label: "Lives Impacted" },
    { value: "230+", label: "Countries" },
    { value: "$100M", label: "Revenue Created" },
  ],
};

export type SiteSettings = typeof siteSettings;
