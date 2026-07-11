import { FolderOpen } from "lucide-react";
import { ResourcesClient } from "@/app/resources/ResourcesClient";

export const metadata = { title: "Resources", robots: { index: false, follow: false } };

export default function PortalResourcesPage() {
  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <FolderOpen className="h-7 w-7 text-primary" aria-hidden="true" /> Resources
        </h1>
        <p className="mt-2 text-charcoal/70">Guides, scripts, trackers, downloads, and important links.</p>
      </header>
      <ResourcesClient />
    </div>
  );
}
