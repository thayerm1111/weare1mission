import type { Config } from "tailwindcss";

/**
 * 1 MISSION BRAND SYSTEM  (stark editorial / monochrome)
 * ------------------------------------------------------
 * Inspired by the One Mission Collection aesthetic: pure white pages,
 * full-black feature sections, a single warm "bone" accent, and clean
 * grotesque type set uppercase with wide tracking. No color accents.
 *
 * Change brand colors here and they update site-wide. Token names are kept
 * generic so components don't change:
 *   navy      → near-black for dark sections, footer, hero panels
 *   primary   → ink for buttons, links, accents
 *   medium    → neutral mid grey (muted icons / secondary text)
 *   light     → light grey (text/detail on dark backgrounds)
 *   ice       → light stone (cards, chips, tints)
 *   offwhite  → barely-warm off-white (alternating sections)
 *   charcoal  → body text ink
 *   cream     → the base page background (now stark white)
 *   gold      → the single "bone" accent (kept named `gold` so classes cascade)
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#0B0B0B",     // near-black (dark sections / footer / hero panels)
        primary: "#111111",  // ink (buttons, links, accents)
        medium: "#737373",   // neutral mid grey
        light: "#B8B4AC",    // light grey (on dark)
        ice: "#EEEDE8",      // light stone (cards / chips / tints)
        offwhite: "#F5F4F1", // off-white (alt sections)
        charcoal: "#1A1A1A", // body text
        cream: "#FFFFFF",    // base background — stark white
        // Accent — a single warm "bone". Deliberately near-monochrome:
        // `DEFAULT` reads on light backgrounds; `light` is bone for dark ones.
        gold: {
          DEFAULT: "#6F6A5D", // warm stone (eyebrows / accents on light bg)
          light: "#CFC7B3",   // bone (accents on dark bg)
          deep: "#4A4638",    // deep stone
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        // Display grotesque used uppercase + tracked for headlines.
        // (Kept named `serif` so existing `font-serif` classes cascade.)
        serif: ["var(--font-display)", "\"Helvetica Neue\"", "Arial", "sans-serif"],
      },
      letterSpacing: {
        label: "0.22em",
        display: "0.02em",
      },
      maxWidth: {
        content: "1180px",
      },
      boxShadow: {
        // Soft, neutral, restrained — no colored glows.
        card: "0 1px 2px rgba(17,17,17,0.04), 0 10px 30px rgba(17,17,17,0.06)",
        cardhover: "0 2px 6px rgba(17,17,17,0.07), 0 18px 44px rgba(17,17,17,0.12)",
        glow: "0 24px 60px rgba(17,17,17,0.16)",
      },
      backgroundImage: {
        // Near-flat neutral gradients only.
        "gradient-navy": "linear-gradient(160deg, #0B0B0B 0%, #161616 100%)",
        "gradient-hero": "linear-gradient(180deg, #FFFFFF 0%, #F5F4F1 100%)",
        "gradient-ice": "linear-gradient(180deg, #F5F4F1 0%, #FFFFFF 100%)",
        "gradient-primary": "linear-gradient(180deg, #1A1A1A 0%, #0B0B0B 100%)",
        // Bone sheen for accent fills (chips, step numbers, accent buttons).
        "gradient-gold": "linear-gradient(95deg, #C4BBA3 0%, #E2DAC6 45%, #C4BBA3 100%)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s ease-out both",
        "fade-in": "fade-in 0.7s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
