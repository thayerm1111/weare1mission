import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "white";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-full transition-all duration-200 focus-ring disabled:opacity-60 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-gradient-primary text-white shadow-[0_8px_24px_rgba(26,22,16,0.22)] hover:shadow-[0_10px_30px_rgba(26,22,16,0.28)] hover:-translate-y-0.5",
  secondary:
    "bg-white text-navy border border-light hover:border-primary hover:text-primary",
  ghost: "text-navy hover:text-primary hover:bg-ice",
  white:
    "bg-white text-navy hover:bg-ice shadow-[0_8px_24px_rgba(8,21,47,0.18)] hover:-translate-y-0.5",
};

const sizes: Record<Size, string> = {
  sm: "text-sm px-4 py-2",
  md: "text-sm px-6 py-3",
  lg: "text-base px-8 py-4",
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}

interface LinkProps extends CommonProps {
  href: string;
  external?: boolean;
  onClick?: never;
  type?: never;
}

interface ButtonProps extends CommonProps {
  href?: undefined;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}

export function Button(props: LinkProps | ButtonProps) {
  const { variant = "primary", size = "md", className = "", children } = props;
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${className}`;

  if ("href" in props && props.href) {
    if (props.external) {
      return (
        <a href={props.href} target="_blank" rel="noopener noreferrer" className={cls}>
          {children}
        </a>
      );
    }
    return (
      <Link href={props.href} className={cls}>
        {children}
      </Link>
    );
  }

  const { onClick, type = "button", disabled } = props as ButtonProps;
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
