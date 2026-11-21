import type { Metadata, Viewport } from "next";
import { PremiumHomepage } from "@/components/public-homepage/PremiumHomepage";
import { buildMetadata } from "@/lib/metadata";

const homepageMetadata = buildMetadata({
    title: "One Mission — Your trading. Connected.",
    description:
      "One Mission brings AI market intelligence, gold analysis, structured trade setups and connected execution into one focused trading platform.",
    path: "/",
    image: "/images/homepage/hero-poster.jpg",
});

export const metadata: Metadata = {
  ...homepageMetadata,
  title: { absolute: "One Mission — Your trading. Connected." },
  icons: { icon: { url: "/images/homepage/favicon.svg", type: "image/svg+xml" } },
  openGraph: {
    ...homepageMetadata.openGraph,
    images: [{ url: "/images/homepage/hero-poster.jpg", width: 1280, height: 720, alt: "One Mission — Your trading. Connected." }],
  },
  keywords: ["One Mission", "AI trading tools", "gold analysis", "GENX", "Atlas", "OM AI Plays", "Market Pulse", "FLOW"],
};

export const viewport: Viewport = { themeColor: "#08090b" };

/** Public presentation only. This page does not initialize trading, account, or generation services. */
export default function HomePage() {
  return <PremiumHomepage />;
}
