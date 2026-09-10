import Link from "next/link";
import { LineChart } from "lucide-react";
import { LoginForm } from "@/app/login/LoginForm";

export const metadata = {
  title: "Log In — The Floor",
  description: "Sign in to The Floor — the 1 Mission live trading desk.",
  robots: { index: false, follow: false },
};

/**
 * THE FLOOR — its own front door (floor.weare1mission.com/login).
 * Same member accounts as weare1mission.com (one Supabase auth system); this page
 * just gives The Floor its own branded entrance so it feels like a separate app.
 * Registration stays on the main site by design — the backoffice is where you
 * create the account, The Floor is where you trade with it.
 */
export default function FloorLoginPage({ searchParams }: { searchParams: { redirect?: string } }) {
  const dest = searchParams.redirect && searchParams.redirect.startsWith("/") && !searchParams.redirect.startsWith("//")
    ? searchParams.redirect
    : "/";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10" style={{ background: "radial-gradient(1200px 600px at 50% -10%, rgba(34,211,238,0.08), transparent), #050505" }}>
      <div className="w-full max-w-md">
        <div className="text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>
            Live Desk
          </div>
          <h1 className="mt-5 flex items-center justify-center gap-3 text-4xl font-black uppercase tracking-tight text-white">
            <LineChart className="h-8 w-8 text-cyan-300" aria-hidden="true" /> The Floor
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Live trading intelligence. Real results. Sign in with your 1 Mission account.
          </p>
        </div>

        {/* The proven 1 Mission login (member ID or email) — light card reads as the
            terminal's glowing sign-in window against the dark desk. */}
        <div className="mt-8 rounded-2xl border border-white/10 bg-offwhite/95 p-6 shadow-[0_0_60px_rgba(34,211,238,0.12)] sm:p-8">
          <LoginForm redirect={dest} />
        </div>

        <p className="mt-6 text-center text-sm text-slate-400">
          No account yet?{" "}
          <Link href="https://weare1mission.com/signup" className="font-semibold text-cyan-300 hover:text-cyan-200">
            Create it at weare1mission.com
          </Link>{" "}
          — then come back here to trade.
        </p>
        <p className="mt-3 text-center text-[11px] text-slate-600">
          Educational only — not financial advice. You approve every action on your own account.
        </p>
      </div>
    </div>
  );
}
