import Link from "next/link";
import { Monogram1M } from "@/components/Logo";
import { SignupForm } from "./SignupForm";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "Create Your Account",
  description: "Create your 1 Mission member account. New accounts are approved by the team before access is granted.",
  path: "/signup",
});

export default function SignupPage({ searchParams }: { searchParams: { ref?: string } }) {
  return (
    <section className="section bg-gradient-hero">
      <div className="container-1m flex justify-center">
        <div className="w-full max-w-md">
          <div className="text-center">
            <Link href="/" aria-label="1 Mission home" className="inline-flex text-primary"><Monogram1M className="mx-auto h-10 w-10" /></Link>
            <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-navy">Create your account</h1>
            <p className="mt-2 text-sm text-charcoal/70">Join the 1 Mission member area. Your access is approved by the team.</p>
          </div>
          <div className="mt-8 rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-6 shadow-card sm:p-8">
            <SignupForm refUsername={searchParams.ref} />
          </div>
          <p className="mt-6 text-center text-sm text-charcoal/70">
            Already have an account? <Link href="/login" className="font-semibold text-primary hover:text-medium">Log in</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
