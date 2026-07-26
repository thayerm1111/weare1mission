import { Compass } from "lucide-react";
import { CustomerStartHere } from "@/components/portal/CustomerStartHere";

export const metadata = { title: "Start Here", robots: { index: false, follow: false } };

/**
 * Start Here — customer (The Ones) onboarding, rendered inside the member portal.
 * A guided, friendly flow: get connected, set up ConeqtX + Tap to Trade + a
 * broker, go live with MFX, learn risk & basics, journal trades, and tour the
 * platform. Progress saves on this device.
 */
export default function PortalStartHerePage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">New Member Onboarding</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Compass className="h-7 w-7 text-primary" aria-hidden="true" /> Start Here
        </h1>
        <p className="mt-2 max-w-2xl text-charcoal/70">
          Welcome to 1 Mission. Follow these steps at your own pace to get fully connected, set up,
          and ready to trade with confidence. Your progress saves automatically on this device.
        </p>
      </header>
      <CustomerStartHere />
    </div>
  );
}
