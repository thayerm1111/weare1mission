import { Monogram1M } from "@/components/Logo";
import { ResetForm } from "./ResetForm";

export const metadata = { title: "Set New Password", robots: { index: false, follow: false } };

export default function ResetPage() {
  return (
    <section className="section bg-gradient-hero">
      <div className="container-1m flex justify-center">
        <div className="w-full max-w-md">
          <div className="text-center">
            <Monogram1M className="mx-auto h-10 w-10 text-primary" />
            <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-navy">Set a new password</h1>
            <p className="mt-2 text-sm text-charcoal/70">Choose a new password for your account.</p>
          </div>
          <div className="mt-8 rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-6 shadow-card sm:p-8"><ResetForm /></div>
        </div>
      </div>
    </section>
  );
}
