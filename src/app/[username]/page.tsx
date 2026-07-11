import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, UserCheck } from "lucide-react";
import { Monogram1M } from "@/components/Logo";
import { RefCookie } from "@/components/RefCookie";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "You're Invited", robots: { index: false, follow: false } };

export default async function ReferralLanding({ params }: { params: { username: string } }) {
  const username = params.username.toLowerCase();

  // If the backend isn't set up, don't try to resolve — fall through to 404.
  if (!isSupabaseConfigured) notFound();

  const supabase = createClient();
  const { data } = await supabase!.rpc("get_referrer", { u: username });
  const referrer = Array.isArray(data) ? data[0] : null;
  if (!referrer) notFound();

  const firstName = (referrer.full_name || "A member").split(" ")[0];

  return (
    <section className="section bg-gradient-hero">
      <RefCookie username={username} />
      <div className="container-1m flex justify-center">
        <div className="w-full max-w-md text-center">
          <Monogram1M className="mx-auto h-11 w-11 text-primary" />
          <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-[#E4DCCB] bg-cream px-3 py-1.5 text-xs font-semibold uppercase tracking-label text-medium">
            <UserCheck className="h-3.5 w-3.5" aria-hidden="true" /> Personal Invitation
          </p>
          <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight text-navy text-balance">
            {firstName} invited you to 1 Mission
          </h1>
          <p className="mt-4 text-charcoal/70">
            One Mission. One Community. One Movement. Create your account to get connected — {firstName}{" "}
            will be your sponsor, and the team will approve your access.
          </p>
          <div className="mt-8">
            <Link
              href={`/signup?ref=${encodeURIComponent(username)}`}
              className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-8 py-4 text-base font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5"
            >
              Create your account <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <p className="mt-6 text-sm text-charcoal/60">
            Already a member? <Link href="/login" className="font-semibold text-primary hover:text-medium">Log in</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
