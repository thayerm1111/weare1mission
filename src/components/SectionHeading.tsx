import type { ReactNode } from "react";

interface Props {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  light?: boolean; // for dark backgrounds
  className?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  light = false,
  className = "",
}: Props) {
  const alignment = align === "center" ? "text-center mx-auto" : "text-left";
  return (
    <div className={`max-w-2xl ${alignment} ${className}`}>
      {eyebrow && (
        <span className={`eyebrow ${light ? "text-gold-light" : "text-gold"}`}>{eyebrow}</span>
      )}
      <h2
        className={`mt-4 font-serif text-4xl font-black leading-[1.05] tracking-tight text-balance sm:text-5xl lg:text-[3.25rem] ${
          light ? "text-white" : "text-navy"
        }`}
      >
        {title}
      </h2>
      {description && (
        <p className={`mt-4 text-base sm:text-lg leading-relaxed ${light ? "text-light" : "text-charcoal/70"}`}>
          {description}
        </p>
      )}
    </div>
  );
}
