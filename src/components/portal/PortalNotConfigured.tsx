import Link from "next/link";
import { ServerCog } from "lucide-react";

/**
 * Shown in the member area when Supabase env vars aren't set yet, so the site
 * still builds and the public pages work. Replace nothing — this disappears
 * automatically once NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY are configured.
 */
export function PortalNotConfigured() {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-8 text-center shadow-card">
      <ServerCog className="mx-auto h-10 w-10 text-medium" aria-hidden="true" />
      <h1 className="mt-4 text-xl font-bold text-navy">Member area is almost ready</h1>
      <p className="mt-2 text-sm leading-relaxed text-charcoal/70">
        The 1 Mission member portal connects to a secure backend for training, live sessions, and
        team updates. It just needs to be linked to Supabase. Once the environment variables are
        set (see the project README), sign-in and member content go live here automatically.
      </p>
      <Link href="/" className="mt-6 inline-flex rounded-full bg-gradient-primary px-6 py-3 text-sm font-semibold text-cream">
        Back to home
      </Link>
    </div>
  );
}
