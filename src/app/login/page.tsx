import Link from "next/link";
import { Monogram1M } from "@/components/Logo";
import { LoginForm } from "./LoginForm";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Member Log In",
  description: "Sign in to the 1 Mission member area for training, live sessions, and team updates.",
  path: "/login",
});

export default function LoginPage({ searchParams }: { searchParams: { redirect?: string } }) {
  return (
    <section className="section bg-gradient-hero">
      <div className="container-1m flex justify-center">
        <div className="w-full max-w-md">
          <div className="text-center">
            <Link href="/" aria-label="1 Mission home" className="inline-flex text-primary">
              <Monogram1M className="mx-auto h-10 w-10" />
            </Link>
            <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-navy">Member Log In</h1>
            <p className="mt-2 text-sm text-charcoal/70">
              Welcome back. Enter your email to access the 1 Mission member area.
            </p>
          </div>
          <div className="mt-8 rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-6 shadow-card sm:p-8">
            <LoginForm redirect={searchParams.redirect} />
          </div>
          <p className="mt-6 text-center text-sm text-charcoal/70">
            New here?{" "}
            <Link href="/start-here" className="font-semibold text-primary hover:text-medium">
              Start with onboarding
            </Link>{" "}
            — your mentor can get you connected.
          </p>
        </div>
      </div>
    </section>
  );
}
