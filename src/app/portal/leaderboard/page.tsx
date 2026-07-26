import { Trophy } from "lucide-react";
import { LeaderboardFull } from "@/components/portal/LeaderboardFull";

export const metadata = { title: "Leaderboard", robots: { index: false, follow: false } };

export default function LeaderboardPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Community</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <Trophy className="h-7 w-7 text-primary" aria-hidden="true" /> Leaderboard
        </h1>
        <p className="mt-2 text-charcoal/70">
          See who&apos;s putting in the work. Every rank is earned by showing up — no shortcuts.
        </p>
      </header>
      <LeaderboardFull />
    </div>
  );
}
