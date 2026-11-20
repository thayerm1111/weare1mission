/**
 * ATLAS'S MARK ON THE FLOOR — one softly lit loop, still.
 *
 * A single band with a half twist, lit from one side. It was rendered once from its own geometry (a
 * Möbius band: radius 1, half-width 0.46, tilted 0.78 rad and turned −0.8 rad, shaded per facet from deep
 * violet through lavender to near-white) and saved as a small transparent image, so it costs the page one
 * 8 KB request instead of hundreds of shapes. It is One Mission's own drawing, not another product's mark.
 *
 * It does not move. Atlas's living presence belongs to the Command Center; nothing animates beside
 * account figures.
 */
export function AtlasMark({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true" style={{ position: "relative", display: "block" }}>
      <span style={{ position: "absolute", left: "8%", right: "4%", bottom: "-6%", height: "34%", borderRadius: "50%", background: "radial-gradient(closest-side, rgba(150,132,246,0.36), rgba(150,132,246,0))" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/images/atlas-loop.webp" alt="" width={397} height={283} decoding="async" draggable={false} style={{ position: "relative", display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
    </span>
  );
}
