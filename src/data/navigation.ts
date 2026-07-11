/**
 * NAVIGATION  —  edit the top navigation + primary button here.
 * `href` values that start with "/" are internal pages.
 *
 * STRUCTURE:
 *  - Public site (logged out): Home, Start Here, Events, Shop.
 *  - Member back office (behind login, at /portal/*): Training, Schedule,
 *    Resources, Leadership, Trading, Team Updates. Edit those in PortalNav.tsx.
 */
export interface NavItem {
  label: string;
  href: string;
}

// Public, logged-out top navigation.
export const mainNav: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "Start Here", href: "/start-here" },
  { label: "Events", href: "/events" },
  { label: "Shop", href: "/shop" },
];

// Prominent primary button in the header. Sends new people to sign up (create
// an account) so they can request access and be approved into the back office.
export const primaryCta: NavItem = {
  label: "Join 1 Mission",
  href: "/signup",
};

// Grouped links used by the footer.
export const footerNav = {
  quickLinks: [
    { label: "Home", href: "/" },
    { label: "Start Here", href: "/start-here" },
    { label: "Events", href: "/events" },
    { label: "Shop", href: "/shop" },
    { label: "Contact", href: "/contact" },
  ] as NavItem[],
  // Member back-office links (require login — they redirect to /login if signed out).
  trainingLinks: [
    { label: "Member Log In", href: "/login" },
    { label: "Affiliate Training", href: "/portal/training" },
    { label: "Schedule & Live Sessions", href: "/portal/schedule" },
    { label: "Resources", href: "/portal/resources" },
    { label: "Leadership", href: "/portal/leadership" },
  ] as NavItem[],
  communityLinks: [
    { label: "Member Portal", href: "/portal" },
    { label: "Contact / Mentor", href: "/contact" },
    { label: "Events", href: "/events" },
    { label: "Shop", href: "/shop" },
  ] as NavItem[],
  legalLinks: [
    { label: "Privacy Policy", href: "/legal#privacy-policy" },
    { label: "Terms of Use", href: "/legal#terms-of-use" },
    { label: "Risk Disclosure", href: "/legal#trading-risk-disclosure" },
    { label: "Earnings Disclaimer", href: "/legal#earnings-disclaimer" },
    { label: "All Disclosures", href: "/legal" },
  ] as NavItem[],
};
