/** A single set of app identities across the One Mission workspace. */
export function ProductIcon({ kind, size = "md", className = "" }: {
  kind: "atlas" | "genx" | "plays" | "pulse" | "flow" | "strata";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span className={`om-product-icon om-product-${kind} om-product-icon-${size} ${className}`} aria-hidden="true">
      {kind === "atlas" && <span className="om-icon-core"><i /><i /><i /></span>}
      {kind === "genx" && <span className="om-icon-crystal"><i /><i /></span>}
      {kind === "plays" && <svg viewBox="0 0 32 32" fill="none"><path d="M16 4c1.5 8 4 10.5 12 12-8 1.5-10.5 4-12 12C14.5 20 12 17.5 4 16 12 14.5 14.5 12 16 4Z" fill="currentColor"/><path d="m26 3 .8 3.2L30 7l-3.2.8L26 11l-.8-3.2L22 7l3.2-.8L26 3Z" fill="currentColor" opacity=".6"/></svg>}
      {kind === "pulse" && <span className="om-icon-wave"><i /><i /><i /><i /><i /></span>}
      {kind === "strata" && <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 23h8l5-8 4 4 8-12"/><path d="M3 29h9l5-8 4 4 8-12" opacity=".42"/>
        <circle cx="16" cy="15" r="2.5" fill="currentColor" stroke="none"/>
      </svg>}
      {kind === "flow" && <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="m12 20-2.2 2.2a5.7 5.7 0 0 1-8-8L8 8a5.7 5.7 0 0 1 8 0" transform="translate(3 1) scale(.85)"/><path d="m16 24a5.7 5.7 0 0 0 8 0l6.2-6.2a5.7 5.7 0 0 0-8-8L20 12" transform="translate(1 -1) scale(.85)"/><path d="m11.5 20.5 9-9"/></svg>}
    </span>
  );
}
