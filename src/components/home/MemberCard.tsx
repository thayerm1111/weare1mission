import { Monogram1M } from "../Logo";
import { siteSettings } from "@/data/siteSettings";

/**
 * Hero "member card" visual (right side of the homepage hero).
 * A premium ID-style card — brand mark, member badge, headline, and stats.
 * Sits on top of the slowly-rotating orbit rings rendered by HomeHero.
 * Edit the stats and est. year in src/data/siteSettings.ts.
 */
export function MemberCard() {
  const { heroStats, established } = siteSettings;
  return (
    <div className="relative w-full max-w-sm rounded-[26px] border border-[#E7E0D2] bg-cream/95 p-7 shadow-glow backdrop-blur sm:p-8">
      {/* Brand mark */}
      <div className="flex items-center">
        <Monogram1M className="h-9 w-9 text-primary" />
      </div>

      {/* Serif headline */}
      <h2 className="mt-8 font-serif text-3xl font-bold leading-tight text-navy">
        One
        <br />
        <span className="gold-grad italic">Mission.</span>
      </h2>

      <hr className="my-6 border-0 border-t border-[#E7E0D2]" />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 text-center">
        {heroStats.map((s) => (
          <div key={s.label}>
            <p className="font-serif text-xl font-bold text-navy">{s.value}</p>
            <p className="mt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-medium">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      <hr className="my-6 border-0 border-t border-[#E7E0D2]" />

      {/* Footer row */}
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-medium">
        <span>Est. {established}</span>
      </div>
    </div>
  );
}
