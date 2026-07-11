import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  tone?: "info" | "warning";
}

export function DisclaimerBanner({ children, tone = "info" }: Props) {
  const styles =
    tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-light bg-ice text-navy";
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${styles}`} role="note">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}
