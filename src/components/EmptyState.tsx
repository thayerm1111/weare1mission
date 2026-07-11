import { SearchX } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title?: string;
  message?: string;
  icon?: ReactNode;
}

export function EmptyState({
  title = "Nothing here yet",
  message = "Try adjusting your search or filters.",
  icon,
}: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-light bg-offwhite px-6 py-16 text-center">
      <div className="text-medium" aria-hidden="true">{icon || <SearchX className="h-10 w-10" />}</div>
      <h3 className="mt-4 text-lg font-semibold text-navy">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-charcoal/60">{message}</p>
    </div>
  );
}
