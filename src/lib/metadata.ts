import type { Metadata } from "next";
import { siteSettings } from "@/data/siteSettings";

/**
 * buildMetadata — one place to generate consistent per-page SEO metadata,
 * Open Graph, and Twitter cards. Each page calls this with its own values.
 */
export function buildMetadata({
  title,
  description,
  path = "/",
}: {
  title: string;
  description: string;
  path?: string;
}): Metadata {
  const url = `${siteSettings.url}${path}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: siteSettings.brandName,
      images: [{ url: siteSettings.ogImage, width: 1200, height: 630, alt: siteSettings.brandName }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [siteSettings.ogImage],
    },
  };
}
