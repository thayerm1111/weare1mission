import { Clock, ShieldX } from "lucide-react";
import { SignOutButton } from "./SignOutButton";

/**
 * Shown to members whose account is not yet active.
 *  - "pending": awaiting admin approval
 *  - "suspended": access has been paused by an admin
 */
export function PendingNotice({ status, name }: { status: "pending" | "suspended"; name?: string | null }) {
  const pending = status === "pending";
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-8 text-center shadow-card">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-ice text-primary" aria-hidden="true">
        {pending ? <Clock className="h-7 w-7" /> : <ShieldX className="h-7 w-7" />}
      </div>
      <h1 className="mt-5 text-xl font-bold text-navy">
        {pending ? "Your account is awaiting approval" : "Your access is currently paused"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-charcoal/70">
        {pending ? (
          <>Thanks{name ? `, ${name.split(" ")[0]}` : ""}! Your 1 Mission account has been created and is
          waiting for the team to approve your access. You&apos;ll be able to see training, sessions, and
          team updates as soon as you&apos;re approved. Reach out to your mentor if you have questions.</>
        ) : (
          <>Your member access has been paused. Please contact your mentor or the 1 Mission team if you
          think this is a mistake.</>
        )}
      </p>
      <div className="mt-6 flex justify-center"><SignOutButton /></div>
    </div>
  );
}
