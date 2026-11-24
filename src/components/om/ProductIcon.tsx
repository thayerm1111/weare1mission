/** A single set of app identities across the One Mission workspace. */
export function ProductIcon({ kind, size = "md", className = "" }: {
  kind: "floor" | "atlas" | "genx" | "plays" | "pulse" | "flow" | "strata";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span className={`om-product-icon om-product-${kind} om-product-icon-${size} ${className}`} aria-hidden="true">
      {kind === "floor" && <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m5 14 11-10 11 10v13h-8v-9h-6v9H5V14Z"/><path d="m10 10 6-5 6 5" opacity=".35"/></svg>}
      {kind === "atlas" && <span className="om-icon-core"><i /><i /><i /></span>}
      {kind === "genx" && <svg className="om-icon-x" viewBox="0 0 32 32" fill="currentColor"><path d="M4 5h7l5 7 5-7h7L20 16l8 11h-7l-5-7-5 7H4l8-11Z"/><path d="m6 6 7 10-7 10h4l8-10-8-10H6Z" fill="#fff3c8" opacity=".45"/></svg>}
      {kind === "plays" && <svg viewBox="0 0 32 32" fill="none"><path d="M16 4c1.5 8 4 10.5 12 12-8 1.5-10.5 4-12 12C14.5 20 12 17.5 4 16 12 14.5 14.5 12 16 4Z" fill="currentColor"/><path d="m26 3 .8 3.2L30 7l-3.2.8L26 11l-.8-3.2L22 7l3.2-.8L26 3Z" fill="currentColor" opacity=".6"/></svg>}
      {kind === "pulse" && <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 17h7l4-11 5 21 4-14 3 4h5"/></svg>}
      {kind === "strata" && <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 23h8l5-8 4 4 8-12"/><path d="M3 29h9l5-8 4 4 8-12" opacity=".42"/>
        <circle cx="16" cy="15" r="2.5" fill="currentColor" stroke="none"/>
      </svg>}
      {kind === "flow" && <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="m12 20-2.2 2.2a5.7 5.7 0 0 1-8-8L8 8a5.7 5.7 0 0 1 8 0" transform="translate(3 1) scale(.85)"/><path d="m16 24a5.7 5.7 0 0 0 8 0l6.2-6.2a5.7 5.7 0 0 0-8-8L20 12" transform="translate(1 -1) scale(.85)"/><path d="m11.5 20.5 9-9"/></svg>}
    </span>
  );
}
