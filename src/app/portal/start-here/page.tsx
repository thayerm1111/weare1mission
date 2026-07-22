import { Compass } from "lucide-react";
import { StartHereClient } from "@/app/start-here/StartHereClient";

export const metadata = { title: "Start Here", robots: { index: false, follow: false } };

/**
 * Start Here — customer onboarding, rendered INSIDE the member portal so the
 * left sidebar stays put. Reuses the same onboarding flow as the public
 * /start-here page (progress is shared via the same local storage key).
 */
export default function PortalStartHerePage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">New Member Onboarding</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Compass className="h-7 w-7 text-primary" aria-hidden="true" /> Start Here
        </h1>
        <p className="mt-2 text-charcoal/70">
          Follow these steps at your own pace to get fully connected and set up for success.
          Your progress saves automatically on this device.
        </p>
      </header>
      <StartHereClient />
    </div>
  );
}
