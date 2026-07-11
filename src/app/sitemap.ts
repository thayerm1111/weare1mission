import type { MetadataRoute } from "next";
import { siteSettings } from "@/data/siteSettings";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    "", "/start-here", "/training", "/schedule", "/events",
    "/resources", "/leadership", "/shop", "/contact", "/legal",
  ];
  const now = new Date();
  return routes.map((path) => ({
    url: `${siteSettings.url}${path}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: path === "" ? 1 : 0.7,
  }));
}
