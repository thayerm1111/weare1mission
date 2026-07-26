/**
 * Portal loading skeleton — shown while a member page fetches its data, so
 * navigation feels instant and no screen ever flashes empty.
 */
export default function PortalLoading() {
  return (
    <div className="animate-pulse space-y-8" aria-hidden="true">
      {/* Hero banner */}
      <div className="h-48 rounded-2xl bg-navy/90 sm:h-52" />

      {/* Two-up cards */}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="h-40 rounded-2xl border border-[#E7E4DD] bg-offwhite/70" />
        <div className="h-40 rounded-2xl border border-[#E7E4DD] bg-offwhite/70" />
      </div>

      {/* Wide panel */}
      <div className="h-56 rounded-2xl border border-[#E7E4DD] bg-offwhite/70" />

      {/* Tile row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-2xl border border-[#E7E4DD] bg-offwhite/70" />
        ))}
      </div>
    </div>
  );
}
