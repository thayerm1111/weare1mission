import type { Config } from "tailwindcss";

/**
 * 1 MISSION BRAND SYSTEM  (warm minimal / editorial)
 * --------------------------------------------------
 * Change brand colors here and they update site-wide.
 * The palette is a warm monochrome: bone/cream backgrounds, near-black ink,
 * and warm greys. Token names are kept generic so components don't change:
 *   navy      → dark "ink" for dark sections, footer, headings
 *   primary   → near-black for buttons, links, accents
 *   medium    → warm mid grey (muted icons / secondary text)
 *   light     → warm light grey (text/detail on dark backgrounds)
 *   ice       → soft cream (cards, chips, tints)
 *   offwhite  → bone (alternating sections)
 *   charcoal  → body text ink
 *   cream     → lightest warm background
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#17130D",     // warm near-black (dark sections / footer)
        primary: "#1A1610",  // ink (buttons, links, accents)
        medium: "#8A8175",   // warm mid grey
        light: "#CFC7B7",    // warm light grey (on dark)
        ice: "#EFE9DC",      // soft cream (cards / chips / tints)
        offwhite: "#F5F0E6", // bone (alt sections)
        charcoal: "#1F1B14", // body text
        cream: "#FAF7EF",    // lightest warm background
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        label: "0.22em",
      },
      maxWidth: {
        content: "1180px",
      },
      boxShadow: {
        // Soft, neutral, restrained — no colored glows.
        card: "0 1px 2px rgba(31,27,20,0.04), 0 10px 30px rgba(31,27,20,0.05)",
        cardhover: "0 2px 6px rgba(31,27,20,0.06), 0 18px 44px rgba(31,27,20,0.10)",
        glow: "0 24px 60px rgba(31,27,20,0.14)",
      },
      backgroundImage: {
        // Warm, subtle gradients only.
        "gradient-navy": "linear-gradient(160deg, #17130D 0%, #241E15 100%)",
        "gradient-hero": "linear-gradient(180deg, #FAF7EF 0%, #F2EBDD 100%)",
        "gradient-ice": "linear-gradient(180deg, #F5F0E6 0%, #FAF7EF 100%)",
        "gradient-primary": "linear-gradient(180deg, #241E15 0%, #17130D 100%)",
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
