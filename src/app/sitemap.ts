import type { MetadataRoute } from "next";
import { siteSettings } from "@/data/siteSettings";

export default function sitemap(): MetadataRoute.Sitemap {
  // Public, indexable routes only. The member back office (/portal/*) and the
  // pages that moved into it are intentionally excluded (login-gated, noindex).
  const routes = ["", "/start-here", "/events", "/shop", "/contact", "/legal"];
  const now = new Date();
  return routes.map((path) => ({
    url: `${siteSettings.url}${path}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: path === "" ? 1 : 0.7,
  }));
}
