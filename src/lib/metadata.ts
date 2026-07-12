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
  image,
}: {
  title: string;
  description: string;
  path?: string;
  /** Custom link-preview image for this page. Defaults to the site OG image. */
  image?: string;
}): Metadata {
  const url = `${siteSettings.url}${path}`;
  const ogImage = image ?? siteSettings.ogImage;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: siteSettings.brandName,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}
