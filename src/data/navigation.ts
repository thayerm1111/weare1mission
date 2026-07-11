/**
 * NAVIGATION  —  edit the top navigation + primary button here.
 * `href` values that start with "/" are internal pages.
 */
export interface NavItem {
  label: string;
  href: string;
}

export const mainNav: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "Start Here", href: "/start-here" },
  { label: "Training", href: "/training" },
  { label: "Schedule", href: "/schedule" },
  { label: "Events", href: "/events" },
  { label: "Resources", href: "/resources" },
  { label: "Leadership", href: "/leadership" },
  { label: "Shop", href: "/shop" },
];

// Prominent primary button in the header.
export const primaryCta: NavItem = {
  label: "Join 1 Mission",
  href: "/start-here",
};

// Grouped links used by the footer.
export const footerNav = {
  quickLinks: [
    { label: "Home", href: "/" },
    { label: "Start Here", href: "/start-here" },
    { label: "Events", href: "/events" },
    { label: "Leadership", href: "/leadership" },
    { label: "Shop", href: "/shop" },
  ] as NavItem[],
  trainingLinks: [
    { label: "Affiliate Training", href: "/training" },
    { label: "Weekly Schedule", href: "/schedule" },
    { label: "Resources", href: "/resources" },
    { label: "New Member Start Here", href: "/start-here" },
  ] as NavItem[],
  communityLinks: [
    { label: "Member Log In", href: "/login" },
    { label: "Contact / Mentor", href: "/contact" },
    { label: "Events", href: "/events" },
    { label: "Leadership Team", href: "/leadership" },
  ] as NavItem[],
  legalLinks: [
    { label: "Privacy Policy", href: "/legal#privacy-policy" },
    { label: "Terms of Use", href: "/legal#terms-of-use" },
    { label: "Risk Disclosure", href: "/legal#trading-risk-disclosure" },
    { label: "Earnings Disclaimer", href: "/legal#earnings-disclaimer" },
    { label: "All Disclosures", href: "/legal" },
  ] as NavItem[],
};
