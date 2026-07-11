import Link from "next/link";
import { Monogram1M } from "@/components/Logo";
import { ForgotForm } from "./ForgotForm";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({ title: "Reset Password", description: "Reset your 1 Mission member password.", path: "/forgot-password" });

export default function ForgotPasswordPage() {
  return (
    <section className="section bg-gradient-hero">
      <div className="container-1m flex justify-center">
        <div className="w-full max-w-md">
          <div className="text-center">
            <Link href="/" aria-label="1 Mission home" className="inline-flex text-primary"><Monogram1M className="mx-auto h-10 w-10" /></Link>
            <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-navy">Reset your password</h1>
            <p className="mt-2 text-sm text-charcoal/70">Enter your email and we&apos;ll send you a link to set a new password.</p>
          </div>
          <div className="mt-8 rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-6 shadow-card sm:p-8"><ForgotForm /></div>
          <p className="mt-6 text-center text-sm text-charcoal/70"><Link href="/login" className="font-semibold text-primary hover:text-medium">Back to log in</Link></p>
        </div>
      </div>
    </section>
  );
}
