import { Hero } from "@/components/Hero";
import { ResourcesClient } from "./ResourcesClient";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Resources",
  description:
    "The 1 Mission resource library: new member guides, affiliate resources, trading education, presentation videos, scripts, trackers, downloads, apps, and important links.",
  path: "/resources",
});

export default function ResourcesPage() {
  return (
    <>
      <Hero
        eyebrow="Resource Library"
        title="Everything in one place"
        description="Guides, scripts, trackers, downloads, and the links you need. Search or filter to find exactly what you're looking for."
      />
      <ResourcesClient />
    </>
  );
}
