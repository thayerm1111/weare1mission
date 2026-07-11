import { GraduationCap } from "lucide-react";
import { TrainingClient } from "@/app/training/TrainingClient";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

export const metadata = { title: "Training", robots: { index: false, follow: false } };

export default function PortalTrainingPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <GraduationCap className="h-7 w-7 text-primary" aria-hidden="true" /> Affiliate Training
        </h1>
        <p className="mt-2 text-charcoal/70">Work through the modules and track your completion.</p>
      </header>
      <DisclaimerBanner tone="warning">
        Educational content only — not individualized financial advice, and no income or results are
        guaranteed. Your results depend on your effort, skill, and factors outside anyone&apos;s control.
      </DisclaimerBanner>
      <TrainingClient />
    </div>
  );
}
