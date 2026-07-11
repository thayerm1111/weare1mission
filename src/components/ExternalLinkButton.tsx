import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  href: string;
  children: ReactNode;
  className?: string;
}

/** Small inline external link with an arrow icon. Handles internal (/x) links too. */
export function ExternalLinkButton({ href, children, className = "" }: Props) {
  const isInternal = href.startsWith("/") || href.startsWith("#/");
  const isPlaceholder = href === "#";
  return (
    <a
      href={href}
      {...(!isInternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      aria-disabled={isPlaceholder}
      className={`inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-medium ${
        isPlaceholder ? "opacity-70" : ""
      } ${className}`}
    >
      {children}
      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
    </a>
  );
}
