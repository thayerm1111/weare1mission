import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { IntroSplash } from "@/components/IntroSplash";
import { siteSettings } from "@/data/siteSettings";

/**
 * FONT: Inter is loaded via a standard stylesheet <link> below (see <head>).
 * The CSS variable `--font-inter` is defined in globals.css, so if the font
 * fails to load the site gracefully falls back to the system UI font.
 *
 * Prefer next/font? On a machine WITH internet you can swap this for:
 *   import { Inter } from "next/font/google";
 *   const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
 * and add `className={inter.variable}` to <html>. We use the <link> approach
 * so the project builds in offline/restricted environments too.
 */

export const metadata: Metadata = {
  metadataBase: new URL(siteSettings.url),
  title: {
    default: `${siteSettings.brandName} | ${siteSettings.tagline}`,
    template: `%s | ${siteSettings.brandName}`,
  },
  description: siteSettings.shortMission,
  applicationName: siteSettings.brandName,
  keywords: [
    "1 Mission", "team community", "onboarding", "affiliate training",
    "leadership development", "trading education", "personal development",
  ],
  icons: {
    // Favicon placeholder — replace /public/favicon.ico with your real icon.
    icon: "/favicon.ico",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#08152F",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="flex min-h-screen flex-col">
        <IntroSplash />
        <Header />
        <main id="main" className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
