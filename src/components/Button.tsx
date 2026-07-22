import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "white";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-medium uppercase tracking-[0.14em] rounded-none transition-all duration-200 focus-ring disabled:opacity-60 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-primary text-white hover:bg-black",
  secondary:
    "bg-white text-navy border border-primary/30 hover:border-primary hover:bg-ice",
  ghost: "text-navy hover:text-primary hover:bg-ice",
  white:
    "bg-white text-navy border border-transparent hover:bg-ice",
};

const sizes: Record<Size, string> = {
  sm: "text-[12px] px-4 py-2.5",
  md: "text-[13px] px-6 py-3.5",
  lg: "text-sm px-8 py-4",
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
